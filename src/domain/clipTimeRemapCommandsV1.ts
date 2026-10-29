import { canonicalJson } from "../shared/canonicalJson";
import type { EditorCommand } from "./commandTypes";
import type { EditProject } from "./types";
import { findAsset, findClip, findTrack } from "./editGraph";
import { EditGraphError } from "./editGraphError";
import { isTemplateManagedClip } from "./clipSourceEdits";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { RETIME_TEMPLATE_REFUSAL } from "./clipRetime";
import { clipSpeedSchemaV1, clipTimeRemapSchemaV1, clipTimeRemapExpectedSchemaV1, clipTimeRemapExpectedV1, clipTimeRemapClockV1, clipTimeRemapRenderRefusalV1, hasAuthoredClipTimeRemapV1 } from "./clipTimeRemapV1";

/**
 * Authored speeds and speed curves the export cannot render (clipTimeRemapRenderRefusalV1), top level and inside
 * compositions. validate_project reports these; the commands refuse to create them.
 */
export function clipTimeRemapRenderBlockersV1(project: Pick<EditProject, "tracks" | "compositions" | "fps" | "timelineTransitions" | "motionTracks" | "assets" | "colorManagement">) {
  const top = project.tracks.flatMap(track => track.clips).map(clip => ({ clip, refusal: clipTimeRemapRenderRefusalV1(project, clip) }));
  const nested = project.compositions.flatMap(composition => composition.tracks.flatMap(track => track.clips))
    .map(clip => ({ clip, refusal: clipTimeRemapRenderRefusalV1(project, clip, { nested: true }) }));
  return [...top, ...nested].filter(row => row.refusal).map(row => ({ clipId: row.clip.id, ...row.refusal! }));
}

const timingEdits = new Set<string>(["split_clip", "trim_clip_start", "trim_clip_end", "extend_clip", "slip_clip", "smart_cut_clip", "retime_clip", "replace_clip_source",
  "rebind_reference_motion_clip_source", "roll_edit", "slide_edit", "roll_clip_boundary", "slide_clip"]);
export function assertClipTimeRemapEditSupportedV1(project: EditProject, command: EditorCommand): void {
  if (command.type === "batch") { command.commands.forEach(c => assertClipTimeRemapEditSupportedV1(project, c)); return; }
  if (!timingEdits.has(command.type) || !("clipId" in command)) return;
  const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === command.clipId);
  if (clip && hasAuthoredClipTimeRemapV1(clip)) throw new EditGraphError("CLIP_TIME_REMAP_SOURCE_EDIT_CONSUMER_REQUIRED");
}

export function applyClipTimeRemapCommandV1(project: EditProject, command: EditorCommand): boolean {
  if (command.type !== "set_clip_speed" && command.type !== "set_clip_time_remap") return false;
  const clip = findClip(project, command.clipId), track = findTrack(project, clip.trackId), expected = clipTimeRemapExpectedSchemaV1.parse(command.expected);
  if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  if (canonicalJson(expected) !== canonicalJson(clipTimeRemapExpectedV1(clip))) throw new EditGraphError("CLIP_TIME_REMAP_SOURCE_OR_SETTINGS_CHANGED");
  if (isTemplateManagedClip(project, clip.id) || project.templateApplication || project.referenceMotionInstances?.length) throw new EditGraphError(RETIME_TEMPLATE_REFUSAL);
  const next = structuredClone(clip);
  if (command.type === "set_clip_speed") { if (command.speed === null) delete next.speed; else next.speed = clipSpeedSchemaV1.parse(command.speed); }
  else { if (command.timeRemap === null) delete next.timeRemap; else next.timeRemap = clipTimeRemapSchemaV1.parse(command.timeRemap); }
  clipTimeRemapClockV1(project, next, findAsset(project, clip.assetId));
  // Only what the export renders may be authored (the source-clock cache, render/timeRemapExportV1); clearing is always allowed.
  const refusal = clipTimeRemapRenderRefusalV1(project, next);
  if (refusal) throw new EditGraphError(`${refusal.code}：${refusal.message}`);
  if (next.speed === undefined) delete clip.speed; else clip.speed = next.speed;
  if (next.timeRemap === undefined) delete clip.timeRemap; else clip.timeRemap = next.timeRemap;
  return true;
}
