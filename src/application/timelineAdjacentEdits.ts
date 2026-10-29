import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { findClip, findTrack, validateProject } from "../domain/editGraph";
import { EditGraphError } from "../domain/editGraphError";
import { clipSourceEditBlocker, clipSourceWindow, isTemplateManagedClip } from "../domain/clipSourceEdits";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject, TimelineClip, TimelineTrack } from "../domain/types";
import { clipAttachments, editTouchesTemplates } from "./timelineMotionEdits";
import { planTimelineAssetInsert, timelineAssetDuration, type TimelinePlacementIdFactory } from "./timelinePlacement";

export const ADJACENT_TEMPLATE_REFUSAL = "這次剪輯會影響標題模板，尚未能安全重排；原專案保持不變。";
export const ADJACENT_REQUIRED = "這項操作需要同軌道上沒有空隙的相鄰片段。";
export const ROLL_LIMIT = "已到兩側素材的可用極限，總長度保持不變。";
export const SLIDE_LIMIT = "鄰居沒有足夠的素材可供滑動，片段保持原位。";
export const INSERT_DONE = "已插入素材，後面內容一起往後移；一次復原即可還原。";
export const OVERWRITE_DONE = "已覆寫這段畫面，後面內容保持原位；一次復原即可還原。";
export const ROLL_DONE = "已一起調整兩段的剪接點，總長度不變；一次復原即可還原。";
export const SLIDE_DONE = "已滑動片段並修剪鄰居，片段內容不變；一次復原即可還原。";
const frame = (project: EditProject, time: number) => Math.round(time * project.fps);
const endFrame = (project: EditProject, clip: TimelineClip) => frame(project, clip.timelineStart) + frame(project, clip.duration);

function clock(project: EditProject): void {
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw new EditGraphError("專案影格率無效，無法調整片段。");
}
function unlocked(track: TimelineTrack): void {
  if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
}
function safeTemplates(project: EditProject, commands: EditorCommand[]): void {
  if (project.templateApplication || commands.some(command => "clipId" in command && isTemplateManagedClip(project, command.clipId))
    || editTouchesTemplates(project, commands)) throw new EditGraphError(ADJACENT_TEMPLATE_REFUSAL);
}
function finish(project: EditProject, commands: EditorCommand[]): EditorCommand {
  safeTemplates(project, commands);
  const command: EditorCommand = { type: "batch", commands };
  applyCommand(project, command);
  return command;
}

/** Stable earlier-cut tie break; the whole main track, not just the visible viewport. */
export function nearestTimelineCut(track: Pick<TimelineTrack, "clips">, time: number, fps: number): number {
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(fps) || fps <= 0) throw new EditGraphError("指定落點必須是有效的時間。");
  const cuts = [...new Set([0, ...track.clips.flatMap(clip => [Math.round(clip.timelineStart * fps), Math.round((clip.timelineStart + clip.duration) * fps)])])].sort((a, b) => a - b);
  const at = time * fps;
  return cuts.reduce((best, cut) => Math.abs(cut - at) < Math.abs(best - at) ? cut : best, cuts[0]) / fps;
}

export interface AssetEditPlan { command: EditorCommand; message: string; trackId: string; timelineStart: number; newLayer: boolean }
function mainTrack(project: EditProject, trackId: string): TimelineTrack {
  clock(project); validateProject(project);
  const track = findTrack(project, trackId); unlocked(track);
  if (track.id !== "video-main" || track.kind !== "video") throw new EditGraphError("插入或覆寫需要主畫面軌。");
  return track;
}

/** One atomic ripple insert. Locked secondary lanes stay put, as with existing ripple edits. */
export function planInsertClip(project: EditProject, assetId: string, trackId: string, time: number, clipId: string, makeId: TimelinePlacementIdFactory): AssetEditPlan {
  const track = mainTrack(project, trackId), start = nearestTimelineCut(track, time, project.fps);
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || asset.kind === "audio") throw new EditGraphError("請把影片或圖片放到主畫面軌。");
  const duration = timelineAssetDuration(asset, project.fps), delta = frame(project, duration), boundary = frame(project, start);
  if (delta < 1) throw new EditGraphError("素材不足一個專案影格，無法加入時間軸。");
  const commands: EditorCommand[] = [];
  for (const lane of project.tracks.filter(item => !item.locked && item.kind !== "caption")) {
    for (const clip of lane.clips.filter(item => frame(project, item.timelineStart) >= boundary)) {
      commands.push({ type: "move_clip", clipId: clip.id, timelineStart: (frame(project, clip.timelineStart) + delta) / project.fps });
    }
  }
  if (!captionTrackLocked(project)) for (const caption of project.captions.filter(item => frame(project, item.start) >= boundary)) {
    commands.push({ type: "update_caption", captionId: caption.id, patch: { start: (frame(project, caption.start) + delta) / project.fps } });
  }
  for (const graphic of project.motionGraphics.filter(item => frame(project, item.timelineStart) >= boundary)) {
    if (project.motionScenes?.some(scene => scene.graphicIds.includes(graphic.id))) throw new EditGraphError(ADJACENT_TEMPLATE_REFUSAL);
    commands.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: (frame(project, graphic.timelineStart) + delta) / project.fps } });
  }
  for (const marker of project.director.markers.filter(item => frame(project, item.time) >= boundary)) {
    commands.push({ type: "update_director_marker", markerId: marker.id, patch: { time: (frame(project, marker.time) + delta) / project.fps } });
  }
  safeTemplates(project, commands);
  const staged = commands.length ? applyCommand(project, { type: "batch", commands }) : project;
  const insert = planTimelineAssetInsert(staged, assetId, trackId, start, clipId, makeId);
  if (insert.newLayer) throw new EditGraphError("插入點沒有足夠空間，素材未加入。");
  commands.push(insert.command);
  return { command: finish(project, commands), message: INSERT_DONE, trackId, timelineStart: start, newLayer: false };
}

/** Replace only the main-track interval. Splits use the real visual/mask/keyframe slicer. */
export function planOverwriteClip(project: EditProject, assetId: string, trackId: string, time: number, clipId: string, makeId: TimelinePlacementIdFactory): AssetEditPlan {
  const track = mainTrack(project, trackId);
  if (!Number.isFinite(time) || time < 0 || !Number.isSafeInteger(Math.round(time * project.fps))) throw new EditGraphError("指定落點必須是有效的時間。");
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || asset.kind === "audio") throw new EditGraphError("請把影片或圖片放到主畫面軌。");
  const from = frame(project, time), duration = timelineAssetDuration(asset, project.fps), to = from + frame(project, duration);
  if (to <= from) throw new EditGraphError("素材不足一個專案影格，無法加入時間軸。");
  const commands: EditorCommand[] = [];
  for (const clip of track.clips) {
    const start = frame(project, clip.timelineStart), end = endFrame(project, clip);
    if (end <= from || start >= to) continue;
    if (isTemplateManagedClip(project, clip.id)) throw new EditGraphError(ADJACENT_TEMPLATE_REFUSAL);
    if (start < from && end > to) {
      const middleId = makeId("overwrite-cut"), tailId = makeId("overwrite-tail");
      commands.push({ type: "split_clip", clipId: clip.id, at: from / project.fps, newClipId: middleId },
        { type: "split_clip", clipId: middleId, at: to / project.fps, newClipId: tailId }, { type: "delete_clip", clipId: middleId });
    } else if (start < from) commands.push({ type: "trim_clip_end", clipId: clip.id, seconds: (end - from) / project.fps });
    else if (end > to) commands.push({ type: "trim_clip_start", clipId: clip.id, seconds: (to - start) / project.fps },
      { type: "move_clip", clipId: clip.id, timelineStart: to / project.fps });
    else commands.push({ type: "delete_clip", clipId: clip.id });
  }
  safeTemplates(project, commands);
  const staged = commands.length ? applyCommand(project, { type: "batch", commands }) : project;
  const insert = planTimelineAssetInsert(staged, assetId, trackId, from / project.fps, clipId, makeId);
  if (insert.newLayer) throw new EditGraphError("覆寫範圍仍有片段，素材未加入。");
  commands.push(insert.command);
  return { command: finish(project, commands), message: OVERWRITE_DONE, trackId, timelineStart: from / project.fps, newLayer: false };
}

export interface AdjacentLimits { left: TimelineClip; right: TimelineClip; minimum: number; maximum: number }
/** No cloning/command dispatch: pointer preview reads these same integer handle limits. */
export function rollEditLimits(project: EditProject, leftId: string, rightId: string): AdjacentLimits {
  clock(project);
  const left = findClip(project, leftId), right = findClip(project, rightId), track = findTrack(project, left.trackId);
  unlocked(track);
  if (right.trackId !== left.trackId || endFrame(project, left) !== frame(project, right.timelineStart)) throw new EditGraphError(ADJACENT_REQUIRED);
  for (const clip of [left, right]) {
    if (isTemplateManagedClip(project, clip.id)) throw new EditGraphError(ADJACENT_TEMPLATE_REFUSAL);
    const blocker = clipSourceEditBlocker(project, clip.id, "extend"); if (blocker) throw new EditGraphError(blocker);
  }
  const leftWindow = clipSourceWindow(project, leftId)!, rightWindow = clipSourceWindow(project, rightId)!;
  return { left, right, minimum: -Math.min(frame(project, left.duration) - 1, rightWindow.headFrames),
    maximum: Math.min(leftWindow.tailFrames, frame(project, right.duration) - 1) };
}
export interface AdjacentEditPlan { command: EditorCommand; message: string; deltaFrames: number; limited: boolean; clipIds: string[] }
function requestedFrames(frames: number): void {
  if (!Number.isSafeInteger(frames)) throw new EditGraphError("調整長度必須是有效的整數影格。");
}
function cutCommands(project: EditProject, limits: AdjacentLimits, delta: number): EditorCommand[] {
  const { left, right } = limits, seconds = Math.abs(delta) / project.fps;
  return delta > 0 ? [
    { type: "trim_clip_start", clipId: right.id, seconds },
    { type: "move_clip", clipId: right.id, timelineStart: (frame(project, right.timelineStart) + delta) / project.fps },
    { type: "extend_clip", clipId: left.id, edge: "end", seconds },
  ] : [
    { type: "trim_clip_end", clipId: left.id, seconds },
    { type: "extend_clip", clipId: right.id, edge: "start", seconds },
  ];
}
/** A shared cut moves; the outer anchors, total duration, and following clips do not. */
export function planRollEdit(project: EditProject, leftId: string, rightId: string, frames: number): AdjacentEditPlan | undefined {
  requestedFrames(frames); const limits = rollEditLimits(project, leftId, rightId);
  if (!frames) return undefined;
  const delta = Math.max(limits.minimum, Math.min(limits.maximum, frames)), limited = delta !== frames;
  if (!delta) throw new EditGraphError(ROLL_LIMIT);
  const command = finish(project, cutCommands(project, limits, delta));
  return { command, message: limited ? `${ROLL_DONE} ${ROLL_LIMIT}` : ROLL_DONE, deltaFrames: delta, limited, clipIds: [leftId, rightId] };
}

export interface SlideLimits { previous: TimelineClip; clip: TimelineClip; next: TimelineClip; minimum: number; maximum: number }
/**
 * The clip touches a clip on both sides of its track (on the frame grid): the one place an Alt-drag slides it between its
 * neighbours. Anywhere else the same Alt-drag picks a new in-point (slip) instead of being refused.
 */
export function clipBetweenNeighbours(project: EditProject, clipId: string): boolean {
  if (!Number.isFinite(project.fps) || project.fps <= 0) return false;
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  if (!track) return false;
  const ordered = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), index = ordered.findIndex(item => item.id === clipId);
  const previous = ordered[index - 1], clip = ordered[index], next = ordered[index + 1];
  return Boolean(previous && next && endFrame(project, previous) === frame(project, clip.timelineStart)
    && endFrame(project, clip) === frame(project, next.timelineStart));
}
export function slideEditLimits(project: EditProject, clipId: string): SlideLimits {
  clock(project); const clip = findClip(project, clipId), track = findTrack(project, clip.trackId); unlocked(track);
  const ordered = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), index = ordered.findIndex(item => item.id === clipId);
  const previous = ordered[index - 1], next = ordered[index + 1];
  if (!previous || !next || endFrame(project, previous) !== frame(project, clip.timelineStart)
    || endFrame(project, clip) !== frame(project, next.timelineStart)) throw new EditGraphError(ADJACENT_REQUIRED);
  for (const item of [previous, clip, next]) if (isTemplateManagedClip(project, item.id)) throw new EditGraphError(ADJACENT_TEMPLATE_REFUSAL);
  for (const item of [previous, next]) { const blocker = clipSourceEditBlocker(project, item.id, "extend"); if (blocker) throw new EditGraphError(blocker); }
  return { previous, clip, next, minimum: -Math.min(frame(project, previous.duration) - 1, clipSourceWindow(project, next.id)!.headFrames),
    maximum: Math.min(clipSourceWindow(project, previous.id)!.tailFrames, frame(project, next.duration) - 1) };
}
/** The middle content stays unchanged; only the neighbours' facing edges are trimmed/extended. */
export function planSlideEdit(project: EditProject, clipId: string, frames: number): AdjacentEditPlan | undefined {
  requestedFrames(frames); const { previous, clip, next, minimum, maximum } = slideEditLimits(project, clipId);
  if (!frames) return undefined;
  if (frames < minimum || frames > maximum) throw new EditGraphError(SLIDE_LIMIT);
  const seconds = Math.abs(frames) / project.fps, move: EditorCommand = { type: "move_clip", clipId, timelineStart: (frame(project, clip.timelineStart) + frames) / project.fps };
  const commands: EditorCommand[] = frames > 0 ? [
    { type: "trim_clip_start", clipId: next.id, seconds }, { type: "move_clip", clipId: next.id, timelineStart: (frame(project, next.timelineStart) + frames) / project.fps },
    move, { type: "extend_clip", clipId: previous.id, edge: "end", seconds },
  ] : [{ type: "trim_clip_end", clipId: previous.id, seconds }, move, { type: "extend_clip", clipId: next.id, edge: "start", seconds }];
  const attached = clipAttachments(project, clipId);
  if (attached.captions.length && captionTrackLocked(project)) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  for (const caption of attached.captions) commands.push({ type: "update_caption", captionId: caption.id, patch: { start: (frame(project, caption.start) + frames) / project.fps } });
  for (const graphic of attached.graphics) commands.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: (frame(project, graphic.timelineStart) + frames) / project.fps } });
  return { command: finish(project, commands), message: SLIDE_DONE, deltaFrames: frames, limited: false, clipIds: [previous.id, clipId, next.id] };
}
