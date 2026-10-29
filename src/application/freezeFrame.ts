import type { EditorCommand } from "../domain/commandTypes";
import { alignTime, animatedClipState, findClip, findTrack } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { isTemplateManagedClip } from "../domain/clipSourceEdits";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";

export const FREEZE_TEMPLATE_REFUSAL = "這次定格會影響標題模板，尚未能安全重排；原專案保持不變。";
export const FREEZE_TRACKING_REFUSAL = "這段有追蹤資料，尚未能安全插入定格；原專案保持不變。";
export const FREEZE_PLAYHEAD_REFUSAL = "播放頭要在選取的影片片段內，才能定格。";
export const FREEZE_DONE = "已插入 2 秒定格並推後內容；復原一次即可完整還原。";

/** Existing command batch: one still asset, an optional split, the ripple and the still clip enter one Undo. */
export function planFreezeFrame(project: EditProject, clipId: string, playhead: number, asset: MediaAsset, ids: { still: string; right: string }) {
  const clip = findClip(project, clipId), track = findTrack(project, clip.trackId);
  const at = alignTime(playhead, project.fps), duration = alignTime(2, project.fps);
  if (track.locked) throw new Error(TRACK_LOCKED_MESSAGE);
  if (track.kind !== "video" || asset.kind !== "image" || at < clip.timelineStart || at >= clip.timelineStart + clip.duration) throw new Error(FREEZE_PLAYHEAD_REFUSAL);
  const scoped = project.tracks.filter(item => !item.locked && (item.id === track.id || track.id === "video-main"));
  const shifted = scoped.flatMap(item => item.clips.filter(candidate => candidate.timelineStart >= at));
  if (isTemplateManagedClip(project, clipId) || shifted.some(candidate => isTemplateManagedClip(project, candidate.id))
    || project.templateApplication || (project.referenceMotionInstances?.length ?? 0) > 0 && track.id === "video-main") throw new Error(FREEZE_TEMPLATE_REFUSAL);
  if (project.motionTracks.some(item => item.clipId === clipId) || clip.masks?.some(mask => mask.keyframes.length > 0)) throw new Error(FREEZE_TRACKING_REFUSAL);
  const commands: EditorCommand[] = [{ type: "import_asset", asset }];
  if (at > clip.timelineStart) {
    commands.push({ type: "split_clip", clipId, at, newClipId: ids.right });
  }
  for (const candidate of shifted.sort((left, right) => right.timelineStart - left.timelineStart)) {
    commands.push({ type: "move_clip", clipId: candidate.id, timelineStart: candidate.timelineStart + duration });
  }
  if (at > clip.timelineStart) commands.push({ type: "move_clip", clipId: ids.right, timelineStart: at + duration });
  if (track.id === "video-main") {
    if (!captionTrackLocked(project)) for (const caption of project.captions) {
      if (caption.start >= at) commands.push({ type: "update_caption", captionId: caption.id, patch: { start: caption.start + duration } });
      else if (caption.start + caption.duration > at) commands.push({ type: "update_caption", captionId: caption.id, patch: { duration: caption.duration + duration } });
    }
    for (const graphic of project.motionGraphics) {
      if (graphic.timelineStart >= at) commands.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { timelineStart: graphic.timelineStart + duration } });
      else if (graphic.timelineStart + graphic.duration > at) commands.push({ type: "update_motion_graphic", graphicId: graphic.id, patch: { duration: graphic.duration + duration } });
    }
    for (const marker of project.director.markers.filter(item => item.time >= at)) commands.push({ type: "update_director_marker", markerId: marker.id, patch: { time: marker.time + duration } });
  }
  // The still keeps the clip's expressions, so it stores the pre-expression values (as planAddClipKeyframeV1 does);
  // storing the displayed values would apply each expression twice.
  const state = animatedClipState({ ...clip, expressions: {} }, at - clip.timelineStart, project.fps);
  const still: TimelineClip = { ...structuredClone(clip), ...state, id: ids.still, assetId: asset.id, timelineStart: at, sourceStart: 0,
    duration, volume: 0, keyframes: [], masks: clip.masks?.map(mask => ({ ...structuredClone(mask), id: makeId("mask"), keyframes: [] })) };
  commands.push({ type: "add_clip", clip: still });
  const command: EditorCommand = { type: "batch", commands };
  applyCommand(project, command);
  return { command, message: FREEZE_DONE, stillClipId: still.id };
}
