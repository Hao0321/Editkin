/** A frame-aligned duration can round one ULP above its integer rational frame
 * count (e.g.16/(60000/1001)). Recognize exact grid round trips instead of
 * broadening the duration with an epsilon; genuinely partial frames still ceil. */
export function timeRemapOutputFrameCountV1(duration: number, rate: { numerator: number; denominator: number }) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(rate.numerator) || !Number.isSafeInteger(rate.denominator)
    || rate.numerator < 1 || rate.denominator < 1) throw Error("TIME_REMAP_CLOCK_FRAME_COUNT_INVALID");
  const fractional = duration * rate.numerator / rate.denominator, nearest = Math.round(fractional);
  const recognizedGrid = duration === nearest * rate.denominator / rate.numerator || duration === nearest / (rate.numerator / rate.denominator);
  const count = recognizedGrid ? nearest : Math.ceil(fractional);
  if (!Number.isSafeInteger(count) || count < 1) throw Error("TIME_REMAP_CLOCK_FRAME_COUNT_INVALID");
  return count;
}
