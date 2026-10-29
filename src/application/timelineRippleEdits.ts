import type { EditorCommand } from "../domain/commandTypes";
export { planCloseGap, planRippleTrim } from "./timelineCanvasEdits";
export { planInsertClip, planOverwriteClip, planRollEdit, planSlideEdit } from "./timelineAdjacentEdits";
import { applyCommand } from "../domain/commands";
import { EditGraphError } from "../domain/editGraphError";
import { applyRippleDelete, liftAttachments, type RippleDeleteOutcome } from "../domain/rippleDelete";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject } from "../domain/types";
import { findSplitTarget } from "./timelineSplitTarget";
import { expandLinkedClipIds, linkedClipRepresentative } from "../domain/clipLinks";
import { applyLinkedRippleDelete } from "../domain/linkedClipCommands";

/**
 * Ripple editing planners (timeline seam S2): pure functions from a project to ONE command (one Undo) and the plain
 * status line. Callers that may change a saved title template wrap the command in runTemplateFollowGesture /
 * planEditCommandsWithTemplates, exactly like the editor's other gestures.
 *
 * planRippleDelete is the editor's Delete (and an agent's ripple_delete_clip, which runs the same domain rule,
 * domain/rippleDelete.ts): 主畫面 closes the gap; captions, free titles and markers inside the clip go with it and a
 * partly covered one is trimmed; what comes after moves up with 主畫面; other picture and sound tracks move up only when
 * nothing would land on another clip, otherwise they stay and the status says so. It never fails for overlap and never
 * deletes picture or sound on another track. With `lift` the clips are deleted and the gap stays (nothing else moves).
 */

export const RIPPLE_DONE = "已刪除片段並自動補上空隙";
export const RIPPLE_DONE_MANY = "已刪除 {count} 段片段並自動補上空隙";
export const RIPPLE_TEMPLATE_DONE = "已刪除片段和上面的標題模板「{title}」，並自動補上空隙";
export const LIFT_DONE = "已刪除片段，空隙保留在原處";
export const LIFT_DONE_MANY = "已刪除 {count} 段片段，空隙保留在原處";
export const LIFT_TEMPLATE_DONE = "已刪除片段和上面的標題模板「{title}」，空隙保留在原處";
export const RIPPLE_UNDO = "復原一次即可完整還原。";

/** One plain note, the most important first. */
export const RIPPLE_NOTES = {
  heldAudio: "其他軌道的聲音沒有跟著移動，避免重疊",
  heldVideo: "其他軌道的畫面沒有跟著移動，避免重疊",
  heldBoth: "其他軌道的畫面和聲音沒有跟著移動，避免重疊",
  locked: "鎖定的軌道沒有跟著移動",
  captionsLocked: "字幕軌已鎖定，字幕保留不動",
  attachments: "片段上的字幕和標題也一起刪除或修短",
  liftAttachments: "片段上的字幕和標題也一起刪除",
} as const;

export interface RippleEditPlan {
  command: EditorCommand;
  /** The status line; it always names the single Undo. */
  message: string;
  /** What happened to the clips, without the note and the Undo words (for a caller that adds its own words). */
  done: string;
  /** The one plain note about what did not move or what went with the clip, when there is one. */
  note?: string;
  /** What each ripple did, in the order its commands run (right to left). Empty for a lift. */
  outcomes: RippleDeleteOutcome[];
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (token, name: string) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token);
}

/** The status line from its parts: `done；note；復原一次即可完整還原。` */
export function rippleMessage(done: string, note?: string): string {
  return note ? `${done}；${note}；${RIPPLE_UNDO}` : `${done}；${RIPPLE_UNDO}`;
}

function noteFor(outcomes: readonly RippleDeleteOutcome[]): string | undefined {
  const overlap = outcomes.flatMap(outcome => outcome.heldTracks.filter(track => track.reason === "overlap"));
  const audio = overlap.some(track => track.kind === "audio"), video = overlap.some(track => track.kind === "video");
  if (audio && video) return RIPPLE_NOTES.heldBoth;
  if (audio) return RIPPLE_NOTES.heldAudio;
  if (video) return RIPPLE_NOTES.heldVideo;
  if (outcomes.some(outcome => outcome.heldTracks.some(track => track.reason === "locked"))) return RIPPLE_NOTES.locked;
  if (outcomes.some(outcome => outcome.captionsLocked)) return RIPPLE_NOTES.captionsLocked;
  if (outcomes.some(outcome => outcome.removedCaptionIds.length || outcome.trimmedCaptionIds.length || outcome.removedGraphicIds.length
    || outcome.trimmedGraphicIds.length)) return RIPPLE_NOTES.attachments;
  return undefined;
}

/** The clips in right-to-left order: deleting a later clip first never moves an earlier one. */
function rightToLeft(project: EditProject, clipIds: readonly string[]): string[] {
  const clips = new Map(project.tracks.flatMap(track => track.clips.map(clip => [clip.id, clip] as const)));
  const unique = [...new Set(clipIds)];
  for (const id of unique) if (!clips.has(id)) throw new EditGraphError("找不到這個片段，請重新選取。");
  return unique.sort((left, right) => clips.get(right)!.timelineStart - clips.get(left)!.timelineStart);
}

function templateTitle(project: EditProject, outcomes: readonly RippleDeleteOutcome[]): string | undefined {
  const id = outcomes.flatMap(outcome => outcome.removedTemplateIds)[0];
  return id === undefined ? undefined : project.referenceMotionInstances?.find(instance => instance.id === id)?.input.title;
}

/**
 * Delete `clipIds` as one command. Throws the plain refusal (a locked track, a missing clip) before anything changes.
 */
export function planRippleDelete(project: EditProject, clipIds: readonly string[], options: { lift?: boolean } = {}): RippleEditPlan {
  if (!clipIds.length) throw new EditGraphError("請先選取要刪除的片段。");
  const ordered = rightToLeft(project, options.lift ? expandLinkedClipIds(project, clipIds)
    : [...new Set(clipIds.map(id => linkedClipRepresentative(project, id)))]);
  if (options.lift) return planLift(project, ordered);
  const commands: EditorCommand[] = ordered.map(clipId => ({ type: "ripple_delete_clip", clipId }));
  const command: EditorCommand = commands.length === 1 ? commands[0] : { type: "batch", commands };
  // The outcomes come from the same domain rule the command runs, on a copy; applyCommand then proves it is accepted.
  const working = structuredClone(project);
  const outcomes = ordered.map(clipId => applyLinkedRippleDelete(working, clipId));
  applyCommand(project, command);
  const title = templateTitle(project, outcomes);
  const done = title !== undefined && ordered.length === 1 ? fill(RIPPLE_TEMPLATE_DONE, { title })
    : ordered.length > 1 ? fill(RIPPLE_DONE_MANY, { count: ordered.length }) : RIPPLE_DONE;
  const note = noteFor(outcomes);
  return { command, message: rippleMessage(done, note), done, note, outcomes };
}

function planLift(project: EditProject, ordered: readonly string[]): RippleEditPlan {
  const commands: EditorCommand[] = [];
  // A locked 字幕 track keeps its captions, as a ripple does.
  const captionsLocked = captionTrackLocked(project);
  let attachments = false, keptCaptions = false, title: string | undefined;
  for (const clipId of ordered) {
    const attached = liftAttachments(project, clipId);
    for (const template of attached.templates) {
      title ??= template.title;
      for (const graphicId of template.graphicIds) commands.push({ type: "delete_motion_graphic", graphicId });
      for (const generated of template.clipIds) commands.push({ type: "delete_clip", clipId: generated });
      for (const trackId of template.trackIds) {
        const track = project.tracks.find(item => item.id === trackId);
        if (track && track.clips.every(clip => template.clipIds.includes(clip.id)) && track.kind !== "caption") commands.push({ type: "delete_track", trackId });
      }
      commands.push({ type: "remove_reference_motion_instance", id: template.id, expectedInstanceRevision: template.instanceRevision });
    }
    for (const graphicId of attached.graphicIds) commands.push({ type: "delete_motion_graphic", graphicId });
    if (captionsLocked) keptCaptions ||= attached.captionIds.length > 0;
    else for (const captionId of attached.captionIds) commands.push({ type: "delete_caption", captionId });
    attachments ||= attached.graphicIds.length > 0 || (!captionsLocked && attached.captionIds.length > 0);
    commands.push({ type: "delete_clip", clipId });
  }
  const command: EditorCommand = commands.length === 1 ? commands[0] : { type: "batch", commands };
  applyCommand(project, command);
  const done = title !== undefined && ordered.length === 1 ? fill(LIFT_TEMPLATE_DONE, { title })
    : ordered.length > 1 ? fill(LIFT_DONE_MANY, { count: ordered.length }) : LIFT_DONE;
  const note = keptCaptions ? RIPPLE_NOTES.captionsLocked : attachments ? RIPPLE_NOTES.liftAttachments : undefined;
  return { command, message: rippleMessage(done, note), done, note, outcomes: [] };
}

/** Q and W: what happened, what is said when there is nothing to delete. */
export const DELETE_LEFT_DONE = "已刪掉播放頭左邊的部分並補上空隙";
export const DELETE_RIGHT_DONE = "已刪掉播放頭右邊的部分並補上空隙";
export const DELETE_LEFT_TEMPLATE_DONE = "已刪掉播放頭左邊的部分和上面的標題模板「{title}」，並補上空隙";
export const DELETE_RIGHT_TEMPLATE_DONE = "已刪掉播放頭右邊的部分和上面的標題模板「{title}」，並補上空隙";
export const DELETE_SIDE_NOTHING_HERE = "播放頭要在片段中間，才能用 Q／W 刪掉左邊或右邊。";

export interface DeleteToPlayheadPlan extends RippleEditPlan {
  /** The two commands of `command`, for a caller that lets saved title templates follow them. */
  edit: EditorCommand[];
  /** The clip that was cut, where it started, and the piece of it that stays. */
  clipId: string;
  start: number;
  keptClipId: string;
}

/**
 * Q (left) and W (right): the part of a clip before or after the playhead goes and the gap closes, as ONE command: the
 * editor's split at the playhead, then the overlap-safe ripple delete of that piece (planRippleDelete, so captions,
 * titles and other tracks follow the same rules as Delete). The clip is the one Ctrl+B cuts (findSplitTarget): the
 * selected one when the playhead is inside it, otherwise the one under the playhead on the selected clip's track, then on
 * 主畫面, then on the topmost unlocked track. Throws the plain refusal before anything changes.
 */
export function planDeleteToPlayhead(project: EditProject, playhead: number, selectedClipId: string | undefined, side: "left" | "right",
  newClipId: string): DeleteToPlayheadPlan {
  // The same clip Ctrl+B (切開) would cut: Q and W are a cut plus a ripple delete of one side.
  const found = findSplitTarget(project, playhead, selectedClipId);
  if (!("target" in found)) throw new EditGraphError(found.refusal === TRACK_LOCKED_MESSAGE ? TRACK_LOCKED_MESSAGE : DELETE_SIDE_NOTHING_HERE);
  const target = found.target;
  if (target.track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  const split: EditorCommand = { type: "split_clip", clipId: target.clip.id, at: playhead, newClipId };
  const pieceId = side === "left" ? target.clip.id : newClipId;
  const pieces = applyCommand(project, split);
  const ripple = planRippleDelete(pieces, [pieceId]);
  const edit = [split, ripple.command];
  const command: EditorCommand = { type: "batch", commands: edit };
  applyCommand(project, command);
  // The piece that goes may carry the clip's title template (the template goes with it, as with Delete): say so.
  const title = templateTitle(pieces, ripple.outcomes);
  const done = title === undefined ? side === "left" ? DELETE_LEFT_DONE : DELETE_RIGHT_DONE
    : fill(side === "left" ? DELETE_LEFT_TEMPLATE_DONE : DELETE_RIGHT_TEMPLATE_DONE, { title });
  return { command, edit, message: rippleMessage(done, ripple.note), done, note: ripple.note, outcomes: ripple.outcomes,
    clipId: target.clip.id, start: target.clip.timelineStart, keptClipId: side === "left" ? newClipId : target.clip.id };
}

export interface RippleDeleteReport {
  clipId: string;
  /** The same plain status line the editor shows for this delete. */
  message: string;
  /** Tracks that stayed where they were, and why ("overlap" or "locked"). */
  heldTracks: RippleDeleteOutcome["heldTracks"];
  removedCaptionIds: string[];
  trimmedCaptionIds: string[];
  removedGraphicIds: string[];
  trimmedGraphicIds: string[];
  removedMarkerIds: string[];
  removedTemplateIds: string[];
}

/**
 * apply_edit_commands: the plain words for each top-level ripple_delete_clip in an agent's command list, in order
 * (each command applies to the result of the ones before it, as apply_edit_commands applies them).
 */
export function rippleDeleteReports(project: EditProject, commands: readonly EditorCommand[]): RippleDeleteReport[] {
  const reports: RippleDeleteReport[] = [];
  let working = project;
  for (const command of commands) {
    if (command.type === "ripple_delete_clip") {
      const outcome = applyRippleDelete(structuredClone(working), command.clipId);
      const title = templateTitle(working, [outcome]);
      reports.push({ clipId: command.clipId, message: rippleMessage(title !== undefined ? fill(RIPPLE_TEMPLATE_DONE, { title }) : RIPPLE_DONE, noteFor([outcome])),
        heldTracks: outcome.heldTracks, removedCaptionIds: outcome.removedCaptionIds, trimmedCaptionIds: outcome.trimmedCaptionIds,
        removedGraphicIds: outcome.removedGraphicIds, trimmedGraphicIds: outcome.trimmedGraphicIds, removedMarkerIds: outcome.removedMarkerIds,
        removedTemplateIds: outcome.removedTemplateIds });
    }
    working = applyCommand(working, command);
  }
  return reports;
}
