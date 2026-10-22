import type { EditProject, TimelineTrack } from "./types";
import { EditGraphError } from "./editGraphError";

export function trackHasSolo(track: Pick<TimelineTrack, "kind" | "solo">): boolean {
  return track.kind !== "caption" && track.solo === true;
}
/** The same audio policy for every preview/export path; picture visibility is independent. */
export function trackAudioAudible(project: Pick<EditProject, "tracks">, track: TimelineTrack): boolean {
  return track.kind !== "caption" && !track.muted && (!project.tracks.some(trackHasSolo) || trackHasSolo(track));
}
export function applyTrackSolo(project: EditProject, trackId: string, solo: boolean): void {
  const track = project.tracks.find(item => item.id === trackId);
  if (!track) throw new EditGraphError("找不到這條軌道。");
  if (track.kind === "caption") throw new EditGraphError("字幕軌沒有聲音，不能獨奏。");
  if (typeof solo !== "boolean") throw new EditGraphError("獨奏狀態必須是 true 或 false。");
  track.solo = solo;
}
