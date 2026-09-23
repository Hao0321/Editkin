import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALPHA_QUALITY_THRESHOLDS,
  REQUIRED_ALPHA_BIT_DEPTHS,
  REQUIRED_ALPHA_CASES,
  aggregateAlphaQualityMetrics,
  computeClipAlphaQuality,
  evaluateAlphaQualityAcceptance,
  type AlphaQualityCapability,
  type AlphaQualityFacts,
  type AlphaQualityMetrics,
  type WeightedAlphaQualityMetrics,
} from "./lib/alpha-quality-metrics";

const MANIFEST_SCHEMA = "editkin.alpha-quality-holdout/v1";
const REPORT_SCHEMA = "editkin.alpha-quality-acceptance-report/v1";
const SELF_TEST_SCHEMA = "editkin.alpha-quality-evaluator-self-test/v1";
const APP_ROOT = resolve(import.meta.dirname, "..");
const SELF_TEST_REPORT = join(APP_ROOT, ".rd", "benchmarks", "editkin-alpha-quality-evaluator", "self-test.json");

interface ArtifactRef {
  path: string;
  bytes: number;
  sha256: string;
}

interface CandidateReceipt {
  engineId: string;
  implementation: ArtifactRef;
  outputsFrozenAt: string;
}

interface BlindingReceipt {
  datasetVisibility: "blind-holdout" | string;
  evaluatorIndependent: boolean;
  candidateHadGroundTruthAccess: boolean;
  groundTruthRevealedAt: string;
  evaluationStartedAt: string;
}

interface RightsReceipt {
  schema: "editkin.alpha-holdout-rights-receipt/v1";
  datasetId: string;
  rightsBasis: "owned" | "commercially-permitted" | string;
  ownerOrLicensor: string;
  commercialUsePermitted: boolean;
  sourceExcludedFromCandidateTraining: boolean;
  annotationIndependentOfCandidate: boolean;
  restrictions: string[];
}

interface CorrectionJournal {
  schema: "editkin.alpha-correction-journal/v1";
  datasetId: string;
  reviewerIds: string[];
  entries: Array<{ clipId: string; reviewerId: string; actions: number; seconds: number; completed: boolean }>;
}

interface PerformanceReceipt {
  schema: "editkin.alpha-performance-receipt/v1";
  datasetId: string;
  deviceIdentity: string;
  runtimeIdentity: string;
  samples: Array<{
    runId: string;
    clipId: string;
    frames: number;
    elapsedMs: number;
    peakMemoryBytes: number;
    failed: boolean;
  }>;
}

interface HoldoutClip {
  id: string;
  sourceId: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  sourceBitDepth: number;
  categories: string[];
  keyChannel?: "green" | "blue";
  sourceRgbF32: ArtifactRef;
  truthAlphaF32: ArtifactRef;
  previewAlphaF32: ArtifactRef;
  formalAlphaF32: ArtifactRef;
  truthForegroundRgbF32: ArtifactRef;
  previewForegroundRgbF32: ArtifactRef;
  formalForegroundRgbF32: ArtifactRef;
  spillEvaluationMaskF32?: ArtifactRef;
  compositeBackgroundsRgbF32: ArtifactRef[];
}

interface HoldoutManifest {
  schema: typeof MANIFEST_SCHEMA;
  datasetId: string;
  capability: AlphaQualityCapability;
  frozenAt: string;
  candidate: CandidateReceipt;
  blinding: BlindingReceipt;
  rightsReceipt: ArtifactRef;
  correctionJournal: ArtifactRef;
  performanceReceipt: ArtifactRef;
  clips: HoldoutClip[];
}

interface IngestedEvidence {
  manifest: HoldoutManifest;
  manifestBytes: Uint8Array;
  facts: AlphaQualityFacts;
  clipMetrics: Array<{ clipId: string; metrics: AlphaQualityMetrics }>;
  verifiedArtifactCount: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown key ${key}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be a non-empty-string array`);
  }
  return value as string[];
}

function timestamp(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be an ISO-compatible timestamp`);
  return parsed;
}

function artifactRef(value: unknown, label: string): ArtifactRef {
  const item = record(value, label);
  exactKeys(item, ["path", "bytes", "sha256"], [], label);
  const path = nonEmptyString(item.path, `${label}.path`);
  const bytes = positiveInteger(item.bytes, `${label}.bytes`);
  const digest = nonEmptyString(item.sha256, `${label}.sha256`);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error(`${label}.path must be a normalized bundle-relative POSIX path`);
  }
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}.sha256 is invalid`);
  return { path, bytes, sha256: digest };
}

function parseManifest(value: unknown): HoldoutManifest {
  const item = record(value, "manifest");
  exactKeys(item, ["schema", "datasetId", "capability", "frozenAt", "candidate", "blinding", "rightsReceipt", "correctionJournal", "performanceReceipt", "clips"], [], "manifest");
  if (item.schema !== MANIFEST_SCHEMA) throw new Error(`Unsupported manifest schema: ${String(item.schema)}`);
  const capability = item.capability;
  if (capability !== "screen-keyer" && capability !== "optical-alpha-refinement") throw new Error("manifest.capability is invalid");
  const candidateItem = record(item.candidate, "manifest.candidate");
  exactKeys(candidateItem, ["engineId", "implementation", "outputsFrozenAt"], [], "manifest.candidate");
  const candidate: CandidateReceipt = {
    engineId: nonEmptyString(candidateItem.engineId, "manifest.candidate.engineId"),
    implementation: artifactRef(candidateItem.implementation, "manifest.candidate.implementation"),
    outputsFrozenAt: timestamp(candidateItem.outputsFrozenAt, "manifest.candidate.outputsFrozenAt"),
  };
  const blindingItem = record(item.blinding, "manifest.blinding");
  exactKeys(blindingItem, ["datasetVisibility", "evaluatorIndependent", "candidateHadGroundTruthAccess", "groundTruthRevealedAt", "evaluationStartedAt"], [], "manifest.blinding");
  const blinding: BlindingReceipt = {
    datasetVisibility: nonEmptyString(blindingItem.datasetVisibility, "manifest.blinding.datasetVisibility"),
    evaluatorIndependent: booleanValue(blindingItem.evaluatorIndependent, "manifest.blinding.evaluatorIndependent"),
    candidateHadGroundTruthAccess: booleanValue(blindingItem.candidateHadGroundTruthAccess, "manifest.blinding.candidateHadGroundTruthAccess"),
    groundTruthRevealedAt: timestamp(blindingItem.groundTruthRevealedAt, "manifest.blinding.groundTruthRevealedAt"),
    evaluationStartedAt: timestamp(blindingItem.evaluationStartedAt, "manifest.blinding.evaluationStartedAt"),
  };
  if (!Array.isArray(item.clips)) throw new Error("manifest.clips must be an array");
  const clips = item.clips.map((value, index): HoldoutClip => {
    const clip = record(value, `manifest.clips[${index}]`);
    exactKeys(clip, ["id", "sourceId", "width", "height", "frames", "fps", "sourceBitDepth", "categories", "sourceRgbF32", "truthAlphaF32", "previewAlphaF32", "formalAlphaF32", "truthForegroundRgbF32", "previewForegroundRgbF32", "formalForegroundRgbF32", "compositeBackgroundsRgbF32"], ["keyChannel", "spillEvaluationMaskF32"], `manifest.clips[${index}]`);
    if (!Array.isArray(clip.compositeBackgroundsRgbF32)) throw new Error(`manifest.clips[${index}].compositeBackgroundsRgbF32 must be an array`);
    const keyChannel = clip.keyChannel;
    if (keyChannel !== undefined && keyChannel !== "green" && keyChannel !== "blue") throw new Error(`manifest.clips[${index}].keyChannel is invalid`);
    return {
      id: nonEmptyString(clip.id, `manifest.clips[${index}].id`),
      sourceId: nonEmptyString(clip.sourceId, `manifest.clips[${index}].sourceId`),
      width: positiveInteger(clip.width, `manifest.clips[${index}].width`),
      height: positiveInteger(clip.height, `manifest.clips[${index}].height`),
      frames: positiveInteger(clip.frames, `manifest.clips[${index}].frames`),
      fps: finiteNumber(clip.fps, `manifest.clips[${index}].fps`),
      sourceBitDepth: positiveInteger(clip.sourceBitDepth, `manifest.clips[${index}].sourceBitDepth`),
      categories: stringArray(clip.categories, `manifest.clips[${index}].categories`),
      ...(keyChannel === undefined ? {} : { keyChannel }),
      sourceRgbF32: artifactRef(clip.sourceRgbF32, `manifest.clips[${index}].sourceRgbF32`),
      truthAlphaF32: artifactRef(clip.truthAlphaF32, `manifest.clips[${index}].truthAlphaF32`),
      previewAlphaF32: artifactRef(clip.previewAlphaF32, `manifest.clips[${index}].previewAlphaF32`),
      formalAlphaF32: artifactRef(clip.formalAlphaF32, `manifest.clips[${index}].formalAlphaF32`),
      truthForegroundRgbF32: artifactRef(clip.truthForegroundRgbF32, `manifest.clips[${index}].truthForegroundRgbF32`),
      previewForegroundRgbF32: artifactRef(clip.previewForegroundRgbF32, `manifest.clips[${index}].previewForegroundRgbF32`),
      formalForegroundRgbF32: artifactRef(clip.formalForegroundRgbF32, `manifest.clips[${index}].formalForegroundRgbF32`),
      ...(clip.spillEvaluationMaskF32 === undefined ? {} : { spillEvaluationMaskF32: artifactRef(clip.spillEvaluationMaskF32, `manifest.clips[${index}].spillEvaluationMaskF32`) }),
      compositeBackgroundsRgbF32: clip.compositeBackgroundsRgbF32.map((background, backgroundIndex) => artifactRef(background, `manifest.clips[${index}].compositeBackgroundsRgbF32[${backgroundIndex}]`)),
    };
  });
  return {
    schema: MANIFEST_SCHEMA,
    datasetId: nonEmptyString(item.datasetId, "manifest.datasetId"),
    capability,
    frozenAt: timestamp(item.frozenAt, "manifest.frozenAt"),
    candidate,
    blinding,
    rightsReceipt: artifactRef(item.rightsReceipt, "manifest.rightsReceipt"),
    correctionJournal: artifactRef(item.correctionJournal, "manifest.correctionJournal"),
    performanceReceipt: artifactRef(item.performanceReceipt, "manifest.performanceReceipt"),
    clips,
  };
}

function parseRights(value: unknown): RightsReceipt {
  const item = record(value, "rights receipt");
  exactKeys(item, ["schema", "datasetId", "rightsBasis", "ownerOrLicensor", "commercialUsePermitted", "sourceExcludedFromCandidateTraining", "annotationIndependentOfCandidate", "restrictions"], [], "rights receipt");
  if (item.schema !== "editkin.alpha-holdout-rights-receipt/v1") throw new Error("Rights receipt schema is invalid");
  return {
    schema: "editkin.alpha-holdout-rights-receipt/v1",
    datasetId: nonEmptyString(item.datasetId, "rights receipt.datasetId"),
    rightsBasis: nonEmptyString(item.rightsBasis, "rights receipt.rightsBasis"),
    ownerOrLicensor: nonEmptyString(item.ownerOrLicensor, "rights receipt.ownerOrLicensor"),
    commercialUsePermitted: booleanValue(item.commercialUsePermitted, "rights receipt.commercialUsePermitted"),
    sourceExcludedFromCandidateTraining: booleanValue(item.sourceExcludedFromCandidateTraining, "rights receipt.sourceExcludedFromCandidateTraining"),
    annotationIndependentOfCandidate: booleanValue(item.annotationIndependentOfCandidate, "rights receipt.annotationIndependentOfCandidate"),
    restrictions: stringArray(item.restrictions, "rights receipt.restrictions"),
  };
}

function parseCorrections(value: unknown): CorrectionJournal {
  const item = record(value, "correction journal");
  exactKeys(item, ["schema", "datasetId", "reviewerIds", "entries"], [], "correction journal");
  if (item.schema !== "editkin.alpha-correction-journal/v1") throw new Error("Correction journal schema is invalid");
  if (!Array.isArray(item.entries)) throw new Error("correction journal.entries must be an array");
  return {
    schema: "editkin.alpha-correction-journal/v1",
    datasetId: nonEmptyString(item.datasetId, "correction journal.datasetId"),
    reviewerIds: stringArray(item.reviewerIds, "correction journal.reviewerIds"),
    entries: item.entries.map((value, index) => {
      const entry = record(value, `correction journal.entries[${index}]`);
      exactKeys(entry, ["clipId", "reviewerId", "actions", "seconds", "completed"], [], `correction journal.entries[${index}]`);
      const actions = finiteNumber(entry.actions, `correction journal.entries[${index}].actions`);
      const seconds = finiteNumber(entry.seconds, `correction journal.entries[${index}].seconds`);
      if (!Number.isSafeInteger(actions) || actions < 0 || seconds < 0) throw new Error(`correction journal.entries[${index}] has invalid effort`);
      return {
        clipId: nonEmptyString(entry.clipId, `correction journal.entries[${index}].clipId`),
        reviewerId: nonEmptyString(entry.reviewerId, `correction journal.entries[${index}].reviewerId`),
        actions,
        seconds,
        completed: booleanValue(entry.completed, `correction journal.entries[${index}].completed`),
      };
    }),
  };
}

function parsePerformance(value: unknown): PerformanceReceipt {
  const item = record(value, "performance receipt");
  exactKeys(item, ["schema", "datasetId", "deviceIdentity", "runtimeIdentity", "samples"], [], "performance receipt");
  if (item.schema !== "editkin.alpha-performance-receipt/v1") throw new Error("Performance receipt schema is invalid");
  if (!Array.isArray(item.samples)) throw new Error("performance receipt.samples must be an array");
  return {
    schema: "editkin.alpha-performance-receipt/v1",
    datasetId: nonEmptyString(item.datasetId, "performance receipt.datasetId"),
    deviceIdentity: nonEmptyString(item.deviceIdentity, "performance receipt.deviceIdentity"),
    runtimeIdentity: nonEmptyString(item.runtimeIdentity, "performance receipt.runtimeIdentity"),
    samples: item.samples.map((value, index) => {
      const sample = record(value, `performance receipt.samples[${index}]`);
      exactKeys(sample, ["runId", "clipId", "frames", "elapsedMs", "peakMemoryBytes", "failed"], [], `performance receipt.samples[${index}]`);
      const elapsedMs = finiteNumber(sample.elapsedMs, `performance receipt.samples[${index}].elapsedMs`);
      const peakMemoryBytes = finiteNumber(sample.peakMemoryBytes, `performance receipt.samples[${index}].peakMemoryBytes`);
      if (elapsedMs <= 0 || peakMemoryBytes < 0 || !Number.isSafeInteger(peakMemoryBytes)) throw new Error(`performance receipt.samples[${index}] has invalid cost`);
      return {
        runId: nonEmptyString(sample.runId, `performance receipt.samples[${index}].runId`),
        clipId: nonEmptyString(sample.clipId, `performance receipt.samples[${index}].clipId`),
        frames: positiveInteger(sample.frames, `performance receipt.samples[${index}].frames`),
        elapsedMs,
        peakMemoryBytes,
        failed: booleanValue(sample.failed, `performance receipt.samples[${index}].failed`),
      };
    }),
  };
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function float32Bytes(values: readonly number[]): Uint8Array {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return output;
}

function decodeFloat32(bytes: Uint8Array, expectedSamples: number, label: string): Float32Array {
  if (bytes.byteLength !== expectedSamples * 4) throw new Error(`${label} byte count does not match ${expectedSamples} float32 samples`);
  const output = new Float32Array(expectedSamples);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < output.length; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} contains a non-finite or out-of-range sample`);
    output[index] = value;
  }
  return output;
}

async function verifiedArtifact(base: string, reference: ArtifactRef, seen: Set<string>): Promise<Uint8Array> {
  if (seen.has(reference.path)) throw new Error(`Artifact path is not closed-world unique: ${reference.path}`);
  seen.add(reference.path);
  const path = resolve(base, ...reference.path.split("/"));
  const outside = relative(base, path);
  if (outside.startsWith("..") || isAbsolute(outside)) throw new Error(`Artifact escapes holdout bundle: ${reference.path}`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== reference.bytes) throw new Error(`Artifact byte count mismatch: ${reference.path}`);
  if (sha256(bytes) !== reference.sha256) throw new Error(`Artifact hash mismatch: ${reference.path}`);
  return bytes;
}

export async function ingestAlphaQualityManifest(manifestPath: string): Promise<IngestedEvidence> {
  const canonicalManifestPath = resolve(manifestPath);
  const manifestBytes = await readFile(canonicalManifestPath);
  const manifest = parseManifest(parseJson(manifestBytes, "manifest"));
  const base = dirname(canonicalManifestPath);
  const seenArtifacts = new Set<string>();
  const [implementationBytes, rightsBytes, correctionBytes, performanceBytes] = await Promise.all([
    verifiedArtifact(base, manifest.candidate.implementation, seenArtifacts),
    verifiedArtifact(base, manifest.rightsReceipt, seenArtifacts),
    verifiedArtifact(base, manifest.correctionJournal, seenArtifacts),
    verifiedArtifact(base, manifest.performanceReceipt, seenArtifacts),
  ]);
  if (!implementationBytes.length) throw new Error("Candidate implementation artifact is empty");
  const rights = parseRights(parseJson(rightsBytes, "rights receipt"));
  const corrections = parseCorrections(parseJson(correctionBytes, "correction journal"));
  const performance = parsePerformance(parseJson(performanceBytes, "performance receipt"));
  if (rights.datasetId !== manifest.datasetId || corrections.datasetId !== manifest.datasetId || performance.datasetId !== manifest.datasetId) {
    throw new Error("Dataset identity differs across manifest and receipts");
  }
  if (!rights.annotationIndependentOfCandidate) throw new Error("Ground-truth annotation must be independent of the candidate");
  if (rights.restrictions.some((restriction) => /non[- ]?commercial|research[- ]?only|evaluation[- ]?only|no commercial/iu.test(restriction))) {
    throw new Error("Rights receipt contains a commercial-use restriction");
  }
  const outputsFrozen = Date.parse(manifest.candidate.outputsFrozenAt);
  const truthRevealed = Date.parse(manifest.blinding.groundTruthRevealedAt);
  const evaluationStarted = Date.parse(manifest.blinding.evaluationStartedAt);
  const bundleFrozen = Date.parse(manifest.frozenAt);
  const candidateFrozenBeforeGroundTruthReveal = outputsFrozen < truthRevealed
    && truthRevealed <= evaluationStarted
    && evaluationStarted <= bundleFrozen
    && !manifest.blinding.candidateHadGroundTruthAccess;
  const clipIds = new Set<string>();
  const sourceIds = new Set<string>();
  const sourceHashes = new Set<string>();
  const metrics: WeightedAlphaQualityMetrics[] = [];
  const clipMetrics: IngestedEvidence["clipMetrics"] = [];
  let totalFrames = 0;
  let minimumBackgroundsPerClip = Number.POSITIVE_INFINITY;
  for (const clip of manifest.clips) {
    if (clipIds.has(clip.id) || sourceIds.has(clip.sourceId)) throw new Error("Clip and source identities must be unique");
    clipIds.add(clip.id);
    sourceIds.add(clip.sourceId);
    if (clip.width < 2 || clip.height < 2 || clip.frames < 2 || clip.fps <= 0) throw new Error(`Clip geometry is not evaluable: ${clip.id}`);
    if (!REQUIRED_ALPHA_BIT_DEPTHS.includes(clip.sourceBitDepth as 8 | 10 | 12 | 16)) throw new Error(`Unsupported source bit depth for ${clip.id}`);
    if (new Set(clip.categories).size !== clip.categories.length) throw new Error(`Clip categories must be unique: ${clip.id}`);
    if (clip.compositeBackgroundsRgbF32.length < ALPHA_QUALITY_THRESHOLDS.minimumBackgroundsPerClip) throw new Error(`Clip lacks multi-background evidence: ${clip.id}`);
    if (manifest.capability === "screen-keyer" && (!clip.keyChannel || !clip.spillEvaluationMaskF32)) throw new Error(`Screen-keyer clip lacks spill evidence: ${clip.id}`);
    if (manifest.capability === "optical-alpha-refinement" && (clip.keyChannel || clip.spillEvaluationMaskF32)) throw new Error(`Optical-alpha clip contains keyer-only spill evidence: ${clip.id}`);
    const pixelCount = clip.width * clip.height * clip.frames;
    const rgbCount = pixelCount * 3;
    const sourceBytes = await verifiedArtifact(base, clip.sourceRgbF32, seenArtifacts);
    sourceHashes.add(clip.sourceRgbF32.sha256);
    decodeFloat32(sourceBytes, rgbCount, `${clip.id}.sourceRgbF32`);
    const [truthAlphaBytes, previewAlphaBytes, formalAlphaBytes, truthForegroundBytes, previewForegroundBytes, formalForegroundBytes] = await Promise.all([
      verifiedArtifact(base, clip.truthAlphaF32, seenArtifacts),
      verifiedArtifact(base, clip.previewAlphaF32, seenArtifacts),
      verifiedArtifact(base, clip.formalAlphaF32, seenArtifacts),
      verifiedArtifact(base, clip.truthForegroundRgbF32, seenArtifacts),
      verifiedArtifact(base, clip.previewForegroundRgbF32, seenArtifacts),
      verifiedArtifact(base, clip.formalForegroundRgbF32, seenArtifacts),
    ]);
    const backgroundBytes: Uint8Array[] = [];
    for (const background of clip.compositeBackgroundsRgbF32) backgroundBytes.push(await verifiedArtifact(base, background, seenArtifacts));
    const spillBytes = clip.spillEvaluationMaskF32
      ? await verifiedArtifact(base, clip.spillEvaluationMaskF32, seenArtifacts)
      : undefined;
    const computed = computeClipAlphaQuality({
      width: clip.width,
      height: clip.height,
      frames: clip.frames,
      truthAlpha: decodeFloat32(truthAlphaBytes, pixelCount, `${clip.id}.truthAlphaF32`),
      previewAlpha: decodeFloat32(previewAlphaBytes, pixelCount, `${clip.id}.previewAlphaF32`),
      formalAlpha: decodeFloat32(formalAlphaBytes, pixelCount, `${clip.id}.formalAlphaF32`),
      truthForegroundRgb: decodeFloat32(truthForegroundBytes, rgbCount, `${clip.id}.truthForegroundRgbF32`),
      previewForegroundRgb: decodeFloat32(previewForegroundBytes, rgbCount, `${clip.id}.previewForegroundRgbF32`),
      formalForegroundRgb: decodeFloat32(formalForegroundBytes, rgbCount, `${clip.id}.formalForegroundRgbF32`),
      backgroundsRgb: backgroundBytes.map((bytes, index) => decodeFloat32(bytes, rgbCount, `${clip.id}.background[${index}]`)),
      ...(clip.keyChannel && spillBytes ? {
        keyChannel: clip.keyChannel,
        spillEvaluationMask: decodeFloat32(spillBytes, pixelCount, `${clip.id}.spillEvaluationMaskF32`),
      } : {}),
    });
    metrics.push(computed);
    const { weights: _weights, ...reportedMetrics } = computed;
    clipMetrics.push({ clipId: clip.id, metrics: reportedMetrics });
    totalFrames += clip.frames;
    minimumBackgroundsPerClip = Math.min(minimumBackgroundsPerClip, clip.compositeBackgroundsRgbF32.length);
  }
  if (sourceHashes.size !== manifest.clips.length) throw new Error("Every holdout clip must bind unique source bytes");
  const reviewerIds = new Set(corrections.reviewerIds);
  if (reviewerIds.size !== corrections.reviewerIds.length || corrections.reviewerIds.some((id) => !/^[a-f0-9]{32,128}$/u.test(id))) {
    throw new Error("Reviewer identities must be unique privacy-safe hashes");
  }
  const correctionPairs = new Set<string>();
  for (const entry of corrections.entries) {
    if (!clipIds.has(entry.clipId) || !reviewerIds.has(entry.reviewerId)) throw new Error("Correction journal contains an unknown clip or reviewer");
    const pair = `${entry.clipId}\u0000${entry.reviewerId}`;
    if (correctionPairs.has(pair)) throw new Error("Correction journal contains duplicate clip/reviewer entries");
    correctionPairs.add(pair);
  }
  if (manifest.clips.some((clip) => corrections.reviewerIds.some((reviewerId) => !correctionPairs.has(`${clip.id}\u0000${reviewerId}`)))) {
    throw new Error("Correction journal must contain exactly one entry per clip/reviewer pair");
  }
  const runIds = new Set<string>();
  for (const sample of performance.samples) {
    if (runIds.has(sample.runId)) throw new Error("Performance run identities must be unique");
    runIds.add(sample.runId);
    const clip = manifest.clips.find((candidate) => candidate.id === sample.clipId);
    if (!clip || sample.frames !== clip.frames) throw new Error("Performance sample does not bind a full known clip");
  }
  if (manifest.clips.some((clip) => performance.samples.filter((sample) => sample.clipId === clip.id).length < 3)) {
    throw new Error("Performance receipt requires at least three full-clip runs per clip");
  }
  const quality = aggregateAlphaQualityMetrics(metrics);
  const facts: AlphaQualityFacts = {
    capability: manifest.capability,
    clipCount: manifest.clips.length,
    totalFrames,
    uniqueSourceCount: sourceHashes.size,
    coverage: [...new Set(manifest.clips.flatMap((clip) => clip.categories))],
    sourceBitDepths: [...new Set(manifest.clips.map((clip) => clip.sourceBitDepth))],
    minimumBackgroundsPerClip,
    rightsBasis: rights.rightsBasis,
    commercialUsePermitted: rights.commercialUsePermitted,
    sourceExcludedFromCandidateTraining: rights.sourceExcludedFromCandidateTraining,
    candidateFrozenBeforeGroundTruthReveal,
    evaluatorIndependent: manifest.blinding.evaluatorIndependent,
    datasetVisibility: manifest.blinding.datasetVisibility,
    reviewerCount: reviewerIds.size,
    meanCorrectionActions: mean(corrections.entries.map((entry) => entry.actions)),
    meanCorrectionSeconds: mean(corrections.entries.map((entry) => entry.seconds)),
    correctionCompletionRate: corrections.entries.length
      ? corrections.entries.filter((entry) => entry.completed).length / corrections.entries.length
      : Number.NaN,
    p95LatencyMsPerFrame: percentile(performance.samples.map((sample) => sample.elapsedMs / sample.frames), 0.95),
    p95PeakMemoryBytes: percentile(performance.samples.map((sample) => sample.peakMemoryBytes), 0.95),
    maximumPeakMemoryBytes: performance.samples.length ? Math.max(...performance.samples.map((sample) => sample.peakMemoryBytes)) : Number.NaN,
    runtimeFailureRate: performance.samples.length
      ? performance.samples.filter((sample) => sample.failed).length / performance.samples.length
      : Number.NaN,
    allArtifactHashesVerified: true,
    ...quality,
  };
  return { manifest, manifestBytes, facts, clipMetrics, verifiedArtifactCount: seenArtifacts.size };
}

function exactMetrics(capability: AlphaQualityCapability): AlphaQualityMetrics {
  return {
    alphaSad: 0,
    alphaMad: 0,
    alphaMse: 0,
    gradientError: 0,
    connectivityError: 0,
    temporalDtssd: 0,
    foregroundRgbMae: 0,
    foregroundRgbMse: 0,
    multiBackgroundCompositeRgbMae: 0,
    multiBackgroundCompositeRgbMse: 0,
    spillResidual: capability === "screen-keyer" ? 0 : null,
    spillResidualExcess: capability === "screen-keyer" ? 0 : null,
    previewFormalAlphaMae: 0,
    previewFormalAlphaMax: 0,
    previewFormalForegroundRgbMae: 0,
    previewFormalCompositeRgbMae: 0,
  };
}

function validFacts(capability: AlphaQualityCapability): AlphaQualityFacts {
  return {
    capability,
    clipCount: 8,
    totalFrames: 32,
    uniqueSourceCount: 8,
    coverage: [...REQUIRED_ALPHA_CASES[capability]],
    sourceBitDepths: [...REQUIRED_ALPHA_BIT_DEPTHS],
    minimumBackgroundsPerClip: 3,
    rightsBasis: "owned",
    commercialUsePermitted: true,
    sourceExcludedFromCandidateTraining: true,
    candidateFrozenBeforeGroundTruthReveal: true,
    evaluatorIndependent: true,
    datasetVisibility: "blind-holdout",
    reviewerCount: 3,
    meanCorrectionActions: 1,
    meanCorrectionSeconds: 5,
    correctionCompletionRate: 1,
    p95LatencyMsPerFrame: 10,
    p95PeakMemoryBytes: 256 * 1024 * 1024,
    maximumPeakMemoryBytes: 256 * 1024 * 1024,
    runtimeFailureRate: 0,
    allArtifactHashesVerified: true,
    ...exactMetrics(capability),
  };
}

async function writeStoredArtifact(workspace: string, name: string, bytes: Uint8Array | string): Promise<ArtifactRef> {
  const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const path = resolve(workspace, ...name.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return { path: name, bytes: body.byteLength, sha256: sha256(body) };
}

async function createSelfTestBundle(workspace: string, capability: AlphaQualityCapability): Promise<{ manifestPath: string; tamperPath: string }> {
  const datasetId = `owned-${capability}-instrument-calibration`;
  const candidateImplementation = await writeStoredArtifact(workspace, "candidate/implementation.bin", Uint8Array.of(1, 3, 3, 7));
  const reviewerIds = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
  const corrections: CorrectionJournal["entries"] = [];
  const samples: PerformanceReceipt["samples"] = [];
  const clips: HoldoutClip[] = [];
  let tamperPath = "";
  for (let clipIndex = 0; clipIndex < 8; clipIndex += 1) {
    const id = `clip-${clipIndex + 1}`;
    const width = 2;
    const height = 2;
    const frames = 4;
    const pixels = width * height * frames;
    const alpha = Array.from({ length: pixels }, (_, index) => [0.25, 0.5, 0.75, 1][(index + clipIndex) % 4]);
    const foreground = Array.from({ length: pixels * 3 }, (_, index) => {
      const channel = index % 3;
      return channel === 0 ? 0.45 + clipIndex * 0.001 : channel === 1 ? 0.45 : 0.4;
    });
    const source = foreground.map((value, index) => Math.min(1, value + ((index === 0 ? clipIndex + 1 : 0) / 1000)));
    const backgrounds = [0.1, 0.5, 0.9].map((level, backgroundIndex) =>
      Array.from({ length: pixels * 3 }, (_, index) => Math.min(1, level + ((index + backgroundIndex) % 3) * 0.01)));
    const prefix = `clips/${id}`;
    const previewAlphaF32 = await writeStoredArtifact(workspace, `${prefix}/preview-alpha.f32le`, float32Bytes(alpha));
    if (clipIndex === 0) tamperPath = resolve(workspace, ...previewAlphaF32.path.split("/"));
    clips.push({
      id,
      sourceId: `owned-source-${clipIndex + 1}`,
      width,
      height,
      frames,
      fps: 24,
      sourceBitDepth: REQUIRED_ALPHA_BIT_DEPTHS[clipIndex % REQUIRED_ALPHA_BIT_DEPTHS.length],
      categories: [...REQUIRED_ALPHA_CASES[capability]],
      ...(capability === "screen-keyer" ? { keyChannel: clipIndex % 2 ? "blue" as const : "green" as const } : {}),
      sourceRgbF32: await writeStoredArtifact(workspace, `${prefix}/source-rgb.f32le`, float32Bytes(source)),
      truthAlphaF32: await writeStoredArtifact(workspace, `${prefix}/truth-alpha.f32le`, float32Bytes(alpha)),
      previewAlphaF32,
      formalAlphaF32: await writeStoredArtifact(workspace, `${prefix}/formal-alpha.f32le`, float32Bytes(alpha)),
      truthForegroundRgbF32: await writeStoredArtifact(workspace, `${prefix}/truth-foreground-rgb.f32le`, float32Bytes(foreground)),
      previewForegroundRgbF32: await writeStoredArtifact(workspace, `${prefix}/preview-foreground-rgb.f32le`, float32Bytes(foreground)),
      formalForegroundRgbF32: await writeStoredArtifact(workspace, `${prefix}/formal-foreground-rgb.f32le`, float32Bytes(foreground)),
      ...(capability === "screen-keyer" ? {
        spillEvaluationMaskF32: await writeStoredArtifact(workspace, `${prefix}/spill-mask.f32le`, float32Bytes(Array.from({ length: pixels }, () => 1))),
      } : {}),
      compositeBackgroundsRgbF32: await Promise.all(backgrounds.map((background, index) =>
        writeStoredArtifact(workspace, `${prefix}/background-${index + 1}-rgb.f32le`, float32Bytes(background)))),
    });
    for (const reviewerId of reviewerIds) corrections.push({ clipId: id, reviewerId, actions: 1, seconds: 5, completed: true });
    for (let run = 0; run < 3; run += 1) {
      samples.push({
        runId: `${id}-run-${run + 1}`,
        clipId: id,
        frames,
        elapsedMs: 20 + run,
        peakMemoryBytes: 64 * 1024 * 1024,
        failed: false,
      });
    }
  }
  const rightsReceipt = await writeStoredArtifact(workspace, "receipts/rights.json", JSON.stringify({
    schema: "editkin.alpha-holdout-rights-receipt/v1",
    datasetId,
    rightsBasis: "owned",
    ownerOrLicensor: "Editkin evaluator-calibration fixture",
    commercialUsePermitted: true,
    sourceExcludedFromCandidateTraining: true,
    annotationIndependentOfCandidate: true,
    restrictions: ["instrument-calibration-only; not product-quality evidence"],
  } satisfies RightsReceipt));
  const correctionJournal = await writeStoredArtifact(workspace, "receipts/corrections.json", JSON.stringify({
    schema: "editkin.alpha-correction-journal/v1",
    datasetId,
    reviewerIds,
    entries: corrections,
  } satisfies CorrectionJournal));
  const performanceReceipt = await writeStoredArtifact(workspace, "receipts/performance.json", JSON.stringify({
    schema: "editkin.alpha-performance-receipt/v1",
    datasetId,
    deviceIdentity: "self-test-cpu",
    runtimeIdentity: "evaluator-calibration-not-product-runtime",
    samples,
  } satisfies PerformanceReceipt));
  const manifest: HoldoutManifest = {
    schema: MANIFEST_SCHEMA,
    datasetId,
    capability,
    frozenAt: "2026-08-28T04:00:00.000Z",
    candidate: {
      engineId: `editkin-${capability}-evaluator-calibration/v1`,
      implementation: candidateImplementation,
      outputsFrozenAt: "2026-08-28T01:00:00.000Z",
    },
    blinding: {
      datasetVisibility: "blind-holdout",
      evaluatorIndependent: true,
      candidateHadGroundTruthAccess: false,
      groundTruthRevealedAt: "2026-08-28T02:00:00.000Z",
      evaluationStartedAt: "2026-08-28T03:00:00.000Z",
    },
    rightsReceipt,
    correctionJournal,
    performanceReceipt,
    clips,
  };
  const manifestPath = resolve(workspace, `${capability}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, tamperPath };
}

async function selfTest(): Promise<void> {
  const exactAlpha = new Float32Array([0, 0.25, 0.75, 1, 0.1, 0.4, 0.6, 0.9]);
  const exactForeground = new Float32Array(exactAlpha.length * 3).fill(0.4);
  const backgrounds = [0.1, 0.5, 0.9].map((value) => new Float32Array(exactForeground.length).fill(value));
  const exact = computeClipAlphaQuality({
    width: 2,
    height: 2,
    frames: 2,
    truthAlpha: exactAlpha,
    previewAlpha: exactAlpha,
    formalAlpha: exactAlpha,
    truthForegroundRgb: exactForeground,
    previewForegroundRgb: exactForeground,
    formalForegroundRgb: exactForeground,
    backgroundsRgb: backgrounds,
    keyChannel: "green",
    spillEvaluationMask: new Float32Array(exactAlpha.length).fill(1),
  });
  if (exact.alphaMad !== 0 || exact.connectivityError !== 0 || exact.foregroundRgbMae !== 0
    || exact.multiBackgroundCompositeRgbMae !== 0 || exact.previewFormalAlphaMax !== 0 || exact.spillResidual !== 0) {
    throw new Error("Exact alpha/foreground/composite control did not score perfectly");
  }
  const keyerValid = validFacts("screen-keyer");
  const opticalValid = validFacts("optical-alpha-refinement");
  if (evaluateAlphaQualityAcceptance(keyerValid).length || evaluateAlphaQualityAcceptance(opticalValid).length) {
    throw new Error("Acceptance evaluator rejects a valid capability control");
  }
  const mutations: Array<[string, string, (facts: AlphaQualityFacts) => void]> = [
    ["clip-count", "clip-count", (facts) => { facts.clipCount = 7; }],
    ["frame-count", "frame-count", (facts) => { facts.totalFrames = 31; }],
    ["source-identity", "unique-source-identity", (facts) => { facts.uniqueSourceCount = 7; }],
    ["hard-case", "coverage:hair-fur", (facts) => { facts.coverage = facts.coverage.filter((value) => value !== "hair-fur"); }],
    ["bit-depth", "bit-depth:12", (facts) => { facts.sourceBitDepths = facts.sourceBitDepths.filter((value) => value !== 12); }],
    ["background-count", "multi-background-count", (facts) => { facts.minimumBackgroundsPerClip = 2; }],
    ["rights-basis", "rights-basis", (facts) => { facts.rightsBasis = "research-only"; }],
    ["commercial-rights", "commercial-use-rights", (facts) => { facts.commercialUsePermitted = false; }],
    ["training-separation", "training-holdout-separation", (facts) => { facts.sourceExcludedFromCandidateTraining = false; }],
    ["freeze-order", "candidate-freeze-order", (facts) => { facts.candidateFrozenBeforeGroundTruthReveal = false; }],
    ["independent-evaluator", "independent-evaluator", (facts) => { facts.evaluatorIndependent = false; }],
    ["blind-holdout", "blind-holdout", (facts) => { facts.datasetVisibility = "development-visible"; }],
    ["reviewer-count", "reviewer-count", (facts) => { facts.reviewerCount = 2; }],
    ["alpha-mad", "alpha-mad", (facts) => { facts.alphaMad = 0.081; }],
    ["alpha-mse", "alpha-mse", (facts) => { facts.alphaMse = 0.026; }],
    ["gradient", "gradient-error", (facts) => { facts.gradientError = 0.081; }],
    ["connectivity", "connectivity-error", (facts) => { facts.connectivityError = 0.081; }],
    ["temporal", "temporal-dtssd", (facts) => { facts.temporalDtssd = 0.081; }],
    ["foreground", "foreground-rgb-mae", (facts) => { facts.foregroundRgbMae = 0.081; }],
    ["multi-background-composite", "multi-background-composite-rgb-mae", (facts) => { facts.multiBackgroundCompositeRgbMae = 0.041; }],
    ["spill-missing", "spill-evidence-missing", (facts) => { facts.spillResidual = null; facts.spillResidualExcess = null; }],
    ["spill-residual", "spill-residual", (facts) => { facts.spillResidual = 0.041; }],
    ["spill-excess", "spill-residual-excess", (facts) => { facts.spillResidualExcess = 0.021; }],
    ["preview-formal-alpha-mean", "preview-formal-alpha-mae", (facts) => { facts.previewFormalAlphaMae = 0.004; }],
    ["preview-formal-alpha-max", "preview-formal-alpha-max", (facts) => { facts.previewFormalAlphaMax = 0.004; }],
    ["preview-formal-foreground", "preview-formal-foreground-rgb-mae", (facts) => { facts.previewFormalForegroundRgbMae = 0.006; }],
    ["preview-formal-composite", "preview-formal-composite-rgb-mae", (facts) => { facts.previewFormalCompositeRgbMae = 0.006; }],
    ["correction-actions", "correction-actions", (facts) => { facts.meanCorrectionActions = 13; }],
    ["correction-seconds", "correction-seconds", (facts) => { facts.meanCorrectionSeconds = 46; }],
    ["correction-completion", "correction-completion-rate", (facts) => { facts.correctionCompletionRate = 0.94; }],
    ["latency", "latency-p95", (facts) => { facts.p95LatencyMsPerFrame = 101; }],
    ["memory", "memory-p95", (facts) => { facts.p95PeakMemoryBytes = 8 * 1024 * 1024 * 1024 + 1; }],
    ["runtime-failure", "runtime-failure-rate", (facts) => { facts.runtimeFailureRate = 0.03; }],
    ["artifact-hash", "artifact-hash-verification", (facts) => { facts.allArtifactHashesVerified = false; }],
    ["non-finite", "non-finite-metric", (facts) => { facts.foregroundRgbMse = Number.NaN; }],
  ];
  for (const [name, expectedFailure, mutate] of mutations) {
    const facts = structuredClone(keyerValid);
    mutate(facts);
    const failures = evaluateAlphaQualityAcceptance(facts);
    if (!failures.includes(expectedFailure)) throw new Error(`Evaluator mutation ${name} did not trigger ${expectedFailure}: ${failures.join(", ")}`);
  }
  const unexpectedSpill = structuredClone(opticalValid);
  unexpectedSpill.spillResidual = 0;
  unexpectedSpill.spillResidualExcess = 0;
  if (!evaluateAlphaQualityAcceptance(unexpectedSpill).includes("spill-evidence-unexpected")) {
    throw new Error("Optical-alpha control accepted keyer-only spill evidence");
  }
  const workspace = await mkdtemp(join(tmpdir(), "editkin-alpha-quality-self-test-"));
  const ingestionControls: Record<AlphaQualityCapability, string> = {
    "screen-keyer": "PENDING",
    "optical-alpha-refinement": "PENDING",
  };
  let artifactTamperControl = "PENDING";
  try {
    for (const capability of ["screen-keyer", "optical-alpha-refinement"] as const) {
      const bundle = await createSelfTestBundle(workspace, capability);
      const ingested = await ingestAlphaQualityManifest(bundle.manifestPath);
      const failures = evaluateAlphaQualityAcceptance(ingested.facts);
      if (failures.length) throw new Error(`Hashed ${capability} fixture was rejected: ${failures.join(", ")}`);
      ingestionControls[capability] = "GREEN";
      if (capability === "screen-keyer") {
        const original = await readFile(bundle.tamperPath);
        const tampered = Buffer.from(original);
        tampered[0] ^= 0xff;
        await writeFile(bundle.tamperPath, tampered);
        let rejected = false;
        try {
          await ingestAlphaQualityManifest(bundle.manifestPath);
        } catch (error) {
          rejected = /hash mismatch/iu.test(String(error));
        }
        if (!rejected) throw new Error("Hash-bound ingestion accepted a tampered alpha artifact");
        artifactTamperControl = "REJECTED";
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  const implementationPath = resolve(import.meta.dirname, "alpha-quality-acceptance-gate.ts");
  const metricsPath = resolve(import.meta.dirname, "lib", "alpha-quality-metrics.ts");
  const protocolPath = join(APP_ROOT, "docs", "alpha-quality-blind-holdout-protocol.md");
  const report = {
    schema: SELF_TEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: "GREEN_INSTRUMENT_CALIBRATED_PRODUCT_QUALITY_UNMEASURED",
    evaluatorMutations: mutations.map(([name, expectedFailure]) => ({ name, expectedFailure, rejected: true })),
    evaluatorMutationCount: mutations.length + 1,
    exactMetricControl: { ...exact, weights: undefined },
    capabilityControls: {
      "screen-keyer": "GREEN",
      "optical-alpha-refinement": "GREEN",
      "optical-rejects-keyer-spill-fields": "GREEN",
    },
    hashedIngestion: ingestionControls,
    artifactTamperControl,
    sources: {
      implementation: { path: "scripts/alpha-quality-acceptance-gate.ts", sha256: sha256(await readFile(implementationPath)) },
      metrics: { path: "scripts/lib/alpha-quality-metrics.ts", sha256: sha256(await readFile(metricsPath)) },
      protocol: { path: "docs/alpha-quality-blind-holdout-protocol.md", sha256: sha256(await readFile(protocolPath)) },
    },
    claimBoundary: [
      "This report calibrates the evaluator, schema, metric oracles, closed-world ingestion, and tamper rejection only.",
      "All self-test media are generated evaluator fixtures visible to the implementation; they are not product-quality evidence.",
      "screen-keyer-quality-acceptance and optical-alpha-quality-acceptance remain unmeasured until independent real blind holdouts are frozen and evaluated.",
    ],
  };
  await mkdir(dirname(SELF_TEST_REPORT), { recursive: true });
  await writeFile(SELF_TEST_REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`ALPHA_QUALITY_EVALUATOR_SELF_TEST status=GREEN mutations=${mutations.length + 1} ingestion=2 tamper=REJECTED quality=UNMEASURED`);
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
  const requestedManifest = argument("--manifest");
  if (!requestedManifest) {
    throw new Error("Usage: tsx scripts/alpha-quality-acceptance-gate.ts --manifest <frozen-holdout.json> [--require-capability screen-keyer|optical-alpha-refinement] [--report <report.json>]");
  }
  const evidence = await ingestAlphaQualityManifest(requestedManifest);
  const requiredCapability = argument("--require-capability");
  if (requiredCapability && evidence.manifest.capability !== requiredCapability) {
    throw new Error(`Manifest capability ${evidence.manifest.capability} does not satisfy required ${requiredCapability}`);
  }
  const failures = evaluateAlphaQualityAcceptance(evidence.facts);
  const manifestPath = resolve(requestedManifest);
  const reportPath = resolve(argument("--report") ?? join(dirname(manifestPath), `${evidence.manifest.capability}-quality-report.json`));
  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_BLIND_HOLDOUT",
    capability: evidence.manifest.capability,
    candidate: evidence.manifest.candidate,
    manifest: {
      path: manifestPath,
      bytes: (await stat(manifestPath)).size,
      sha256: sha256(evidence.manifestBytes),
    },
    verifiedArtifactCount: evidence.verifiedArtifactCount,
    thresholds: ALPHA_QUALITY_THRESHOLDS,
    requiredCoverage: REQUIRED_ALPHA_CASES[evidence.manifest.capability],
    requiredBitDepths: REQUIRED_ALPHA_BIT_DEPTHS,
    facts: evidence.facts,
    clipMetrics: evidence.clipMetrics,
    failures,
    metricSemantics: {
      alpha: "straight-alpha float32 SAD/MAD/MSE over every frozen pixel",
      gradient: "mean absolute central-difference alpha-gradient magnitude error",
      connectivity: "largest shared four-connected alpha component over 0.1 threshold levels",
      temporalDtssd: "RMS disagreement of adjacent-frame alpha derivatives without motion compensation",
      foreground: "truth-alpha-weighted straight-foreground RGB error; zero-alpha RGB is excluded",
      composite: "RGB error after independently compositing preview/truth foreground and alpha over at least three frozen backgrounds",
      spill: "truth-mask-weighted positive green/blue channel dominance and excess over truth; screen-keyer only",
      previewFormal: "direct alpha/foreground and multi-background composite disagreement between preview and formal frame packs",
      performance: "full-clip elapsed time per frame and peak process memory; at least three runs per clip",
    },
    claimBoundary: [
      "GREEN applies only to the exact hash-bound, owned or commercially permitted, training-separated blind holdout, candidate bytes, device/runtime, reviewers, preview and formal outputs in this manifest.",
      "GREEN does not establish competitor superiority, unseen-domain generalization, installer delivery, high-bit-depth export round-trip, or cross-platform parity.",
      "A self-test report is instrument calibration, not a product-quality report.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) throw new Error(`Alpha quality acceptance BLOCK: ${failures.join(", ")}`);
  console.log(`Alpha quality acceptance GREEN capability=${evidence.manifest.capability} report=${reportPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await main();
}
