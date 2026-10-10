import { alignTimelineTime, resolveTimelineDrag } from "./timelineInteraction";
import type { MediaAsset } from "../domain/types";

export const EDITKIN_ASSET_DRAG_TYPE = "application/x-editkin-asset-id";

export function timelineAssetDuration(asset: Pick<MediaAsset, "kind" | "duration">, fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  if (!Number.isFinite(asset.duration) || asset.duration <= 0) return 0;
  const seconds = asset.kind === "image" ? Math.min(3, asset.duration) : asset.duration;
  const frames = seconds * safeFps;
  const completeFrames = Math.floor(frames + Number.EPSILON * Math.max(1, frames) * 8);
  return completeFrames < 1 ? 0 : Math.min(seconds, completeFrames / safeFps);
}

export interface TimelineAssetDropInput {
  rawTime: number;
  duration: number;
  fps: number;
  pixelsPerSecond: number;
  snapCandidates: number[];
  occupied: Array<{ timelineStart: number; duration: number }>;
  magnetEnabled: boolean;
  collisionPolicy?: "reject" | "new-layer";
}

export interface TimelineAssetDropResult {
  start: number;
  duration: number;
  allowed: boolean;
  snappedTo?: number;
  newLayer: boolean;
}

/** The same frame-rounded position is used for the preview and the committed insert. */
export function resolveTimelineAssetDrop(input: TimelineAssetDropInput): TimelineAssetDropResult {
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 30;
  const duration = timelineAssetDuration({ kind: "video", duration: input.duration }, fps);
  if (duration <= 0) return { start: alignTimelineTime(input.rawTime, fps), duration: 0, allowed: false, newLayer: false };
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
    isStartAllowed: input.collisionPolicy === "new-layer" ? undefined : isStartAllowed,
  });
  const collision = !isStartAllowed(drag.start);
  return { start: drag.start, duration, allowed: !collision || input.collisionPolicy === "new-layer", snappedTo: drag.snappedTo,
    newLayer: collision && input.collisionPolicy === "new-layer" };
}
