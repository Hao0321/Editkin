import { useEffect, useMemo, useState } from "react";
import type { ActivePreviewLayer } from "../application/previewMedia";
import type { EditProject } from "../domain/types";
import { isTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import type { HaoDesktopApi, NativeEffectPreviewResult } from "./types";

interface NativeEffectPreviewState {
  layers: ActivePreviewLayer[];
  readyClipIds: string[];
  pendingClipIds: string[];
  errorByClipId: Record<string, string>;
}

interface CachedPreview {
  projectIdentity: string;
  result: NativeEffectPreviewResult;
}

export function useNativeEffectPreview(
  api: HaoDesktopApi | undefined,
  project: EditProject,
  layers: ActivePreviewLayer[],
  enabled: boolean,
): NativeEffectPreviewState {
  const targetClipIds = useMemo(() => layers
    .filter((layer) => !layer.displayClip && layer.clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled && instance.runtimeType !== "gpu_effect_graph" && !isTransformMotionBlurInstance(instance)))
    .map((layer) => layer.clip.id)
    .sort(), [layers]);
  const targetKey = targetClipIds.join("\u0000");
  const projectIdentity = `${project.id}:${project.revision}:${project.updatedAt}`;
  const [cache, setCache] = useState<Record<string, CachedPreview>>({});
  const [pendingClipIds, setPendingClipIds] = useState<string[]>([]);
  const [errorByClipId, setErrorByClipId] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!enabled || !api?.renderNativeEffectPreview || !targetClipIds.length) {
      setPendingClipIds([]);
      return;
    }
    let disposed = false;
    const timer = window.setTimeout(() => {
      setPendingClipIds(targetClipIds);
      setErrorByClipId((current) => Object.fromEntries(Object.entries(current).filter(([clipId]) => !targetClipIds.includes(clipId))));
      void (async () => {
        for (const clipId of targetClipIds) {
          try {
            const result = await api.renderNativeEffectPreview!(project, clipId);
            if (disposed) return;
            setCache((current) => ({ ...current, [clipId]: { projectIdentity, result } }));
            setErrorByClipId((current) => {
              const next = { ...current };
              delete next[clipId];
              return next;
            });
          } catch (error) {
            if (disposed) return;
            setErrorByClipId((current) => ({ ...current, [clipId]: error instanceof Error ? error.message : String(error) }));
          } finally {
            if (!disposed) setPendingClipIds((current) => current.filter((candidate) => candidate !== clipId));
          }
        }
      })();
    }, 350);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api, enabled, project, projectIdentity, targetKey]);

  const readyClipIds = targetClipIds.filter((clipId) => cache[clipId]?.projectIdentity === projectIdentity);
  const ready = new Set(readyClipIds);
  return {
    layers: layers.map((layer) => {
      if (!ready.has(layer.clip.id)) return layer;
      const result = cache[layer.clip.id].result;
      return {
        ...layer,
        clip: { ...layer.clip, sourceStart: result.sourceStart },
        asset: { ...layer.asset, kind: "video" },
        source: result.previewUrl,
      };
    }),
    readyClipIds,
    pendingClipIds,
    errorByClipId,
  };
}
