import { TIMELINE_MAGNET_THRESHOLD_PX, resolveTimelineDrag } from "./timelineInteraction";

/**
 * Pointer math for blocks on the 標題與圖卡 lane. The same frame grid, magnet threshold and Alt rule as clips:
 * every result is a whole project frame, snapping only reaches targets within 8 px, and Alt pauses snapping.
 */

export interface MotionBlockMoveInput {
  originStartFrame: number;
  durationFrames: number;
  originClientX: number;
  currentClientX: number;
  originScrollLeft: number;
  currentScrollLeft: number;
  pixelsPerSecond: number;
  fps: number;
  snapCandidates?: number[];
  magnetEnabled: boolean;
  /** Earliest and latest first frame (a tracked label stays inside its clip; nothing goes before 0). */
  minStartFrame: number;
  maxStartFrame: number;
}

export interface MotionBlockMoveResult {
  startFrame: number;
  moved: boolean;
  snappedTo?: number;
  /** The pointer asked for more than the limits allow. */
  limited: boolean;
}

function safeFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

export function resolveMotionBlockMove(input: MotionBlockMoveInput): MotionBlockMoveResult {
  const fps = safeFps(input.fps);
  const resolved = resolveTimelineDrag({ originStart: input.originStartFrame / fps, duration: input.durationFrames / fps,
    originClientX: input.originClientX, currentClientX: input.currentClientX, originScrollLeft: input.originScrollLeft,
    currentScrollLeft: input.currentScrollLeft, pixelsPerSecond: input.pixelsPerSecond, fps, snapCandidates: input.snapCandidates,
    magnetEnabled: input.magnetEnabled });
  const requested = Math.round(resolved.start * fps);
  const startFrame = Math.max(input.minStartFrame, Math.min(input.maxStartFrame, requested));
  const limited = startFrame !== requested;
  return { startFrame, moved: startFrame !== input.originStartFrame, limited,
    snappedTo: limited ? undefined : resolved.snappedTo };
}

export interface MotionBlockTrimInput {
  edge: "start" | "end";
  originStartFrame: number;
  durationFrames: number;
  /** Pointer travel in pixels, including any scroll since the press. */
  deltaPixels: number;
  pixelsPerSecond: number;
  fps: number;
  snapCandidates?: number[];
  magnetEnabled: boolean;
  minDurationFrames: number;
  maxDurationFrames: number;
  /** A tracked label's clip, or [0, ∞). */
  minStartFrame: number;
  maxEndFrame: number;
}

export interface MotionBlockTrimResult {
  startFrame: number;
  durationFrames: number;
  moved: boolean;
  snappedTo?: number;
  limited: boolean;
  /** Which limit stopped the edge, for the readout. */
  limit?: "shortest" | "longest" | "range";
}

export function resolveMotionBlockTrim(input: MotionBlockTrimInput): MotionBlockTrimResult {
  const fps = safeFps(input.fps), pixelsPerSecond = Math.max(1, input.pixelsPerSecond);
  const originEnd = input.originStartFrame + input.durationFrames;
  const originEdge = input.edge === "start" ? input.originStartFrame : originEnd;
  let edge = originEdge + Math.round(input.deltaPixels / pixelsPerSecond * fps);
  let snappedTo: number | undefined;
  if (input.magnetEnabled && edge !== originEdge) {
    let best = TIMELINE_MAGNET_THRESHOLD_PX / pixelsPerSecond;
    for (const candidate of input.snapCandidates ?? []) {
      if (!Number.isFinite(candidate) || candidate < 0) continue;
      const frame = Math.round(candidate * fps);
      if (frame === originEdge) continue;
      const distance = Math.abs(frame - edge) / fps;
      if (distance <= best) { best = distance; edge = frame; snappedTo = frame / fps; }
    }
  }
  // Growing outward stops at the longest length or at the range (time 0, or a tracked label's clip), whichever comes first.
  const longestEdge = input.edge === "start" ? originEnd - input.maxDurationFrames : input.originStartFrame + input.maxDurationFrames;
  const rangeEdge = input.edge === "start" ? input.minStartFrame : input.maxEndFrame;
  const shortestEdge = input.edge === "start" ? originEnd - input.minDurationFrames : input.originStartFrame + input.minDurationFrames;
  const outward = input.edge === "start" ? Math.max(longestEdge, rangeEdge) : Math.min(longestEdge, rangeEdge);
  const low = input.edge === "start" ? outward : shortestEdge, high = input.edge === "start" ? shortestEdge : outward;
  const clamped = Math.max(low, Math.min(high, edge));
  const limited = clamped !== edge;
  let limit: MotionBlockTrimResult["limit"];
  if (limited) {
    const shorter = input.edge === "start" ? edge > clamped : edge < clamped;
    limit = shorter ? "shortest" : outward === rangeEdge ? "range" : "longest";
  }
  const startFrame = input.edge === "start" ? clamped : input.originStartFrame;
  const durationFrames = input.edge === "start" ? originEnd - clamped : clamped - input.originStartFrame;
  return { startFrame, durationFrames, moved: startFrame !== input.originStartFrame || durationFrames !== input.durationFrames,
    snappedTo: limited ? undefined : snappedTo, limited, limit };
}
