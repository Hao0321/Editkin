import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const EXPECTED_SOURCE_PATH = "public/demo-source.mp4";
export const EXPECTED_REGISTRY_SOURCE_PATHS = [
  "src/creative/haoCorePack.json",
  "src/creative/corePack.ts",
  "src/creative/studioAssets.ts",
  "src/creative/wave2Registry.ts",
  "../../community/hao-motion-kit/expansion_2026_wave2/hao-core-pack-wave2-additions.json",
] as const;
export const EXPECTED_RENDERER_SOURCE_PATHS = [
  "src/render/creativeFilters.ts",
  "src/render/ffmpegComposite.ts",
  "src/render/ffmpeg.ts",
] as const;
export const EXPECTED_EVALUATOR_SOURCE_PATHS = [
  "scripts/cinematic-decoded-matrix-gate.ts",
  "scripts/lib/cinematic-decoded-matrix-gate.ts",
  "scripts/lib/cinematic-decoded-matrix-io.ts",
  "scripts/lib/cinematic-decoded-matrix-runtime.ts",
] as const;
export const EXPECTED_RUNTIME_PATHS = [
  "vendor/ffmpeg/win32-x64/ffmpeg.exe",
  "vendor/ffmpeg/win32-x64/ffprobe.exe",
] as const;

function numberedArtifactPaths(kind: "look" | "transition", count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const shard = `${kind}-shard-${String(index + 1).padStart(2, "0")}`;
    return [
      `.rd/benchmarks/editkin-cinematic-decoded-matrix/${shard}/baseline.mp4`,
      `.rd/benchmarks/editkin-cinematic-decoded-matrix/${shard}/candidate.mp4`,
    ];
  }).flat();
}

export const EXPECTED_ARTIFACT_PATHS = [
  ...numberedArtifactPaths("look", 4),
  ".rd/benchmarks/editkin-cinematic-decoded-matrix/look-shard-01/baseline-repeat.mp4",
  ...numberedArtifactPaths("transition", 7),
] as const;

export const REQUIRED_LOOK_IDS = [
  "clean_neutral",
  "cinematic_warm_soft",
  "vlog_bright_clean",
  "podcast_skin_neutral",
  "travel_airy_local",
  "food_warm_appetite",
  "toy_energy_clean",
  "toy_arena_punch",
  "ai_cobalt_crisp",
  "night_neon_controlled",
  "studio_skin_daylight",
  "studio_food_amber",
  "studio_city_cyan",
  "studio_film_cream",
  "studio_product_white",
  "studio_night_violet",
  "studio_documentary_olive",
  "studio_soft_pink",
  "cine_neutral_balance",
  "cine_creator_clean_pop",
  "cine_soft_daylight_skin",
  "cine_cool_precision",
  "cine_warm_documentary",
  "cine_muted_editorial",
  "cine_dense_print",
  "cine_pastel_air",
  "cine_neon_night_guard",
  "cine_dawn_gold",
  "cine_moonlit_steel",
  "cine_silver_monochrome",
] as const;

export const REQUIRED_TRANSITION_IDS = [
  "luma_fade",
  "lens_blur_cut",
  "chromatic_whip_cut",
  "prism_flash_cut",
  "exp26_depth_push",
  "exp26_laser_slash",
  "exp26_impact_flash",
  "exp26_signal_scan",
  "exp26_data_shutter",
  "exp26_paper_pull",
  "exp26_marker_wipe",
  "exp26_prism_bloom",
  "exp26_glass_orbit",
  "exp26_editorial_page",
  "exp26_shape_swap",
  "exp26_clean_hold_cut",
  "studio_eyeline_match",
  "studio_action_match",
  "studio_proof_reveal",
  "studio_chapter_breath",
  "studio_ui_focus",
  "studio_location_slide",
  "studio_before_after",
  "studio_soft_memory",
  "cine_short_fade_through_base",
  "cine_emotion_fade_through_base",
  "cine_chapter_fade_through_base",
  "cine_semantic_punch",
  "cine_impact_zoom",
  "cine_ui_detail_push",
  "cine_axis_carry_left",
  "cine_axis_carry_right",
  "cine_soft_direction_slide",
  "cine_proof_flash",
  "cine_payoff_burst",
  "cine_exposure_breath",
  "cine_soft_fade_push",
  "cine_memory_fade_push",
  "cine_left_slide_fade",
  "cine_right_slide_fade",
  "cine_proof_flash_push",
  "cine_payoff_flash_push",
  "cine_left_energy_relay",
  "cine_right_energy_relay",
  "exp26w2_directional_reveal",
  "exp26w2_focus_snap",
  "exp26w2_evidence_slide",
  "exp26w2_media_match",
  "exp26w2_chapter_fold",
  "exp26w2_waveform_cut",
  "exp26w2_foreground_pass",
  "exp26w2_clean_breath",
] as const;

export type MatrixKind = "look" | "transition";
export type MatrixSamplePhase = "steady" | "in" | "out";

export interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactIdentity extends FileIdentity {
  codecName: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  duration: number;
  hasAudio: boolean;
}

export interface MatrixRegistryEntry {
  id: string;
  renderer: string;
  contract: Record<string, unknown>;
  contractFingerprint: string;
}

export interface DecodedMatrixSample {
  phase: MatrixSamplePhase;
  localFrame: number;
  baselineSha256: string;
  candidateSha256: string;
  meanAbsoluteError: number;
  changedPixelRatio: number;
  deltaFeatures: number[];
}

export interface DecodedMatrixObservation {
  kind: MatrixKind;
  id: string;
  registryFingerprint: string;
  expectedCompiler: Record<string, unknown>;
  actualCompiler: Record<string, unknown>;
  expectedCompilerFingerprint: string;
  actualCompilerFingerprint: string;
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  baselineArtifact: Pick<FileIdentity, "path" | "sha256">;
  candidateArtifact: Pick<FileIdentity, "path" | "sha256">;
  samples: DecodedMatrixSample[];
  decodedSignature: string;
}

export interface CinematicDecodedMatrixInput {
  schema: "editkin.cinematic-decoded-matrix-evidence/v1";
  source: FileIdentity;
  registrySources: FileIdentity[];
  rendererSources: FileIdentity[];
  evaluatorSources: FileIdentity[];
  runtimes: FileIdentity[];
  artifacts: ArtifactIdentity[];
  registry: {
    looks: MatrixRegistryEntry[];
    transitions: MatrixRegistryEntry[];
  };
  observations: DecodedMatrixObservation[];
  determinism: {
    baselinePath: string;
    repeatPath: string;
    baselineSha256: string;
    repeatSha256: string;
    decodedSignaturesEqual: boolean;
  };
}

export interface CinematicDecodedMatrixResult {
  schema: "editkin.cinematic-decoded-matrix-gate/v1";
  status: "GREEN" | "BLOCK";
  evidenceState: "measured" | "diagnostic";
  failures: string[];
  counts: {
    requiredLooks: number;
    requiredTransitions: number;
    registeredLooks: number;
    registeredTransitions: number;
    observedLooks: number;
    observedTransitions: number;
    decodedSamples: number;
    artifacts: number;
  };
  claimBoundary: string;
}

export interface CinematicDecodedMatrixAuthority {
  root: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MIN_MAE = 0.05;
const MIN_CHANGED_PIXEL_RATIO = 0.001;
const FEATURE_COUNT = 48;
const DEFAULT_AUTHORITY_ROOT = resolve(import.meta.dirname, "../..");
const EXPECTED_SCHEMA = "editkin.cinematic-decoded-matrix-evidence/v1";
const EXPECTED_DETERMINISM_BASELINE_PATH = ".rd/benchmarks/editkin-cinematic-decoded-matrix/look-shard-01/baseline.mp4";
const EXPECTED_DETERMINISM_REPEAT_PATH = ".rd/benchmarks/editkin-cinematic-decoded-matrix/look-shard-01/baseline-repeat.mp4";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function decodedSampleSignature(samples: readonly DecodedMatrixSample[]): string {
  return hashCanonical(samples.map((sample) => ({
    phase: sample.phase,
    localFrame: sample.localFrame,
    candidateSha256: sample.candidateSha256,
    deltaFeatures: sample.deltaFeatures,
  })));
}

function exactSet(actual: string[], required: readonly string[]): boolean {
  return actual.length === required.length
    && [...actual].sort().every((id, index) => id === [...required].sort()[index]);
}

function duplicateIds(items: Array<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

function duplicatePaths(items: Array<{ path: string }>): string[] {
  return duplicateIds(items.map((item) => ({ id: item.path })));
}

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateIdentity(failures: string[], label: string, identity: FileIdentity): void {
  if (!identity.path || !Number.isInteger(identity.bytes) || identity.bytes <= 0 || !SHA256.test(identity.sha256)) {
    failures.push(`identity:${label}:${identity.path || "<missing>"}`);
  }
}

function validateLiveIdentity(
  failures: string[],
  label: string,
  identity: FileIdentity,
  authorityRoot: string,
): void {
  try {
    const bytes = readFileSync(resolve(authorityRoot, identity.path));
    if (bytes.length !== identity.bytes) failures.push(`identity:${label}:bytes:${identity.path}`);
    if (fileSha256(bytes) !== identity.sha256) failures.push(`identity:${label}:sha256:${identity.path}`);
  } catch {
    failures.push(`identity:${label}:missing:${identity.path}`);
  }
}

function validateClosedWorldIdentities(
  failures: string[],
  label: string,
  identities: FileIdentity[],
  expectedPaths: readonly string[],
  authorityRoot: string,
): void {
  if (!exactSet(identities.map((identity) => identity.path), expectedPaths)) failures.push(`identity:${label}:closed-world`);
  for (const duplicate of duplicatePaths(identities)) failures.push(`identity:${label}:duplicate:${duplicate}`);
  for (const identity of identities) {
    validateIdentity(failures, label, identity);
    if (expectedPaths.includes(identity.path)) validateLiveIdentity(failures, label, identity, authorityRoot);
  }
}

function validateRegistry(
  failures: string[],
  kind: MatrixKind,
  entries: MatrixRegistryEntry[],
  requiredIds: readonly string[],
): void {
  if (!exactSet(entries.map((entry) => entry.id), requiredIds)) failures.push(`registry:${kind}:closed-world`);
  for (const duplicate of duplicateIds(entries)) failures.push(`registry:${kind}:duplicate:${duplicate}`);
  for (const entry of entries) {
    if (!entry.renderer) failures.push(`registry:${kind}:renderer:${entry.id}`);
    if (entry.contractFingerprint !== hashCanonical(entry.contract)) failures.push(`registry:${kind}:fingerprint:${entry.id}`);
  }
  const byContract = new Map<string, string[]>();
  for (const entry of entries) byContract.set(entry.contractFingerprint, [...(byContract.get(entry.contractFingerprint) ?? []), entry.id]);
  for (const ids of byContract.values()) {
    if (ids.length > 1) failures.push(`registry:${kind}:silent-alias:${ids.sort().join(",")}`);
  }
}

function validateArtifact(failures: string[], artifact: ArtifactIdentity): void {
  validateIdentity(failures, "artifact", artifact);
  if (artifact.codecName !== "h264" || artifact.width !== 320 || artifact.height !== 180 || Math.abs(artifact.fps - 60) > 0.001
    || !Number.isInteger(artifact.frameCount) || artifact.frameCount <= 0 || artifact.duration <= 0 || !artifact.hasAudio) {
    failures.push(`artifact:decoded-contract:${artifact.path}`);
  }
}

function validateSample(failures: string[], observation: DecodedMatrixObservation, sample: DecodedMatrixSample, index: number): boolean {
  const label = `${observation.kind}:${observation.id}:${sample.phase}:${index}`;
  if (!Number.isInteger(sample.localFrame) || sample.localFrame < 0 || !SHA256.test(sample.baselineSha256) || !SHA256.test(sample.candidateSha256)) {
    failures.push(`sample:identity:${label}`);
  }
  if (sample.deltaFeatures.length !== FEATURE_COUNT || sample.deltaFeatures.some((value) => !Number.isFinite(value))) {
    failures.push(`sample:feature-contract:${label}`);
  }
  const changed = sample.baselineSha256 !== sample.candidateSha256
    && sample.meanAbsoluteError >= MIN_MAE
    && sample.changedPixelRatio >= MIN_CHANGED_PIXEL_RATIO;
  if (!changed) failures.push(`sample:no-op:${label}`);
  return changed;
}

function validateObservation(
  failures: string[],
  observation: DecodedMatrixObservation,
  registryEntry: MatrixRegistryEntry | undefined,
  artifactByPath: Map<string, ArtifactIdentity>,
  source: FileIdentity,
): void {
  const label = `${observation.kind}:${observation.id}`;
  if (!registryEntry) {
    failures.push(`observation:unregistered:${label}`);
    return;
  }
  if (observation.registryFingerprint !== registryEntry.contractFingerprint) failures.push(`observation:registry-drift:${label}`);
  if (observation.sourcePath !== source.path
    || observation.sourceBytes !== source.bytes
    || observation.sourceSha256 !== source.sha256) failures.push(`observation:source-drift:${label}`);
  if (observation.expectedCompilerFingerprint !== hashCanonical(observation.expectedCompiler)) failures.push(`compiler:expected-fingerprint:${label}`);
  if (observation.actualCompilerFingerprint !== hashCanonical(observation.actualCompiler)) failures.push(`compiler:actual-fingerprint:${label}`);
  if (observation.expectedCompilerFingerprint !== observation.actualCompilerFingerprint
    || canonical(observation.expectedCompiler) !== canonical(observation.actualCompiler)) failures.push(`compiler:mismatch:${label}`);

  const baselineArtifact = artifactByPath.get(observation.baselineArtifact.path);
  const candidateArtifact = artifactByPath.get(observation.candidateArtifact.path);
  if (!baselineArtifact || baselineArtifact.sha256 !== observation.baselineArtifact.sha256) failures.push(`observation:baseline-artifact:${label}`);
  if (!candidateArtifact || candidateArtifact.sha256 !== observation.candidateArtifact.sha256) failures.push(`observation:candidate-artifact:${label}`);
  if (observation.baselineArtifact.sha256 === observation.candidateArtifact.sha256) failures.push(`observation:artifact-no-op:${label}`);
  const requiredIds = observation.kind === "look" ? REQUIRED_LOOK_IDS : REQUIRED_TRANSITION_IDS;
  const registryIndex = requiredIds.indexOf(observation.id as never);
  const shard = `${observation.kind}-shard-${String(Math.floor(registryIndex / 8) + 1).padStart(2, "0")}`;
  const expectedBaselinePath = `.rd/benchmarks/editkin-cinematic-decoded-matrix/${shard}/baseline.mp4`;
  const expectedCandidatePath = `.rd/benchmarks/editkin-cinematic-decoded-matrix/${shard}/candidate.mp4`;
  if (registryIndex < 0 || observation.baselineArtifact.path !== expectedBaselinePath) failures.push(`observation:baseline-path:${label}`);
  if (registryIndex < 0 || observation.candidateArtifact.path !== expectedCandidatePath) failures.push(`observation:candidate-path:${label}`);

  const phases = observation.samples.map((sample) => sample.phase);
  if (observation.kind === "look") {
    if (phases.length !== 3 || phases.some((phase) => phase !== "steady")) failures.push(`sample:coverage:${label}`);
  } else {
    if (phases.filter((phase) => phase === "in").length !== 3 || phases.filter((phase) => phase === "out").length !== 3 || phases.length !== 6) {
      failures.push(`sample:coverage:${label}`);
    }
  }
  observation.samples.forEach((sample, index) => validateSample(failures, observation, sample, index));
  if (observation.decodedSignature !== decodedSampleSignature(observation.samples)) failures.push(`sample:signature:${label}`);
}

export function evaluateCinematicDecodedMatrix(
  input: CinematicDecodedMatrixInput,
  authority: CinematicDecodedMatrixAuthority = { root: DEFAULT_AUTHORITY_ROOT },
): CinematicDecodedMatrixResult {
  const failures: string[] = [];
  const authorityRoot = resolve(authority.root);
  if ((input as { schema?: unknown }).schema !== EXPECTED_SCHEMA) failures.push("schema:exact");
  validateIdentity(failures, "source", input.source);
  if (input.source.path !== EXPECTED_SOURCE_PATH) failures.push("identity:source:closed-world");
  if (input.source.path === EXPECTED_SOURCE_PATH) validateLiveIdentity(failures, "source", input.source, authorityRoot);
  validateClosedWorldIdentities(failures, "registry-source", input.registrySources, EXPECTED_REGISTRY_SOURCE_PATHS, authorityRoot);
  validateClosedWorldIdentities(failures, "renderer-source", input.rendererSources, EXPECTED_RENDERER_SOURCE_PATHS, authorityRoot);
  validateClosedWorldIdentities(failures, "evaluator-source", input.evaluatorSources, EXPECTED_EVALUATOR_SOURCE_PATHS, authorityRoot);
  validateClosedWorldIdentities(failures, "runtime", input.runtimes, EXPECTED_RUNTIME_PATHS, authorityRoot);

  validateRegistry(failures, "look", input.registry.looks, REQUIRED_LOOK_IDS);
  validateRegistry(failures, "transition", input.registry.transitions, REQUIRED_TRANSITION_IDS);
  if (!exactSet(input.artifacts.map((artifact) => artifact.path), EXPECTED_ARTIFACT_PATHS)) failures.push("artifact:closed-world");
  for (const duplicate of duplicatePaths(input.artifacts)) failures.push(`artifact:duplicate:${duplicate}`);
  input.artifacts.forEach((artifact) => {
    validateArtifact(failures, artifact);
    if (EXPECTED_ARTIFACT_PATHS.includes(artifact.path as never)) validateLiveIdentity(failures, "artifact", artifact, authorityRoot);
  });
  const artifactByPath = new Map(input.artifacts.map((artifact) => [artifact.path, artifact]));

  const looks = input.observations.filter((observation) => observation.kind === "look");
  const transitions = input.observations.filter((observation) => observation.kind === "transition");
  if (!exactSet(looks.map((observation) => observation.id), REQUIRED_LOOK_IDS)) failures.push("observation:look:closed-world");
  if (!exactSet(transitions.map((observation) => observation.id), REQUIRED_TRANSITION_IDS)) failures.push("observation:transition:closed-world");
  for (const duplicate of duplicateIds(looks)) failures.push(`observation:look:duplicate:${duplicate}`);
  for (const duplicate of duplicateIds(transitions)) failures.push(`observation:transition:duplicate:${duplicate}`);
  const registryByKey = new Map([
    ...input.registry.looks.map((entry) => [`look:${entry.id}`, entry] as const),
    ...input.registry.transitions.map((entry) => [`transition:${entry.id}`, entry] as const),
  ]);
  input.observations.forEach((observation) => validateObservation(
    failures,
    observation,
    registryByKey.get(`${observation.kind}:${observation.id}`),
    artifactByPath,
    input.source,
  ));

  const referencedArtifacts = new Set<string>([
    ...input.observations.flatMap((observation) => [observation.baselineArtifact.path, observation.candidateArtifact.path]),
    input.determinism.baselinePath,
    input.determinism.repeatPath,
  ]);
  if (!exactSet([...referencedArtifacts], EXPECTED_ARTIFACT_PATHS)) failures.push("artifact:reference-closed-world");

  for (const kind of ["look", "transition"] as const) {
    const signatures = new Map<string, string[]>();
    for (const observation of input.observations.filter((item) => item.kind === kind)) {
      signatures.set(observation.decodedSignature, [...(signatures.get(observation.decodedSignature) ?? []), observation.id]);
    }
    for (const ids of signatures.values()) {
      if (ids.length > 1) failures.push(`decoded:${kind}:silent-identity:${ids.sort().join(",")}`);
    }
  }

  const baseline = artifactByPath.get(input.determinism.baselinePath);
  const repeat = artifactByPath.get(input.determinism.repeatPath);
  if (input.determinism.baselinePath !== EXPECTED_DETERMINISM_BASELINE_PATH
    || input.determinism.repeatPath !== EXPECTED_DETERMINISM_REPEAT_PATH
    || !baseline || !repeat || baseline.sha256 !== input.determinism.baselineSha256 || repeat.sha256 !== input.determinism.repeatSha256
    || input.determinism.baselineSha256 !== input.determinism.repeatSha256 || !input.determinism.decodedSignaturesEqual) {
    failures.push("determinism:baseline-repeat");
  }

  return {
    schema: "editkin.cinematic-decoded-matrix-gate/v1",
    status: failures.length === 0 ? "GREEN" : "BLOCK",
    evidenceState: failures.length === 0 ? "measured" : "diagnostic",
    failures,
    counts: {
      requiredLooks: REQUIRED_LOOK_IDS.length,
      requiredTransitions: REQUIRED_TRANSITION_IDS.length,
      registeredLooks: input.registry.looks.length,
      registeredTransitions: input.registry.transitions.length,
      observedLooks: looks.length,
      observedTransitions: transitions.length,
      decodedSamples: input.observations.reduce((total, observation) => total + observation.samples.length, 0),
      artifacts: input.artifacts.length,
    },
    claimBoundary: "Deterministic Windows Rec.709 synthetic/demo-source decoded coverage only; this does not establish real-footage aesthetic quality, packaged UI application, macOS delivery, HDR fidelity, or competitor parity.",
  };
}

export function assertCinematicDecodedMatrix(
  input: CinematicDecodedMatrixInput,
  authority?: CinematicDecodedMatrixAuthority,
): CinematicDecodedMatrixResult {
  const result = evaluateCinematicDecodedMatrix(input, authority);
  if (result.status !== "GREEN") throw new Error(`cinematic decoded matrix BLOCK: ${result.failures.join(" | ")}`);
  return result;
}
