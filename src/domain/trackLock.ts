import type { EditorCommand } from "./commandTypes";
import { EditGraphError } from "./editGraphError";
import type { EditProject, TimelineTrack } from "./types";

/**
 * Track lock, enforced where every edit lands (applyCommand, so the editor's own gestures and an agent's
 * apply_edit_commands alike): a command that would change an item on a locked track is refused with one plain
 * sentence and nothing changes. Locking, unlocking, muting, hiding and renaming a track stay allowed, and so does
 * the automatic clean-up of a reference to a deleted clip. Extending, slipping, replacing a clip's source and
 * precomposing keep their own, more specific lock refusals (clipSourceEdits, clipSourceReplacement, precompose_clips).
 */
export const TRACK_LOCKED_MESSAGE = "這個軌道已鎖定，先解鎖才能修改。";

/** Commands that change the clip named by their `clipId` (its timing, picture, sound, effects, masks or keyframes). */
const CLIP_EDITS: ReadonlySet<EditorCommand["type"]> = new Set<EditorCommand["type"]>([
  "split_clip", "delete_clip", "ripple_delete_clip", "move_clip", "move_clip_to_track", "trim_clip_start", "trim_clip_end",
  "set_clip_speed", "set_clip_time_remap",
  "set_clip_volume", "set_clip_audio_envelope", "smart_cut_clip", "update_clip_transform", "update_clip_transform_3d", "set_clip_floating_frame",
  "set_clip_color", "set_clip_creative", "set_clip_grade_v2", "add_native_effect", "update_native_effect", "reorder_native_effect",
  "paste_clip_grade_v1",
  "remove_native_effect", "set_clip_layout", "add_clip_mask", "update_clip_mask", "delete_clip_mask", "set_clip_mask_track",
  "set_clip_mask_keyframe", "freeze_clip_mask_range", "set_clip_chroma_key", "set_clip_layer", "set_clip_expression",
  "add_keyframe", "update_keyframe", "delete_keyframe",
]);

const CAPTION_EDITS: ReadonlySet<EditorCommand["type"]> = new Set<EditorCommand["type"]>(["add_caption", "update_caption", "delete_caption"]);

export function trackOfClip(project: Pick<EditProject, "tracks">, clipId: string): TimelineTrack | undefined {
  return project.tracks.find(track => track.clips.some(clip => clip.id === clipId));
}

/** Captions live on the 字幕 track: when it is locked, captions stay as they are. */
export function captionTrackLocked(project: Pick<EditProject, "tracks">): boolean {
  return project.tracks.some(track => track.kind === "caption" && track.locked);
}

/** Why `command` (never a batch) may not change `project`, or undefined when no locked track is involved. */
export function lockedTrackRefusal(project: Pick<EditProject, "tracks" | "timelineTransitions"> & Partial<Pick<EditProject, "scene3d" | "motionTracks">>, command: EditorCommand): string | undefined {
  if (command.type === "add_motion_track") return trackOfClip(project, command.track.clipId)?.locked ? TRACK_LOCKED_MESSAGE : undefined;
  if (command.type === "set_motion_track_point" || command.type === "delete_motion_track") {
    const tracked = project.motionTracks?.find(track => track.id === command.trackId);
    if (tracked && trackOfClip(project, tracked.clipId)?.locked) return TRACK_LOCKED_MESSAGE;
    if (command.type === "delete_motion_track" && project.tracks.some(track => track.locked
      && track.clips.some(clip => clip.masks?.some(mask => mask.trackId === command.trackId)))) return TRACK_LOCKED_MESSAGE;
  }
  if (command.type === "set_mesh_3d_scene" && JSON.stringify(command.scene) !== JSON.stringify(project.scene3d)) {
    const clips = new Set([project.scene3d, command.scene].flatMap(scene => scene ? [
      ...scene.segments.flatMap(s => s.objects.flatMap(o => o.material.clipId ? [o.material.clipId] : [])),
      ...scene.overlaysV1?.layers.map(l => l.clipId) ?? [],
    ] : []));
    if (project.tracks.some(t => t.locked && t.clips.some(c => clips.has(c.id)))) return TRACK_LOCKED_MESSAGE;
  }
  if (command.type === "set_timeline_transition") {
    const t = command.transition;
    return project.tracks.some(track => track.locked && (track.id === t.trackId || track.clips.some(clip => clip.id === t.fromClipId || clip.id === t.toClipId))) ? TRACK_LOCKED_MESSAGE : undefined;
  }
  if (command.type === "delete_timeline_transition") {
    const t = project.timelineTransitions?.find(t => t.id === command.transitionId);
    return t && project.tracks.find(track => track.id === t.trackId)?.locked ? TRACK_LOCKED_MESSAGE : undefined;
  }
  if (CLIP_EDITS.has(command.type) && "clipId" in command) {
    if (trackOfClip(project, command.clipId)?.locked) return TRACK_LOCKED_MESSAGE;
    if (command.type === "move_clip_to_track" && project.tracks.find(track => track.id === command.trackId)?.locked) return TRACK_LOCKED_MESSAGE;
    return undefined;
  }
  if (command.type === "add_clip") return project.tracks.find(track => track.id === command.clip.trackId)?.locked ? TRACK_LOCKED_MESSAGE : undefined;
  if (command.type === "compact_track") return project.tracks.find(track => track.id === command.trackId)?.locked ? TRACK_LOCKED_MESSAGE : undefined;
  if (CAPTION_EDITS.has(command.type)) return captionTrackLocked(project) ? TRACK_LOCKED_MESSAGE : undefined;
  return undefined;
}

export function assertTrackUnlockedFor(project: Pick<EditProject, "tracks" | "timelineTransitions"> & Partial<Pick<EditProject, "scene3d" | "motionTracks">>, command: EditorCommand): void {
  const refusal = lockedTrackRefusal(project, command);
  if (refusal) throw new EditGraphError(refusal);
}
