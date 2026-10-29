import { motionLibraryAssetFileNameV1, motionLibraryCacheKeyV1, motionLibraryClipSecondsV1, motionLibraryFrameCountV1, motionLibraryFrameRateV1,
  type MotionLibraryAssetRoleV1 } from "../domain/motionLibraryV1";
import type { MediaAsset } from "../domain/types";
import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { MOTION_LIBRARY_ENGINE_VERSION, type MotionLibraryParams } from "../motionLibrary/types";
import { MOTION_LIBRARY_CANCELLED_V1, type MotionLibraryRenderHostV1, type MotionLibraryRenderedV1 } from "./motionLibraryRenderHostV1";

/**
 * A stand-in render host for tests and the browser-preview checks: it computes exactly the field and asset records the
 * service layer writes (cache key, file names, frame count, alpha, colour; see domain/motionLibraryV1.fixture.ts) and
 * reports staged progress, but it renders no file. Production never installs it.
 */
export function createSimulatedMotionLibraryRenderHostV1(options: { cacheRoot?: string; delayMs?: number; steps?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void> } = {}): MotionLibraryRenderHostV1 & { readonly calls: number } {
  const root = options.cacheRoot ?? "D:/simulated-project/.editkin-media-cache";
  const steps = Math.max(1, options.steps ?? 4);
  const wait = options.wait ?? ((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error(MOTION_LIBRARY_CANCELLED_V1));
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error(MOTION_LIBRARY_CANCELLED_V1)); }, { once: true });
  }));
  let calls = 0;
  return {
    get calls() { return calls; },
    async render(request, { signal, onProgress }): Promise<MotionLibraryRenderedV1> {
      calls += 1;
      const item = getMotionLibraryItem(request.itemId);
      const params = resolveMotionLibraryParams(item, request.params) as MotionLibraryParams;
      const rate = motionLibraryFrameRateV1(request.fps);
      const frameCount = motionLibraryFrameCountV1(params.durationSeconds, rate);
      const itemRevision = item.revision ?? 1;
      const cacheKey = motionLibraryCacheKeyV1({ itemId: item.id, itemRevision, kind: item.kind, params, width: request.width, height: request.height, fps: request.fps });
      for (let step = 0; step <= steps; step += 1) {
        if (signal.aborted) throw new Error(MOTION_LIBRARY_CANCELLED_V1);
        onProgress({ phase: step < steps ? "generate" : "done", fraction: step / steps });
        if (step < steps) await wait((options.delayMs ?? 0) / steps, signal);
      }
      const asset = (role: MotionLibraryAssetRoleV1): MediaAsset => ({
        id: `motionlib-${item.id}-${role}-${cacheKey.slice(0, 16)}`,
        name: `${item.names.zh}${role === "clip" ? "" : role === "matte" ? "（轉場遮罩）" : "（轉場色層）"}`,
        kind: "video", uri: `${root}/motionlib/${item.id}/${motionLibraryAssetFileNameV1(cacheKey, role)}`,
        duration: motionLibraryClipSecondsV1(frameCount, rate), width: request.width, height: request.height,
        alphaMode: role === "clip" && item.kind === "background" ? "opaque" : "straight",
        color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
      });
      const assets = item.kind === "transition" ? { matte: asset("matte"), overlay: asset("overlay") } : { clip: asset("clip") };
      return { itemId: item.id, kind: item.kind, itemRevision, engineVersion: MOTION_LIBRARY_ENGINE_VERSION, cacheKey,
        params: structuredClone(params) as Record<string, unknown>, frameCount, durationSeconds: motionLibraryClipSecondsV1(frameCount, rate), assets, previewUrls: {} };
    },
  };
}
