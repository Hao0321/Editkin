export type AlphaQualityCapability = "screen-keyer" | "optical-alpha-refinement";

export const REQUIRED_ALPHA_CASES = Object.freeze({
  "screen-keyer": Object.freeze([
    "green-screen",
    "blue-screen",
    "uneven-lighting",
    "screen-shadow-fold",
    "spill",
    "hair-fur",
    "thin-detail",
    "motion-blur",
    "defocus",
    "semi-transparent",
  ]),
  "optical-alpha-refinement": Object.freeze([
    "hair-fur",
    "glass-veil",
    "smoke",
    "motion-blur",
    "defocus",
    "low-contrast",
    "fast-temporal-edge",
    "thin-detail",
  ]),
} satisfies Record<AlphaQualityCapability, readonly string[]>);

export const REQUIRED_ALPHA_BIT_DEPTHS = Object.freeze([8, 10, 12, 16] as const);

export const ALPHA_QUALITY_THRESHOLDS = Object.freeze({
  minimumClips: 8,
  minimumFrames: 32,
  minimumReviewers: 3,
  minimumBackgroundsPerClip: 3,
  maximumAlphaMad: 0.08,
  maximumAlphaMse: 0.025,
  maximumGradientError: 0.08,
  maximumConnectivityError: 0.08,
  maximumTemporalDtssd: 0.08,
  maximumForegroundRgbMae: 0.08,
  maximumCompositeRgbMae: 0.04,
  maximumSpillResidual: 0.04,
  maximumSpillResidualExcess: 0.02,
  maximumPreviewFormalAlphaMae: 1 / 255,
  maximumPreviewFormalAlphaMax: 1 / 255,
  maximumPreviewFormalForegroundRgbMae: 0.005,
  maximumPreviewFormalCompositeRgbMae: 0.005,
  maximumMeanCorrectionActions: 12,
  maximumMeanCorrectionSeconds: 45,
  minimumCorrectionCompletionRate: 0.95,
  maximumP95LatencyMsPerFrame: 100,
  maximumP95PeakMemoryBytes: 8 * 1024 * 1024 * 1024,
  maximumRuntimeFailureRate: 0.02,
});

export interface ClipAlphaQualityInput {
  width: number;
  height: number;
  frames: number;
  truthAlpha: Float32Array;
  previewAlpha: Float32Array;
  formalAlpha: Float32Array;
  truthForegroundRgb: Float32Array;
  previewForegroundRgb: Float32Array;
  formalForegroundRgb: Float32Array;
  backgroundsRgb: Float32Array[];
  keyChannel?: "green" | "blue";
  spillEvaluationMask?: Float32Array;
}

export interface AlphaQualityMetrics {
  alphaSad: number;
  alphaMad: number;
  alphaMse: number;
  gradientError: number;
  connectivityError: number;
  temporalDtssd: number;
  foregroundRgbMae: number;
  foregroundRgbMse: number;
  multiBackgroundCompositeRgbMae: number;
  multiBackgroundCompositeRgbMse: number;
  spillResidual: number | null;
  spillResidualExcess: number | null;
  previewFormalAlphaMae: number;
  previewFormalAlphaMax: number;
  previewFormalForegroundRgbMae: number;
  previewFormalCompositeRgbMae: number;
}

export interface WeightedAlphaQualityMetrics extends AlphaQualityMetrics {
  weights: {
    pixels: number;
    frames: number;
    temporalSamples: number;
    foreground: number;
    compositeSamples: number;
    spill: number;
  };
}

export interface AlphaQualityFacts extends AlphaQualityMetrics {
  capability: AlphaQualityCapability;
  clipCount: number;
  totalFrames: number;
  uniqueSourceCount: number;
  coverage: string[];
  sourceBitDepths: number[];
  minimumBackgroundsPerClip: number;
  rightsBasis: "owned" | "commercially-permitted" | string;
  commercialUsePermitted: boolean;
  sourceExcludedFromCandidateTraining: boolean;
  candidateFrozenBeforeGroundTruthReveal: boolean;
  evaluatorIndependent: boolean;
  datasetVisibility: string;
  reviewerCount: number;
  meanCorrectionActions: number;
  meanCorrectionSeconds: number;
  correctionCompletionRate: number;
  p95LatencyMsPerFrame: number;
  p95PeakMemoryBytes: number;
  maximumPeakMemoryBytes: number;
  runtimeFailureRate: number;
  allArtifactHashesVerified: boolean;
}

function requireFiniteUnitInterval(values: Float32Array, label: string): void {
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${label} contains a non-finite or out-of-range sample`);
    }
  }
}

function requireLength(values: Float32Array, expected: number, label: string): void {
  if (values.length !== expected) throw new Error(`${label} length ${values.length} does not match ${expected}`);
  requireFiniteUnitInterval(values, label);
}

function alphaGradient(values: Float32Array, frameOffset: number, width: number, height: number, x: number, y: number): number {
  const left = values[frameOffset + y * width + Math.max(0, x - 1)];
  const right = values[frameOffset + y * width + Math.min(width - 1, x + 1)];
  const top = values[frameOffset + Math.max(0, y - 1) * width + x];
  const bottom = values[frameOffset + Math.min(height - 1, y + 1) * width + x];
  return Math.hypot((right - left) / 2, (bottom - top) / 2);
}

function largestSharedComponent(
  candidate: Float32Array,
  truth: Float32Array,
  frameOffset: number,
  width: number,
  height: number,
  threshold: number,
): Uint8Array {
  const pixels = width * height;
  const admitted = new Uint8Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    admitted[pixel] = candidate[frameOffset + pixel] >= threshold && truth[frameOffset + pixel] >= threshold ? 1 : 0;
  }
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let largest: number[] = [];
  for (let seed = 0; seed < pixels; seed += 1) {
    if (!admitted[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    const component: number[] = [];
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const current = queue[head++];
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [current - 1, current + 1, current - width, current + width];
      for (let index = 0; index < neighbors.length; index += 1) {
        const neighbor = neighbors[index];
        if (neighbor < 0 || neighbor >= pixels) continue;
        if (index === 0 && x === 0) continue;
        if (index === 1 && x + 1 === width) continue;
        if (index === 2 && y === 0) continue;
        if (index === 3 && y + 1 === height) continue;
        if (admitted[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const output = new Uint8Array(pixels);
  for (const pixel of largest) output[pixel] = 1;
  return output;
}

function frameConnectivityError(
  candidate: Float32Array,
  truth: Float32Array,
  frameOffset: number,
  width: number,
  height: number,
): number {
  const pixels = width * height;
  const sharedLevel = new Float32Array(pixels);
  sharedLevel.fill(-1);
  for (let step = 1; step <= 10; step += 1) {
    const component = largestSharedComponent(candidate, truth, frameOffset, width, height, step / 10);
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      if (sharedLevel[pixel] < 0 && !component[pixel]) sharedLevel[pixel] = (step - 1) / 10;
    }
  }
  let sum = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const level = sharedLevel[pixel] < 0 ? 1 : sharedLevel[pixel];
    const candidateDelta = candidate[frameOffset + pixel] - level;
    const truthDelta = truth[frameOffset + pixel] - level;
    const candidatePhi = candidateDelta >= 0.15 ? 1 - candidateDelta : 1;
    const truthPhi = truthDelta >= 0.15 ? 1 - truthDelta : 1;
    sum += Math.abs(candidatePhi - truthPhi);
  }
  return sum / pixels;
}

function compositeChannel(foreground: number, alpha: number, background: number): number {
  return foreground * alpha + background * (1 - alpha);
}

function keyDominance(rgb: Float32Array, rgbOffset: number, keyChannel: "green" | "blue"): number {
  if (keyChannel === "green") return Math.max(0, rgb[rgbOffset + 1] - Math.max(rgb[rgbOffset], rgb[rgbOffset + 2]));
  return Math.max(0, rgb[rgbOffset + 2] - Math.max(rgb[rgbOffset], rgb[rgbOffset + 1]));
}

export function computeClipAlphaQuality(input: ClipAlphaQualityInput): WeightedAlphaQualityMetrics {
  const { width, height, frames } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(frames)
    || width < 2 || height < 2 || frames < 2) throw new Error("Alpha quality geometry requires at least 2x2 pixels and two frames");
  const pixels = width * height * frames;
  const rgbSamples = pixels * 3;
  requireLength(input.truthAlpha, pixels, "truthAlpha");
  requireLength(input.previewAlpha, pixels, "previewAlpha");
  requireLength(input.formalAlpha, pixels, "formalAlpha");
  requireLength(input.truthForegroundRgb, rgbSamples, "truthForegroundRgb");
  requireLength(input.previewForegroundRgb, rgbSamples, "previewForegroundRgb");
  requireLength(input.formalForegroundRgb, rgbSamples, "formalForegroundRgb");
  if (input.backgroundsRgb.length < 1) throw new Error("At least one composite background is required");
  for (const [index, background] of input.backgroundsRgb.entries()) requireLength(background, rgbSamples, `backgroundsRgb[${index}]`);
  if ((input.keyChannel === undefined) !== (input.spillEvaluationMask === undefined)) {
    throw new Error("keyChannel and spillEvaluationMask must be supplied together");
  }
  if (input.spillEvaluationMask) requireLength(input.spillEvaluationMask, pixels, "spillEvaluationMask");

  let alphaSad = 0;
  let alphaSquared = 0;
  let gradientSum = 0;
  let connectivitySum = 0;
  let temporalSquared = 0;
  let temporalSamples = 0;
  let foregroundAbsolute = 0;
  let foregroundSquared = 0;
  let foregroundWeight = 0;
  let compositeAbsolute = 0;
  let compositeSquared = 0;
  let compositeSamples = 0;
  let parityAlphaAbsolute = 0;
  let parityAlphaMax = 0;
  let parityForegroundAbsolute = 0;
  let parityCompositeAbsolute = 0;
  let spillResidual = 0;
  let spillResidualExcess = 0;
  let spillWeight = 0;
  const framePixels = width * height;

  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * framePixels;
    connectivitySum += frameConnectivityError(input.previewAlpha, input.truthAlpha, frameOffset, width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = frameOffset + y * width + x;
        const rgbOffset = pixel * 3;
        const truthAlpha = input.truthAlpha[pixel];
        const previewAlpha = input.previewAlpha[pixel];
        const formalAlpha = input.formalAlpha[pixel];
        const alphaDifference = previewAlpha - truthAlpha;
        alphaSad += Math.abs(alphaDifference);
        alphaSquared += alphaDifference ** 2;
        gradientSum += Math.abs(
          alphaGradient(input.previewAlpha, frameOffset, width, height, x, y)
          - alphaGradient(input.truthAlpha, frameOffset, width, height, x, y),
        );
        const parityAlpha = Math.abs(previewAlpha - formalAlpha);
        parityAlphaAbsolute += parityAlpha;
        parityAlphaMax = Math.max(parityAlphaMax, parityAlpha);
        if (frame > 0) {
          const prior = pixel - framePixels;
          const previewDelta = previewAlpha - input.previewAlpha[prior];
          const truthDelta = truthAlpha - input.truthAlpha[prior];
          temporalSquared += (previewDelta - truthDelta) ** 2;
          temporalSamples += 1;
        }
        const visibleWeight = truthAlpha;
        foregroundWeight += visibleWeight * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          const truthForeground = input.truthForegroundRgb[rgbOffset + channel];
          const previewForeground = input.previewForegroundRgb[rgbOffset + channel];
          const formalForeground = input.formalForegroundRgb[rgbOffset + channel];
          const foregroundDifference = previewForeground - truthForeground;
          foregroundAbsolute += Math.abs(foregroundDifference) * visibleWeight;
          foregroundSquared += foregroundDifference ** 2 * visibleWeight;
          parityForegroundAbsolute += Math.abs(previewForeground - formalForeground) * visibleWeight;
          for (const background of input.backgroundsRgb) {
            const truthComposite = compositeChannel(truthForeground, truthAlpha, background[rgbOffset + channel]);
            const previewComposite = compositeChannel(previewForeground, previewAlpha, background[rgbOffset + channel]);
            const formalComposite = compositeChannel(formalForeground, formalAlpha, background[rgbOffset + channel]);
            const compositeDifference = previewComposite - truthComposite;
            compositeAbsolute += Math.abs(compositeDifference);
            compositeSquared += compositeDifference ** 2;
            parityCompositeAbsolute += Math.abs(previewComposite - formalComposite);
            compositeSamples += 1;
          }
        }
        if (input.spillEvaluationMask && input.keyChannel) {
          const weight = input.spillEvaluationMask[pixel];
          if (weight > 0) {
            const candidateDominance = keyDominance(input.previewForegroundRgb, rgbOffset, input.keyChannel);
            const truthDominance = keyDominance(input.truthForegroundRgb, rgbOffset, input.keyChannel);
            spillResidual += candidateDominance * weight;
            spillResidualExcess += Math.max(0, candidateDominance - truthDominance) * weight;
            spillWeight += weight;
          }
        }
      }
    }
  }
  if (!(foregroundWeight > 0)) throw new Error("Truth alpha contains no evaluable foreground");
  if (input.spillEvaluationMask && !(spillWeight > 0)) throw new Error("Spill evaluation mask contains no weighted samples");
  return {
    alphaSad,
    alphaMad: alphaSad / pixels,
    alphaMse: alphaSquared / pixels,
    gradientError: gradientSum / pixels,
    connectivityError: connectivitySum / frames,
    temporalDtssd: Math.sqrt(temporalSquared / temporalSamples),
    foregroundRgbMae: foregroundAbsolute / foregroundWeight,
    foregroundRgbMse: foregroundSquared / foregroundWeight,
    multiBackgroundCompositeRgbMae: compositeAbsolute / compositeSamples,
    multiBackgroundCompositeRgbMse: compositeSquared / compositeSamples,
    spillResidual: input.spillEvaluationMask ? spillResidual / spillWeight : null,
    spillResidualExcess: input.spillEvaluationMask ? spillResidualExcess / spillWeight : null,
    previewFormalAlphaMae: parityAlphaAbsolute / pixels,
    previewFormalAlphaMax: parityAlphaMax,
    previewFormalForegroundRgbMae: parityForegroundAbsolute / foregroundWeight,
    previewFormalCompositeRgbMae: parityCompositeAbsolute / compositeSamples,
    weights: { pixels, frames, temporalSamples, foreground: foregroundWeight, compositeSamples, spill: spillWeight },
  };
}

function weightedMean(values: WeightedAlphaQualityMetrics[], key: keyof AlphaQualityMetrics, weight: keyof WeightedAlphaQualityMetrics["weights"]): number {
  let numerator = 0;
  let denominator = 0;
  for (const value of values) {
    const metric = value[key];
    const metricWeight = value.weights[weight];
    if (metric === null || metricWeight <= 0) continue;
    numerator += metric * metricWeight;
    denominator += metricWeight;
  }
  return denominator ? numerator / denominator : Number.NaN;
}

export function aggregateAlphaQualityMetrics(values: WeightedAlphaQualityMetrics[]): AlphaQualityMetrics {
  if (!values.length) throw new Error("At least one clip metric is required");
  const spillValues = values.filter((value) => value.spillResidual !== null);
  return {
    alphaSad: values.reduce((sum, value) => sum + value.alphaSad, 0),
    alphaMad: weightedMean(values, "alphaMad", "pixels"),
    alphaMse: weightedMean(values, "alphaMse", "pixels"),
    gradientError: weightedMean(values, "gradientError", "pixels"),
    connectivityError: weightedMean(values, "connectivityError", "frames"),
    temporalDtssd: Math.sqrt(weightedMean(values.map((value) => ({ ...value, temporalDtssd: value.temporalDtssd ** 2 })), "temporalDtssd", "temporalSamples")),
    foregroundRgbMae: weightedMean(values, "foregroundRgbMae", "foreground"),
    foregroundRgbMse: weightedMean(values, "foregroundRgbMse", "foreground"),
    multiBackgroundCompositeRgbMae: weightedMean(values, "multiBackgroundCompositeRgbMae", "compositeSamples"),
    multiBackgroundCompositeRgbMse: weightedMean(values, "multiBackgroundCompositeRgbMse", "compositeSamples"),
    spillResidual: spillValues.length ? weightedMean(spillValues, "spillResidual", "spill") : null,
    spillResidualExcess: spillValues.length ? weightedMean(spillValues, "spillResidualExcess", "spill") : null,
    previewFormalAlphaMae: weightedMean(values, "previewFormalAlphaMae", "pixels"),
    previewFormalAlphaMax: Math.max(...values.map((value) => value.previewFormalAlphaMax)),
    previewFormalForegroundRgbMae: weightedMean(values, "previewFormalForegroundRgbMae", "foreground"),
    previewFormalCompositeRgbMae: weightedMean(values, "previewFormalCompositeRgbMae", "compositeSamples"),
  };
}

export function evaluateAlphaQualityAcceptance(facts: AlphaQualityFacts): string[] {
  const failures: string[] = [];
  const numeric = [
    facts.alphaSad,
    facts.alphaMad,
    facts.alphaMse,
    facts.gradientError,
    facts.connectivityError,
    facts.temporalDtssd,
    facts.foregroundRgbMae,
    facts.foregroundRgbMse,
    facts.multiBackgroundCompositeRgbMae,
    facts.multiBackgroundCompositeRgbMse,
    facts.previewFormalAlphaMae,
    facts.previewFormalAlphaMax,
    facts.previewFormalForegroundRgbMae,
    facts.previewFormalCompositeRgbMae,
    facts.meanCorrectionActions,
    facts.meanCorrectionSeconds,
    facts.correctionCompletionRate,
    facts.p95LatencyMsPerFrame,
    facts.p95PeakMemoryBytes,
    facts.maximumPeakMemoryBytes,
    facts.runtimeFailureRate,
  ];
  if (facts.spillResidual !== null) numeric.push(facts.spillResidual);
  if (facts.spillResidualExcess !== null) numeric.push(facts.spillResidualExcess);
  if (numeric.some((value) => !Number.isFinite(value))) failures.push("non-finite-metric");
  if (facts.clipCount < ALPHA_QUALITY_THRESHOLDS.minimumClips) failures.push("clip-count");
  if (facts.totalFrames < ALPHA_QUALITY_THRESHOLDS.minimumFrames) failures.push("frame-count");
  if (facts.uniqueSourceCount !== facts.clipCount) failures.push("unique-source-identity");
  for (const category of REQUIRED_ALPHA_CASES[facts.capability]) {
    if (!facts.coverage.includes(category)) failures.push(`coverage:${category}`);
  }
  for (const bitDepth of REQUIRED_ALPHA_BIT_DEPTHS) {
    if (!facts.sourceBitDepths.includes(bitDepth)) failures.push(`bit-depth:${bitDepth}`);
  }
  if (facts.minimumBackgroundsPerClip < ALPHA_QUALITY_THRESHOLDS.minimumBackgroundsPerClip) failures.push("multi-background-count");
  if (!(["owned", "commercially-permitted"] as string[]).includes(facts.rightsBasis)) failures.push("rights-basis");
  if (!facts.commercialUsePermitted) failures.push("commercial-use-rights");
  if (!facts.sourceExcludedFromCandidateTraining) failures.push("training-holdout-separation");
  if (!facts.candidateFrozenBeforeGroundTruthReveal) failures.push("candidate-freeze-order");
  if (!facts.evaluatorIndependent) failures.push("independent-evaluator");
  if (facts.datasetVisibility !== "blind-holdout") failures.push("blind-holdout");
  if (facts.reviewerCount < ALPHA_QUALITY_THRESHOLDS.minimumReviewers) failures.push("reviewer-count");
  if (facts.alphaMad > ALPHA_QUALITY_THRESHOLDS.maximumAlphaMad) failures.push("alpha-mad");
  if (facts.alphaMse > ALPHA_QUALITY_THRESHOLDS.maximumAlphaMse) failures.push("alpha-mse");
  if (facts.gradientError > ALPHA_QUALITY_THRESHOLDS.maximumGradientError) failures.push("gradient-error");
  if (facts.connectivityError > ALPHA_QUALITY_THRESHOLDS.maximumConnectivityError) failures.push("connectivity-error");
  if (facts.temporalDtssd > ALPHA_QUALITY_THRESHOLDS.maximumTemporalDtssd) failures.push("temporal-dtssd");
  if (facts.foregroundRgbMae > ALPHA_QUALITY_THRESHOLDS.maximumForegroundRgbMae) failures.push("foreground-rgb-mae");
  if (facts.multiBackgroundCompositeRgbMae > ALPHA_QUALITY_THRESHOLDS.maximumCompositeRgbMae) failures.push("multi-background-composite-rgb-mae");
  if (facts.capability === "screen-keyer") {
    if (facts.spillResidual === null || facts.spillResidualExcess === null) failures.push("spill-evidence-missing");
    if (facts.spillResidual !== null && facts.spillResidual > ALPHA_QUALITY_THRESHOLDS.maximumSpillResidual) failures.push("spill-residual");
    if (facts.spillResidualExcess !== null && facts.spillResidualExcess > ALPHA_QUALITY_THRESHOLDS.maximumSpillResidualExcess) failures.push("spill-residual-excess");
  } else if (facts.spillResidual !== null || facts.spillResidualExcess !== null) {
    failures.push("spill-evidence-unexpected");
  }
  if (facts.previewFormalAlphaMae > ALPHA_QUALITY_THRESHOLDS.maximumPreviewFormalAlphaMae) failures.push("preview-formal-alpha-mae");
  if (facts.previewFormalAlphaMax > ALPHA_QUALITY_THRESHOLDS.maximumPreviewFormalAlphaMax) failures.push("preview-formal-alpha-max");
  if (facts.previewFormalForegroundRgbMae > ALPHA_QUALITY_THRESHOLDS.maximumPreviewFormalForegroundRgbMae) failures.push("preview-formal-foreground-rgb-mae");
  if (facts.previewFormalCompositeRgbMae > ALPHA_QUALITY_THRESHOLDS.maximumPreviewFormalCompositeRgbMae) failures.push("preview-formal-composite-rgb-mae");
  if (facts.meanCorrectionActions > ALPHA_QUALITY_THRESHOLDS.maximumMeanCorrectionActions) failures.push("correction-actions");
  if (facts.meanCorrectionSeconds > ALPHA_QUALITY_THRESHOLDS.maximumMeanCorrectionSeconds) failures.push("correction-seconds");
  if (facts.correctionCompletionRate < ALPHA_QUALITY_THRESHOLDS.minimumCorrectionCompletionRate) failures.push("correction-completion-rate");
  if (facts.p95LatencyMsPerFrame > ALPHA_QUALITY_THRESHOLDS.maximumP95LatencyMsPerFrame) failures.push("latency-p95");
  if (facts.p95PeakMemoryBytes > ALPHA_QUALITY_THRESHOLDS.maximumP95PeakMemoryBytes) failures.push("memory-p95");
  if (facts.runtimeFailureRate > ALPHA_QUALITY_THRESHOLDS.maximumRuntimeFailureRate) failures.push("runtime-failure-rate");
  if (!facts.allArtifactHashesVerified) failures.push("artifact-hash-verification");
  return failures;
}
