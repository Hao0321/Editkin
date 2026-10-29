import type { EditProject, MediaAsset } from "../domain/types";
import { activeVideoClip } from "../domain/editGraph";
import { formatTime } from "../lib/format";
import type { MobileRemoteSnapshot } from "./types";

export function buildMobileSnapshot(
  project: EditProject,
  playhead: number,
  status: string,
  previewAsset?: MediaAsset,
): MobileRemoteSnapshot {
  const previewPath = previewAsset?.derivatives?.proxyUri ?? previewAsset?.uri;
  const absolutePreview = previewPath && (/^[A-Za-z]:[\\/]/.test(previewPath) || previewPath.startsWith("\\\\") || previewPath.startsWith("/"));
  return {
    projectName: project.name, resolution: `${project.width}×${project.height}`, fps: project.fps,
    trackCount: project.tracks.length, playhead, playheadLabel: formatTime(playhead), status,
    previewId: previewAsset?.id, previewPath: absolutePreview ? previewPath : undefined, previewKind: previewAsset?.kind,
  };
}

/**
 * The phone's snapshot without re-rendering App on every playhead tick (PF1, 2026-10-23): built on demand from the
 * project and status of App's last render and the playhead the editor last rendered, and the same object until one of
 * them (or the clip under the playhead) changes, exactly like the useMemo it replaces. `notify` is called after commits.
 */
export function createMobileSnapshotSource(read: () => { project: EditProject; status: string; playhead: number }) {
  const listeners = new Set<() => void>();
  let memo: { project: EditProject; status: string; playhead: number; previewAsset?: MediaAsset; snapshot: MobileRemoteSnapshot } | undefined;
  return {
    getSnapshot(): MobileRemoteSnapshot {
      const { project, status, playhead } = read();
      const clip = activeVideoClip(project, playhead);
      const previewAsset = clip ? project.assets.find((asset) => asset.id === clip.assetId) : undefined;
      if (memo && memo.project === project && memo.status === status && memo.playhead === playhead && memo.previewAsset === previewAsset) return memo.snapshot;
      const snapshot = buildMobileSnapshot(project, playhead, status, previewAsset);
      memo = { project, status, playhead, previewAsset, snapshot };
      return snapshot;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    notify() { for (const listener of [...listeners]) listener(); },
  };
}
