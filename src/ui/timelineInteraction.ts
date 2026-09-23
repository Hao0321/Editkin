export const TIMELINE_DRAG_THRESHOLD_PX = 3;
export const TIMELINE_MAGNET_THRESHOLD_PX = 8;

export interface TimelineDragInput {
  originStart: number;
  duration: number;
  originClientX: number;
  currentClientX: number;
  originScrollLeft: number;
  currentScrollLeft: number;
  pixelsPerSecond: number;
  fps: number;
  snapCandidates?: number[];
  magnetEnabled?: boolean;
  isStartAllowed?: (start: number) => boolean;
}

export interface TimelineDragResult {
  start: number;
  deltaPixels: number;
  moved: boolean;
  snappedTo?: number;
}

export interface TimelineTrimInput {
  edge: "start" | "end";
  originStart?: number;
  duration: number;
  originClientX: number;
  currentClientX: number;
  pixelsPerSecond: number;
  fps: number;
  snapCandidates?: number[];
  magnetEnabled?: boolean;
}

export interface TimelineTrimResult {
  trimSeconds: number;
  duration: number;
  moved: boolean;
  start: number;
  snappedTo?: number;
}

export interface TimelineDropLane {
  trackId: string;
  trackKind: "video" | "audio" | "caption";
  locked: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function resolveTimelineDropTarget(
  clientX: number,
  clientY: number,
  trackKind: TimelineDropLane["trackKind"],
  lanes: TimelineDropLane[],
): TimelineDropLane | undefined {
  return lanes.find((lane) => !lane.locked
    && lane.trackKind === trackKind
    && clientX >= lane.left
    && clientX <= lane.right
    && clientY >= lane.top
    && clientY <= lane.bottom);
}

export function alignTimelineTime(value: number, fps: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Math.max(0, Math.round(Math.max(0, value) * safeFps) / safeFps);
}

export function nudgeTimelineTime(start: number, frames: number, fps: number): number {
  return alignTimelineTime(alignTimelineTime(start, fps) + frames / fps, fps);
}

/** Non-drop display timecode. Frame count remains unambiguous at fractional fps. */
export function timelineFrameLabel(time: number, fps: number): string {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const nominalFps = Math.round(safeFps);
  const frame = Math.round(alignTimelineTime(time, safeFps) * safeFps);
  const seconds = Math.floor(frame / nominalFps);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}:${pad(frame % nominalFps)}`;
}

export function resolveTimelineDrag(input: TimelineDragInput): TimelineDragResult {
  const pixelsPerSecond = Math.max(1, input.pixelsPerSecond);
  const deltaPixels = input.currentClientX - input.originClientX + input.currentScrollLeft - input.originScrollLeft;
  let start = alignTimelineTime(input.originStart + deltaPixels / pixelsPerSecond, input.fps);
  let snappedTo: number | undefined;
  if (input.magnetEnabled !== false && input.snapCandidates?.length) {
    const thresholdSeconds = TIMELINE_MAGNET_THRESHOLD_PX / pixelsPerSecond;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestStart = start;
    for (const candidate of input.snapCandidates) {
      if (!Number.isFinite(candidate) || candidate < 0) continue;
      const target = alignTimelineTime(candidate, input.fps);
      for (const offset of [0, input.duration]) {
        const desiredStart = target - offset;
        if (desiredStart < -1e-7) continue;
        const alignedStart = alignTimelineTime(desiredStart, input.fps);
        // Never show an alignment guide that the final frame-rounded move cannot reach.
        if (Math.abs(alignedStart + offset - target) > 1e-7) continue;
        if (input.isStartAllowed && !input.isStartAllowed(alignedStart)) continue;
        const distance = Math.abs(alignedStart - start);
        if (distance <= thresholdSeconds && distance < bestDistance) {
          bestDistance = distance;
          bestStart = alignedStart;
          snappedTo = target;
        }
      }
    }
    if (snappedTo !== undefined) start = bestStart;
  }
  return { start, deltaPixels, moved: Math.abs(deltaPixels) >= TIMELINE_DRAG_THRESHOLD_PX, snappedTo };
}

export function resolveTimelineTrim(input: TimelineTrimInput): TimelineTrimResult {
  const safeFps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 30;
  const startFrame = Math.round(Math.max(0, input.originStart ?? 0) * safeFps);
  const durationFrames = Math.max(1, Math.round(input.duration * safeFps));
  const maximumTrimFrames = durationFrames - 1;
  const deltaPixels = input.currentClientX - input.originClientX;
  const inwardPixels = input.edge === "start" ? deltaPixels : -deltaPixels;
  const pixelsPerSecond = Math.max(1, input.pixelsPerSecond);
  let trimFrames = Math.min(maximumTrimFrames, Math.max(0, Math.round(inwardPixels / pixelsPerSecond * safeFps)));
  let snappedTo: number | undefined;
  if (inwardPixels > 0 && input.magnetEnabled !== false) {
    const pointerTrimFrames = trimFrames;
    let bestDistance = TIMELINE_MAGNET_THRESHOLD_PX / pixelsPerSecond;
    for (const candidate of input.snapCandidates ?? []) {
      if (!Number.isFinite(candidate) || candidate < 0) continue;
      const targetFrame = Math.round(candidate * safeFps);
      const candidateTrim = input.edge === "start" ? targetFrame - startFrame : startFrame + durationFrames - targetFrame;
      if (candidateTrim <= 0 || candidateTrim > maximumTrimFrames) continue;
      const distance = Math.abs(candidateTrim - pointerTrimFrames) / safeFps;
      if (distance <= bestDistance) {
        bestDistance = distance;
        trimFrames = candidateTrim;
        snappedTo = targetFrame / safeFps;
      }
    }
  }
  return {
    trimSeconds: trimFrames / safeFps,
    start: (startFrame + (input.edge === "start" ? trimFrames : 0)) / safeFps,
    duration: (durationFrames - trimFrames) / safeFps,
    moved: Math.abs(deltaPixels) >= TIMELINE_DRAG_THRESHOLD_PX,
    snappedTo,
  };
}

export function timelineTimeAtPointer(clientX: number, laneLeft: number, pixelsPerSecond: number, duration: number, fps: number): number {
  const raw = (clientX - laneLeft) / Math.max(1, pixelsPerSecond);
  return Math.min(Math.max(0, duration), alignTimelineTime(raw, fps));
}

export function timelineAutoScrollDelta(clientX: number, viewportLeft: number, viewportRight: number, edgePixels = 52, maximumPixels = 28): number {
  if (clientX < viewportLeft + edgePixels) {
    return -Math.ceil(maximumPixels * Math.min(1, (viewportLeft + edgePixels - clientX) / edgePixels));
  }
  if (clientX > viewportRight - edgePixels) {
    return Math.ceil(maximumPixels * Math.min(1, (clientX - (viewportRight - edgePixels)) / edgePixels));
  }
  return 0;
}
