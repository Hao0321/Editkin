import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native", "hao-core");
const reportPath = join(root, ".rd", "benchmarks", "editkin-self-authored-optical-alpha-refiner", "report.json");
const planPath = join(root, ".rd", "experiments", "self-authored-optical-alpha-refiner-plan.json");
const ENGINE = "editkin-self-authored-optical-alpha-refiner/v1";
const BASELINE_ENGINE = "editkin-native-box-matte-refine/v1";
const THRESHOLDS = {
  minimumFixtureCount: 3,
  maximumAlphaMadRatio: 0.85,
  maximumFractionalEdgeMadRatio: 0.8,
  maximumForegroundRgbMaeRatio: 0.85,
  maximumCompositeRgbMaeRatio: 1,
  maximumTemporalDtssdRatio: 1,
  maximumKnownCoreError: 1 / 255,
  maximumReferenceP95Ms: 1_000,
} as const;

interface Facts {
  schema: string;
  engine: string;
  fixtureCount: number;
  baselineAlphaMad: number;
  candidateAlphaMad: number;
  baselineEdgeMad: number;
  candidateEdgeMad: number;
  baselineForegroundRgbMae: number;
  candidateForegroundRgbMae: number;
  baselineCompositeRgbMae: number;
  candidateCompositeRgbMae: number;
  baselineTemporalDtssd: number;
  candidateTemporalDtssd: number;
  knownCoreMaxError: number;
  candidateP95Ms: number;
  solvedPixels: number;
  fractionalPixels: number;
  restrictedDependencyFree: boolean;
}

function evaluate(facts: Facts): string[] {
  const failures: string[] = [];
  const finite = Object.entries(facts).filter(([, value]) => typeof value === "number");
  if (facts.schema !== "editkin.optical-alpha-benchmark/v1") failures.push("benchmark-schema");
  if (facts.engine !== ENGINE) failures.push("engine-identity");
  if (facts.fixtureCount < THRESHOLDS.minimumFixtureCount) failures.push("fixture-count");
  if (finite.some(([, value]) => !Number.isFinite(value))) failures.push("non-finite-metric");
  if (finite.some(([, value]) => value < 0)) failures.push("negative-metric");
  if (![facts.fixtureCount, facts.solvedPixels, facts.fractionalPixels].every(Number.isSafeInteger)) {
    failures.push("non-integer-count");
  }
  if (!(facts.candidateAlphaMad <= facts.baselineAlphaMad * THRESHOLDS.maximumAlphaMadRatio)) failures.push("alpha-mad-improvement");
  if (!(facts.candidateEdgeMad <= facts.baselineEdgeMad * THRESHOLDS.maximumFractionalEdgeMadRatio)) failures.push("fractional-edge-improvement");
  if (!(facts.candidateForegroundRgbMae <= facts.baselineForegroundRgbMae * THRESHOLDS.maximumForegroundRgbMaeRatio)) failures.push("foreground-rgb-improvement");
  if (!(facts.candidateCompositeRgbMae <= facts.baselineCompositeRgbMae * THRESHOLDS.maximumCompositeRgbMaeRatio)) failures.push("composite-rgb-regression");
  if (!(facts.candidateTemporalDtssd <= facts.baselineTemporalDtssd * THRESHOLDS.maximumTemporalDtssdRatio)) failures.push("temporal-dtssd-regression");
  if (!(facts.knownCoreMaxError <= THRESHOLDS.maximumKnownCoreError + 1e-9)) failures.push("known-core-preservation");
  if (!(facts.solvedPixels > 0 && facts.solvedPixels === facts.fractionalPixels)) failures.push("fractional-band-coverage");
  if (!(facts.candidateP95Ms > 0 && facts.candidateP95Ms < THRESHOLDS.maximumReferenceP95Ms)) failures.push("bounded-reference-runtime");
  if (!facts.restrictedDependencyFree) failures.push("restricted-external-dependency");
  return failures;
}

const validFacts: Facts = {
  schema: "editkin.optical-alpha-benchmark/v1",
  engine: ENGINE,
  fixtureCount: 3,
  baselineAlphaMad: 0.02,
  candidateAlphaMad: 0.01,
  baselineEdgeMad: 0.08,
  candidateEdgeMad: 0.04,
  baselineForegroundRgbMae: 0.04,
  candidateForegroundRgbMae: 0.02,
  baselineCompositeRgbMae: 0.01,
  candidateCompositeRgbMae: 0.005,
  baselineTemporalDtssd: 0.01,
  candidateTemporalDtssd: 0.005,
  knownCoreMaxError: 0,
  candidateP95Ms: 2,
  solvedPixels: 100,
  fractionalPixels: 100,
  restrictedDependencyFree: true,
};

function evaluatorSelfTest(): string[] {
  const mutations: Array<[string, (facts: Facts) => void]> = [
    ["schema", (facts) => { facts.schema = "wrong"; }],
    ["engine", (facts) => { facts.engine = "external-matting-model"; }],
    ["fixtures", (facts) => { facts.fixtureCount = 2; }],
    ["alpha", (facts) => { facts.candidateAlphaMad = facts.baselineAlphaMad; }],
    ["edge", (facts) => { facts.candidateEdgeMad = facts.baselineEdgeMad; }],
    ["foreground", (facts) => { facts.candidateForegroundRgbMae = facts.baselineForegroundRgbMae; }],
    ["composite", (facts) => { facts.candidateCompositeRgbMae = facts.baselineCompositeRgbMae * 2; }],
    ["temporal", (facts) => { facts.candidateTemporalDtssd = facts.baselineTemporalDtssd * 2; }],
    ["core", (facts) => { facts.knownCoreMaxError = 2 / 255; }],
    ["coverage", (facts) => { facts.solvedPixels -= 1; }],
    ["runtime", (facts) => { facts.candidateP95Ms = 1_001; }],
    ["restricted", (facts) => { facts.restrictedDependencyFree = false; }],
    ["negative-metric", (facts) => { facts.candidateCompositeRgbMae = -0.001; }],
    ["fractional-count", (facts) => { facts.solvedPixels = 100.5; facts.fractionalPixels = 100.5; }],
  ];
  if (evaluate(structuredClone(validFacts)).length) throw new Error("Optical-alpha evaluator rejects its valid control");
  for (const [name, mutate] of mutations) {
    const facts = structuredClone(validFacts);
    mutate(facts);
    if (!evaluate(facts).length) throw new Error(`Optical-alpha evaluator accepted mutation: ${name}`);
  }
  return mutations.map(([name]) => name);
}

function cargoExecutable(): string {
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  const candidates = [process.env.CARGO, join(homedir(), ".cargo", "bin", executable)].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? "cargo";
}

function runBenchmark(cargoPath: string) {
  const argv = ["run", "--quiet", "--bin", "optical_alpha_benchmark"];
  const result = spawnSync(cargoPath, argv, {
    cwd: nativeRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Native optical-alpha benchmark failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return {
    facts: JSON.parse(result.stdout.trim()) as Omit<Facts, "restrictedDependencyFree">,
    launch: {
      argv: [cargoPath, ...argv],
      cwd: nativeRoot,
      exitCode: result.status,
      stdoutSha256: createHash("sha256").update(result.stdout).digest("hex"),
      stderrSha256: createHash("sha256").update(result.stderr).digest("hex"),
    },
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileIdentity(path: string) {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function restrictedDependencyFree(): Promise<boolean> {
  const paths = [
    join(nativeRoot, "src", "engine", "optical_alpha.rs"),
    join(nativeRoot, "src", "engine", "auto_roto.rs"),
    join(nativeRoot, "src", "bin", "optical_alpha_benchmark.rs"),
    join(nativeRoot, "Cargo.toml"),
  ];
  const source = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
  return !/(corridor\s*key|sam2\s*matting|commercial\s*license\s*key|download\s*model|https?:\/\/)/iu.test(source);
}

async function main() {
  const rejectedMutations = evaluatorSelfTest();
  if (process.argv.includes("--self-test")) {
    console.log(`Self-authored optical-alpha evaluator calibration passed (${rejectedMutations.length} mutations)`);
    return;
  }
  const cargoPath = cargoExecutable();
  const benchmark = runBenchmark(cargoPath);
  const facts: Facts = { ...benchmark.facts, restrictedDependencyFree: await restrictedDependencyFree() };
  const failures = evaluate(facts);
  const sources = {
    experimentPlan: {
      path: ".rd/experiments/self-authored-optical-alpha-refiner-plan.json",
      sha256: await sha256(planPath),
    },
    evaluator: {
      path: "scripts/self-authored-optical-alpha-refiner-gate.ts",
      sha256: await sha256(fileURLToPath(import.meta.url)),
    },
    implementation: {
      path: "native/hao-core/src/engine/optical_alpha.rs",
      sha256: await sha256(join(nativeRoot, "src", "engine", "optical_alpha.rs")),
    },
    benchmark: {
      path: "native/hao-core/src/bin/optical_alpha_benchmark.rs",
      sha256: await sha256(join(nativeRoot, "src", "bin", "optical_alpha_benchmark.rs")),
    },
    nativeAutoRotoIntegration: {
      path: "native/hao-core/src/engine/auto_roto.rs",
      sha256: await sha256(join(nativeRoot, "src", "engine", "auto_roto.rs")),
    },
    dependencyManifest: {
      path: "native/hao-core/Cargo.toml",
      sha256: await sha256(join(nativeRoot, "Cargo.toml")),
    },
    dependencyLock: {
      path: "native/hao-core/Cargo.lock",
      sha256: await sha256(join(nativeRoot, "Cargo.lock")),
    },
    baselineImplementation: {
      path: "native/hao-core/src/engine/roto.rs",
      sha256: await sha256(join(nativeRoot, "src", "engine", "roto.rs")),
    },
  };
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? resolve(nativeRoot, process.env.CARGO_TARGET_DIR)
    : join(nativeRoot, "target");
  const benchmarkArtifact = join(targetDirectory, "debug", process.platform === "win32" ? "optical_alpha_benchmark.exe" : "optical_alpha_benchmark");
  const report = {
    schema: "editkin.self-authored-optical-alpha-gate-report/v1",
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_CALIBRATION_CANDIDATE_PRODUCT_PLANNED",
    claim: "On the frozen deterministic synthetic corpus, Editkin-owned Rust optical-alpha v1 must improve box-matte fractional alpha and straight-foreground recovery while preserving known cores, temporal discontinuities, determinism and the restricted-dependency boundary.",
    baseline: {
      engine: BASELINE_ENGINE,
      sameFixtureAndMetricProvenance: true,
    },
    thresholds: THRESHOLDS,
    facts,
    failures,
    evaluator: { mutationCount: rejectedMutations.length, allRejected: true, rejectedMutations },
    sources,
    execution: {
      ...benchmark.launch,
      cargo: await fileIdentity(cargoPath),
      benchmarkArtifact: await fileIdentity(benchmarkArtifact),
    },
    claimBoundary: [
      "Synthetic deterministic calibration only; no competitor-superiority claim.",
      "No real hair, fur, glass, veil, motion-blur, independent holdout, native-GPU, installer, or cross-platform closure.",
      "The receipt is wired into the bounded native Auto Roto color/optional-research-ONNX fallback only; Screen Keyer invocation, owned blind real holdout, manual trimap, Preview/formal parity, GPU adapter, save/reopen, installer and macOS remain unverified.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) throw new Error(`Self-authored optical-alpha gate BLOCK: ${failures.join(", ")}`);
  console.log(`Self-authored optical-alpha gate GREEN (calibration candidate, product planned) · report ${reportPath}`);
}

await main();
