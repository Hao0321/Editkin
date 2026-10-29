import type { TimelineTrack } from "./types";

/**
 * Track matte sources that draw nothing themselves (design D3, After Effects / Premiere behaviour): every clip an
 * enabled content clip uses as its track matte, unless the source sets `layer.showMatteSource: true`. A hidden source
 * track does not change this: the matte still applies and the source is never drawn. Saved projects without track
 * mattes return an empty set, so their renders are unchanged.
 */
export function matteOnlySourceIdsV1(owner: { tracks: readonly TimelineTrack[] }): Set<string> {
  const sources = new Set<string>();
  for (const track of owner.tracks) for (const clip of track.clips) {
    const matte = clip.layer?.trackMatte;
    if (matte && clip.layer?.enabled !== false && (clip.layer?.role ?? "content") === "content") sources.add(matte.sourceClipId);
  }
  if (!sources.size) return sources;
  for (const track of owner.tracks) for (const clip of track.clips) if (clip.layer?.showMatteSource === true) sources.delete(clip.id);
  return sources;
}
