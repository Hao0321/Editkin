import { ffmpegRationalRate, rationalRate } from "../domain/clipAlphaPlan";

/** Same nearest-frame policy as domain alignTime; never decimal seconds / TB. */
export function compositeFrameClock(fps: number, timelineStart = 0) {
  if (!Number.isFinite(timelineStart) || timelineStart < 0) throw new Error("Composite timeline start must be finite and nonnegative");
  const rate = rationalRate(fps);
  // Preserve alignTime's operation order, including IEEE754 half-frame ties.
  // Rationalization is for FFmpeg's clock, not a second timeline quantizer.
  const startFrame = Math.round(timelineStart * fps);
  if (!Number.isSafeInteger(startFrame)) throw new Error("Composite timeline frame exceeds safe integer range");
  return {
    rate: ffmpegRationalRate(rate), startFrame,
    // fps has produced one frame per project tick. Reassert the exact rational
    // timebase before adding integer ticks, shared by source and all mattes.
    timestampFilters: `settb=expr=${rate.denominator}/${rate.numerator},setpts=PTS-STARTPTS+${startFrame}`,
  };
}
