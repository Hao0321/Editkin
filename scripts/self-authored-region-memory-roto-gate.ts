import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native", "hao-core");
const reportPath = join(root, ".rd", "benchmarks", "editkin-self-authored-region-memory-roto", "report.json");
const planPath = join(root, ".rd", "experiments", "self-authored-roto-memory-plan.json");
const datasetManifestPath = join(root, ".rd", "experiments", "self-authored-region-memory-roto-dataset", "manifest.json");
const baselineReceiptPath = join(root, ".rd", "experiments", "self-authored-region-memory-roto-baseline.json");
const buildReceiptPath = join(root, ".rd", "benchmarks", "editkin-native-core-build-receipt.json");
const evaluatorPath = fileURLToPath(import.meta.url);
const ENGINE = "editkin-self-authored-region-memory-roto/v1";
const BASELINE_ENGINE = "editkin-native-color-temporal-roto/v1";
const DATASET_ID = "editkin-owned-synthetic-region-memory-v2";
const BUILD_INPUT_ROOTS = ["scripts/build-native-core.mjs", "native/hao-core/Cargo.toml", "native/hao-core/Cargo.lock", "native/hao-core/src"];

type Json = Record<string, any>;
type FileObservation = { path: string; bytes: number; sha256: string };

interface ScenarioScore {
  name: string;
  baselineJ: number;
  candidateJ: number;
  baselineBoundaryF: number;
  candidateBoundaryF: number;
}

interface Facts {
  schema: string;
  engine: string;
  datasetId: string;
  fixtureCount: number;
  frameCount: number;
  meanJBaseline: number;
  meanJCandidate: number;
  meanBoundaryFBaseline: number;
  meanBoundaryFCandidate: number;
  lightingDriftJBaseline: number;
  lightingDriftJCandidate: number;
  distractorFalsePositiveRateBaseline: number;
  distractorFalsePositiveRateCandidate: number;
  occlusionLeakageCandidate: number;
  reappearanceJCandidate: number;
  temporalDtssdBaseline: number;
  temporalDtssdCandidate: number;
  candidateP95MsPerFrame: number;
  candidateRuntimeSamplesMsPerFrame: number[];
  performanceWarmupRuns: number;
  memoryUpdates: number;
  fullOcclusionFreezes: number;
  sceneCutFreezes: number;
  sceneCutReseeds: number;
  modelBoundsValid: boolean;
  invalidStateIdentityRejected: boolean;
  deterministic: boolean;
  regressionCount: number;
  scenarios: ScenarioScore[];
}

interface PromotionCriteria {
  meanJAbsoluteGainMin: number;
  lightingDriftJAbsoluteGainMin: number;
  distractorFalsePositiveRelativeReductionMin: number;
  occlusionLeakageMaximum: number;
  reappearanceJMinimum: number;
  temporalDtssdRegressionMaximum: number;
  p95MsPerFrameMaximum: number;
  evaluatorMutationCountMin: number;
  regressionsAllowed: number;
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8")) as Json;
}

function planFailures(plan: Json): string[] {
  const failures: string[] = [];
  if (plan.schema !== "editkin.rd-experiment-plan/v1" || plan.id !== "self-authored-region-memory-roto-v1") failures.push("plan-identity");
  if (plan.baseline?.engine !== BASELINE_ENGINE || plan.baseline?.receipt !== ".rd/experiments/self-authored-region-memory-roto-baseline.json") failures.push("plan-baseline-binding");
  if (plan.candidate?.engine !== ENGINE || plan.candidate?.runtimePolicy !== "guarded_experimental_only") failures.push("plan-candidate-policy");
  if (plan.dataset?.id !== DATASET_ID || plan.dataset?.manifest !== ".rd/experiments/self-authored-region-memory-roto-dataset/manifest.json") failures.push("plan-dataset-binding");
  if (plan.promotionEvidence?.blindHoldoutState !== "unmeasured" || plan.promotionEvidence?.realFootageMinimumFrames < 240) failures.push("plan-blind-holdout-boundary");
  const criteria = plan.promotionCriteria as PromotionCriteria | undefined;
  const required: PromotionCriteria = {
    meanJAbsoluteGainMin: 0.05,
    lightingDriftJAbsoluteGainMin: 0.10,
    distractorFalsePositiveRelativeReductionMin: 0.30,
    occlusionLeakageMaximum: 0.10,
    reappearanceJMinimum: 0.75,
    temporalDtssdRegressionMaximum: 0.005,
    p95MsPerFrameMaximum: 100,
    evaluatorMutationCountMin: 20,
    regressionsAllowed: 0,
  };
  if (!criteria || Object.entries(required).some(([key, value]) => criteria[key as keyof PromotionCriteria] !== value)) failures.push("plan-promotion-criteria");
  const allowed = plan.candidate?.allowedExternalPrimitives;
  if (!Array.isArray(allowed) || allowed.join(",") !== "serde") failures.push("plan-dependency-policy");
  return failures;
}

function evaluateFacts(facts: Facts, criteria: PromotionCriteria): string[] {
  const failures: string[] = [];
  const numeric = Object.entries(facts).filter(([, value]) => typeof value === "number");
  if (facts.schema !== "editkin.region-memory-roto-benchmark/v1" || facts.engine !== ENGINE) failures.push("benchmark-identity");
  if (facts.datasetId !== DATASET_ID || facts.fixtureCount !== 5 || facts.frameCount !== 63) failures.push("dataset-coverage");
  if (numeric.some(([, value]) => !Number.isFinite(value))) failures.push("non-finite-metric");
  const unitMetrics = [facts.meanJBaseline, facts.meanJCandidate, facts.meanBoundaryFBaseline,
    facts.meanBoundaryFCandidate, facts.lightingDriftJBaseline, facts.lightingDriftJCandidate,
    facts.distractorFalsePositiveRateBaseline, facts.distractorFalsePositiveRateCandidate,
    facts.occlusionLeakageCandidate, facts.reappearanceJCandidate];
  if (unitMetrics.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    || facts.temporalDtssdBaseline < 0 || facts.temporalDtssdCandidate < 0) failures.push("bounded-metric-domain");
  if (!(facts.meanJCandidate - facts.meanJBaseline >= criteria.meanJAbsoluteGainMin)) failures.push("mean-j-absolute-gain");
  if (facts.meanBoundaryFCandidate < facts.meanBoundaryFBaseline) failures.push("mean-boundary-f-regression");
  if (!(facts.lightingDriftJCandidate - facts.lightingDriftJBaseline >= criteria.lightingDriftJAbsoluteGainMin)) failures.push("lighting-drift-j-absolute-gain");
  const reduction = facts.distractorFalsePositiveRateBaseline > 0
    ? (facts.distractorFalsePositiveRateBaseline - facts.distractorFalsePositiveRateCandidate) / facts.distractorFalsePositiveRateBaseline
    : Number.NEGATIVE_INFINITY;
  if (reduction < criteria.distractorFalsePositiveRelativeReductionMin) failures.push("distractor-fp-relative-reduction");
  if (facts.occlusionLeakageCandidate > criteria.occlusionLeakageMaximum) failures.push("occlusion-leakage");
  if (facts.reappearanceJCandidate < criteria.reappearanceJMinimum) failures.push("reappearance-j");
  if (facts.temporalDtssdCandidate - facts.temporalDtssdBaseline > criteria.temporalDtssdRegressionMaximum) failures.push("temporal-dtssd-regression");
  if (!(facts.candidateP95MsPerFrame > 0 && facts.candidateP95MsPerFrame <= criteria.p95MsPerFrameMaximum)) failures.push("p95-runtime");
  if (facts.regressionCount !== criteria.regressionsAllowed) failures.push("scenario-regression");
  if (facts.memoryUpdates <= 0 || facts.fullOcclusionFreezes < 1) failures.push("memory-or-occlusion-path");
  if (facts.sceneCutFreezes !== 0 || facts.sceneCutReseeds < 1) failures.push("scene-cut-reseed-path");
  if (!facts.modelBoundsValid || !facts.invalidStateIdentityRejected || !facts.deterministic) failures.push("correctness-guardrail");
  if (facts.performanceWarmupRuns < 3 || facts.candidateRuntimeSamplesMsPerFrame.length < 9
    || facts.candidateRuntimeSamplesMsPerFrame.some((value) => !Number.isFinite(value) || value <= 0)) failures.push("performance-raw-evidence");
  const requiredScenarios = new Set(["lighting_color_drift", "same_color_distractor", "full_occlusion_reappearance", "temporal_stability", "scene_cut_reseed"]);
  if (facts.scenarios.length !== requiredScenarios.size
    || facts.scenarios.some((scenario) => !requiredScenarios.delete(scenario.name)) || requiredScenarios.size) failures.push("scenario-identity");
  if (facts.scenarios.some((scenario) => scenario.candidateJ + 1e-9 < scenario.baselineJ
    || scenario.candidateBoundaryF + 1e-9 < scenario.baselineBoundaryF)) failures.push("scenario-score-regression");
  return failures;
}

async function observeFiles(entries: Array<{ path: string }>): Promise<FileObservation[]> {
  return Promise.all(entries.map(async (entry) => {
    const full = resolve(root, entry.path);
    const info = await stat(full);
    return { path: entry.path.replaceAll("\\", "/"), bytes: info.size, sha256: await sha256(full) };
  }));
}

function boundFileFailures(expected: Array<{ path: string; bytes: number; sha256: string }>, observed: FileObservation[]): string[] {
  const failures: string[] = [];
  const observedByPath = new Map(observed.map((item) => [item.path, item]));
  if (expected.length !== observed.length || new Set(expected.map((item) => item.path)).size !== expected.length) failures.push("file-inventory-cardinality");
  for (const item of expected) {
    const actual = observedByPath.get(item.path);
    if (!actual || actual.bytes !== item.bytes || actual.sha256 !== item.sha256) failures.push(`file-binding:${item.path}`);
  }
  return failures;
}

async function datasetFailures(manifest: Json): Promise<string[]> {
  const failures: string[] = [];
  if (manifest.schema !== "editkin.region-memory-roto-dataset/v1" || manifest.datasetId !== DATASET_ID
    || manifest.evidenceState !== "diagnostic_controlled_synthetic" || manifest.truthAuthority !== "independent_parametric_oracle_not_visible_to_candidate"
    || manifest.width !== 96 || manifest.height !== 64 || manifest.frameCount !== 63) failures.push("dataset-manifest-identity");
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.map((item: Json) => item.role).join(",") !== "inputs,annotations,distractors") failures.push("dataset-role-inventory");
  if (files.some((item: Json) => !String(item.path).startsWith(".rd/experiments/self-authored-region-memory-roto-dataset/"))) failures.push("dataset-path-boundary");
  try { failures.push(...boundFileFailures(files, await observeFiles(files))); } catch { failures.push("dataset-file-missing"); }
  const generator = manifest.generator;
  if (!generator || generator.path !== "scripts/freeze-region-memory-roto-dataset.ts") failures.push("dataset-generator-identity");
  else {
    try { failures.push(...boundFileFailures([generator], await observeFiles([generator]))); } catch { failures.push("dataset-generator-missing"); }
  }
  return failures;
}

async function baselineFailures(receipt: Json): Promise<string[]> {
  const failures: string[] = [];
  if (receipt.schema !== "editkin.region-memory-roto-baseline-receipt/v1" || receipt.engine !== BASELINE_ENGINE
    || receipt.function !== "segment_rgb_sequence_fixed_initial_frame_baseline" || receipt.state !== "frozen_after_safety_audit") failures.push("baseline-receipt-identity");
  const sources = Array.isArray(receipt.sources) ? receipt.sources : [];
  const required = ["native/hao-core/src/engine/auto_roto.rs", "native/hao-core/src/engine/optical_alpha.rs", "native/hao-core/src/engine/roto.rs", "native/hao-core/Cargo.toml", "native/hao-core/Cargo.lock"];
  if (sources.map((item: Json) => item.path).join(",") !== required.join(",")) failures.push("baseline-source-inventory");
  try { failures.push(...boundFileFailures(sources, await observeFiles(sources))); } catch { failures.push("baseline-source-missing"); }
  return failures;
}

async function collectBuildInputs(): Promise<{ files: FileObservation[]; aggregateSha256: string }> {
  const files: FileObservation[] = [];
  async function visit(path: string) {
    const info = await stat(path);
    if (info.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relative(root, path).split(sep).join("/"), bytes: bytes.length, sha256: sha256Bytes(bytes) });
      return;
    }
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`build input symlink: ${join(path, entry.name)}`);
      await visit(join(path, entry.name));
    }
  }
  for (const item of BUILD_INPUT_ROOTS) await visit(resolve(root, item));
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const digest = createHash("sha256");
  for (const file of files) digest.update(file.path).update("\0").update(String(file.bytes)).update("\0").update(file.sha256).update("\n");
  return { files, aggregateSha256: digest.digest("hex") };
}

function toolVersion(path: string, args: string[]): string | null {
  const result = spawnSync(path, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function buildReceiptFailures(receipt: Json): Promise<string[]> {
  const failures: string[] = [];
  if (receipt.schema !== "editkin.native-core-build-receipt/v1") failures.push("build-receipt-identity");
  const liveInputs = await collectBuildInputs();
  if (receipt.inputs?.aggregateSha256 !== liveInputs.aggregateSha256) failures.push("build-input-aggregate-stale");
  failures.push(...boundFileFailures(receipt.inputs?.files ?? [], liveInputs.files));
  for (const [name, args] of [["cargo", ["--version"]], ["rustc", ["--version", "--verbose"]]] as const) {
    const tool = receipt.toolchain?.[name];
    if (!tool || !existsSync(tool.path) || await sha256(tool.path) !== tool.sha256 || toolVersion(tool.path, [...args]) !== tool.version) failures.push(`build-toolchain:${name}`);
  }
  for (const role of ["output", "promoted"] as const) {
    const item = receipt[role];
    if (!item || !existsSync(item.path)) failures.push(`build-${role}-missing`);
    else {
      const info = await stat(item.path);
      if (info.size !== item.bytes || await sha256(item.path) !== item.sha256) failures.push(`build-${role}-stale`);
    }
  }
  if (receipt.output?.sha256 !== receipt.promoted?.sha256) failures.push("build-promotion-hash-mismatch");
  return failures;
}

function transitiveDependencyFailures(sources: Record<string, string>): string[] {
  const failures: string[] = [];
  const allowedOwned = new Set(["region_memory_roto", "optical_alpha", "roto"]);
  const allowedExternal = new Set(["serde"]);
  const queue = ["region_memory_roto"];
  const visited = new Set<string>();
  while (queue.length) {
    const module = queue.shift()!;
    if (visited.has(module)) continue;
    visited.add(module);
    const source = sources[module];
    if (!source) { failures.push(`owned-module-missing:${module}`); continue; }
    for (const match of source.matchAll(/\buse\s+super::([a-zA-Z0-9_]+)/g)) {
      const dependency = match[1]!;
      if (!allowedOwned.has(dependency)) failures.push(`unapproved-owned-module:${dependency}`);
      else queue.push(dependency);
    }
    for (const match of source.matchAll(/\buse\s+([a-zA-Z0-9_]+)::/g)) {
      const dependency = match[1]!;
      if (dependency !== "super" && dependency !== "crate" && dependency !== "std" && !allowedExternal.has(dependency)) failures.push(`unapproved-external-crate:${dependency}`);
    }
    if (/https?:\/\/|include_(?:bytes|str)!|std::(?:fs|net|process)|reqwest|ureq|libloading|\bort::|download/iu.test(source)) failures.push(`forbidden-runtime-edge:${module}`);
  }
  if ([...allowedOwned].some((module) => !visited.has(module))) failures.push("owned-module-closure-incomplete");
  return failures;
}

function routingSourceFailures(source: string): string[] {
  const required = [
    "pub enum RegionMemoryRoutePolicy",
    "FixedBaseline",
    "GuardedExperimental",
    "guarded_candidate_or_fallback",
    "executed: \"fixed_baseline\"",
    "deterministic_fallback: fell_back",
    "segment(None, false)",
    "region_memory_policy: RegionMemoryRoutePolicy",
  ];
  const failures = required.filter((marker) => !source.includes(marker)).map((marker) => `routing-marker:${marker}`);
  const publicRoute = source.slice(source.indexOf("pub fn segment_rgb_sequence("), source.indexOf("pub fn segment_rgb_sequence_fixed_initial_frame_baseline"));
  if (!publicRoute.includes("None,\n        false,")) failures.push("product-default-not-fixed-baseline");
  return failures;
}

function cargoExecutable(): string {
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  const candidates = [process.env.CARGO, join(homedir(), ".cargo", "bin", executable)].filter((value): value is string => Boolean(value));
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error("Exact cargo executable unavailable");
  return resolved;
}

function runCargo(args: string[], timeout: number): { stdout: string; stderr: string; cargo: Json } {
  const cargo = cargoExecutable();
  const result = spawnSync(cargo, args, { cwd: nativeRoot, encoding: "utf8", windowsHide: true, timeout });
  if (result.status !== 0) throw new Error(`Cargo command failed: ${result.stderr || result.stdout}`);
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    cargo: { path: cargo, sha256: sha256Bytes(readFileSync(cargo)), version: toolVersion(cargo, ["--version"]) },
  };
}

function processInventory(): Json[] {
  if (process.platform !== "win32") return [];
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout) as Json | Json[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function performanceReceipt(before: Json[], after: Json[], isolationRequested: boolean): Json {
  const ignored = new Set([process.pid, process.ppid]);
  const heavy = [...before, ...after].filter((item) => !ignored.has(Number(item.Id))
    && /^(cargo|rustc|ffmpeg|ffprobe|python|python3|node|hao-core|editkin-gpu-compositor)$/iu.test(String(item.ProcessName)));
  const unique = [...new Map(heavy.map((item) => [`${item.Id}:${item.ProcessName}`, { pid: Number(item.Id), name: String(item.ProcessName) }])).values()];
  return {
    state: isolationRequested && unique.length === 0 ? "measured_isolated" : "diagnostic_not_isolated",
    isolationRequested,
    isolationConfirmed: isolationRequested && unique.length === 0,
    competingProcesses: unique,
    host: { platform: platform(), release: release(), arch: arch(), cpuModel: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAfter: freemem() },
  };
}

async function runDeliveredNativeSmoke(policy: "fixed_baseline" | "guarded_experimental"): Promise<Json> {
  const binaryPath = join(root, "native", "bin", "win32-x64", "hao-core.exe");
  const workspace = await mkdtemp(join(tmpdir(), `editkin-region-memory-${policy}-`));
  try {
    const width = 32;
    const height = 24;
    const frameCount = 4;
    const raw = Buffer.alloc(width * height * frameCount * 3, 24);
    for (let frame = 0; frame < frameCount; frame += 1) for (let y = 7; y < 17; y += 1) for (let x = 8 + frame; x < 19 + frame; x += 1) {
      const offset = (frame * width * height + y * width + x) * 3;
      raw.set([220, 55, 44], offset);
    }
    const rawPath = join(workspace, "frames.rgb24");
    const outputDir = join(workspace, "output");
    const requestPath = join(workspace, "request.json");
    await writeFile(rawPath, raw);
    await writeFile(requestPath, `${JSON.stringify({ rawPath, outputDir, width, height, frameCount, analysisFps: 12, initialFrame: 0,
      initialRect: { x: 6 / width, y: 5 / height, width: 16 / width, height: 14 / height }, temporalStability: 0.18,
      feather: 0.01, edgeShift: 0, contrast: 1.7, corrections: [], regionMemoryPolicy: policy })}\n`, "utf8");
    const executed = spawnSync(binaryPath, ["auto-roto", requestPath], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (executed.status !== 0) throw new Error(`Delivered native smoke failed: ${executed.stderr || executed.stdout}`);
    const receipt = JSON.parse(executed.stdout.trim()) as Json;
    const manifest = await readJson(join(outputDir, "matte-manifest.json"));
    const expectedExecuted = policy === "fixed_baseline" ? "fixed_baseline" : "guarded_experimental";
    const passed = receipt.engine === BASELINE_ENGINE && receipt.frames?.length === frameCount
      && receipt.regionMemoryRouting?.requested === policy && receipt.regionMemoryRouting?.executed === expectedExecuted
      && receipt.regionMemoryRouting?.deterministicFallback === false
      && (policy === "fixed_baseline" ? receipt.regionMemory === undefined : receipt.regionMemory?.engine === ENGINE)
      && JSON.stringify(receipt.regionMemoryRouting) === JSON.stringify(manifest.regionMemoryRouting);
    return { passed, policy, executed: receipt.regionMemoryRouting?.executed ?? null, regionMemoryEngine: receipt.regionMemory?.engine ?? null };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function evaluatorSelfTest(): Promise<number> {
  const criteria: PromotionCriteria = { meanJAbsoluteGainMin: .05, lightingDriftJAbsoluteGainMin: .1,
    distractorFalsePositiveRelativeReductionMin: .3, occlusionLeakageMaximum: .1, reappearanceJMinimum: .75,
    temporalDtssdRegressionMaximum: .005, p95MsPerFrameMaximum: 100, evaluatorMutationCountMin: 20, regressionsAllowed: 0 };
  const scenarios = ["lighting_color_drift", "same_color_distractor", "full_occlusion_reappearance", "temporal_stability", "scene_cut_reseed"]
    .map((name) => ({ name, baselineJ: .5, candidateJ: .8, baselineBoundaryF: .7, candidateBoundaryF: .8 }));
  const valid: Facts = { schema: "editkin.region-memory-roto-benchmark/v1", engine: ENGINE, datasetId: DATASET_ID,
    fixtureCount: 5, frameCount: 63, meanJBaseline: .6, meanJCandidate: .8, meanBoundaryFBaseline: .7,
    meanBoundaryFCandidate: .8, lightingDriftJBaseline: .5, lightingDriftJCandidate: .7,
    distractorFalsePositiveRateBaseline: .5, distractorFalsePositiveRateCandidate: .2, occlusionLeakageCandidate: .05,
    reappearanceJCandidate: .8, temporalDtssdBaseline: .01, temporalDtssdCandidate: .012, candidateP95MsPerFrame: 20,
    candidateRuntimeSamplesMsPerFrame: Array(9).fill(20), performanceWarmupRuns: 3, memoryUpdates: 20,
    fullOcclusionFreezes: 3, sceneCutFreezes: 0, sceneCutReseeds: 1, modelBoundsValid: true,
    invalidStateIdentityRejected: true, deterministic: true, regressionCount: 0, scenarios };
  const mutations: Array<(facts: Facts) => void> = [
    (facts) => { facts.schema = "wrong"; }, (facts) => { facts.engine = "external"; }, (facts) => { facts.datasetId = "changed"; },
    (facts) => { facts.fixtureCount = 4; }, (facts) => { facts.meanJCandidate = .64; }, (facts) => { facts.meanBoundaryFCandidate = .69; },
    (facts) => { facts.lightingDriftJCandidate = .59; }, (facts) => { facts.distractorFalsePositiveRateCandidate = .36; },
    (facts) => { facts.occlusionLeakageCandidate = .11; }, (facts) => { facts.reappearanceJCandidate = .74; },
    (facts) => { facts.temporalDtssdCandidate = .016; }, (facts) => { facts.candidateP95MsPerFrame = 101; },
    (facts) => { facts.candidateRuntimeSamplesMsPerFrame = []; }, (facts) => { facts.performanceWarmupRuns = 0; },
    (facts) => { facts.memoryUpdates = 0; }, (facts) => { facts.fullOcclusionFreezes = 0; },
    (facts) => { facts.sceneCutFreezes = 1; }, (facts) => { facts.sceneCutReseeds = 0; }, (facts) => { facts.deterministic = false; },
    (facts) => { facts.regressionCount = 1; }, (facts) => { facts.scenarios[4]!.name = "scene_cut_freeze"; },
  ];
  if (evaluateFacts(structuredClone(valid), criteria).length) throw new Error("Evaluator rejects valid benchmark control");
  for (const mutate of mutations) {
    const changed = structuredClone(valid); mutate(changed);
    if (!evaluateFacts(changed, criteria).length) throw new Error("Evaluator accepted benchmark mutation");
  }
  const validPlan = { schema: "editkin.rd-experiment-plan/v1", id: "self-authored-region-memory-roto-v1",
    baseline: { engine: BASELINE_ENGINE, receipt: ".rd/experiments/self-authored-region-memory-roto-baseline.json" },
    candidate: { engine: ENGINE, runtimePolicy: "guarded_experimental_only", allowedExternalPrimitives: ["serde"] },
    dataset: { id: DATASET_ID, manifest: ".rd/experiments/self-authored-region-memory-roto-dataset/manifest.json" },
    promotionEvidence: { blindHoldoutState: "unmeasured", realFootageMinimumFrames: 240 }, promotionCriteria: criteria };
  if (planFailures(validPlan).length) throw new Error("Evaluator rejects valid frozen plan control");
  for (const mutate of [(plan: Json) => { plan.promotionCriteria.meanJAbsoluteGainMin = 0; },
    (plan: Json) => { plan.baseline.receipt = "mutable.json"; }, (plan: Json) => { plan.candidate.runtimePolicy = "default"; },
    (plan: Json) => { plan.dataset.id = "changed"; }, (plan: Json) => { plan.candidate.allowedExternalPrimitives = ["serde", "mystery"];}]) {
    const changed = structuredClone(validPlan); mutate(changed);
    if (!planFailures(changed).length) throw new Error("Evaluator accepted plan mutation");
  }
  if (boundFileFailures([{ path: "a", bytes: 1, sha256: "a".repeat(64) }], [{ path: "a", bytes: 1, sha256: "a".repeat(64) }]).length) throw new Error("File binder rejects valid control");
  for (const observed of [[], [{ path: "a", bytes: 2, sha256: "a".repeat(64) }], [{ path: "a", bytes: 1, sha256: "b".repeat(64) }]]) {
    if (!boundFileFailures([{ path: "a", bytes: 1, sha256: "a".repeat(64) }], observed).length) throw new Error("File binder accepted stale data/build/binary control");
  }
  const validSources = { region_memory_roto: "use super::optical_alpha::x; use super::roto::y; use serde::Serialize;", optical_alpha: "use super::roto::x; use serde::Serialize;", roto: "use serde::Serialize;" };
  if (transitiveDependencyFailures(validSources).length) throw new Error("Dependency scanner rejects owned closure");
  for (const source of ["use super::mystery_runtime::x;", "use neutralcrate::x;", "use std::fs;"]) {
    const changed = { ...validSources, region_memory_roto: `${validSources.region_memory_roto}\n${source}` };
    if (!transitiveDependencyFailures(changed).length) throw new Error("Dependency scanner accepted neutral-name external/runtime edge");
  }
  const routing = await readFile(join(nativeRoot, "src", "engine", "auto_roto.rs"), "utf8");
  if (routingSourceFailures(routing).length) throw new Error("Routing scanner rejects current safe route");
  for (const marker of ["guarded_candidate_or_fallback", "deterministic_fallback: fell_back", "None,\n        false,"]) {
    if (!routingSourceFailures(routing.replaceAll(marker, "removed-negative-control")).length) throw new Error(`Routing scanner accepted missing rollback marker: ${marker}`);
  }
  const measured = performanceReceipt([], [], true);
  const diagnostic = performanceReceipt([{ Id: 999999, ProcessName: "ffmpeg" }], [], true);
  if (!measured.isolationConfirmed || diagnostic.isolationConfirmed || diagnostic.state !== "diagnostic_not_isolated") throw new Error("Performance isolation detector failed");
  return mutations.length + 5 + 3 + 3 + 3 + 1;
}

async function main() {
  const mutationCount = await evaluatorSelfTest();
  if (process.argv.includes("--self-test")) {
    console.log(`Self-authored region-memory Roto evaluator calibration passed (${mutationCount} task-shaped mutations)`);
    return;
  }
  const plan = await readJson(planPath);
  const dataset = await readJson(datasetManifestPath);
  const baseline = await readJson(baselineReceiptPath);
  const buildReceipt = await readJson(buildReceiptPath);
  const infrastructureFailures = [
    ...planFailures(plan),
    ...await datasetFailures(dataset),
    ...await baselineFailures(baseline),
    ...await buildReceiptFailures(buildReceipt),
  ];
  const candidateSources = Object.fromEntries(await Promise.all(["region_memory_roto", "optical_alpha", "roto"].map(async (module) => [module,
    await readFile(join(nativeRoot, "src", "engine", `${module}.rs`), "utf8")]))) as Record<string, string>;
  infrastructureFailures.push(...transitiveDependencyFailures(candidateSources));
  const routingSource = await readFile(join(nativeRoot, "src", "engine", "auto_roto.rs"), "utf8");
  infrastructureFailures.push(...routingSourceFailures(routingSource));
  const beforeProcesses = processInventory();
  const correctness = runCargo(["test", "--locked", "--quiet"], 180_000);
  const benchmarkRun = runCargo(["run", "--quiet", "--locked", "--bin", "region_memory_roto_benchmark"], 180_000);
  const afterProcesses = processInventory();
  const performance = performanceReceipt(beforeProcesses, afterProcesses, process.argv.includes("--isolated-performance"));
  const facts = JSON.parse(benchmarkRun.stdout) as Facts;
  const benchmarkFailures = evaluateFacts(facts, plan.promotionCriteria as PromotionCriteria);
  const [defaultSmoke, experimentalSmoke] = await Promise.all([
    runDeliveredNativeSmoke("fixed_baseline"),
    runDeliveredNativeSmoke("guarded_experimental"),
  ]);
  if (!defaultSmoke.passed) infrastructureFailures.push("delivered-default-baseline-smoke");
  if (!experimentalSmoke.passed) infrastructureFailures.push("delivered-experimental-candidate-smoke");
  if (mutationCount < (plan.promotionCriteria as PromotionCriteria).evaluatorMutationCountMin) infrastructureFailures.push("evaluator-mutation-count");
  const blindHoldoutMeasured = plan.promotionEvidence?.blindHoldoutState === "measured"
    && typeof plan.promotionEvidence?.receiptSha256 === "string";
  const promoted = infrastructureFailures.length === 0 && benchmarkFailures.length === 0
    && blindHoldoutMeasured && performance.isolationConfirmed;
  const sourcePaths = [planPath, datasetManifestPath, baselineReceiptPath, buildReceiptPath, evaluatorPath,
    join(root, ".rd", "DECISIONS.md"), join(root, ".rd", "experiments", "ledger.jsonl"),
    join(nativeRoot, "src", "engine", "region_memory_roto.rs"), join(nativeRoot, "src", "engine", "optical_alpha.rs"),
    join(nativeRoot, "src", "engine", "roto.rs"), join(nativeRoot, "src", "engine", "auto_roto.rs"),
    join(nativeRoot, "Cargo.toml"), join(nativeRoot, "Cargo.lock"), join(root, "scripts", "build-native-core.mjs"),
    join(root, "native", "bin", "win32-x64", "hao-core.exe")];
  const sources = await Promise.all(sourcePaths.map(async (path) => ({ path: path.slice(root.length + 1).replaceAll("\\", "/"), sha256: await sha256(path) })));
  const report = {
    schema: "editkin.self-authored-region-memory-roto-gate-report/v2",
    generatedAt: new Date().toISOString(),
    status: infrastructureFailures.length || benchmarkFailures.length
      ? "BLOCK_EXPERIMENT_REJECTED_PRODUCT_FIXED_BASELINE"
      : promoted ? "GREEN_PROMOTED_BY_BLIND_AND_ISOLATED_EVIDENCE" : "GREEN_DIAGNOSTIC_EXPERIMENTAL_PRODUCT_FIXED_BASELINE",
    productDefault: "fixed_baseline",
    candidateAvailability: "guarded_experimental_only",
    claimStatus: promoted ? "measured" : "unmeasured",
    facts,
    failures: [...infrastructureFailures, ...benchmarkFailures],
    openPromotionEvidence: [
      ...(blindHoldoutMeasured ? [] : ["real-blind-holdout-unmeasured"]),
      ...(performance.isolationConfirmed ? [] : ["isolated-performance-unmeasured"]),
      "installer-and-macos-unmeasured",
    ],
    evaluator: { mutationCount, allRejected: true },
    performance,
    correctness: { passed: true, stdoutSha256: sha256Bytes(correctness.stdout), stderrSha256: sha256Bytes(correctness.stderr), cargo: correctness.cargo },
    deliveredNativeSmoke: { defaultSmoke, experimentalSmoke, binarySha256: buildReceipt.promoted.sha256 },
    evidence: { planSha256: await sha256(planPath), datasetManifestSha256: await sha256(datasetManifestPath), baselineReceiptSha256: await sha256(baselineReceiptPath), buildReceiptSha256: await sha256(buildReceiptPath) },
    sources,
    claimBoundary: [
      "Synthetic calibration is diagnostic and cannot promote the product route without independent real blind holdout evidence.",
      "The product default is the frozen fixed-initial-frame baseline; region memory is explicit guarded experimental only and candidate errors deterministically fall back.",
      "Scene cuts create a new seeded segment instead of latching the remaining sequence transparent.",
      "Performance remains diagnostic unless the explicit isolated-performance mode records no competing heavy process.",
      "No competitor-superiority, difficult-transparency, installer, GPU, or macOS quality claim is made.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (infrastructureFailures.length || benchmarkFailures.length) throw new Error(`Self-authored region-memory Roto gate BLOCK: ${report.failures.join(", ")}`);
  console.log(`Self-authored region-memory Roto gate ${report.status} · report ${reportPath}`);
}

await main();
