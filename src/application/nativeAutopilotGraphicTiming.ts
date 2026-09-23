import type { CaptionCue } from "../domain/types";

/** Temporal separation, not a spatial layout solver. Only optional duplicate
 * graphics use these gaps; subtitle text/timing is never removed or shortened. */
export function createCaptionGapAllocator(captions: readonly CaptionCue[], start: number, end: number, fps: number) {
  // Two frames leave at least a full frame after decimal-time quantization.
  const padding = 2 / fps;
  const occupied = captions.map(cue => ({ start: cue.start - padding, end: cue.start + cue.duration + padding }));
  return (preferredStart: number, preferredDuration: number, allowedEnd = end): { timelineStart: number; duration: number } | undefined => {
    const limit = Math.min(end, allowedEnd);
    let cursor = start;
    const gaps: Array<{ start: number; end: number }> = [];
    for (const interval of [...occupied].sort((a, b) => a.start - b.start)) {
      if (interval.end <= cursor || interval.start >= limit) continue;
      if (interval.start > cursor) gaps.push({ start: cursor, end: Math.min(interval.start, limit) });
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < limit) gaps.push({ start: cursor, end: limit });
    const candidates = [...gaps.filter(gap => gap.end > preferredStart).map(gap => ({ ...gap, start: Math.max(gap.start, preferredStart) })), ...gaps];
    for (const gap of candidates) {
      const firstFrame = Math.max(0, Math.ceil((gap.start - 1e-9) * fps));
      const lastFrame = Math.floor((Math.min(gap.end, firstFrame / fps + preferredDuration) + 1e-9) * fps);
      // Do not flash optional repeat text for an unreadably short instant.
      if (lastFrame - firstFrame < Math.ceil(fps)) continue;
      const timing = { timelineStart: firstFrame / fps, duration: (lastFrame - firstFrame) / fps };
      occupied.push({ start: timing.timelineStart - padding, end: timing.timelineStart + timing.duration + padding });
      return timing;
    }
    return undefined;
  };
}
