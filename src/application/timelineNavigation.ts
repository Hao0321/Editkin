import type { DirectorMarker, EditProject } from "../domain/types";

export interface TimelineMarkRange { in?: number; out?: number }

/** Strictly previous/next frame-aligned clip edge across unlocked tracks. */
export function timelineEditPoint(project: EditProject, playhead: number, direction: -1 | 1): number | undefined {
  return adjacentTime(project.tracks.filter(track => !track.locked).flatMap(track => track.clips
    .flatMap(clip => [clip.timelineStart, clip.timelineStart + clip.duration])), playhead, direction, project.fps);
}

export function timelineMarkerPoint(markers: readonly DirectorMarker[], playhead: number, direction: -1 | 1, fps: number): number | undefined {
  return adjacentTime(markers.map(marker => marker.time), playhead, direction, fps);
}

function adjacentTime(times: readonly number[], playhead: number, direction: -1 | 1, fps: number): number | undefined {
  const current = Math.round(playhead * fps);
  const frames = [...new Set(times.filter(time => Number.isFinite(time) && time >= 0).map(time => Math.round(time * fps)))];
  const candidates = frames.filter(frame => direction === -1 ? frame < current : frame > current);
  if (!candidates.length) return undefined;
  return (direction === -1 ? Math.max(...candidates) : Math.min(...candidates)) / fps;
}

/** Range is transient editor state. Setting a crossing endpoint clears the other until it is set again. */
export function setTimelineMark(range: TimelineMarkRange, edge: "in" | "out", time: number, fps: number): TimelineMarkRange {
  const at = Math.round(Math.max(0, time) * fps) / fps;
  return edge === "in" ? { in: at, ...(range.out !== undefined && range.out > at ? { out: range.out } : {}) }
    : { out: at, ...(range.in !== undefined && range.in < at ? { in: range.in } : {}) };
}

export function validTimelineMarkRange(range: TimelineMarkRange): range is { in: number; out: number } {
  return range.in !== undefined && range.out !== undefined && Number.isFinite(range.in) && Number.isFinite(range.out)
    && range.in >= 0 && range.out > range.in;
}
