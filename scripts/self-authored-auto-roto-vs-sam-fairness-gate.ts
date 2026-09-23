import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const APP_ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE_SCHEMA = "editkin.self-authored-auto-roto-vs-sam-paired-evidence/v1";
const DATASET_SCHEMA = "editkin.auto-roto-paired-dataset-manifest/v1";
const PERFORMANCE_SCHEMA = "editkin.auto-roto-paired-performance-receipt/v1";
const REPORT_SCHEMA = "editkin.self-authored-auto-roto-vs-sam-fair-comparison-report/v1";
const SELF_ENGINE = "editkin-native-color-temporal-roto/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const REQUIRED_COVERAGE = [
  "hair-fur", "thin-detail", "motion-blur", "similar-distractor", "full-occlusion",
  "reappearance", "scene-cut", "multi-object", "transparent-edge", "long-duration",
] as const;
const PROTOCOL = Object.freeze({
  id: "editkin.self-authored-auto-roto-vs-sam-fair-comparison/2026-08-28",
  evidenceClass: "legacy-v1-structure-preflight-no-promotion",
  prompt: "identical first-frame object-label mask; prompt frame excluded from scoring",
  sampling: "all remaining annotated frames from every preregistered eligible clip",
  metrics: {
    regionJ: "binary alpha >= 0.5 intersection-over-union",
    boundaryF: "two-sided boundary F with 0.75% frame-diagonal tolerance",
    primary: "macro mean of per-clip (J+F)/2",
  },
  minimums: { clips: 8, evaluatedFrames: 240, warmupRuns: 1, measuredRuns: 3 },
  superiority: {
    macroJAndFDeltaMinimum: .02,
    frameWeightedJAndFDeltaMinimum: .015,
    medianClipJAndFDeltaMinimum: .01,
    clipWinRateMinimum: .75,
    worstClipJAndFDeltaMinimum: -.08,
    componentNonInferiorityMinimum: -.005,
  },
  samBoundary: "upstream-attributed research control only; never product-eligible, staged, or bundled",
  promotionBoundary: "BLOCK until a v2 independently runner-attested execution receipt and blind commit-reveal freeze are implemented",
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const PROTOCOL_SHA256 = createHash("sha256").update(canonicalJson(PROTOCOL)).digest("hex");

interface ArtifactRef {
  path: string;
  bytes: number;
  sha256: string;
}

interface PairResult {
  predictionAlpha8: ArtifactRef;
  failed: boolean;
  failureDisposition: "completed" | "zero-mask-scored";
}

interface EvidencePair {
  id: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  categories: string[];
  source: ArtifactRef;
  truthAlpha8: ArtifactRef;
  promptLabels8: ArtifactRef;
  selfAuthored: PairResult;
  sam: PairResult;
}

interface DatasetManifest {
  schema: string;
  id: string;
  capturedAt: string;
  groundTruthRevealedAt: string;
  clips: Array<{
    id: string;
    width: number;
    height: number;
    frames: number;
    fps: number;
    categories: string[];
    sourceSha256: string;
    truthAlpha8Sha256: string;
    promptLabels8Sha256: string;
  }>;
}

interface RuntimeSample {
  elapsedMs: number | null;
  peakMemoryBytes: number | null;
  failed: boolean;
}

interface PerformanceReceipt {
  schema: string;
  device: { identitySha256: string; description: string; os: string; accelerator: string; driver: string };
  controls: {
    samePhysicalDevice: boolean;
    sameOsAndDriver: boolean;
    isolatedProcessPerEngine: boolean;
    counterbalancedOrder: boolean;
    powerProfile: string;
    warmupRuns: number;
    measuredRuns: number;
  };
  pairs: Array<{
    clipId: string;
    order: "self-authored-first" | "sam-first";
    selfAuthored: RuntimeSample[];
    sam: RuntimeSample[];
  }>;
}

interface PairedEvidence {
  schema: string;
  protocol: { id: string; sha256: string };
  generatedAt: string;
  controls: {
    realFootage: boolean;
    blindHoldout: boolean;
    preregisteredAllEligibleNoCherryPicking: boolean;
    configurationsFrozenBeforeCapture: boolean;
    independentHumanReviewedGroundTruth: boolean;
    identicalSourceFramesAndPrompt: boolean;
    promptFrameExcluded: boolean;
    noManualCorrections: boolean;
    noPerEngineHoldoutTuning: boolean;
    failedRunsScoredNotDropped: boolean;
  };
  dataset: {
    id: string;
    origin: string;
    licenseOrOwnership: string;
    researchUsePermitted: boolean;
    redistribution: string;
    manifest: ArtifactRef;
  };
  environment: { performanceReceipt: ArtifactRef };
  engines: {
    selfAuthored: {
      id: string;
      provenance: "editkin-self-authored";
      implementation: ArtifactRef;
      frozenAt: string;
      externalWeights: boolean;
      fallbackUsed: boolean;
    };
    sam: {
      id: string;
      modelFamily: string;
      repository: string;
      upstreamCommit: string;
      licenseSpdx: string;
      provenanceOrganization: string;
      role: "research-control-only";
      productEligible: boolean;
      bundledInProduct: boolean;
      attributionPreserved: boolean;
      implementation: ArtifactRef;
      checkpoint: ArtifactRef;
      licenseNotice: ArtifactRef;
      frozenAt: string;
      fallbackUsed: boolean;
    };
  };
  pairs: EvidencePair[];
}

interface ComparisonFacts {
  evidencePresent: boolean;
  schemaValid: boolean;
  protocolBound: boolean;
  realBlindHoldout: boolean;
  preregisteredNoCherryPicking: boolean;
  configurationsFrozenBeforeCapture: boolean;
  groundTruthIndependentAndPostFreeze: boolean;
  identicalInputsAndPrompt: boolean;
  promptFrameExcluded: boolean;
  noManualCorrections: boolean;
  noHoldoutTuning: boolean;
  datasetProvenanceComplete: boolean;
  researchUsePermitted: boolean;
  datasetManifestExact: boolean;
  allArtifactHashesVerified: boolean;
  exactClosedWorldInventory: boolean;
  independentRunnerExecutionReceiptBound: boolean;
  blindFreezeProvenanceBound: boolean;
  selfEngineIdentity: boolean;
  selfAuthoredNoExternalWeights: boolean;
  samProvenanceComplete: boolean;
  samResearchOnly: boolean;
  samNotBundledOrProductEligible: boolean;
  noEngineFallbacks: boolean;
  samePhysicalDeviceAndRuntime: boolean;
  isolatedProcesses: boolean;
  counterbalancedOrder: boolean;
  warmupsAdequate: boolean;
  measuredRunsAdequate: boolean;
  performancePairsComplete: boolean;
  failedRunsScoredNotDropped: boolean;
  minimumClipCount: boolean;
  minimumFrameCount: boolean;
  coverageComplete: boolean;
  metricsFinite: boolean;
  macroSuperiority: boolean;
  frameWeightedSuperiority: boolean;
  medianSuperiority: boolean;
  clipWinRate: boolean;
  worstClipSafety: boolean;
  regionJNonInferior: boolean;
  boundaryFNonInferior: boolean;
  selfRuntimeFailureNoWorse: boolean;
}

interface ClipMetrics {
  j: number;
  f: number;
  jAndF: number;
  allZero: boolean;
}

interface PairMetrics {
  id: string;
  frames: number;
  selfAuthored: ClipMetrics;
  sam: ClipMetrics;
  delta: { j: number; f: number; jAndF: number };
}

function evaluateFacts(facts: ComparisonFacts): string[] {
  return (Object.entries(facts) as Array<[keyof ComparisonFacts, boolean]>)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

const PROMOTION_ATTESTATION_FACTS = new Set<keyof ComparisonFacts>([
  "independentRunnerExecutionReceiptBound",
  "blindFreezeProvenanceBound",
]);
const OUTCOME_FACTS = new Set<keyof ComparisonFacts>([
  "macroSuperiority", "frameWeightedSuperiority", "medianSuperiority", "clipWinRate", "worstClipSafety",
  "regionJNonInferior", "boundaryFNonInferior", "selfRuntimeFailureNoWorse",
]);

function preflightStatus(failures: string[]): "BLOCK_INVALID_PAIRED_EVIDENCE" | "BLOCK_SUPERIORITY_NOT_PROVEN" | "BLOCK_RUNNER_ATTESTATION_REQUIRED" | "BLOCK_PROMOTION_PROTOCOL_V2_REQUIRED" {
  const structuralFailures = failures.filter((failure) => !PROMOTION_ATTESTATION_FACTS.has(failure as keyof ComparisonFacts)
    && !OUTCOME_FACTS.has(failure as keyof ComparisonFacts));
  if (structuralFailures.length) return "BLOCK_INVALID_PAIRED_EVIDENCE";
  if (failures.some((failure) => PROMOTION_ATTESTATION_FACTS.has(failure as keyof ComparisonFacts))) return "BLOCK_RUNNER_ATTESTATION_REQUIRED";
  const outcomeFailures = failures.filter((failure) => OUTCOME_FACTS.has(failure as keyof ComparisonFacts));
  if (outcomeFailures.length) return "BLOCK_SUPERIORITY_NOT_PROVEN";
  return "BLOCK_PROMOTION_PROTOCOL_V2_REQUIRED";
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalized(path: string): string {
  return path.split(sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function parseArtifactRef(value: unknown, label: string): ArtifactRef {
  if (!value || typeof value !== "object") throw new Error(`${label} artifact reference is missing`);
  const item = value as Partial<ArtifactRef>;
  if (typeof item.path !== "string" || item.path.includes("\\") || item.path.startsWith("/") || isAbsolute(item.path)
    || item.path.split("/").some((part) => !part || part === "." || part === "..")
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 || !SHA256.test(item.sha256 ?? "")) {
    throw new Error(`${label} artifact reference is invalid`);
  }
  return item as ArtifactRef;
}

async function assertRealFile(root: string, reference: ArtifactRef): Promise<string> {
  const target = resolve(root, ...reference.path.split("/"));
  if (!isInside(root, target)) throw new Error(`Artifact escaped evidence root: ${reference.path}`);
  let cursor = root;
  for (const part of reference.path.split("/")) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Artifact path contains symlink/junction: ${reference.path}`);
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size !== reference.bytes) throw new Error(`Artifact size/type mismatch: ${reference.path}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target, { highWaterMark: 4 * 1024 * 1024 })) digest.update(chunk);
  if (digest.digest("hex") !== reference.sha256) throw new Error(`Artifact hash mismatch: ${reference.path}`);
  return target;
}

async function exactInventory(root: string, evidenceName: string, references: ArtifactRef[]): Promise<boolean> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
  const expectedFiles = new Set([evidenceName, ...references.map((entry) => entry.path)]);
  const expectedDirectories = new Set([...expectedFiles].flatMap((path) => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }));
  const observedFiles: string[] = [];
  const observedDirectories: string[] = [];
  const folded = new Set<string>();
  let invalid = false;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = resolve(directory, entry.name);
      const path = normalized(relative(root, target));
      const key = path.toLocaleLowerCase("en-US");
      if (folded.has(key)) invalid = true;
      folded.add(key);
      const info = await lstat(target);
      if (info.isSymbolicLink()) { invalid = true; continue; }
      if (info.isDirectory()) { observedDirectories.push(path); await visit(target); }
      else if (info.isFile()) observedFiles.push(path);
      else invalid = true;
    }
  }
  await visit(root);
  return !invalid
    && observedFiles.length === expectedFiles.size
    && observedFiles.every((path) => expectedFiles.has(path))
    && observedDirectories.length === expectedDirectories.size
    && observedDirectories.every((path) => expectedDirectories.has(path));
}

function boundaryMap(frame: Uint8Array, width: number, height: number): { map: Uint8Array; count: number } {
  const map = new Uint8Array(width * height);
  const foreground = (x: number, y: number) => frame[y * width + x] >= 128;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = foreground(x, y);
      if ((value && (x === 0 || x + 1 === width || y === 0 || y + 1 === height))
        || (x > 0 && foreground(x - 1, y) !== value)
        || (x + 1 < width && foreground(x + 1, y) !== value)
        || (y > 0 && foreground(x, y - 1) !== value)
        || (y + 1 < height && foreground(x, y + 1) !== value)) {
        map[y * width + x] = 1;
        count += 1;
      }
    }
  }
  return { map, count };
}

function squaredDistanceTransform(boundary: Uint8Array, width: number, height: number): Float64Array {
  const large = 1e20;
  const first = new Float64Array(width * height);
  const output = new Float64Array(width * height);
  const maxLength = Math.max(width, height);
  const values = new Float64Array(maxLength);
  const distances = new Float64Array(maxLength);
  const sites = new Int32Array(maxLength);
  const intersections = new Float64Array(maxLength + 1);
  const transform = (length: number): void => {
    let k = 0;
    sites[0] = 0;
    intersections[0] = Number.NEGATIVE_INFINITY;
    intersections[1] = Number.POSITIVE_INFINITY;
    for (let q = 1; q < length; q += 1) {
      let separation = ((values[q] + q * q) - (values[sites[k]] + sites[k] * sites[k])) / (2 * q - 2 * sites[k]);
      while (separation <= intersections[k]) {
        k -= 1;
        separation = ((values[q] + q * q) - (values[sites[k]] + sites[k] * sites[k])) / (2 * q - 2 * sites[k]);
      }
      k += 1;
      sites[k] = q;
      intersections[k] = separation;
      intersections[k + 1] = Number.POSITIVE_INFINITY;
    }
    k = 0;
    for (let q = 0; q < length; q += 1) {
      while (intersections[k + 1] < q) k += 1;
      const delta = q - sites[k];
      distances[q] = delta * delta + values[sites[k]];
    }
  };
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) values[y] = boundary[y * width + x] ? 0 : large;
    transform(height);
    for (let y = 0; y < height; y += 1) first[y * width + x] = distances[y];
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) values[x] = first[y * width + x];
    transform(width);
    for (let x = 0; x < width; x += 1) output[y * width + x] = distances[x];
  }
  return output;
}

function frameMetrics(prediction: Uint8Array, truth: Uint8Array, width: number, height: number): { j: number; f: number } {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < prediction.length; index += 1) {
    const predicted = prediction[index] >= 128;
    const expected = truth[index] >= 128;
    if (predicted && expected) intersection += 1;
    if (predicted || expected) union += 1;
  }
  const j = union === 0 ? 1 : intersection / union;
  const predictedBoundary = boundaryMap(prediction, width, height);
  const truthBoundary = boundaryMap(truth, width, height);
  if (predictedBoundary.count === 0 && truthBoundary.count === 0) return { j, f: 1 };
  if (predictedBoundary.count === 0 || truthBoundary.count === 0) return { j, f: 0 };
  const truthDistance = squaredDistanceTransform(truthBoundary.map, width, height);
  const predictedDistance = squaredDistanceTransform(predictedBoundary.map, width, height);
  const radiusSquared = Math.max(1, Math.ceil(Math.hypot(width, height) * .0075)) ** 2;
  let predictedMatches = 0;
  let truthMatches = 0;
  for (let index = 0; index < prediction.length; index += 1) {
    if (predictedBoundary.map[index] && truthDistance[index] <= radiusSquared) predictedMatches += 1;
    if (truthBoundary.map[index] && predictedDistance[index] <= radiusSquared) truthMatches += 1;
  }
  const precision = predictedMatches / predictedBoundary.count;
  const recall = truthMatches / truthBoundary.count;
  return { j, f: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) };
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("Unexpected end of alpha evidence");
    offset += result.bytesRead;
  }
}

async function comparePair(pair: EvidencePair, paths: { truth: string; selfAuthored: string; sam: string }): Promise<PairMetrics> {
  const frameBytes = pair.width * pair.height;
  const [truthHandle, selfHandle, samHandle] = await Promise.all([open(paths.truth, "r"), open(paths.selfAuthored, "r"), open(paths.sam, "r")]);
  let selfJ = 0; let selfF = 0; let samJ = 0; let samF = 0;
  let selfAllZero = true; let samAllZero = true;
  try {
    const truth = Buffer.allocUnsafe(frameBytes);
    const self = Buffer.allocUnsafe(frameBytes);
    const sam = Buffer.allocUnsafe(frameBytes);
    for (let frame = 0; frame < pair.frames; frame += 1) {
      const position = frame * frameBytes;
      await Promise.all([readExact(truthHandle, truth, position), readExact(selfHandle, self, position), readExact(samHandle, sam, position)]);
      if (selfAllZero && self.some((value) => value !== 0)) selfAllZero = false;
      if (samAllZero && sam.some((value) => value !== 0)) samAllZero = false;
      const selfMetric = frameMetrics(self, truth, pair.width, pair.height);
      const samMetric = frameMetrics(sam, truth, pair.width, pair.height);
      selfJ += selfMetric.j; selfF += selfMetric.f; samJ += samMetric.j; samF += samMetric.f;
    }
  } finally {
    await Promise.all([truthHandle.close(), selfHandle.close(), samHandle.close()]);
  }
  const selfMetrics = { j: selfJ / pair.frames, f: selfF / pair.frames, jAndF: (selfJ + selfF) / (2 * pair.frames), allZero: selfAllZero };
  const samMetrics = { j: samJ / pair.frames, f: samF / pair.frames, jAndF: (samJ + samF) / (2 * pair.frames), allZero: samAllZero };
  return {
    id: pair.id,
    frames: pair.frames,
    selfAuthored: selfMetrics,
    sam: samMetrics,
    delta: { j: selfMetrics.j - samMetrics.j, f: selfMetrics.f - samMetrics.f, jAndF: selfMetrics.jAndF - samMetrics.jAndF },
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function artifactReferences(evidence: PairedEvidence): ArtifactRef[] {
  return [
    parseArtifactRef(evidence.dataset?.manifest, "dataset manifest"),
    parseArtifactRef(evidence.environment?.performanceReceipt, "performance receipt"),
    parseArtifactRef(evidence.engines?.selfAuthored?.implementation, "self-authored implementation"),
    parseArtifactRef(evidence.engines?.sam?.implementation, "SAM implementation"),
    parseArtifactRef(evidence.engines?.sam?.checkpoint, "SAM checkpoint"),
    parseArtifactRef(evidence.engines?.sam?.licenseNotice, "SAM license notice"),
    ...evidence.pairs.flatMap((pair) => [
      parseArtifactRef(pair.source, `${pair.id} source`),
      parseArtifactRef(pair.truthAlpha8, `${pair.id} truth`),
      parseArtifactRef(pair.promptLabels8, `${pair.id} prompt`),
      parseArtifactRef(pair.selfAuthored?.predictionAlpha8, `${pair.id} self-authored prediction`),
      parseArtifactRef(pair.sam?.predictionAlpha8, `${pair.id} SAM prediction`),
    ]),
  ];
}

async function buildFacts(evidencePath: string): Promise<{
  evidence: PairedEvidence;
  facts: ComparisonFacts;
  metrics: PairMetrics[];
  performance: { selfFailureRate: number; samFailureRate: number; selfMedianMs: number; samMedianMs: number };
  artifactEvidence: { files: number; bytes: number; aggregateSha256: string };
}> {
  const evidenceBytes = await readFile(evidencePath);
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as PairedEvidence;
  if (!evidence || typeof evidence !== "object" || !Array.isArray(evidence.pairs)) throw new Error("Paired evidence is not a valid object");
  const root = dirname(evidencePath);
  const references = artifactReferences(evidence);
  const folded = new Set<string>();
  for (const reference of references) {
    const key = reference.path.toLocaleLowerCase("en-US");
    if (key === basename(evidencePath).toLocaleLowerCase("en-US") || folded.has(key)) throw new Error(`Duplicate/reserved artifact reference: ${reference.path}`);
    folded.add(key);
  }
  const verifiedPaths = new Map<string, string>();
  for (const reference of references) verifiedPaths.set(reference.path, await assertRealFile(root, reference));
  const inventoryExact = await exactInventory(root, basename(evidencePath), references);
  const dataset = JSON.parse(await readFile(verifiedPaths.get(evidence.dataset.manifest.path)!, "utf8")) as DatasetManifest;
  const performance = JSON.parse(await readFile(verifiedPaths.get(evidence.environment.performanceReceipt.path)!, "utf8")) as PerformanceReceipt;
  const pairIds = new Set<string>();
  const categories = new Set<string>();
  let totalFrames = 0;
  const expectedDatasetClips = evidence.pairs.map((pair) => {
    if (!pair.id?.trim() || pairIds.has(pair.id) || !Number.isSafeInteger(pair.width) || pair.width < 16 || pair.width > 4096
      || !Number.isSafeInteger(pair.height) || pair.height < 16 || pair.height > 4096
      || !Number.isSafeInteger(pair.frames) || pair.frames < 1 || pair.frames > 172_800
      || !Number.isFinite(pair.fps) || pair.fps <= 0 || pair.fps > 240 || !Array.isArray(pair.categories)) throw new Error(`Invalid paired clip: ${pair.id}`);
    pairIds.add(pair.id);
    totalFrames += pair.frames;
    pair.categories.forEach((category) => categories.add(category));
    const expectedAlphaBytes = pair.width * pair.height * pair.frames;
    if (pair.truthAlpha8.bytes !== expectedAlphaBytes || pair.selfAuthored.predictionAlpha8.bytes !== expectedAlphaBytes
      || pair.sam.predictionAlpha8.bytes !== expectedAlphaBytes || pair.promptLabels8.bytes !== pair.width * pair.height) {
      throw new Error(`Alpha/prompt geometry mismatch: ${pair.id}`);
    }
    if (pair.selfAuthored.failed !== (pair.selfAuthored.failureDisposition === "zero-mask-scored")
      || pair.sam.failed !== (pair.sam.failureDisposition === "zero-mask-scored")) throw new Error(`Failure disposition is inconsistent: ${pair.id}`);
    return {
      id: pair.id, width: pair.width, height: pair.height, frames: pair.frames, fps: pair.fps,
      categories: pair.categories, sourceSha256: pair.source.sha256, truthAlpha8Sha256: pair.truthAlpha8.sha256,
      promptLabels8Sha256: pair.promptLabels8.sha256,
    };
  });
  const datasetExact = dataset.schema === DATASET_SCHEMA && dataset.id === evidence.dataset.id
    && canonicalJson(dataset.clips) === canonicalJson(expectedDatasetClips);
  if (performance.schema !== PERFORMANCE_SCHEMA || !Array.isArray(performance.pairs)) throw new Error("Performance receipt schema is invalid");
  const performanceByPair = new Map(performance.pairs.map((pair) => [pair.clipId, pair]));
  const runtimeSamples = (samples: RuntimeSample[], expected: number): boolean => Array.isArray(samples) && samples.length === expected
    && samples.every((sample) => sample && typeof sample.failed === "boolean"
      && (sample.failed
        ? sample.elapsedMs === null && sample.peakMemoryBytes === null
        : Number.isFinite(sample.elapsedMs) && Number(sample.elapsedMs) > 0 && Number.isSafeInteger(sample.peakMemoryBytes) && Number(sample.peakMemoryBytes) >= 0));
  const performancePairsComplete = performance.pairs.length === evidence.pairs.length
    && performance.pairs.every((pair) => pairIds.has(pair.clipId) && ["self-authored-first", "sam-first"].includes(pair.order))
    && evidence.pairs.every((pair) => {
      const receipt = performanceByPair.get(pair.id);
      return Boolean(receipt && runtimeSamples(receipt.selfAuthored, performance.controls.measuredRuns) && runtimeSamples(receipt.sam, performance.controls.measuredRuns));
    });
  const orderCounts = performance.pairs.reduce((counts, pair) => {
    counts[pair.order] = (counts[pair.order] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const counterbalanced = performance.controls.counterbalancedOrder
    && Math.abs((orderCounts["self-authored-first"] ?? 0) - (orderCounts["sam-first"] ?? 0)) <= 1;
  const metrics: PairMetrics[] = [];
  for (const pair of evidence.pairs) {
    const item = await comparePair(pair, {
      truth: verifiedPaths.get(pair.truthAlpha8.path)!,
      selfAuthored: verifiedPaths.get(pair.selfAuthored.predictionAlpha8.path)!,
      sam: verifiedPaths.get(pair.sam.predictionAlpha8.path)!,
    });
    if ((pair.selfAuthored.failed && !item.selfAuthored.allZero) || (pair.sam.failed && !item.sam.allZero)) {
      throw new Error(`Failed engine output was not scored as an exact zero mask: ${pair.id}`);
    }
    metrics.push(item);
  }
  const selfSamples = performance.pairs.flatMap((pair) => pair.selfAuthored);
  const samSamples = performance.pairs.flatMap((pair) => pair.sam);
  const successfulTimes = (samples: RuntimeSample[]) => samples.filter((sample) => !sample.failed).map((sample) => sample.elapsedMs!);
  const runtime = {
    selfFailureRate: selfSamples.length ? selfSamples.filter((sample) => sample.failed).length / selfSamples.length : Number.NaN,
    samFailureRate: samSamples.length ? samSamples.filter((sample) => sample.failed).length / samSamples.length : Number.NaN,
    selfMedianMs: median(successfulTimes(selfSamples)),
    samMedianMs: median(successfulTimes(samSamples)),
  };
  const macro = (engine: "selfAuthored" | "sam", metric: "j" | "f" | "jAndF") => mean(metrics.map((pair) => pair[engine][metric]));
  const weighted = (engine: "selfAuthored" | "sam") => metrics.reduce((sum, pair) => sum + pair[engine].jAndF * pair.frames, 0) / totalFrames;
  const deltas = metrics.map((pair) => pair.delta.jAndF);
  const parseTime = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.NaN;
  const selfFrozen = parseTime(evidence.engines?.selfAuthored?.frozenAt);
  const samFrozen = parseTime(evidence.engines?.sam?.frozenAt);
  const captured = parseTime(dataset.capturedAt);
  const revealed = parseTime(dataset.groundTruthRevealedAt);
  const generated = parseTime(evidence.generatedAt);
  const sam = evidence.engines?.sam;
  const facts: ComparisonFacts = {
    evidencePresent: true,
    schemaValid: evidence.schema === EVIDENCE_SCHEMA,
    protocolBound: evidence.protocol?.id === PROTOCOL.id && evidence.protocol?.sha256 === PROTOCOL_SHA256,
    realBlindHoldout: evidence.controls?.realFootage === true && evidence.controls?.blindHoldout === true,
    preregisteredNoCherryPicking: evidence.controls?.preregisteredAllEligibleNoCherryPicking === true,
    configurationsFrozenBeforeCapture: evidence.controls?.configurationsFrozenBeforeCapture === true
      && Number.isFinite(selfFrozen) && Number.isFinite(samFrozen) && Number.isFinite(captured) && captured > Math.max(selfFrozen, samFrozen),
    groundTruthIndependentAndPostFreeze: evidence.controls?.independentHumanReviewedGroundTruth === true
      && Number.isFinite(revealed) && Number.isFinite(generated) && revealed >= captured && generated >= revealed,
    identicalInputsAndPrompt: evidence.controls?.identicalSourceFramesAndPrompt === true,
    promptFrameExcluded: evidence.controls?.promptFrameExcluded === true,
    noManualCorrections: evidence.controls?.noManualCorrections === true,
    noHoldoutTuning: evidence.controls?.noPerEngineHoldoutTuning === true,
    datasetProvenanceComplete: Boolean(evidence.dataset?.id?.trim() && evidence.dataset?.origin?.trim()
      && evidence.dataset?.licenseOrOwnership?.trim() && evidence.dataset?.redistribution?.trim()),
    researchUsePermitted: evidence.dataset?.researchUsePermitted === true,
    datasetManifestExact: datasetExact,
    allArtifactHashesVerified: true,
    exactClosedWorldInventory: inventoryExact,
    // Evidence schema v1 has no trusted runner signature, execution binding,
    // eligible-universe commitment, truth-reveal seal, or independent timestamp.
    // Self-declared booleans/hashes must never be upgraded into those facts.
    independentRunnerExecutionReceiptBound: false,
    blindFreezeProvenanceBound: false,
    selfEngineIdentity: evidence.engines?.selfAuthored?.id === SELF_ENGINE && evidence.engines?.selfAuthored?.provenance === "editkin-self-authored",
    selfAuthoredNoExternalWeights: evidence.engines?.selfAuthored?.externalWeights === false,
    samProvenanceComplete: Boolean(sam?.id?.trim() && /^SAM(?:\s|[-_.]?)[23]/i.test(sam?.modelFamily ?? "")
      && /^https:\/\/(?:www\.)?github\.com\//i.test(sam?.repository ?? "") && COMMIT.test(sam?.upstreamCommit ?? "")
      && sam?.licenseSpdx?.trim() && sam?.provenanceOrganization?.trim() && sam?.provenanceOrganization !== "Editkin" && sam?.attributionPreserved === true),
    samResearchOnly: sam?.role === "research-control-only",
    samNotBundledOrProductEligible: sam?.productEligible === false && sam?.bundledInProduct === false,
    noEngineFallbacks: evidence.engines?.selfAuthored?.fallbackUsed === false && sam?.fallbackUsed === false,
    samePhysicalDeviceAndRuntime: performance.controls?.samePhysicalDevice === true && performance.controls?.sameOsAndDriver === true
      && SHA256.test(performance.device?.identitySha256 ?? "") && Boolean(performance.device?.description?.trim() && performance.device?.os?.trim()
        && performance.device?.accelerator?.trim() && performance.device?.driver?.trim() && performance.controls?.powerProfile?.trim()),
    isolatedProcesses: performance.controls?.isolatedProcessPerEngine === true,
    counterbalancedOrder: counterbalanced,
    warmupsAdequate: Number.isSafeInteger(performance.controls?.warmupRuns) && performance.controls.warmupRuns >= PROTOCOL.minimums.warmupRuns,
    measuredRunsAdequate: Number.isSafeInteger(performance.controls?.measuredRuns) && performance.controls.measuredRuns >= PROTOCOL.minimums.measuredRuns,
    performancePairsComplete,
    failedRunsScoredNotDropped: evidence.controls?.failedRunsScoredNotDropped === true && performancePairsComplete,
    minimumClipCount: evidence.pairs.length >= PROTOCOL.minimums.clips,
    minimumFrameCount: totalFrames >= PROTOCOL.minimums.evaluatedFrames,
    coverageComplete: REQUIRED_COVERAGE.every((category) => categories.has(category)),
    metricsFinite: metrics.flatMap((pair) => [pair.selfAuthored.j, pair.selfAuthored.f, pair.selfAuthored.jAndF,
      pair.sam.j, pair.sam.f, pair.sam.jAndF, pair.delta.j, pair.delta.f, pair.delta.jAndF]).every(Number.isFinite),
    macroSuperiority: macro("selfAuthored", "jAndF") - macro("sam", "jAndF") >= PROTOCOL.superiority.macroJAndFDeltaMinimum,
    frameWeightedSuperiority: weighted("selfAuthored") - weighted("sam") >= PROTOCOL.superiority.frameWeightedJAndFDeltaMinimum,
    medianSuperiority: median(deltas) >= PROTOCOL.superiority.medianClipJAndFDeltaMinimum,
    clipWinRate: deltas.filter((value) => value > 0).length / deltas.length >= PROTOCOL.superiority.clipWinRateMinimum,
    worstClipSafety: Math.min(...deltas) >= PROTOCOL.superiority.worstClipJAndFDeltaMinimum,
    regionJNonInferior: macro("selfAuthored", "j") - macro("sam", "j") >= PROTOCOL.superiority.componentNonInferiorityMinimum,
    boundaryFNonInferior: macro("selfAuthored", "f") - macro("sam", "f") >= PROTOCOL.superiority.componentNonInferiorityMinimum,
    selfRuntimeFailureNoWorse: runtime.selfFailureRate <= runtime.samFailureRate,
  };
  const identity = createHash("sha256");
  let artifactBytes = 0;
  for (const reference of [...references].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    identity.update(reference.path).update("\0").update(String(reference.bytes)).update("\0").update(reference.sha256).update("\n");
    artifactBytes += reference.bytes;
  }
  return { evidence, facts, metrics, performance: runtime, artifactEvidence: { files: references.length, bytes: artifactBytes, aggregateSha256: identity.digest("hex") } };
}

async function writeReport(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!(["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))) throw error;
      await rm(path, { force: true });
      await rename(temporary, path);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function validFactsFixture(): ComparisonFacts {
  return Object.fromEntries([
    "evidencePresent", "schemaValid", "protocolBound", "realBlindHoldout", "preregisteredNoCherryPicking",
    "configurationsFrozenBeforeCapture", "groundTruthIndependentAndPostFreeze", "identicalInputsAndPrompt",
    "promptFrameExcluded", "noManualCorrections", "noHoldoutTuning", "datasetProvenanceComplete",
    "researchUsePermitted", "datasetManifestExact", "allArtifactHashesVerified", "exactClosedWorldInventory",
    "independentRunnerExecutionReceiptBound", "blindFreezeProvenanceBound",
    "selfEngineIdentity", "selfAuthoredNoExternalWeights", "samProvenanceComplete", "samResearchOnly",
    "samNotBundledOrProductEligible", "noEngineFallbacks", "samePhysicalDeviceAndRuntime", "isolatedProcesses",
    "counterbalancedOrder", "warmupsAdequate", "measuredRunsAdequate", "performancePairsComplete",
    "failedRunsScoredNotDropped", "minimumClipCount", "minimumFrameCount", "coverageComplete", "metricsFinite",
    "macroSuperiority", "frameWeightedSuperiority", "medianSuperiority", "clipWinRate", "worstClipSafety",
    "regionJNonInferior", "boundaryFNonInferior", "selfRuntimeFailureNoWorse",
  ].map((key) => [key, true])) as unknown as ComparisonFacts;
}

async function selfTest(): Promise<void> {
  const valid = validFactsFixture();
  if (evaluateFacts(valid).length) throw new Error("Fair comparison evaluator rejected valid control");
  if (preflightStatus([]) !== "BLOCK_PROMOTION_PROTOCOL_V2_REQUIRED") throw new Error("All-true legacy facts may not promote a superiority claim");
  const mutations = (Object.keys(valid) as Array<keyof ComparisonFacts>).map((key) => {
    const changed = { ...valid, [key]: false };
    if (!evaluateFacts(changed).includes(key)) throw new Error(`Fair comparison evaluator accepted mutation: ${key}`);
    return key;
  });
  const width = 20; const height = 16;
  const truth = new Uint8Array(width * height);
  const exact = new Uint8Array(width * height);
  const empty = new Uint8Array(width * height);
  for (let y = 3; y < 13; y += 1) for (let x = 4; x < 16; x += 1) truth[y * width + x] = exact[y * width + x] = 255;
  const exactMetrics = frameMetrics(exact, truth, width, height);
  const emptyMetrics = frameMetrics(empty, truth, width, height);
  const full = new Uint8Array(width * height); full.fill(255);
  const fullAgainstEmpty = frameMetrics(full, empty, width, height);
  if (exactMetrics.j !== 1 || exactMetrics.f !== 1 || emptyMetrics.j !== 0 || emptyMetrics.f !== 0
    || fullAgainstEmpty.j !== 0 || fullAgainstEmpty.f !== 0) throw new Error("Raw paired metric calibration failed");
  const missingEvidenceBlocks = evaluateFacts({ ...valid, evidencePresent: false }).includes("evidencePresent");
  if (mutations.length < 15 || !missingEvidenceBlocks) throw new Error("Fair comparison negative controls are incomplete");
  const workspace = await mkdtemp(resolve(tmpdir(), "editkin-auto-roto-vs-sam-self-test-"));
  let hashedStructureIngestion = false;
  let syntheticPromotionBlocked = false;
  let artifactTamperRejected = false;
  let extraArtifactRejected = false;
  try {
    const store = async (path: string, value: string | Uint8Array): Promise<ArtifactRef> => {
      const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
      const target = resolve(workspace, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    };
    const selfImplementation = await store("engines/self.bin", "self-authored parser fixture");
    const samImplementation = await store("engines/sam.py", "upstream SAM parser fixture");
    const checkpoint = await store("engines/sam.ckpt", "research checkpoint fixture");
    const licenseNotice = await store("engines/SAM-LICENSE.txt", "Apache-2.0 parser fixture");
    const pairs: EvidencePair[] = [];
    for (let clip = 0; clip < 8; clip += 1) {
      const id = `clip-${clip + 1}`;
      const frames = 30;
      const truthSequence = new Uint8Array(width * height * frames);
      const samSequence = new Uint8Array(width * height * frames);
      for (let frame = 0; frame < frames; frame += 1) {
        for (let y = 3; y < 13; y += 1) {
          for (let x = 4; x < 16; x += 1) {
            truthSequence[frame * width * height + y * width + x] = 255;
            if (x >= 6 && x < 14) samSequence[frame * width * height + y * width + x] = 255;
          }
        }
      }
      pairs.push({
        id, width, height, frames, fps: 12, categories: [...REQUIRED_COVERAGE],
        source: await store(`clips/${id}.source`, Uint8Array.of(clip + 1)),
        truthAlpha8: await store(`clips/${id}.truth.alpha8`, truthSequence),
        promptLabels8: await store(`clips/${id}.prompt.labels8`, truthSequence.subarray(0, width * height)),
        selfAuthored: { predictionAlpha8: await store(`clips/${id}.self.alpha8`, truthSequence), failed: false, failureDisposition: "completed" },
        sam: { predictionAlpha8: await store(`clips/${id}.sam.alpha8`, samSequence), failed: false, failureDisposition: "completed" },
      });
    }
    const datasetManifest = await store("dataset/manifest.json", JSON.stringify({
      schema: DATASET_SCHEMA,
      id: "self-test-parser-fixture",
      capturedAt: "2026-08-10T00:00:00.000Z",
      groundTruthRevealedAt: "2026-08-11T00:00:00.000Z",
      clips: pairs.map((pair) => ({
        id: pair.id, width: pair.width, height: pair.height, frames: pair.frames, fps: pair.fps,
        categories: pair.categories, sourceSha256: pair.source.sha256, truthAlpha8Sha256: pair.truthAlpha8.sha256,
        promptLabels8Sha256: pair.promptLabels8.sha256,
      })),
    } satisfies DatasetManifest));
    const performanceReceipt = await store("performance/receipt.json", JSON.stringify({
      schema: PERFORMANCE_SCHEMA,
      device: { identitySha256: "d".repeat(64), description: "self-test device", os: "self-test OS", accelerator: "self-test accelerator", driver: "self-test driver" },
      controls: { samePhysicalDevice: true, sameOsAndDriver: true, isolatedProcessPerEngine: true, counterbalancedOrder: true, powerProfile: "fixed", warmupRuns: 1, measuredRuns: 3 },
      pairs: pairs.map((pair, index) => ({
        clipId: pair.id,
        order: index % 2 ? "sam-first" as const : "self-authored-first" as const,
        selfAuthored: Array.from({ length: 3 }, (_, run) => ({ elapsedMs: 100 + run, peakMemoryBytes: 1024, failed: false })),
        sam: Array.from({ length: 3 }, (_, run) => ({ elapsedMs: 120 + run, peakMemoryBytes: 2048, failed: false })),
      })),
    } satisfies PerformanceReceipt));
    const evidence: PairedEvidence = {
      schema: EVIDENCE_SCHEMA,
      protocol: { id: PROTOCOL.id, sha256: PROTOCOL_SHA256 },
      generatedAt: "2026-08-12T00:00:00.000Z",
      controls: {
        realFootage: true, blindHoldout: true, preregisteredAllEligibleNoCherryPicking: true,
        configurationsFrozenBeforeCapture: true, independentHumanReviewedGroundTruth: true,
        identicalSourceFramesAndPrompt: true, promptFrameExcluded: true, noManualCorrections: true,
        noPerEngineHoldoutTuning: true, failedRunsScoredNotDropped: true,
      },
      dataset: {
        id: "self-test-parser-fixture", origin: "synthetic parser calibration only",
        licenseOrOwnership: "self-test bytes", researchUsePermitted: true, redistribution: "not distributed",
        manifest: datasetManifest,
      },
      environment: { performanceReceipt },
      engines: {
        selfAuthored: { id: SELF_ENGINE, provenance: "editkin-self-authored", implementation: selfImplementation, frozenAt: "2026-08-01T00:00:00.000Z", externalWeights: false, fallbackUsed: false },
        sam: {
          id: "upstream-sam-research-control/v1", modelFamily: "SAM 2.1", repository: "https://github.com/facebookresearch/sam2",
          upstreamCommit: "a".repeat(40), licenseSpdx: "Apache-2.0", provenanceOrganization: "Meta Platforms, Inc.",
          role: "research-control-only", productEligible: false, bundledInProduct: false, attributionPreserved: true,
          implementation: samImplementation, checkpoint, licenseNotice, frozenAt: "2026-08-01T00:00:00.000Z", fallbackUsed: false,
        },
      },
      pairs,
    };
    const evidencePath = resolve(workspace, "paired-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const ingested = await buildFacts(evidencePath);
    const ingestionFailures = evaluateFacts(ingested.facts);
    hashedStructureIngestion = ingestionFailures.length === PROMOTION_ATTESTATION_FACTS.size
      && ingestionFailures.every((failure) => PROMOTION_ATTESTATION_FACTS.has(failure as keyof ComparisonFacts));
    syntheticPromotionBlocked = preflightStatus(ingestionFailures) === "BLOCK_RUNNER_ATTESTATION_REQUIRED";
    await writeFile(resolve(workspace, pairs[0].selfAuthored.predictionAlpha8.path), Uint8Array.of(0));
    try { await buildFacts(evidencePath); } catch { artifactTamperRejected = true; }
    await writeFile(
      resolve(workspace, pairs[0].selfAuthored.predictionAlpha8.path),
      await readFile(resolve(workspace, pairs[0].truthAlpha8.path)),
    );
    await writeFile(resolve(workspace, "unreferenced.bin"), "extra", "utf8");
    const extra = await buildFacts(evidencePath);
    extraArtifactRejected = !extra.facts.exactClosedWorldInventory;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  if (!hashedStructureIngestion || !syntheticPromotionBlocked || !artifactTamperRejected || !extraArtifactRejected) throw new Error("Paired evidence preflight controls are incomplete");
  process.stdout.write(`${JSON.stringify({ status: "GREEN_STRUCTURE_INSTRUMENT_SELF_TEST_SUPERIORITY_DISABLED", mutationsRejected: mutations.length, exactMetricControl: exactMetrics, emptyMetricControl: emptyMetrics, fullAgainstEmptyControl: fullAgainstEmpty, missingEvidenceBlocks, hashedStructureIngestion, syntheticPromotionBlocked, artifactTamperRejected, extraArtifactRejected, protocolSha256: PROTOCOL_SHA256 })}\n`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("--self-test")) {
  await selfTest();
  process.exit(0);
}

const evidencePath = resolve(argument("--evidence") ?? resolve(APP_ROOT, ".rd/evidence/editkin-auto-roto-vs-sam/paired-evidence.json"));
const reportPath = resolve(argument("--report") ?? resolve(APP_ROOT, ".rd/benchmarks/editkin-auto-roto-vs-sam-fair-comparison/report.json"));
const sourcePath = resolve(process.argv[1]);
const sourceBytes = await readFile(sourcePath);
const baseReport = {
  schema: REPORT_SCHEMA,
  generatedAt: new Date().toISOString(),
  protocol: { ...PROTOCOL, sha256: PROTOCOL_SHA256 },
  evaluator: { path: normalized(relative(APP_ROOT, sourcePath)), bytes: sourceBytes.length, sha256: sha256(sourceBytes), mutationMinimum: 15 },
  evidencePath: normalized(relative(APP_ROOT, evidencePath)),
  claimBoundary: [
    "SAM remains an upstream-attributed research control and is never represented as Editkin-authored or product-eligible.",
    "Schema v1 is an evidence-structure and metric-instrument preflight only; its metrics cannot establish superiority.",
    "Promotion remains blocked until an independent runner receipt binds executable/build/config/source/prompt/output and a blind commit-reveal freeze binds the eligible source universe, decoded frame IDs, sealed predictions, and later truth reveal.",
    "Synthetic self-tests calibrate rejection and metric plumbing only; they are never competitor evidence.",
  ],
  promotionDisabled: true,
};
try {
  await lstat(evidencePath);
} catch {
  const report = { ...baseReport, status: "BLOCK_MISSING_PAIRED_EVIDENCE", failures: ["evidencePresent"], facts: { evidencePresent: false } };
  await writeReport(reportPath, report);
  process.stdout.write(`AUTO_ROTO_VS_SAM_FAIR_COMPARISON status=${report.status} report=${reportPath}\n`);
  process.exitCode = 1;
  process.exit();
}

try {
  if (isInside(dirname(evidencePath), reportPath)) throw new Error("Report path must remain outside the closed-world evidence root");
  const built = await buildFacts(evidencePath);
  const failures = evaluateFacts(built.facts);
  const status = preflightStatus(failures);
  const report = {
    ...baseReport,
    status,
    failures,
    facts: built.facts,
    evidence: { bytes: (await lstat(evidencePath)).size, sha256: sha256(await readFile(evidencePath)), artifactIdentity: built.artifactEvidence },
    engines: {
      selfAuthored: { id: built.evidence.engines.selfAuthored.id, implementationSha256: built.evidence.engines.selfAuthored.implementation.sha256 },
      samResearchControl: {
        id: built.evidence.engines.sam.id,
        family: built.evidence.engines.sam.modelFamily,
        repository: built.evidence.engines.sam.repository,
        upstreamCommit: built.evidence.engines.sam.upstreamCommit,
        licenseSpdx: built.evidence.engines.sam.licenseSpdx,
        provenanceOrganization: built.evidence.engines.sam.provenanceOrganization,
        checkpointSha256: built.evidence.engines.sam.checkpoint.sha256,
        licenseNoticeSha256: built.evidence.engines.sam.licenseNotice.sha256,
        role: built.evidence.engines.sam.role,
        productEligible: built.evidence.engines.sam.productEligible,
        bundledInProduct: built.evidence.engines.sam.bundledInProduct,
        attributionPreserved: built.evidence.engines.sam.attributionPreserved,
      },
    },
    metrics: built.metrics,
    performance: built.performance,
  };
  await writeReport(reportPath, report);
  process.stdout.write(`AUTO_ROTO_VS_SAM_FAIR_COMPARISON status=${status} pairs=${built.metrics.length} report=${reportPath}\n`);
  process.exitCode = 1;
} catch (error) {
  const report = { ...baseReport, status: "BLOCK_INVALID_PAIRED_EVIDENCE", failures: ["evidence-invalid"], error: String(error) };
  await writeReport(reportPath, report);
  process.stdout.write(`AUTO_ROTO_VS_SAM_FAIR_COMPARISON status=${report.status} report=${reportPath}\n`);
  process.exitCode = 1;
}
