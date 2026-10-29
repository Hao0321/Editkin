import type { TimelineMarkRange } from "./timelineNavigation";

export type TimelinePlaybackRange = { in: number; out: number };
export type TimelineSeekValue = number | ((current: number) => number);
export interface TimelineRangeTransportHost {
  setPlayhead: (value: TimelineSeekValue) => void;
  onPlaybackClock: (time: number, seekRevision: number) => void;
  onRangeEnd: () => void;
}

/** A range is frame-aligned and wholly within the current timeline; it never enters the project document. */
export function timelinePlaybackRange(range: TimelineMarkRange, duration: number, fps: number): TimelinePlaybackRange | undefined {
  if (range.in === undefined || range.out === undefined || ![range.in, range.out, duration, fps].every(Number.isFinite)
    || range.in < 0 || fps <= 0 || duration <= 0) return undefined;
  const start = Math.round(range.in * fps), end = Math.round(range.out * fps);
  if (start >= end || end > Math.round(duration * fps)) return undefined;
  return { in: start / fps, out: end / fps };
}

/** Wrap the existing seek/clock reducer. Its actual revision after the start gesture owns the range;
 * a keypress can enqueue several seeks (pause, rate change, start), so it is never guessed in advance. */
export function createTimelineRangeTransport(getHost: () => TimelineRangeTransportHost, initialSeekRevision = 0) {
  let observedSeekRevision = initialSeekRevision;
  let active: (TimelinePlaybackRange & { seekRevision?: number; afterRevision: number }) | undefined;
  return {
    observeSeekRevision(revision: number) {
      observedSeekRevision = revision;
      if (!active) return;
      if (active.seekRevision === undefined) {
        if (revision > active.afterRevision) active.seekRevision = revision;
      } else if (revision !== active.seekRevision) active = undefined;
    },
    setPlayhead(value: TimelineSeekValue) {
      // The existing reducer ignores invalid numeric seeks; they do not cancel a valid range either.
      if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) { getHost().setPlayhead(value); return; }
      active = undefined;
      getHost().setPlayhead(value);
    },
    beginRange(range: TimelinePlaybackRange, startGesture: (range: TimelinePlaybackRange) => void) {
      active = undefined;
      const afterRevision = observedSeekRevision;
      startGesture(range);
      active = { ...range, afterRevision };
    },
    cancelRange() { active = undefined; },
    onPlaybackClock(time: number, seekRevision: number) {
      const host = getHost();
      if (!active || active.seekRevision === undefined || seekRevision !== active.seekRevision || !Number.isFinite(time) || time < 0) {
        host.onPlaybackClock(time, seekRevision);
        return;
      }
      if (time < active.out) { host.onPlaybackClock(Math.max(active.in, time), seekRevision); return; }
      const end = active.out;
      active = undefined;
      // A real seek retires late device events, including an overshoot. Pausing may enqueue another seek too.
      host.setPlayhead(end);
      host.onRangeEnd();
    },
    getActiveRange(): TimelinePlaybackRange | undefined { return active ? { in: active.in, out: active.out } : undefined; },
  };
}
