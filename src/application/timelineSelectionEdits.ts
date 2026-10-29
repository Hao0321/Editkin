import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { EditGraphError } from "../domain/editGraphError";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject, TimelineClip } from "../domain/types";
import { isNativeReferenceMotionPresentation } from "../motion/referenceMotionTemplates";
import { captionClashForMove, clipAttachments, TEMPLATE_NATIVE_PAINT_REFUSAL } from "./timelineMotionEdits";
import { planRippleDelete } from "./timelineRippleEdits";
import { normalizeTimelineSelection, type TimelineSelection } from "./timelineSelection";

export const SELECTION_EMPTY = "請先選取要調整的片段或字幕。";
export const SELECTION_GENERATED = "這段是標題模板產生的畫面，請選取它的原片段，再一起調整。";
export const SELECTION_OVERLAP = "整組移到這裡會和其他片段重疊，請少移一點或換個位置。";
export const SELECTION_TEMPLATE_OVERLAP = "整組移到這裡會和其他標題重疊，模板就不能再改字；請換個位置。";
export const SELECTION_MOVED = "已一起移動選取的片段與字幕；一次復原即可還原。";
export const SELECTION_LIFTED = "已刪除選取的片段與字幕，空隙保留在原處；一次復原即可還原。";
export const SELECTION_DELETED = "已刪除選取的片段與字幕並補上空隙；一次復原即可還原。";
export const SELECTION_CAPTIONS_DELETED = "已刪除選取的字幕；一次復原即可還原。";

export interface TimelineSelectionEditPlan { command: EditorCommand; message: string }

/** A generated template layer is adjusted by its selected main clip, never by a second independent edit. */
function sourceClips(project: EditProject, selection: TimelineSelection): TimelineClip[] {
  const selected = new Set(selection.clipIds);
  const generated = new Map((project.referenceMotionInstances ?? []).flatMap(instance => instance.roles
    .filter(role => role.kind === "clip" && role.id !== instance.input.clipId).map(role => [role.id, instance.input.clipId] as const)));
  for (const id of selected) if (generated.has(id) && !selected.has(generated.get(id)!)) throw new EditGraphError(SELECTION_GENERATED);
  return project.tracks.flatMap(track => track.clips).filter(clip => selected.has(clip.id) && !generated.has(clip.id));
}

/** Explicit captions go first, so a ripple/lift that also removes their holder never deletes a caption twice. */
export function planTimelineSelectionDelete(project: EditProject, selection: TimelineSelection, lift = false): TimelineSelectionEditPlan {
  const current = normalizeTimelineSelection(project, selection), clips = sourceClips(project, current);
  if (!clips.length && !current.captionIds.length) throw new EditGraphError(SELECTION_EMPTY);
  const captions: EditorCommand[] = current.captionIds.map(captionId => ({ type: "delete_caption", captionId }));
  const working = captions.length ? applyCommand(project, { type: "batch", commands: captions }) : project;
  const ripple = clips.length ? planRippleDelete(working, clips.map(clip => clip.id), { lift }) : undefined;
  const commands = [...captions, ...(ripple ? [ripple.command] : [])];
  const command: EditorCommand = { type: "batch", commands };
  applyCommand(project, command);
  return { command, message: !clips.length ? SELECTION_CAPTIONS_DELETED
    : current.captionIds.length ? lift ? SELECTION_LIFTED : SELECTION_DELETED : ripple!.message };
}

/** Every selected item has the same frame delta; at zero, clamp the whole group together and create no empty Undo. */
export function planTimelineSelectionNudge(project: EditProject, selection: TimelineSelection, frames: number): TimelineSelectionEditPlan | undefined {
  if (!Number.isInteger(frames)) throw new EditGraphError("請使用整數影格調整位置。");
  const current = normalizeTimelineSelection(project, selection), clips = sourceClips(project, current);
  if (!clips.length && !current.captionIds.length) throw new EditGraphError(SELECTION_EMPTY);
  if (clips.some(clip => project.tracks.find(track => track.id === clip.trackId)?.locked)) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  const attached = clips.map(clip => clipAttachments(project, clip.id));
  if (attached.some(items => items.instances.some(instance => isNativeReferenceMotionPresentation(instance.input.graphicPresentation)))) {
    throw new EditGraphError(TEMPLATE_NATIVE_PAINT_REFUSAL);
  }
  const captionIds = new Set([...current.captionIds, ...attached.flatMap(items => items.captions.map(caption => caption.id))]);
  const captions = project.captions.filter(caption => captionIds.has(caption.id));
  if (captions.length && captionTrackLocked(project)) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  const frame = (time: number) => Math.round(time * project.fps);
  const earliest = Math.min(...clips.map(clip => frame(clip.timelineStart)), ...captions.map(caption => frame(caption.start)));
  const delta = Math.max(-earliest, frames);
  if (delta === 0) return undefined;
  const clash = captionClashForMove(project, [...captionIds], delta / project.fps);
  if (clash) throw new EditGraphError(clash);
  const graphics = [...new Map(attached.flatMap(items => items.graphics).map(graphic => [graphic.id, graphic])).values()];
  assertTemplateSpace(project, attached.flatMap(items => items.instances), graphics.map(graphic => graphic.id), delta);
  const shift = (time: number) => (frame(time) + delta) / project.fps;
  const commands: EditorCommand[] = [
    ...clips.map(clip => ({ type: "move_clip" as const, clipId: clip.id, timelineStart: shift(clip.timelineStart) })),
    ...captions.map(caption => ({ type: "update_caption" as const, captionId: caption.id, patch: { start: shift(caption.start) } })),
    ...graphics.map(graphic => ({ type: "update_motion_graphic" as const, graphicId: graphic.id, patch: { timelineStart: shift(graphic.timelineStart) } })),
  ];
  const command: EditorCommand = { type: "batch", commands };
  try { applyCommand(project, command); }
  catch (error) {
    if (error instanceof Error && error.message.includes("片段重疊")) throw new EditGraphError(SELECTION_OVERLAP);
    throw error;
  }
  return { command, message: SELECTION_MOVED };
}

/** Preserve the editor's existing rule: a new overlap must not make a saved template uneditable. */
function assertTemplateSpace(project: EditProject, moving: NonNullable<EditProject["referenceMotionInstances"]>, graphicIds: string[], delta: number): void {
  const selected = new Set(moving.map(instance => instance.id));
  const movingGraphics = new Set([...graphicIds, ...moving.flatMap(instance => instance.roles.filter(role => role.kind === "graphic").map(role => role.id))]);
  const frame = (time: number) => Math.round(time * project.fps);
  const overlap = (a: number, b: number, c: number, d: number) => a < d && b > c;
  for (const instance of moving) {
    const from = instance.input.startFrame, end = from + instance.input.durationFrames;
    if (project.motionGraphics.some(graphic => !movingGraphics.has(graphic.id)
      && overlap(from + delta, end + delta, frame(graphic.timelineStart), frame(graphic.timelineStart + graphic.duration))
      && !overlap(from, end, frame(graphic.timelineStart), frame(graphic.timelineStart + graphic.duration)))) throw new EditGraphError(SELECTION_TEMPLATE_OVERLAP);
  }
  for (const graphic of project.motionGraphics.filter(item => graphicIds.includes(item.id))) {
    const from = frame(graphic.timelineStart), end = frame(graphic.timelineStart + graphic.duration);
    if ((project.referenceMotionInstances ?? []).some(instance => !selected.has(instance.id)
      && overlap(from + delta, end + delta, instance.input.startFrame, instance.input.startFrame + instance.input.durationFrames)
      && !overlap(from, end, instance.input.startFrame, instance.input.startFrame + instance.input.durationFrames))) throw new EditGraphError(SELECTION_TEMPLATE_OVERLAP);
  }
}
