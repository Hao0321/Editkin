import type { EditProject } from "../domain/types";
import { TIMELINE_MAGNET_THRESHOLD_PX } from "./timelineInteraction";

export interface TimelineSnapPoint { time: number; owner: string }

/** Build once per edit; dragging queries only two small edge windows, not every clip. */
export function buildTimelineSnapIndex(project: Pick<EditProject, "tracks" | "captions" | "director">): TimelineSnapPoint[] {
  const points: TimelineSnapPoint[] = [{ time: 0, owner: "origin" }];
  for (const track of project.tracks) for (const clip of track.clips) {
    points.push({ time: clip.timelineStart, owner: `clip:${clip.id}` }, { time: clip.timelineStart + clip.duration, owner: `clip:${clip.id}` });
  }
  for (const caption of project.captions) points.push({ time: caption.start, owner: `caption:${caption.id}` }, { time: caption.start + caption.duration, owner: `caption:${caption.id}` });
  for (const marker of project.director.markers) points.push({ time: marker.time, owner: `marker:${marker.id}` });
  return points.filter(point => Number.isFinite(point.time) && point.time >= 0).sort((a, b) => a.time - b.time);
}

export function queryTimelineSnapTimes(index: TimelineSnapPoint[], owner: string, edges: number[], pixelsPerSecond: number, fps: number, playhead: number): number[] {
  const threshold = TIMELINE_MAGNET_THRESHOLD_PX / Math.max(1, pixelsPerSecond) + 1 / fps;
  const times = new Set<number>();
  if (Number.isFinite(playhead) && playhead >= 0) times.add(playhead);
  for (const edge of edges) {
    let low = 0, high = index.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index[middle].time < edge - threshold) low = middle + 1;
      else high = middle;
    }
    for (let cursor = low; cursor < index.length && index[cursor].time <= edge + threshold; cursor += 1) {
      const point = index[cursor];
      if (point.owner !== owner) times.add(point.time);
    }
  }
  return [...times];
}
