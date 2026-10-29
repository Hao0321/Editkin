import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { liftAttachments } from "../domain/rippleDelete";
import { isTemplateManagedClip } from "../domain/clipSourceEdits";
import type { TimelineSelectionEditPlan } from "./timelineSelectionEdits";


export const RIPPLE_TEMPLATE_REFUSAL = "這次波紋調整會影響標題模板，還不能安全重排；原專案保持不變。";
export const RIPPLE_TRIM_DONE = "已波紋修剪片段，後面內容一起移動；一次復原即可還原。";
export const CLOSE_GAP_DONE = "已刪除這個空隙，後面內容一起移動；一次復原即可還原。";
export const NO_GAP = "這裡沒有可以刪除的空隙。";
const frame = (project: EditProject, time: number) => Math.round(time * project.fps);

/** Only later items on an unlocked track move. A spanning item stays; final validation rejects a new collision. */
function shiftAfter(project: EditProject, trackId: string, boundary: number, delta: number, exclude?: string): EditorCommand[] {
  const main = trackId === "video-main", commands: EditorCommand[] = [];
  for (const track of project.tracks.filter(track => !track.locked && (main || track.id === trackId))) {
    for (const clip of track.clips.filter(clip => clip.id !== exclude && frame(project, clip.timelineStart) >= boundary)) {
      commands.push({ type: "move_clip", clipId: clip.id, timelineStart: (frame(project, clip.timelineStart) + delta) / project.fps });
    }
  }
  if (main) {
    if (!captionTrackLocked(project)) for (const caption of project.captions.filter(item => frame(project, item.start) >= boundary)) {
      commands.push({ type: "update_caption", captionId: caption.id, patch: { start: (frame(project, caption.start) + delta) / project.fps } });
    }
    for (const graphic of project.motionGraphics.filter(item => frame(project, item.timelineStart) >= boundary)) {
      commands.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: (frame(project, graphic.timelineStart) + delta) / project.fps } });
    }
    for (const marker of project.director.markers.filter(item => frame(project, item.time) >= boundary)) {
      commands.push({ type: "update_director_marker", markerId: marker.id, patch: { time: (frame(project, marker.time) + delta) / project.fps } });
    }
  }
  return commands;
}
function finish(project: EditProject, commands: EditorCommand[], message: string): TimelineSelectionEditPlan {
  const owned = new Set((project.referenceMotionInstances ?? []).flatMap(instance => instance.roles.map(role => role.id)));
  if (project.templateApplication || commands.some(command => "clipId" in command && isTemplateManagedClip(project, command.clipId)
    || "graphicId" in command && owned.has(command.graphicId) || "captionId" in command && owned.has(command.captionId))) throw new Error(RIPPLE_TEMPLATE_REFUSAL);
  const command: EditorCommand = { type: "batch", commands };
  applyCommand(project, command);
  return { command, message };
}

/** Shrink an edge on the frame grid. Start trimming changes the source in-point while retaining the timeline anchor. */
export function planRippleTrim(project: EditProject, clipId: string, edge: "start" | "end", seconds: number): TimelineSelectionEditPlan | undefined {
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId)), clip = track?.clips.find(item => item.id === clipId);
  if (!track || !clip) throw new Error("找不到這個片段，請重新選取。");
  if (track.locked) throw new Error(TRACK_LOCKED_MESSAGE);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("修剪長度必須是有效的正數。");
  const trim = frame(project, seconds), length = frame(project, clip.duration);
  if (!trim) return undefined;
  if (trim >= length) throw new Error("片段至少要保留一幀，請少修剪一點。");
  const start = frame(project, clip.timelineStart), end = start + length;
  const commands: EditorCommand[] = [{ type: edge === "start" ? "trim_clip_start" : "trim_clip_end", clipId, seconds: trim / project.fps },
    ...shiftAfter(project, track.id, end, -trim, clipId)];
  const ids = liftAttachments(project, clipId);
  const attached = { captions: project.captions.filter(item => ids.captionIds.includes(item.id)), graphics: project.motionGraphics.filter(item => ids.graphicIds.includes(item.id)) };
  if (project.motionTracks.some(item => item.clipId === clipId) || attached.graphics.some(item => item.trackId)) {
    throw new Error("這段有追蹤內容，尚未能安全波紋修剪；原專案保持不變。");
  }
  const retainedStart = edge === "start" ? start + trim : start, retainedEnd = edge === "end" ? end - trim : end;
  const shift = edge === "start" ? -trim : 0;
  if (!captionTrackLocked(project)) for (const caption of attached.captions) {
    const from = Math.max(frame(project, caption.start), retainedStart), to = Math.min(frame(project, caption.start + caption.duration), retainedEnd);
    commands.push(to <= from ? { type: "delete_caption", captionId: caption.id }
      : { type: "update_caption", captionId: caption.id, patch: { start: (from + shift) / project.fps, duration: (to - from) / project.fps } });
  }
  for (const graphic of attached.graphics) {
    const from = Math.max(frame(project, graphic.timelineStart), retainedStart), to = Math.min(frame(project, graphic.timelineStart + graphic.duration), retainedEnd);
    commands.push(to <= from ? { type: "delete_motion_graphic", graphicId: graphic.id }
      : { type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: (from + shift) / project.fps, duration: (to - from) / project.fps } });
  }
  return finish(project, commands, RIPPLE_TRIM_DONE);
}

/** Close just the pointed gap (including a leading gap), never compact unrelated earlier gaps. */
export function planCloseGap(project: EditProject, trackId: string, time: number): TimelineSelectionEditPlan {
  const track = project.tracks.find(item => item.id === trackId);
  if (!track) throw new Error(NO_GAP);
  if (track.locked) throw new Error(TRACK_LOCKED_MESSAGE);
  const at = frame(project, time), intervals = (track.kind === "caption" ? project.captions.map(item => ({ start: item.start, duration: item.duration })) : track.clips.map(item => ({ start: item.timelineStart, duration: item.duration })))
    .map(item => ({ start: frame(project, item.start), end: frame(project, item.start + item.duration) })).sort((a, b) => a.start - b.start);
  if (intervals.some(item => at >= item.start && at < item.end)) throw new Error(NO_GAP);
  const next = intervals.find(item => item.start > at), previousEnd = Math.max(0, ...intervals.filter(item => item.end <= at).map(item => item.end));
  if (!next || next.start <= previousEnd) throw new Error(NO_GAP);
  const delta = previousEnd - next.start;
  const commands: EditorCommand[] = track.kind === "caption"
    ? project.captions.filter(item => frame(project, item.start) >= next.start).map(item => ({ type: "update_caption", captionId: item.id, patch: { start: (frame(project, item.start) + delta) / project.fps } }))
    : shiftAfter(project, trackId, next.start, delta);
  return finish(project, commands, CLOSE_GAP_DONE);
}


