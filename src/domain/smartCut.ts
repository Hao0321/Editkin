import { alignTime, animatedClipState, EditGraphError, findClip, findTrack } from "./editGraph";
import type { CaptionCue, EditProject, TimelineClip } from "./types";
import { sliceClipVisuals } from "./clipSlicing";

export interface SmartCutKeepRange {
  start: number;
  end: number;
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd - 1e-6 && rightStart < leftEnd - 1e-6;
}

export function applySmartCutToClip(
  project: EditProject,
  clipId: string,
  keepRangesInput: SmartCutKeepRange[],
  segmentIds: string[],
): void {
  const original = structuredClone(findClip(project, clipId));
  const track = findTrack(project, original.trackId);
  const tolerance = 0.5 / project.fps;
  if (!keepRangesInput.length || segmentIds.length !== keepRangesInput.length || segmentIds[0] !== clipId) {
    throw new EditGraphError("Smart Cut 區間與片段 id 不一致");
  }
  if (new Set(segmentIds).size !== segmentIds.length) throw new EditGraphError("Smart Cut 片段 id 不可重複");
  const existingIds = new Set(project.tracks.flatMap((item) => item.clips).filter((item) => item.id !== clipId).map((item) => item.id));
  if (segmentIds.some((id) => existingIds.has(id))) throw new EditGraphError("Smart Cut 片段 id 已存在");
  const keepRanges = keepRangesInput.map((range) => ({
    start: alignTime(range.start, project.fps),
    end: alignTime(range.end, project.fps),
  }));
  keepRanges.forEach((range, index) => {
    if (![range.start, range.end].every(Number.isFinite)
      || range.start < 0 || range.end <= range.start || range.end > original.duration + tolerance
      || (index > 0 && range.start < keepRanges[index - 1].end - tolerance)) {
      throw new EditGraphError("Smart Cut 區間必須遞增、互不重疊且位於原片段內");
    }
  });
  const originalEnd = original.timelineStart + original.duration;
  const conflicting = project.tracks.flatMap((item) => item.clips).find((item) => (
    item.id !== original.id && overlaps(item.timelineStart, item.timelineStart + item.duration, original.timelineStart, originalEnd)
  ));
  if (conflicting) throw new EditGraphError(`Smart Cut 前請先移開與主片段重疊的「${conflicting.id}」`);

  const slicedMasks = sliceClipVisuals(project, original, keepRanges.map((range, index) => ({ ...range, clipId: segmentIds[index] })));

  let cursor = original.timelineStart;
  const segments: TimelineClip[] = keepRanges.map((range, index) => {
    const duration = alignTime(range.end - range.start, project.fps);
    const initial = animatedClipState(original, range.start);
    const keyframes = original.keyframes
      .filter((keyframe) => keyframe.time > range.start + tolerance && keyframe.time <= range.end + tolerance)
      .map((keyframe) => ({
        ...structuredClone(keyframe),
        id: `${segmentIds[index]}-${keyframe.id}`,
        time: alignTime(Math.min(range.end, keyframe.time) - range.start, project.fps),
      }));
    if (original.keyframes.some((keyframe) => keyframe.time > range.end + tolerance)
      && !keyframes.some((keyframe) => Math.abs(keyframe.time - duration) <= tolerance)) {
      const ending = animatedClipState(original, range.end);
      keyframes.push({
        id: `${segmentIds[index]}-smart-end`,
        time: duration,
        transform: ending.transform,
        color: ending.color,
        easing: "linear",
      });
    }
    const segment: TimelineClip = {
      ...original,
      id: segmentIds[index],
      timelineStart: cursor,
      sourceStart: alignTime(original.sourceStart + range.start, project.fps),
      duration,
      transform: initial.transform,
      color: initial.color,
      keyframes,
      masks: slicedMasks[index],
    };
    cursor = alignTime(cursor + duration, project.fps);
    return segment;
  });
  const removedDuration = alignTime(original.duration - (cursor - original.timelineStart), project.fps);
  track.clips = track.clips.filter((item) => item.id !== original.id).concat(segments).sort((left, right) => left.timelineStart - right.timelineStart);
  if (removedDuration > 0) {
    for (const item of project.tracks.flatMap((timelineTrack) => timelineTrack.clips)) {
      if (!segmentIds.includes(item.id) && item.timelineStart >= originalEnd - tolerance) {
        item.timelineStart = alignTime(item.timelineStart - removedDuration, project.fps);
      }
    }
  }

  const keptBefore = (relativeTime: number) => keepRanges.reduce((sum, range) => (
    sum + Math.max(0, Math.min(relativeTime, range.end) - range.start)
  ), 0);
  const mapTimelineTime = (time: number) => {
    if (time <= original.timelineStart) return time;
    if (time >= originalEnd) return alignTime(time - removedDuration, project.fps);
    return alignTime(original.timelineStart + keptBefore(time - original.timelineStart), project.fps);
  };
  project.captions = project.captions.flatMap((caption): CaptionCue[] => {
    const start = mapTimelineTime(caption.start);
    const end = mapTimelineTime(caption.start + caption.duration);
    const duration = alignTime(end - start, project.fps);
    return duration >= 1 / project.fps ? [{ ...caption, start, duration }] : [];
  }).sort((left, right) => left.start - right.start);
}
