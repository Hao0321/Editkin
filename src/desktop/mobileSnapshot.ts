import type { EditProject, MediaAsset } from "../domain/types";
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
