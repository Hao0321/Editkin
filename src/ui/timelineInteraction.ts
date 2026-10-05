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

export function resolveTimelineDropTarget<T extends TimelineDropLane>(
  clientX: number,
  clientY: number,
  trackKind: TimelineDropLane["trackKind"],
  lanes: readonly T[],
): T | undefined {
  return lanes.find((lane) => !lane.locked
    && lane.trackKind === trackKind
    && clientX >= lane.left
    && clientX < lane.right
    && clientY >= lane.top
    && clientY < lane.bottom);
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
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 30;
  const deltaPixels = input.currentClientX - input.originClientX + input.currentScrollLeft - input.originScrollLeft;
  let start = alignTimelineTime(input.originStart + deltaPixels / pixelsPerSecond, input.fps);
  let snappedTo: number | undefined;
  const originFrame = Math.round(Math.max(0, input.originStart) * fps);
  if (Math.round(start * fps) !== originFrame && input.magnetEnabled !== false && input.snapCandidates?.length) {
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
        // A playhead/origin magnet must not eat a deliberate one-frame move.
        if (Math.round(alignedStart * fps) === originFrame) continue;
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
  // A frame is the smallest edit, even when it occupies less than three pixels.
  // Comparing frames also keeps pointer jitter within the original frame a click.
  const moved = Math.round(start * fps) !== originFrame;
  return { start, deltaPixels, moved, snappedTo };
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
  if (trimFrames > 0 && input.magnetEnabled !== false) {
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
    moved: trimFrames > 0,
    snappedTo,
  };
}

/** Clip live lane rectangles to the visible content, excluding labels/ruler.
 * The UI supplies fresh measurements for every preview and final release. */
export function visibleTimelineDropLanes<T extends TimelineDropLane>(lanes: readonly T[], viewport: {
  left: number; right: number; top: number; bottom: number;
}): T[] {
  if (![viewport.left, viewport.right, viewport.top, viewport.bottom].every(Number.isFinite)) return [];
  return lanes.flatMap(lane => {
    const left = Math.max(lane.left, viewport.left), right = Math.min(lane.right, viewport.right);
    const top = Math.max(lane.top, viewport.top), bottom = Math.min(lane.bottom, viewport.bottom);
    return [left, right, top, bottom].every(Number.isFinite) && left < right && top < bottom
      ? [{ ...lane, left, right, top, bottom }] : [];
  });
}

export function timelineTimeAtPointer(clientX: number, laneLeft: number, pixelsPerSecond: number, duration: number, fps: number): number {
  const raw = (clientX - laneLeft) / Math.max(1, pixelsPerSecond);
  return Math.min(Math.max(0, duration), alignTimelineTime(raw, fps));
}

/** Horizontal edge scrolling uses elapsed time, not one jump per display frame.
 * Bounds exclude the sticky labels and scrollbar; leaving them stops scrolling. */
export function timelineAutoScrollDelta(clientX: number, viewportLeft: number, viewportRight: number, elapsedMs = 1000 / 60): number {
  if (![clientX, viewportLeft, viewportRight, elapsedMs].every(Number.isFinite)
    || elapsedMs <= 0 || viewportRight <= viewportLeft || clientX < viewportLeft || clientX >= viewportRight) return 0;
  const edge = Math.min(52, (viewportRight - viewportLeft) / 2);
  const leftDistance = clientX - viewportLeft, rightDistance = viewportRight - clientX;
  const penetration = leftDistance < edge ? -(1 - leftDistance / edge)
    : rightDistance < edge ? 1 - rightDistance / edge : 0;
  // A stalled RAF must not move the drop target by several seconds on resume.
  return penetration * 360 * Math.min(50, elapsedMs) / 1000;
}

/** Track-stack scrolling has a real-time velocity, independent of refresh rate.
 * Bounds describe only the visible track content below the sticky ruler. */
export function timelineTrackAutoScrollDelta(clientY: number, contentTop: number, contentBottom: number, elapsedMs: number): number {
  if (![clientY, contentTop, contentBottom, elapsedMs].every(Number.isFinite)
    || elapsedMs <= 0 || contentBottom <= contentTop || clientY < contentTop || clientY >= contentBottom) return 0;
  const edge = Math.min(36, (contentBottom - contentTop) / 2);
  const topDistance = clientY - contentTop, bottomDistance = contentBottom - clientY;
  const penetration = topDistance < edge ? -(1 - topDistance / edge)
    : bottomDistance < edge ? 1 - bottomDistance / edge : 0;
  // A stalled frame must not jump across several tracks on resume.
  return penetration * 360 * Math.min(50, elapsedMs) / 1000;
}
