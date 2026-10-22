import type { MediaAsset, TimelineClip } from "../domain/types";

/** Same first-frame admission as the original hook, with one indexed asset lookup per clip. */
export function selectTimelineFilmstripSources(
  assets: ReadonlyMap<string, MediaAsset>,
  runtimeUrls: Record<string, string>,
  visibleClips: ReadonlyMap<string, readonly TimelineClip[]>,
  pixelsPerSecond: number,
): Map<string, string> {
  const sources = new Map<string, string>();
  for (const clips of visibleClips.values()) {
    for (const clip of clips) {
      const asset = assets.get(clip.assetId);
      const uri = runtimeUrls[clip.assetId + ":proxy"] ?? runtimeUrls[clip.assetId];
      if (asset?.kind === "video" && !asset.compositionId && !asset.imageSequence
        && clip.layer?.role !== "controller" && clip.duration * pixelsPerSecond >= 80
        && !runtimeUrls[clip.assetId + ":thumbnail"] && uri) {
        sources.set(clip.assetId, uri);
      }
    }
  }
  return sources;
}

