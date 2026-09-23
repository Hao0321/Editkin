/** A bounded RGB measurement instrument, not a white-point detector or grading policy. */
export const SHOT_COLOR_LIMITS = Object.freeze({ pixelsPerFrame: 1_048_576, frames: 16, totalPixels: 4_194_304, histogramBins: 4096 });
export type ShotColorTransfer = "srgb" | "bt709-oetf" | "linear";
export interface ShotColorFrame {
  sampleId: string;
  timeSeconds: number;
  width: number;
  height: number;
  format: "rgb8" | "rgb32f";
  /** Caller must supply a verified interpretation, not infer it from bright pixels. */
  primaries: "bt709";
  transfer: ShotColorTransfer;
  range: "full";
  pixels: Uint8Array | Float32Array;
}
export interface ShotColorThresholds {
  nearBlackY: number;
  nearWhiteY: number;
  neutralMaximumRelativeSpread: number;
  neutralMinimumY: number;
  neutralMaximumY: number;
}
export const DEFAULT_SHOT_COLOR_THRESHOLDS: Readonly<ShotColorThresholds> = Object.freeze({
  nearBlackY: 0.01, nearWhiteY: 0.98,
  neutralMaximumRelativeSpread: 0.04, neutralMinimumY: 0.05, neutralMaximumY: 0.8,
});
export class ShotColorAnalysisError extends Error {
  readonly code = "SHOT_COLOR_INPUT_INVALID";
}
interface Distribution {
  minimum: number; maximum: number; mean: number;
  p01: number; p05: number; p50: number; p95: number; p99: number;
}
interface CountRate { count: number; fraction: number }
export interface FrameColorMeasurement {
  sampleId: string; timeSeconds: number; pixelCount: number;
  linearRelativeY: Distribution;
  nearBlack: CountRate; nearWhite: CountRate;
  /** Stored-surface endpoint occupancy; not evidence of original sensor clipping. */
  encodedEndpoints: { low: [CountRate, CountRate, CountRate]; high: [CountRate, CountRate, CountRate]; anyLow: CountRate; anyHigh: CountRate };
  relativeLinearChroma: Distribution;
  neutralCandidates: CountRate & { meanLinearRgb: [number, number, number] | null; trustedWhitePoint: false };
}
export interface ShotColorAnalysis {
  status: "measured";
  scope: "provided-representative-rgb-surfaces-only";
  interpretation: { primaries: "bt709"; transfer: ShotColorTransfer; range: "full"; format: "rgb8" | "rgb32f" };
  thresholds: ShotColorThresholds;
  quantiles: { method: "nearest-rank-histogram-lower-edge"; bins: number; maximumAbsoluteBinError: number };
  frames: FrameColorMeasurement[];
  changes: Array<{ fromSampleId: string; toSampleId: string; elapsedSeconds: number; meanAbsoluteLinearRgbDifference: number; meanYDifference: number; medianYDifference: number; nearWhiteFractionDifference: number; meanChromaDifference: number }>;
  advice: {
    exposure: { status: "unmeasured"; reason: "scene-intent-and-exposure-target-not-verified" };
    whiteBalance: { status: "unmeasured"; reason: "no-trusted-neutral-reference-or-illuminant" };
  };
}

function reject(reason: string): never { throw new ShotColorAnalysisError(reason); }
function unit(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function validateThresholds(value: ShotColorThresholds): void {
  if (!value || !Object.values(value).every(unit)
    || !unit(value.nearBlackY) || !unit(value.nearWhiteY) || !unit(value.neutralMaximumRelativeSpread)
    || !unit(value.neutralMinimumY) || !unit(value.neutralMaximumY)
    || value.nearBlackY >= value.nearWhiteY || value.neutralMinimumY <= value.nearBlackY
    || value.neutralMaximumY >= value.nearWhiteY || value.neutralMinimumY >= value.neutralMaximumY) reject("Invalid or overlapping measurement thresholds");
}
function linearize(value: number, transfer: ShotColorTransfer): number {
  if (transfer === "linear") return value;
  if (transfer === "srgb") return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  // Explicit inverse Rec709 OETF; not a calibrated display EOTF or absolute nits.
  return value < 0.081 ? value / 4.5 : ((value + 0.099) / 1.099) ** (1 / 0.45);
}
function quantile(histogram: Uint32Array, count: number, q: number): number {
  const rank = Math.max(1, Math.ceil(q * count));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    cumulative += histogram[bin];
    if (cumulative >= rank) return bin / (histogram.length - 1);
  }
  return reject("Measurement histogram is incomplete");
}
function distribution(histogram: Uint32Array, count: number, minimum: number, maximum: number, sum: number): Distribution {
  return { minimum, maximum, mean: sum / count,
    p01: quantile(histogram, count, .01), p05: quantile(histogram, count, .05), p50: quantile(histogram, count, .5), p95: quantile(histogram, count, .95), p99: quantile(histogram, count, .99) };
}

export function analyzeShotColor(frames: readonly ShotColorFrame[], thresholds: ShotColorThresholds = DEFAULT_SHOT_COLOR_THRESHOLDS): ShotColorAnalysis {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > SHOT_COLOR_LIMITS.frames) reject("Expected 1..16 representative frames");
  validateThresholds(thresholds);
  const ids = new Set<string>();
  let totalPixels = 0;
  // Validate the entire batch before allocating per-frame working buffers.
  for (const [index, frame] of frames.entries()) {
    if (!frame || typeof frame.sampleId !== "string" || !frame.sampleId.trim() || frame.sampleId.length > 128 || ids.has(frame.sampleId)) reject("Frame sample IDs must be unique nonempty strings");
    ids.add(frame.sampleId);
    if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0 || (index > 0 && frame.timeSeconds <= frames[index - 1].timeSeconds)) reject("Frame times must be finite and strictly increasing");
    if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1
      || !Number.isSafeInteger(frame.width * frame.height) || frame.width * frame.height > SHOT_COLOR_LIMITS.pixelsPerFrame) reject("Invalid or oversized RGB dimensions");
    const count = frame.width * frame.height;
    totalPixels += count;
    if (totalPixels > SHOT_COLOR_LIMITS.totalPixels) reject("Representative-frame pixel budget exceeded");
    if (frame.primaries !== "bt709" || frame.range !== "full" || !["srgb", "bt709-oetf", "linear"].includes(frame.transfer)) reject("Explicit supported RGB interpretation required");
    if (!((frame.format === "rgb8" && frame.pixels instanceof Uint8Array) || (frame.format === "rgb32f" && frame.pixels instanceof Float32Array))) reject("Pixel buffer type does not match packed RGB format");
    if (typeof SharedArrayBuffer !== "undefined" && frame.pixels.buffer instanceof SharedArrayBuffer) reject("Concurrent shared RGB buffers are unsupported");
    if (frame.pixels.length !== count * 3) reject("Packed RGB buffer length does not match dimensions (no implicit alpha or stride)");
    if (index > 0 && ["width", "height", "format", "primaries", "transfer", "range"].some(key => frame[key as keyof ShotColorFrame] !== frames[0][key as keyof ShotColorFrame])) reject("Representative frames require matching geometry and interpretation");
    if (frame.format === "rgb32f") for (const value of frame.pixels) if (!unit(value)) reject("Float RGB must contain finite normalized values; HDR/out-of-gamut surfaces require another instrument");
  }
  const measurements: FrameColorMeasurement[] = [], changes: ShotColorAnalysis["changes"] = [];
  let previousLinear: Float32Array | undefined;
  for (const frame of frames) {
    const count = frame.width * frame.height, bins = SHOT_COLOR_LIMITS.histogramBins;
    const yHistogram = new Uint32Array(bins), chromaHistogram = new Uint32Array(bins), currentLinear = new Float32Array(count * 3);
    const low = [0, 0, 0], high = [0, 0, 0], neutralSum = [0, 0, 0];
    let ySum = 0, yMin = Infinity, yMax = -Infinity, chromaSum = 0, chromaMin = Infinity, chromaMax = -Infinity;
    let black = 0, white = 0, anyLow = 0, anyHigh = 0, neutral = 0, difference = 0;
    const denominator = frame.format === "rgb8" ? 255 : 1;
    for (let pixel = 0; pixel < count; pixel++) {
      const offset = pixel * 3;
      let pixelLow = false, pixelHigh = false;
      for (let channel = 0; channel < 3; channel++) {
        const encoded = frame.pixels[offset + channel] / denominator;
        if (encoded === 0) { low[channel]++; pixelLow = true; }
        if (encoded === 1) { high[channel]++; pixelHigh = true; }
        currentLinear[offset + channel] = linearize(encoded, frame.transfer);
        if (previousLinear) difference += Math.abs(currentLinear[offset + channel] - previousLinear[offset + channel]);
      }
      if (pixelLow) anyLow++;
      if (pixelHigh) anyHigh++;
      const r = currentLinear[offset], g = currentLinear[offset + 1], b = currentLinear[offset + 2];
      const y = Math.min(1, Math.max(0, .2126 * r + .7152 * g + .0722 * b));
      const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
      const chroma = maximum === 0 ? 0 : (maximum - minimum) / maximum;
      yHistogram[Math.floor(y * (bins - 1))]++; chromaHistogram[Math.floor(chroma * (bins - 1))]++;
      ySum += y; yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      chromaSum += chroma; chromaMin = Math.min(chromaMin, chroma); chromaMax = Math.max(chromaMax, chroma);
      if (y <= thresholds.nearBlackY) black++;
      if (y >= thresholds.nearWhiteY) white++;
      if (y >= thresholds.neutralMinimumY && y <= thresholds.neutralMaximumY && chroma <= thresholds.neutralMaximumRelativeSpread) {
        neutral++; neutralSum[0] += r; neutralSum[1] += g; neutralSum[2] += b;
      }
    }
    const rate = (value: number): CountRate => ({ count: value, fraction: value / count });
    const measurement: FrameColorMeasurement = {
      sampleId: frame.sampleId, timeSeconds: frame.timeSeconds, pixelCount: count,
      linearRelativeY: distribution(yHistogram, count, yMin, yMax, ySum), nearBlack: rate(black), nearWhite: rate(white),
      encodedEndpoints: { low: low.map(rate) as [CountRate, CountRate, CountRate], high: high.map(rate) as [CountRate, CountRate, CountRate], anyLow: rate(anyLow), anyHigh: rate(anyHigh) },
      relativeLinearChroma: distribution(chromaHistogram, count, chromaMin, chromaMax, chromaSum),
      neutralCandidates: { ...rate(neutral), meanLinearRgb: neutral ? neutralSum.map(value => value / neutral) as [number, number, number] : null, trustedWhitePoint: false },
    };
    const previous = measurements.at(-1);
    if (previous) changes.push({ fromSampleId: previous.sampleId, toSampleId: measurement.sampleId, elapsedSeconds: measurement.timeSeconds - previous.timeSeconds,
      meanAbsoluteLinearRgbDifference: difference / (count * 3), meanYDifference: measurement.linearRelativeY.mean - previous.linearRelativeY.mean,
      medianYDifference: measurement.linearRelativeY.p50 - previous.linearRelativeY.p50, nearWhiteFractionDifference: measurement.nearWhite.fraction - previous.nearWhite.fraction,
      meanChromaDifference: measurement.relativeLinearChroma.mean - previous.relativeLinearChroma.mean });
    measurements.push(measurement); previousLinear = currentLinear;
  }
  const first = frames[0];
  return { status: "measured", scope: "provided-representative-rgb-surfaces-only",
    interpretation: { primaries: first.primaries, transfer: first.transfer, range: first.range, format: first.format }, thresholds: { ...thresholds },
    quantiles: { method: "nearest-rank-histogram-lower-edge", bins: SHOT_COLOR_LIMITS.histogramBins, maximumAbsoluteBinError: 1 / (SHOT_COLOR_LIMITS.histogramBins - 1) },
    frames: measurements, changes,
    advice: { exposure: { status: "unmeasured", reason: "scene-intent-and-exposure-target-not-verified" }, whiteBalance: { status: "unmeasured", reason: "no-trusted-neutral-reference-or-illuminant" } } };
}
