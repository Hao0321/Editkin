import type { EditProject, MediaAsset, TimelineClip, TimelineTrack } from "../domain/types";
import { formatTime } from "../lib/format";

/**
 * What a person calls a clip in the layer pickers and the 圖層 panel: its media's name (or 調整圖層 / Null), then where
 * it sits, so two clips of the same file are told apart. `translate` is the interface's own UI translator; media
 * names are the project's words and are never translated.
 */
export function clipLayerLabelV1(project: Pick<EditProject, "assets" | "tracks">, clip: TimelineClip, translate: (text: string) => string = text => text,
  known: { asset?: MediaAsset; track?: TimelineTrack } = {}) {
  const role = clip.layer?.role ?? "content";
  const asset = "asset" in known ? known.asset : project.assets.find(item => item.id === clip.assetId);
  const name = role === "adjustment" ? translate("調整圖層") : role === "controller" ? `Null · ${asset?.name ?? clip.id}` : asset?.name ?? translate("片段");
  const track = known.track ?? project.tracks.find(item => item.clips.some(candidate => candidate.id === clip.id));
  return { name, detail: `${track?.name ?? ""} · ${formatTime(clip.timelineStart)}`, label: `${name} · ${track?.name ?? ""} ${formatTime(clip.timelineStart)}` };
}

/** Clips that draw pictures (or, as Null, move them): on picture tracks only. Sound and caption tracks never qualify. */
export function pictureLayerClipsV1(project: Pick<EditProject, "tracks">): TimelineClip[] {
  return project.tracks.filter(track => track.kind === "video").flatMap(track => track.clips);
}
