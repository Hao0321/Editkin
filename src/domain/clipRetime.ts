import { retimedClipAudioEnvelope } from "./clipAudioEnvelope";
import type { EditorCommand } from "./commandTypes";
import { alignTime, findAsset, findClip, findTrack } from "./editGraph";
import { EditGraphError } from "./editGraphError";
import { isTemplateManagedClip } from "./clipSourceEdits";
import { captionTrackLocked, TRACK_LOCKED_MESSAGE } from "./trackLock";
import { captionHolder } from "./rippleDelete";
import type { EditProject } from "./types";

export const RETIME_TEMPLATE_REFUSAL = "這次速度調整會影響標題模板，尚未能安全重排；原專案保持不變。";
export const RETIME_TRACKING_REFUSAL = "這段有追蹤或動態遮罩，尚未能安全改速度；原專案保持不變。";
export const RETIME_SOURCE_CHANGED = "片段來源剛剛有變更，這次速度調整沒有套用；請再試一次。";

/** Source and duration change together; the surrounding timing follows the existing main-track ripple scope. */
export function applyClipRetime(project: EditProject, command: Extract<EditorCommand, { type: "retime_clip" }>): void {
  const clip = findClip(project, command.clipId), track = findTrack(project, clip.trackId), asset = findAsset(project, command.assetId);
  if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  if (clip.assetId !== command.expectedAssetId) throw new EditGraphError(RETIME_SOURCE_CHANGED);
  const duration = alignTime(command.duration, project.fps), sourceStart = alignTime(command.sourceStart, project.fps);
  if (asset.kind === "image" || asset.compositionId || !Number.isFinite(duration) || duration < 1 / project.fps
    || !Number.isFinite(sourceStart) || sourceStart < 0 || sourceStart + duration > asset.duration + 1e-6
    || track.kind === "video" && asset.kind !== "video") throw new EditGraphError("速度衍生素材的種類或時長無效。" );
  if (isTemplateManagedClip(project, clip.id) || project.templateApplication
    || track.id === "video-main" && (project.referenceMotionInstances?.length ?? 0) > 0) throw new EditGraphError(RETIME_TEMPLATE_REFUSAL);
  if (project.motionTracks.some(item => item.clipId === clip.id) || clip.masks?.some(mask => mask.keyframes.length > 0)) throw new EditGraphError(RETIME_TRACKING_REFUSAL);
  const beforeDuration = clip.duration, beforeEnd = clip.timelineStart + beforeDuration, delta = duration - beforeDuration;
  const scope = project.tracks.filter(item => !item.locked && (item.id === track.id || track.id === "video-main"));
  const moves: Array<{ clip: typeof clip; start: number }> = [];
  for (const candidateTrack of scope) {
    const candidates = candidateTrack.clips.filter(item => item.id !== clip.id && item.timelineStart >= beforeEnd - 1e-6);
    if (candidates.some(item => isTemplateManagedClip(project, item.id))) throw new EditGraphError(RETIME_TEMPLATE_REFUSAL);
    const proposed = candidateTrack.clips.map(item => ({ id: item.id, start: item.timelineStart + (candidates.includes(item) ? delta : 0), duration: item.id === clip.id ? duration : item.duration })).sort((a,b) => a.start-b.start);
    const overlap = proposed.some((item,index) => item.start < 0 || index > 0 && item.start < proposed[index-1].start+proposed[index-1].duration-1e-6);
    if (overlap && candidateTrack.id !== track.id) continue;
    if (overlap) throw new EditGraphError("速度調整後的片段會重疊。" );
    candidates.forEach(item => moves.push({ clip: item, start: alignTime(item.timelineStart + delta, project.fps) }));
  }
  if (!captionTrackLocked(project)) for (const caption of project.captions) {
    if (captionHolder(project, caption, project.fps)?.id === clip.id) {
      const reverseChanged = (findAsset(project, clip.assetId).clipRetime?.reverse ?? false) !== (asset.clipRetime?.reverse ?? false);
      const localStart = reverseChanged ? beforeEnd - caption.start - caption.duration : caption.start - clip.timelineStart;
      caption.start = Math.min(clip.timelineStart + duration - 1 / project.fps,
        alignTime(clip.timelineStart + localStart * duration / beforeDuration, project.fps));
      caption.duration = Math.min(clip.timelineStart + duration - caption.start,
        Math.max(1 / project.fps, alignTime(caption.duration * duration / beforeDuration, project.fps)));
    } else if (track.id === "video-main" && caption.start >= beforeEnd) caption.start = alignTime(caption.start + delta, project.fps);
  }
  if (track.id === "video-main") {
    for (const marker of project.director.markers) {
      if (marker.time >= beforeEnd) marker.time = alignTime(marker.time + delta, project.fps);
      else if (marker.time >= clip.timelineStart) marker.time = alignTime(clip.timelineStart + (marker.time - clip.timelineStart) * duration / beforeDuration, project.fps);
    }
    for (const graphic of project.motionGraphics) if (graphic.timelineStart >= beforeEnd) graphic.timelineStart = alignTime(graphic.timelineStart + delta, project.fps);
  }
  moves.forEach(move => { move.clip.timelineStart = move.start; });
  clip.keyframes = clip.keyframes.map(item => ({ ...item, time: alignTime(item.time * duration / beforeDuration, project.fps) }));
  if (clip.audioEnvelope) clip.audioEnvelope = retimedClipAudioEnvelope(clip, duration);
  clip.assetId = asset.id; clip.sourceStart = sourceStart; clip.duration = duration;
  if (clip.creative?.transitionIn) clip.creative.transitionIn.duration = Math.min(duration, clip.creative.transitionIn.duration);
  if (clip.creative?.transitionOut) clip.creative.transitionOut.duration = Math.min(duration, clip.creative.transitionOut.duration);
}
