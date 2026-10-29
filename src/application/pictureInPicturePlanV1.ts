import type { EditorCommand } from "../domain/commandTypes";
import type { ClipLayout, EditProject, TimelineClip, TimelineTrack } from "../domain/types";

export interface PictureInPicturePlanV1 {
  /** One batch's worth of commands (one Undo). */
  commands: EditorCommand[];
  /** Another picture plays under the clip, so the two layers show at once. */
  hasBackground: boolean;
}

/**
 * 畫中畫 for the selected clip: it moves to a 畫中畫 track at the same time (its own, the first existing one, or a new one),
 * takes the layout and is switched on. Its blend mode and the rest of its layer settings stay as the creator set them:
 * making a picture-in-picture only places the picture (it used to reset 混合模式 to 一般).
 */
export function planPictureInPictureV1(project: EditProject, clip: TimelineClip, layout: ClipLayout, newTrackId: () => string): PictureInPicturePlanV1 {
  const commands: EditorCommand[] = [];
  const currentTrack = project.tracks.find((track) => track.id === clip.trackId);
  let target: TimelineTrack | undefined = currentTrack?.name.startsWith("畫中畫") ? currentTrack
    : project.tracks.find((track) => track.kind === "video" && track.name.startsWith("畫中畫"));
  if (!target) {
    target = { id: newTrackId(), name: `畫中畫 ${project.tracks.filter((track) => track.name.startsWith("畫中畫")).length + 1}`, kind: "video", locked: false, muted: false, clips: [] };
    commands.push({ type: "add_track", track: target });
  }
  if (clip.trackId !== target.id) commands.push({ type: "move_clip_to_track", clipId: clip.id, trackId: target.id, timelineStart: clip.timelineStart });
  commands.push(
    { type: "set_clip_layout", clipId: clip.id, layout },
    { type: "set_clip_layer", clipId: clip.id, patch: { enabled: true } },
  );
  const hasBackground = project.tracks.some((track) => track.kind === "video" && track.id !== clip.trackId && track.clips.some((other) =>
    other.timelineStart < clip.timelineStart + clip.duration && other.timelineStart + other.duration > clip.timelineStart));
  return { commands, hasBackground };
}
