import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SCHEMA = "editkin.roto-quality-holdout/v1";
const REPORT_SCHEMA = "editkin.roto-quality-acceptance-report/v1";
const APP_ROOT = resolve(import.meta.dirname, "..");
const SELF_TEST_REPORT = join(APP_ROOT, ".rd", "benchmarks", "editkin-roto-quality-evaluator", "self-test.json");
const REQUIRED_COVERAGE = [
  "hair-fur",
  "thin-detail",
  "motion-blur",
  "similar-distractor",
  "full-occlusion",
  "reappearance",
  "scene-cut",
  "multi-object",
  "transparent-edge",
  "long-duration",
] as const;

interface ArtifactRef {
  path: string;
  sha256: string;
}

interface HoldoutClip {
  id: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  categories: string[];
  source: ArtifactRef;
  truthAlpha8: ArtifactRef;
  candidateAlpha8: ArtifactRef;
  formalAlpha8: ArtifactRef;
  truthLabels8?: ArtifactRef;
  candidateLabels8?: ArtifactRef;
}

interface RightsReceipt {
  schema: "editkin.holdout-rights-receipt/v1";
  datasetId: string;
  commercialUsePermitted: boolean;
  sourceSeparatedFromTraining: boolean;
  ownerOrLicense: string;
}

interface CorrectionJournal {
  schema: "editkin.roto-correction-journal/v1";
  reviewerIds: string[];
  entries: Array<{ clipId: string; reviewerId: string; actions: number; seconds: number; completed: boolean }>;
}

interface PerformanceReceipt {
  schema: "editkin.roto-performance-receipt/v1";
  deviceIdentity: string;
  samples: Array<{ clipId: string; frames: number; elapsedMs: number; peakVramBytes: number; failed: boolean }>;
}

interface HoldoutManifest {
  schema: string;
  frozenAt: string;
  candidateEngine: string;
  candidateImplementationSha256: string;
  algorithmFrozenBeforeGroundTruthReveal: boolean;
  evaluatorIndependent: boolean;
  datasetVisibility: string;
  rightsReceipt: ArtifactRef;
  correctionJournal: ArtifactRef;
  performanceReceipt: ArtifactRef;
  clips: HoldoutClip[];
}

interface SequenceMetrics {
  jMean: number;
  boundaryFMean: number;
  alphaMad: number;
  alphaMse: number;
  gradientError: number;
  connectivityError: number;
  temporalDtssd: number;
  previewFormalMeanCodeError: number;
  previewFormalMaxCodeError: number;
}

interface AcceptanceFacts extends SequenceMetrics {
  clipCount: number;
  totalFrames: number;
  uniqueSourceCount: number;
  coverage: string[];
  rightsCommercialUsePermitted: boolean;
  sourceSeparatedFromTraining: boolean;
  algorithmFrozenBeforeGroundTruthReveal: boolean;
  evaluatorIndependent: boolean;
  datasetVisibility: string;
  reviewerCount: number;
  meanCorrectionActions: number;
  meanCorrectionSeconds: number;
  correctionCompletionRate: number;
  p95LatencyMsPerFrame: number;
  peakVramBytes: number;
  runtimeFailureRate: number;
  idSwitches: number;
  lostObjectFrameRate: number;
  maxReacquisitionFrames: number;
  allArtifactHashesVerified: boolean;
}

const THRESHOLDS = Object.freeze({
  minimumClips: 8,
  minimumFrames: 240,
  minimumReviewers: 3,
  minimumJMean: 0.82,
  minimumBoundaryFMean: 0.8,
  maximumAlphaMad: 0.08,
  maximumAlphaMse: 0.025,
  maximumGradientError: 0.08,
  maximumConnectivityError: 0.08,
  maximumTemporalDtssd: 0.08,
  maximumPreviewFormalMeanCodeError: 0.25,
  maximumPreviewFormalMaxCodeError: 1,
  maximumMeanCorrectionActions: 12,
  maximumMeanCorrectionSeconds: 45,
  minimumCorrectionCompletionRate: 0.95,
  maximumP95LatencyMsPerFrame: 100,
  maximumRuntimeFailureRate: 0.02,
  maximumIdSwitches: 0,
  maximumLostObjectFrameRate: 0.05,
  maximumReacquisitionFrames: 3,
});

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function alphaAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] / 255;
}

function jaccard(predicted: Uint8Array, truth: Uint8Array, frameOffset: number, frameBytes: number): number {
  let intersection = 0;
  let union = 0;
  for (let pixel = 0; pixel < frameBytes; pixel += 1) {
    const candidate = predicted[frameOffset + pixel] >= 128;
    const expected = truth[frameOffset + pixel] >= 128;
    if (candidate && expected) intersection += 1;
    if (candidate || expected) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

function boundaryMap(bytes: Uint8Array, frameOffset: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height);
  const foreground = (x: number, y: number) => bytes[frameOffset + y * width + x] >= 128;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = foreground(x, y);
      if ((x > 0 && foreground(x - 1, y) !== value)
        || (x + 1 < width && foreground(x + 1, y) !== value)
        || (y > 0 && foreground(x, y - 1) !== value)
        || (y + 1 < height && foreground(x, y + 1) !== value)) {
        output[y * width + x] = 1;
      }
    }
  }
  return output;
}

function withinBoundary(boundary: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const sampleX = x + dx;
      const sampleY = y + dy;
      if (sampleX >= 0 && sampleY >= 0 && sampleX < width && sampleY < height && boundary[sampleY * width + sampleX]) return true;
    }
  }
  return false;
}

function boundaryF(predicted: Uint8Array, truth: Uint8Array, frameOffset: number, width: number, height: number): number {
  const candidate = boundaryMap(predicted, frameOffset, width, height);
  const expected = boundaryMap(truth, frameOffset, width, height);
  const radius = Math.max(1, Math.ceil(Math.hypot(width, height) * 0.0075));
  let candidateCount = 0;
  let expectedCount = 0;
  let candidateMatches = 0;
  let expectedMatches = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (candidate[index]) {
        candidateCount += 1;
        if (withinBoundary(expected, width, height, x, y, radius)) candidateMatches += 1;
      }
      if (expected[index]) {
        expectedCount += 1;
        if (withinBoundary(candidate, width, height, x, y, radius)) expectedMatches += 1;
      }
    }
  }
  if (candidateCount === 0 && expectedCount === 0) return 1;
  const precision = candidateCount ? candidateMatches / candidateCount : 0;
  const recall = expectedCount ? expectedMatches / expectedCount : 0;
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
}

function gradientMagnitude(bytes: Uint8Array, frameOffset: number, width: number, height: number, x: number, y: number): number {
  const left = alphaAt(bytes, frameOffset + y * width + Math.max(0, x - 1));
  const right = alphaAt(bytes, frameOffset + y * width + Math.min(width - 1, x + 1));
  const top = alphaAt(bytes, frameOffset + Math.max(0, y - 1) * width + x);
  const bottom = alphaAt(bytes, frameOffset + Math.min(height - 1, y + 1) * width + x);
  return Math.hypot((right - left) / 2, (bottom - top) / 2);
}

function largestIntersectionComponent(
  predicted: Uint8Array,
  truth: Uint8Array,
  frameOffset: number,
  width: number,
  height: number,
  threshold: number,
): Uint8Array {
  const frameBytes = width * height;
  const admitted = new Uint8Array(frameBytes);
  for (let pixel = 0; pixel < frameBytes; pixel += 1) {
    admitted[pixel] = alphaAt(predicted, frameOffset + pixel) >= threshold && alphaAt(truth, frameOffset + pixel) >= threshold ? 1 : 0;
  }
  const visited = new Uint8Array(frameBytes);
  let largest: number[] = [];
  const queue = new Int32Array(frameBytes);
  for (let seed = 0; seed < frameBytes; seed += 1) {
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
        if (neighbor < 0 || neighbor >= frameBytes) continue;
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
  const mask = new Uint8Array(frameBytes);
  for (const pixel of largest) mask[pixel] = 1;
  return mask;
}

function connectivityError(predicted: Uint8Array, truth: Uint8Array, frameOffset: number, width: number, height: number): number {
  const frameBytes = width * height;
  const level = new Float32Array(frameBytes);
  level.fill(-1);
  for (let step = 1; step <= 10; step += 1) {
    const threshold = step / 10;
    const largest = largestIntersectionComponent(predicted, truth, frameOffset, width, height, threshold);
    for (let pixel = 0; pixel < frameBytes; pixel += 1) {
      if (level[pixel] < 0 && !largest[pixel]) level[pixel] = (step - 1) / 10;
    }
  }
  let total = 0;
  for (let pixel = 0; pixel < frameBytes; pixel += 1) {
    const sharedLevel = level[pixel] < 0 ? 1 : level[pixel];
    const candidateDelta = alphaAt(predicted, frameOffset + pixel) - sharedLevel;
    const truthDelta = alphaAt(truth, frameOffset + pixel) - sharedLevel;
    const candidatePhi = candidateDelta >= 0.15 ? 1 - candidateDelta : 1;
    const truthPhi = truthDelta >= 0.15 ? 1 - truthDelta : 1;
    total += Math.abs(candidatePhi - truthPhi);
  }
  return total / frameBytes;
}

export function computeSequenceMetrics(
  predicted: Uint8Array,
  truth: Uint8Array,
  formal: Uint8Array,
  width: number,
  height: number,
  frames: number,
): SequenceMetrics {
  const frameBytes = width * height;
  const expectedBytes = frameBytes * frames;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(frames)
    || width <= 0 || height <= 0 || frames <= 0 || predicted.length !== expectedBytes
    || truth.length !== expectedBytes || formal.length !== expectedBytes) {
    throw new Error("Alpha sequence dimensions or byte counts are invalid");
  }
  const perFrameJ: number[] = [];
  const perFrameF: number[] = [];
  const perFrameConnectivity: number[] = [];
  let absolute = 0;
  let squared = 0;
  let gradient = 0;
  let temporalSquared = 0;
  let temporalSamples = 0;
  let formalAbsoluteCodes = 0;
  let formalMaxCode = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * frameBytes;
    perFrameJ.push(jaccard(predicted, truth, frameOffset, frameBytes));
    perFrameF.push(boundaryF(predicted, truth, frameOffset, width, height));
    perFrameConnectivity.push(connectivityError(predicted, truth, frameOffset, width, height));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = frameOffset + y * width + x;
        const difference = alphaAt(predicted, index) - alphaAt(truth, index);
        absolute += Math.abs(difference);
        squared += difference * difference;
        gradient += Math.abs(
          gradientMagnitude(predicted, frameOffset, width, height, x, y)
          - gradientMagnitude(truth, frameOffset, width, height, x, y),
        );
        const formalDifference = Math.abs(predicted[index] - formal[index]);
        formalAbsoluteCodes += formalDifference;
        formalMaxCode = Math.max(formalMaxCode, formalDifference);
        if (frame > 0) {
          const prior = index - frameBytes;
          const candidateDelta = alphaAt(predicted, index) - alphaAt(predicted, prior);
          const truthDelta = alphaAt(truth, index) - alphaAt(truth, prior);
          temporalSquared += (candidateDelta - truthDelta) ** 2;
          temporalSamples += 1;
        }
      }
    }
  }
  return {
    jMean: mean(perFrameJ),
    boundaryFMean: mean(perFrameF),
    alphaMad: absolute / expectedBytes,
    alphaMse: squared / expectedBytes,
    gradientError: gradient / expectedBytes,
    connectivityError: mean(perFrameConnectivity),
    temporalDtssd: temporalSamples ? Math.sqrt(temporalSquared / temporalSamples) : 0,
    previewFormalMeanCodeError: formalAbsoluteCodes / expectedBytes,
    previewFormalMaxCodeError: formalMaxCode,
  };
}

interface IdentityMetrics {
  idSwitches: number;
  visibleObjectFrames: number;
  lostObjectFrames: number;
  maxReacquisitionFrames: number;
}

export function computeIdentityMetrics(
  candidate: Uint8Array,
  truth: Uint8Array,
  width: number,
  height: number,
  frames: number,
): IdentityMetrics {
  const frameBytes = width * height;
  if (candidate.length !== frameBytes * frames || truth.length !== frameBytes * frames) throw new Error("Object-label sequence byte counts are invalid");
  const objectIds = new Set<number>();
  for (const label of truth) if (label > 0) objectIds.add(label);
  if (!objectIds.size) throw new Error("Object-label truth contains no object identity");
  const priorCandidate = new Map<number, number>();
  const wasOccluded = new Map<number, boolean>();
  const reacquisitionDelay = new Map<number, number>();
  let idSwitches = 0;
  let visibleObjectFrames = 0;
  let lostObjectFrames = 0;
  let maxReacquisitionFrames = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * frameBytes;
    for (const objectId of objectIds) {
      let truthPixels = 0;
      const overlap = new Uint32Array(256);
      for (let pixel = 0; pixel < frameBytes; pixel += 1) {
        if (truth[offset + pixel] !== objectId) continue;
        truthPixels += 1;
        const candidateId = candidate[offset + pixel];
        if (candidateId > 0) overlap[candidateId] += 1;
      }
      if (!truthPixels) {
        wasOccluded.set(objectId, true);
        reacquisitionDelay.set(objectId, 0);
        continue;
      }
      visibleObjectFrames += 1;
      let bestCandidate = 0;
      let bestOverlap = 0;
      for (let candidateId = 1; candidateId < overlap.length; candidateId += 1) {
        if (overlap[candidateId] > bestOverlap) {
          bestOverlap = overlap[candidateId];
          bestCandidate = candidateId;
        }
      }
      const matched = bestCandidate > 0 && bestOverlap / truthPixels >= 0.5;
      if (!matched) lostObjectFrames += 1;
      if (wasOccluded.get(objectId)) {
        const delay = reacquisitionDelay.get(objectId) ?? 0;
        if (matched) {
          maxReacquisitionFrames = Math.max(maxReacquisitionFrames, delay);
          wasOccluded.set(objectId, false);
          reacquisitionDelay.set(objectId, 0);
        } else {
          const nextDelay = delay + 1;
          reacquisitionDelay.set(objectId, nextDelay);
          maxReacquisitionFrames = Math.max(maxReacquisitionFrames, nextDelay);
        }
      }
      if (matched) {
        const prior = priorCandidate.get(objectId);
        if (prior !== undefined && prior !== bestCandidate) idSwitches += 1;
        priorCandidate.set(objectId, bestCandidate);
      }
    }
  }
  return { idSwitches, visibleObjectFrames, lostObjectFrames, maxReacquisitionFrames };
}

export function evaluateAcceptance(facts: AcceptanceFacts): string[] {
  const failures: string[] = [];
  const metrics = [facts.jMean, facts.boundaryFMean, facts.alphaMad, facts.alphaMse, facts.gradientError,
    facts.connectivityError, facts.temporalDtssd, facts.previewFormalMeanCodeError, facts.previewFormalMaxCodeError,
    facts.meanCorrectionActions, facts.meanCorrectionSeconds, facts.correctionCompletionRate,
    facts.p95LatencyMsPerFrame, facts.peakVramBytes, facts.runtimeFailureRate,
    facts.idSwitches, facts.lostObjectFrameRate, facts.maxReacquisitionFrames];
  if (metrics.some((value) => !finite(value))) failures.push("non-finite-metric");
  if (facts.clipCount < THRESHOLDS.minimumClips) failures.push("clip-count");
  if (facts.totalFrames < THRESHOLDS.minimumFrames) failures.push("frame-count");
  if (facts.uniqueSourceCount !== facts.clipCount) failures.push("unique-source-identity");
  for (const category of REQUIRED_COVERAGE) if (!facts.coverage.includes(category)) failures.push(`coverage:${category}`);
  if (!facts.rightsCommercialUsePermitted) failures.push("commercial-use-rights");
  if (!facts.sourceSeparatedFromTraining) failures.push("training-holdout-separation");
  if (!facts.algorithmFrozenBeforeGroundTruthReveal) failures.push("algorithm-freeze");
  if (!facts.evaluatorIndependent) failures.push("independent-evaluator");
  if (facts.datasetVisibility !== "blind-holdout") failures.push("blind-holdout");
  if (facts.reviewerCount < THRESHOLDS.minimumReviewers) failures.push("reviewer-count");
  if (facts.jMean < THRESHOLDS.minimumJMean) failures.push("j-mean");
  if (facts.boundaryFMean < THRESHOLDS.minimumBoundaryFMean) failures.push("boundary-f-mean");
  if (facts.alphaMad > THRESHOLDS.maximumAlphaMad) failures.push("alpha-mad");
  if (facts.alphaMse > THRESHOLDS.maximumAlphaMse) failures.push("alpha-mse");
  if (facts.gradientError > THRESHOLDS.maximumGradientError) failures.push("gradient-error");
  if (facts.connectivityError > THRESHOLDS.maximumConnectivityError) failures.push("connectivity-error");
  if (facts.temporalDtssd > THRESHOLDS.maximumTemporalDtssd) failures.push("temporal-dtssd");
  if (facts.previewFormalMeanCodeError > THRESHOLDS.maximumPreviewFormalMeanCodeError) failures.push("preview-formal-mean-code-error");
  if (facts.previewFormalMaxCodeError > THRESHOLDS.maximumPreviewFormalMaxCodeError) failures.push("preview-formal-max-code-error");
  if (facts.meanCorrectionActions > THRESHOLDS.maximumMeanCorrectionActions) failures.push("correction-actions");
  if (facts.meanCorrectionSeconds > THRESHOLDS.maximumMeanCorrectionSeconds) failures.push("correction-seconds");
  if (facts.correctionCompletionRate < THRESHOLDS.minimumCorrectionCompletionRate) failures.push("correction-completion-rate");
  if (facts.p95LatencyMsPerFrame > THRESHOLDS.maximumP95LatencyMsPerFrame) failures.push("latency-p95");
  if (facts.runtimeFailureRate > THRESHOLDS.maximumRuntimeFailureRate) failures.push("runtime-failure-rate");
  if (facts.idSwitches > THRESHOLDS.maximumIdSwitches) failures.push("id-switches");
  if (facts.lostObjectFrameRate > THRESHOLDS.maximumLostObjectFrameRate) failures.push("lost-object-frame-rate");
  if (facts.maxReacquisitionFrames > THRESHOLDS.maximumReacquisitionFrames) failures.push("reacquisition-frames");
  if (!facts.allArtifactHashesVerified) failures.push("artifact-hash-verification");
  return failures;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactPath(base: string, reference: ArtifactRef): string {
  return isAbsolute(reference.path) ? reference.path : resolve(base, reference.path);
}

async function verifiedArtifact(base: string, reference: ArtifactRef): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/u.test(reference.sha256)) throw new Error(`Invalid SHA-256 for ${reference.path}`);
  const bytes = await readFile(artifactPath(base, reference));
  if (sha256(bytes) !== reference.sha256) throw new Error(`Artifact hash mismatch: ${reference.path}`);
  return bytes;
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function buildFacts(manifestPath: string): Promise<{ facts: AcceptanceFacts; manifest: HoldoutManifest }> {
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseJson<HoldoutManifest>(manifestBytes, "Holdout manifest");
  if (manifest.schema !== SCHEMA) throw new Error(`Unsupported holdout schema: ${manifest.schema}`);
  if (!manifest.candidateEngine.trim() || !Number.isFinite(Date.parse(manifest.frozenAt))) throw new Error("Candidate engine or freeze timestamp is invalid");
  if (!/^[a-f0-9]{64}$/u.test(manifest.candidateImplementationSha256)) throw new Error("Candidate implementation identity is invalid");
  const base = dirname(manifestPath);
  const rights = parseJson<RightsReceipt>(await verifiedArtifact(base, manifest.rightsReceipt), "Rights receipt");
  const corrections = parseJson<CorrectionJournal>(await verifiedArtifact(base, manifest.correctionJournal), "Correction journal");
  const performance = parseJson<PerformanceReceipt>(await verifiedArtifact(base, manifest.performanceReceipt), "Performance receipt");
  if (rights.schema !== "editkin.holdout-rights-receipt/v1") throw new Error("Rights receipt schema is invalid");
  if (!rights.datasetId.trim() || !rights.ownerOrLicense.trim()) throw new Error("Rights receipt identity is incomplete");
  if (corrections.schema !== "editkin.roto-correction-journal/v1") throw new Error("Correction journal schema is invalid");
  if (performance.schema !== "editkin.roto-performance-receipt/v1") throw new Error("Performance receipt schema is invalid");
  const metrics: SequenceMetrics[] = [];
  const identityMetrics: IdentityMetrics[] = [];
  const sourceHashes = new Set<string>();
  let totalFrames = 0;
  for (const clip of manifest.clips) {
    if (!clip.id || !Number.isSafeInteger(clip.width) || !Number.isSafeInteger(clip.height)
      || !Number.isSafeInteger(clip.frames) || !(clip.fps > 0)) throw new Error(`Invalid clip geometry: ${clip.id}`);
    const [source, truth, candidate, formal] = await Promise.all([
      verifiedArtifact(base, clip.source),
      verifiedArtifact(base, clip.truthAlpha8),
      verifiedArtifact(base, clip.candidateAlpha8),
      verifiedArtifact(base, clip.formalAlpha8),
    ]);
    if (!source.length) throw new Error(`Empty source artifact: ${clip.id}`);
    sourceHashes.add(clip.source.sha256);
    totalFrames += clip.frames;
    metrics.push(computeSequenceMetrics(candidate, truth, formal, clip.width, clip.height, clip.frames));
    const identityRequired = clip.categories.some((category) => ["multi-object", "full-occlusion", "reappearance"].includes(category));
    if (identityRequired && (!clip.truthLabels8 || !clip.candidateLabels8)) throw new Error(`Object-label evidence is required for ${clip.id}`);
    if (clip.truthLabels8 && clip.candidateLabels8) {
      const [truthLabels, candidateLabels] = await Promise.all([
        verifiedArtifact(base, clip.truthLabels8),
        verifiedArtifact(base, clip.candidateLabels8),
      ]);
      identityMetrics.push(computeIdentityMetrics(candidateLabels, truthLabels, clip.width, clip.height, clip.frames));
    }
  }
  const correctionEntries = corrections.entries.filter((entry) => manifest.clips.some((clip) => clip.id === entry.clipId));
  const performanceSamples = performance.samples.filter((sample) => manifest.clips.some((clip) => clip.id === sample.clipId));
  if (!corrections.reviewerIds.every((reviewer) => /^[a-f0-9]{16,128}$/u.test(reviewer))) throw new Error("Reviewer identities must be privacy-safe hashes");
  if (new Set(corrections.reviewerIds).size !== corrections.reviewerIds.length) throw new Error("Reviewer identities must be unique");
  if (correctionEntries.some((entry) => !corrections.reviewerIds.includes(entry.reviewerId)
    || !Number.isSafeInteger(entry.actions) || entry.actions < 0 || !finite(entry.seconds) || entry.seconds < 0)) throw new Error("Correction journal entry is invalid");
  if (performanceSamples.some((sample) => !Number.isSafeInteger(sample.frames) || sample.frames <= 0
    || !finite(sample.elapsedMs) || sample.elapsedMs <= 0 || !Number.isSafeInteger(sample.peakVramBytes) || sample.peakVramBytes < 0)) throw new Error("Performance receipt sample is invalid");
  const correctionPairs = new Set(correctionEntries.map((entry) => `${entry.clipId}\u0000${entry.reviewerId}`));
  if (correctionPairs.size !== correctionEntries.length
    || manifest.clips.some((clip) => corrections.reviewerIds.some((reviewer) => !correctionPairs.has(`${clip.id}\u0000${reviewer}`)))) {
    throw new Error("Correction journal must contain exactly one result for every clip/reviewer pair");
  }
  if (manifest.clips.some((clip) => performanceSamples.filter((sample) => sample.clipId === clip.id && sample.frames === clip.frames).length < 3)) {
    throw new Error("Performance receipt must contain at least three full-clip runs per clip");
  }
  const weighted = (key: keyof SequenceMetrics) => {
    let numerator = 0;
    let denominator = 0;
    manifest.clips.forEach((clip, index) => {
      numerator += metrics[index][key] * clip.frames;
      denominator += clip.frames;
    });
    return numerator / denominator;
  };
  const facts: AcceptanceFacts = {
    clipCount: manifest.clips.length,
    totalFrames,
    uniqueSourceCount: sourceHashes.size,
    coverage: [...new Set(manifest.clips.flatMap((clip) => clip.categories))],
    rightsCommercialUsePermitted: rights.commercialUsePermitted,
    sourceSeparatedFromTraining: rights.sourceSeparatedFromTraining,
    algorithmFrozenBeforeGroundTruthReveal: manifest.algorithmFrozenBeforeGroundTruthReveal,
    evaluatorIndependent: manifest.evaluatorIndependent,
    datasetVisibility: manifest.datasetVisibility,
    reviewerCount: new Set(corrections.reviewerIds).size,
    meanCorrectionActions: mean(correctionEntries.map((entry) => entry.actions)),
    meanCorrectionSeconds: mean(correctionEntries.map((entry) => entry.seconds)),
    correctionCompletionRate: correctionEntries.length ? correctionEntries.filter((entry) => entry.completed).length / correctionEntries.length : Number.NaN,
    p95LatencyMsPerFrame: percentile(performanceSamples.map((sample) => sample.elapsedMs / sample.frames), 0.95),
    peakVramBytes: performanceSamples.length ? Math.max(...performanceSamples.map((sample) => sample.peakVramBytes)) : Number.NaN,
    runtimeFailureRate: performanceSamples.length ? performanceSamples.filter((sample) => sample.failed).length / performanceSamples.length : Number.NaN,
    idSwitches: identityMetrics.reduce((sum, metric) => sum + metric.idSwitches, 0),
    lostObjectFrameRate: identityMetrics.reduce((sum, metric) => sum + metric.visibleObjectFrames, 0)
      ? identityMetrics.reduce((sum, metric) => sum + metric.lostObjectFrames, 0) / identityMetrics.reduce((sum, metric) => sum + metric.visibleObjectFrames, 0)
      : Number.NaN,
    maxReacquisitionFrames: identityMetrics.length ? Math.max(...identityMetrics.map((metric) => metric.maxReacquisitionFrames)) : Number.NaN,
    jMean: weighted("jMean"),
    boundaryFMean: weighted("boundaryFMean"),
    alphaMad: weighted("alphaMad"),
    alphaMse: weighted("alphaMse"),
    gradientError: weighted("gradientError"),
    connectivityError: weighted("connectivityError"),
    temporalDtssd: weighted("temporalDtssd"),
    previewFormalMeanCodeError: weighted("previewFormalMeanCodeError"),
    previewFormalMaxCodeError: Math.max(...metrics.map((metric) => metric.previewFormalMaxCodeError)),
    allArtifactHashesVerified: true,
  };
  return { facts, manifest };
}

async function selfTest(): Promise<void> {
  const width = 16;
  const height = 12;
  const frames = 3;
  const truth = new Uint8Array(width * height * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let y = 2; y < 10; y += 1) for (let x = 2 + frame; x < 10 + frame; x += 1) truth[frame * width * height + y * width + x] = 255;
  }
  const exact = computeSequenceMetrics(truth, truth, truth, width, height, frames);
  if (exact.jMean !== 1 || exact.boundaryFMean !== 1 || exact.alphaMad !== 0 || exact.connectivityError !== 0
    || exact.previewFormalMaxCodeError !== 0) throw new Error("Exact alpha control did not score perfectly");
  const identityTruth = new Uint8Array(4 * 4 * 4);
  const identityCandidateSwitch = new Uint8Array(identityTruth.length);
  const identityCandidateDelayed = new Uint8Array(identityTruth.length);
  for (const frame of [0, 2, 3]) {
    for (const pixel of [5, 6, 9, 10]) identityTruth[frame * 16 + pixel] = 1;
  }
  for (const pixel of [5, 6, 9, 10]) {
    identityCandidateSwitch[pixel] = 1;
    identityCandidateSwitch[2 * 16 + pixel] = 2;
    identityCandidateSwitch[3 * 16 + pixel] = 2;
    identityCandidateDelayed[pixel] = 1;
    identityCandidateDelayed[3 * 16 + pixel] = 1;
  }
  const switched = computeIdentityMetrics(identityCandidateSwitch, identityTruth, 4, 4, 4);
  const delayed = computeIdentityMetrics(identityCandidateDelayed, identityTruth, 4, 4, 4);
  if (switched.idSwitches !== 1 || switched.maxReacquisitionFrames !== 0 || switched.lostObjectFrames !== 0) {
    throw new Error("Identity-switch oracle is not calibrated");
  }
  if (delayed.idSwitches !== 0 || delayed.maxReacquisitionFrames !== 1 || delayed.lostObjectFrames !== 1) {
    throw new Error("Occlusion/reacquisition oracle is not calibrated");
  }
  const valid: AcceptanceFacts = {
    ...exact,
    clipCount: 8,
    totalFrames: 240,
    uniqueSourceCount: 8,
    coverage: [...REQUIRED_COVERAGE],
    rightsCommercialUsePermitted: true,
    sourceSeparatedFromTraining: true,
    algorithmFrozenBeforeGroundTruthReveal: true,
    evaluatorIndependent: true,
    datasetVisibility: "blind-holdout",
    reviewerCount: 3,
    meanCorrectionActions: 2,
    meanCorrectionSeconds: 10,
    correctionCompletionRate: 1,
    p95LatencyMsPerFrame: 20,
    peakVramBytes: 512 * 1024 * 1024,
    runtimeFailureRate: 0,
    idSwitches: 0,
    lostObjectFrameRate: 0,
    maxReacquisitionFrames: 0,
    allArtifactHashesVerified: true,
  };
  if (evaluateAcceptance(valid).length) throw new Error("Acceptance evaluator rejects its valid control");
  const mutations: Array<[string, (facts: AcceptanceFacts) => void]> = [
    ["clip-count", (facts) => { facts.clipCount = 7; }],
    ["frame-count", (facts) => { facts.totalFrames = 239; }],
    ["unique-sources", (facts) => { facts.uniqueSourceCount = 7; }],
    ["coverage", (facts) => { facts.coverage = facts.coverage.filter((value) => value !== "hair-fur"); }],
    ["rights", (facts) => { facts.rightsCommercialUsePermitted = false; }],
    ["training-separation", (facts) => { facts.sourceSeparatedFromTraining = false; }],
    ["algorithm-freeze", (facts) => { facts.algorithmFrozenBeforeGroundTruthReveal = false; }],
    ["independent-evaluator", (facts) => { facts.evaluatorIndependent = false; }],
    ["blind", (facts) => { facts.datasetVisibility = "development-visible"; }],
    ["reviewers", (facts) => { facts.reviewerCount = 2; }],
    ["j", (facts) => { facts.jMean = 0.5; }],
    ["boundary", (facts) => { facts.boundaryFMean = 0.5; }],
    ["alpha", (facts) => { facts.alphaMad = 0.2; }],
    ["alpha-mse", (facts) => { facts.alphaMse = 0.2; }],
    ["gradient", (facts) => { facts.gradientError = 0.2; }],
    ["connectivity", (facts) => { facts.connectivityError = 0.2; }],
    ["temporal", (facts) => { facts.temporalDtssd = 0.2; }],
    ["parity-mean", (facts) => { facts.previewFormalMeanCodeError = 1; }],
    ["parity", (facts) => { facts.previewFormalMaxCodeError = 2; }],
    ["correction-actions", (facts) => { facts.meanCorrectionActions = 20; }],
    ["correction", (facts) => { facts.meanCorrectionSeconds = 60; }],
    ["correction-completion", (facts) => { facts.correctionCompletionRate = 0.8; }],
    ["latency", (facts) => { facts.p95LatencyMsPerFrame = 101; }],
    ["runtime-failure", (facts) => { facts.runtimeFailureRate = 0.1; }],
    ["id-switch", (facts) => { facts.idSwitches = 1; }],
    ["lost-object", (facts) => { facts.lostObjectFrameRate = 0.2; }],
    ["reacquisition", (facts) => { facts.maxReacquisitionFrames = 4; }],
    ["hash", (facts) => { facts.allArtifactHashesVerified = false; }],
  ];
  for (const [name, mutate] of mutations) {
    const facts = structuredClone(valid);
    mutate(facts);
    if (!evaluateAcceptance(facts).length) throw new Error(`Acceptance evaluator accepted mutation: ${name}`);
  }
  const workspace = await mkdtemp(join(tmpdir(), "editkin-roto-quality-self-test-"));
  try {
    const store = async (name: string, bytes: Uint8Array | string): Promise<ArtifactRef> => {
      const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
      const path = join(workspace, name);
      await writeFile(path, body);
      return { path: name, sha256: sha256(body) };
    };
    const reviewerIds = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    const clips: HoldoutClip[] = [];
    const entries: CorrectionJournal["entries"] = [];
    const samples: PerformanceReceipt["samples"] = [];
    for (let clipIndex = 0; clipIndex < 8; clipIndex += 1) {
      const id = `clip-${clipIndex + 1}`;
      const alpha = new Uint8Array(width * height * 30);
      for (let frame = 0; frame < 30; frame += 1) {
        for (let y = 2; y < 10; y += 1) for (let x = 2; x < 10; x += 1) alpha[frame * width * height + y * width + x] = 255;
      }
      clips.push({
        id,
        width,
        height,
        frames: 30,
        fps: 12,
        categories: [...REQUIRED_COVERAGE],
        source: await store(`${id}.source`, Uint8Array.of(clipIndex + 1)),
        truthAlpha8: await store(`${id}.truth.alpha8`, alpha),
        candidateAlpha8: await store(`${id}.candidate.alpha8`, alpha),
        formalAlpha8: await store(`${id}.formal.alpha8`, alpha),
        truthLabels8: await store(`${id}.truth.labels8`, alpha.map((value) => value > 0 ? 1 : 0)),
        candidateLabels8: await store(`${id}.candidate.labels8`, alpha.map((value) => value > 0 ? 1 : 0)),
      });
      for (const reviewerId of reviewerIds) entries.push({ clipId: id, reviewerId, actions: 1, seconds: 5, completed: true });
      for (let run = 0; run < 3; run += 1) samples.push({ clipId: id, frames: 30, elapsedMs: 300 + run, peakVramBytes: 64 * 1024 * 1024, failed: false });
    }
    const rightsReceipt = await store("rights.json", JSON.stringify({
      schema: "editkin.holdout-rights-receipt/v1",
      datasetId: "owned-self-test",
      commercialUsePermitted: true,
      sourceSeparatedFromTraining: true,
      ownerOrLicense: "Editkin synthetic evaluator calibration only",
    } satisfies RightsReceipt));
    const correctionJournal = await store("corrections.json", JSON.stringify({
      schema: "editkin.roto-correction-journal/v1",
      reviewerIds,
      entries,
    } satisfies CorrectionJournal));
    const performanceReceipt = await store("performance.json", JSON.stringify({
      schema: "editkin.roto-performance-receipt/v1",
      deviceIdentity: "self-test-cpu",
      samples,
    } satisfies PerformanceReceipt));
    const manifest: HoldoutManifest = {
      schema: SCHEMA,
      frozenAt: "2026-08-28T00:00:00.000Z",
      candidateEngine: "editkin-self-test-roto/v1",
      candidateImplementationSha256: "a".repeat(64),
      algorithmFrozenBeforeGroundTruthReveal: true,
      evaluatorIndependent: true,
      datasetVisibility: "blind-holdout",
      rightsReceipt,
      correctionJournal,
      performanceReceipt,
      clips,
    };
    const manifestPath = join(workspace, "holdout.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const ingested = await buildFacts(manifestPath);
    if (evaluateAcceptance(ingested.facts).length) throw new Error("Hashed holdout ingestion rejects its valid control");
    await writeFile(join(workspace, clips[0].truthAlpha8.path), Uint8Array.of(0));
    let rejectedTamper = false;
    try {
      await buildFacts(manifestPath);
    } catch {
      rejectedTamper = true;
    }
    if (!rejectedTamper) throw new Error("Hashed holdout ingestion accepted artifact tampering");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  const implementationPath = resolve(process.argv[1]);
  const protocolPath = join(APP_ROOT, "docs", "roto-quality-holdout-protocol.md");
  const calibrationReport = {
    schema: "editkin.roto-quality-evaluator-self-test/v1",
    generatedAt: new Date().toISOString(),
    status: "GREEN_INSTRUMENT_CALIBRATED_QUALITY_UNMEASURED",
    evaluatorMutations: mutations.length,
    exactSequenceControl: exact,
    identityControls: { switched, delayed },
    hashedIngestion: "GREEN",
    artifactTamperControl: "REJECTED",
    sources: {
      implementation: { path: "scripts/roto-quality-acceptance-gate.ts", sha256: sha256(await readFile(implementationPath)) },
      protocol: { path: "docs/roto-quality-holdout-protocol.md", sha256: sha256(await readFile(protocolPath)) },
    },
    claimBoundary: "This calibrates the evaluator and hash-bound ingestion only. No independent real-footage holdout was measured, so Auto Roto product quality remains unmeasured.",
  };
  await mkdir(dirname(SELF_TEST_REPORT), { recursive: true });
  await writeFile(SELF_TEST_REPORT, `${JSON.stringify(calibrationReport, null, 2)}\n`, "utf8");
  console.log(`ROTO_QUALITY_EVALUATOR_SELF_TEST status=GREEN mutations=${mutations.length} ingestion=GREEN tamper=REJECTED`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  const requested = argument("--manifest");
  if (!requested) throw new Error("Usage: tsx scripts/roto-quality-acceptance-gate.ts --manifest <frozen-holdout.json> [--report <report.json>]");
  const manifestPath = resolve(requested);
  const { facts, manifest } = await buildFacts(manifestPath);
  const failures = evaluateAcceptance(facts);
  const reportPath = resolve(argument("--report") ?? join(dirname(manifestPath), "roto-quality-report.json"));
  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_BLIND_HOLDOUT",
    candidate: {
      engine: manifest.candidateEngine,
      implementationSha256: manifest.candidateImplementationSha256,
    },
    manifest: {
      path: manifestPath,
      bytes: (await stat(manifestPath)).size,
      sha256: sha256(await readFile(manifestPath)),
    },
    thresholds: THRESHOLDS,
    facts,
    failures,
    metricSemantics: {
      j: "binary alpha >= 0.5 intersection-over-union per frame",
      boundaryF: "two-sided boundary F-measure with 0.75% frame-diagonal tolerance",
      gradient: "mean absolute central-difference alpha-gradient magnitude error",
      connectivity: "largest shared four-connected alpha component over 0.1 threshold levels",
      temporalDtssd: "RMS disagreement between adjacent-frame alpha derivatives; no optical-flow warping claim",
      identity: "per-ground-truth-object majority-overlap identity switches, lost visible frames, and post-occlusion reacquisition delay",
    },
    claimBoundary: [
      "The gate accepts only owned or commercially permitted, training-separated, independently evaluated blind holdouts.",
      "A GREEN report covers only the exact frozen sources, candidate implementation, device receipt, formal outputs, and reviewers bound by this manifest.",
      "It does not by itself establish competitor superiority, unseen-domain generalization, installer delivery, or cross-platform parity.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) throw new Error(`Roto quality acceptance BLOCK: ${failures.join(", ")}`);
  console.log(`Roto quality acceptance GREEN · report ${reportPath}`);
}

await main();
