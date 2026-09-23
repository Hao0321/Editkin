import { ffmpegRationalRate, type RationalRate } from "../domain/clipAlphaPlan";

/**
 * A sample k becomes active at ceil(k * projectRate / sampleRate).
 * Rounding sample timestamps UP therefore implements floor selection at each
 * output tick, unlike fps:round=down, which can expose the next sample early.
 * The input rawvideo rate must be the receipt's exact rational sampleRate.
 */
export function pixelMatteSamplingFilters(projectRate: RationalRate, sampleCount: number, outputFrames: number, firstProjectFrame = 0): string[] {
  if (![projectRate.numerator, projectRate.denominator, sampleCount, outputFrames].every(v => Number.isSafeInteger(v) && v > 0)
    || !Number.isSafeInteger(firstProjectFrame) || firstProjectFrame < 0
    || !Number.isSafeInteger(firstProjectFrame + outputFrames)) throw new Error("Invalid bounded pixel-matte sampling clock");
  return [
    `trim=end_frame=${sampleCount}`, "setpts=PTS-STARTPTS",
    // Domain clamps at the last stored sample. Extend before resampling so a
    // short receipt cannot disappear or hold the penultimate sample at EOF.
    "tpad=stop_mode=clone:stop=-1",
    `fps=${ffmpegRationalRate(projectRate)}:start_time=0:round=up`,
    `trim=start_frame=${firstProjectFrame}:end_frame=${firstProjectFrame + outputFrames}`,
    "setpts=PTS-STARTPTS",
  ];
}
