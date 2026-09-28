import { alignTimelineTime, resolveTimelineDrag } from "./timelineInteraction";
import type { MediaAsset } from "../domain/types";

export const EDITKIN_ASSET_DRAG_TYPE = "application/x-editkin-asset-id";

export function timelineAssetDuration(asset: Pick<MediaAsset, "kind" | "duration">, fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const seconds = asset.kind === "image" ? 3 : asset.duration > 0 ? asset.duration : 3;
  return Math.max(1 / safeFps, alignTimelineTime(seconds, safeFps));
}

export interface TimelineAssetDropInput {
  rawTime: number;
  duration: number;
  fps: number;
  pixelsPerSecond: number;
  snapCandidates: number[];
  occupied: Array<{ timelineStart: number; duration: number }>;
  magnetEnabled: boolean;
}

export interface TimelineAssetDropResult {
  start: number;
  duration: number;
  allowed: boolean;
  snappedTo?: number;
}

/** The same frame-rounded position is used for the preview and the committed insert. */
export function resolveTimelineAssetDrop(input: TimelineAssetDropInput): TimelineAssetDropResult {
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 30;
  const duration = Math.max(1 / fps, alignTimelineTime(input.duration, fps));
  const isStartAllowed = (start: number) => input.occupied.every((clip) =>
    start + duration <= clip.timelineStart + 1e-6 || start >= clip.timelineStart + clip.duration - 1e-6);
  const drag = resolveTimelineDrag({
    originStart: 0,
    duration,
    originClientX: 0,
    currentClientX: Math.max(0, input.rawTime) * input.pixelsPerSecond,
    originScrollLeft: 0,
    currentScrollLeft: 0,
    pixelsPerSecond: input.pixelsPerSecond,
    fps,
    snapCandidates: input.snapCandidates,
    magnetEnabled: input.magnetEnabled,
    isStartAllowed,
  });
  return { start: drag.start, duration, allowed: isStartAllowed(drag.start), snappedTo: drag.snappedTo };
}
