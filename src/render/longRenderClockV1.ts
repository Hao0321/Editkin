// Pure rational clock for LONG renders (LV-01, design C1 "day 0"): frame, audio-sample and container-tick
// conversions as exact integers. Products are computed in BigInt; every result is range-checked as a JS safe
// integer. No 32-bit arithmetic anywhere (25 h at 48 kHz is 4.32e9 samples, at 90 kHz 8.1e9 ticks).
import { timebaseForFps } from "./engineGraph";
import { LongRenderRefusalV1, type RationalRateV1 } from "./longRenderContractsV1";

export type ClockRoundingV1 = "floor" | "ceil" | "round";

function refuse(message: string, details: Record<string, unknown> = {}): never {
  throw new LongRenderRefusalV1("LONG_RENDER_CLOCK_RANGE", message, details);
}

export function assertSafeIndexV1(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) refuse(`${label} must be a non-negative safe integer`, { label, value });
  return value;
}

function assertRate(rate: RationalRateV1): void {
  if (!Number.isSafeInteger(rate.numerator) || !Number.isSafeInteger(rate.denominator) || rate.numerator <= 0 || rate.denominator <= 0) {
    refuse("frame rate must be a positive integer ratio", { rate });
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) refuse(`${label} must be a positive safe integer`, { label, value });
}

/** n / d for n >= 0, d > 0 with an explicit rounding (round = half up). */
function divide(n: bigint, d: bigint, mode: ClockRoundingV1): bigint {
  if (mode === "floor") return n / d;
  if (mode === "ceil") return (n + d - 1n) / d;
  return (2n * n + d) / (2n * d);
}

function toSafe(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) refuse(`${label} exceeds the safe integer range`, { label, value: value.toString() });
  return Number(value);
}

/** Frames per second as an exact ratio: 30 -> 30/1, 29.97002997 -> 30000/1001 (shared engine timebase). */
export function frameRateRationalV1(fps: number): RationalRateV1 {
  try {
    const timebase = timebaseForFps(fps);
    return { numerator: timebase.denominator, denominator: timebase.numerator };
  } catch (error) {
    return refuse(`fps ${fps} has no rational timebase: ${error instanceof Error ? error.message : String(error)}`, { fps });
  }
}

/** Frame index of a (float) time in seconds. */
export function secondsToFrameV1(seconds: number, rate: RationalRateV1, mode: ClockRoundingV1 = "round"): number {
  assertRate(rate);
  if (!Number.isFinite(seconds) || seconds < 0) refuse("time must be a finite non-negative number of seconds", { seconds });
  const exact = seconds * rate.numerator / rate.denominator;
  // A float time within 1e-6 frame of an integer is that frame (timeline times are stored as float seconds).
  const nearest = Math.round(exact);
  const value = Math.abs(exact - nearest) <= 1e-6 ? nearest : mode === "floor" ? Math.floor(exact) : mode === "ceil" ? Math.ceil(exact) : nearest;
  return assertSafeIndexV1(value, "frame");
}

/** Number of frames a duration covers (rounded to the nearest frame, like the planner). */
export function durationFrameCountV1(seconds: number, rate: RationalRateV1): number {
  return secondsToFrameV1(seconds, rate, "round");
}

/** Start time of a frame in seconds (float, for display and FFmpeg arguments only). */
export function frameToSecondsV1(frame: number, rate: RationalRateV1): number {
  assertRate(rate); assertSafeIndexV1(frame, "frame");
  return frame * rate.denominator / rate.numerator;
}

/** Audio sample at the start of `frame`. */
export function frameToSampleV1(frame: number, rate: RationalRateV1, sampleRate: number, mode: ClockRoundingV1 = "round"): number {
  assertRate(rate); assertSafeIndexV1(frame, "frame"); assertPositiveInteger(sampleRate, "sample rate");
  return toSafe(divide(BigInt(frame) * BigInt(sampleRate) * BigInt(rate.denominator), BigInt(rate.numerator), mode), "sample");
}

/** Frame that contains audio sample `sample` (floor) or the nearest frame boundary (round/ceil). */
export function sampleToFrameV1(sample: number, rate: RationalRateV1, sampleRate: number, mode: ClockRoundingV1 = "floor"): number {
  assertRate(rate); assertSafeIndexV1(sample, "sample"); assertPositiveInteger(sampleRate, "sample rate");
  return toSafe(divide(BigInt(sample) * BigInt(rate.numerator), BigInt(sampleRate) * BigInt(rate.denominator), mode), "frame");
}

/** Container ticks (e.g. 90 kHz, 1/15360) at the start of `frame`. */
export function frameToTicksV1(frame: number, rate: RationalRateV1, ticksPerSecond: number, mode: ClockRoundingV1 = "round"): number {
  assertRate(rate); assertSafeIndexV1(frame, "frame"); assertPositiveInteger(ticksPerSecond, "tick rate");
  return toSafe(divide(BigInt(frame) * BigInt(ticksPerSecond) * BigInt(rate.denominator), BigInt(rate.numerator), mode), "ticks");
}

export function ticksToFrameV1(ticks: number, rate: RationalRateV1, ticksPerSecond: number, mode: ClockRoundingV1 = "floor"): number {
  assertRate(rate); assertSafeIndexV1(ticks, "ticks"); assertPositiveInteger(ticksPerSecond, "tick rate");
  return toSafe(divide(BigInt(ticks) * BigInt(rate.numerator), BigInt(ticksPerSecond) * BigInt(rate.denominator), mode), "frame");
}

/** Samples in a (float) duration. */
export function secondsToSamplesV1(seconds: number, sampleRate: number, mode: ClockRoundingV1 = "round"): number {
  assertPositiveInteger(sampleRate, "sample rate");
  if (!Number.isFinite(seconds) || seconds < 0) refuse("time must be a finite non-negative number of seconds", { seconds });
  const exact = seconds * sampleRate, nearest = Math.round(exact);
  const value = Math.abs(exact - nearest) <= 1e-6 ? nearest : mode === "floor" ? Math.floor(exact) : mode === "ceil" ? Math.ceil(exact) : nearest;
  return assertSafeIndexV1(value, "samples");
}

/**
 * Exact sample placement of a clip, computed once (C6). Frame-aligned clips derive both edges from absolute frame
 * boundaries, so adjacent clips tile with no gap, no overlap and no per-window re-rounding at any duration.
 */
export function clipSamplePlacementV1(input: { timelineStartSeconds: number; durationSeconds: number; sampleRate: number; frameRate?: RationalRateV1 }): { startSample: number; sampleCount: number; frameAligned: boolean } {
  const { timelineStartSeconds, durationSeconds, sampleRate, frameRate } = input;
  if (frameRate) {
    assertRate(frameRate);
    const start = timelineStartSeconds * frameRate.numerator / frameRate.denominator;
    const end = (timelineStartSeconds + durationSeconds) * frameRate.numerator / frameRate.denominator;
    if (Number.isFinite(start) && Number.isFinite(end) && Math.abs(start - Math.round(start)) <= 1e-6 && Math.abs(end - Math.round(end)) <= 1e-6) {
      const startSample = frameToSampleV1(Math.round(start), frameRate, sampleRate);
      const endSample = frameToSampleV1(Math.round(end), frameRate, sampleRate);
      if (endSample < startSample) refuse("clip ends before it starts", input);
      return { startSample, sampleCount: endSample - startSample, frameAligned: true };
    }
  }
  const startSample = secondsToSamplesV1(timelineStartSeconds, sampleRate);
  const endSample = secondsToSamplesV1(timelineStartSeconds + durationSeconds, sampleRate);
  if (endSample < startSample) refuse("clip ends before it starts", input);
  return { startSample, sampleCount: endSample - startSample, frameAligned: false };
}

/** Consecutive windows of exactly `windowSamples` (the last may be shorter) that tile [0, totalSamples). */
export function sampleWindowsV1(totalSamples: number, windowSamples: number): Array<{ index: number; startSample: number; sampleCount: number }> {
  assertSafeIndexV1(totalSamples, "total samples"); assertPositiveInteger(windowSamples, "window samples");
  const windows: Array<{ index: number; startSample: number; sampleCount: number }> = [];
  for (let startSample = 0, index = 0; startSample < totalSamples; startSample += windowSamples, index += 1) {
    windows.push({ index, startSample, sampleCount: Math.min(windowSamples, totalSamples - startSample) });
  }
  return windows;
}

/** Frame-aligned windows: window k covers frames [k*n, min((k+1)*n, total)) with exact sample edges (C6 audio, C4 chunks). */
export function frameAlignedSampleWindowsV1(totalFrames: number, framesPerWindow: number, rate: RationalRateV1, sampleRate: number): Array<{ index: number; startFrame: number; frameCount: number; startSample: number; sampleCount: number }> {
  assertSafeIndexV1(totalFrames, "total frames"); assertPositiveInteger(framesPerWindow, "frames per window");
  const windows: Array<{ index: number; startFrame: number; frameCount: number; startSample: number; sampleCount: number }> = [];
  for (let startFrame = 0, index = 0; startFrame < totalFrames; startFrame += framesPerWindow, index += 1) {
    const endFrame = Math.min(totalFrames, startFrame + framesPerWindow);
    const startSample = frameToSampleV1(startFrame, rate, sampleRate), endSample = frameToSampleV1(endFrame, rate, sampleRate);
    windows.push({ index, startFrame, frameCount: endFrame - startFrame, startSample, sampleCount: endSample - startSample });
  }
  return windows;
}
