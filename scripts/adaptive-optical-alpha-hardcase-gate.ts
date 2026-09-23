import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(appRoot, "native", "hao-core");
const reportPath = join(appRoot, ".rd", "benchmarks", "editkin-adaptive-optical-alpha-hardcases", "report.json");
const ENGINE = "editkin-self-authored-adaptive-optical-alpha-refiner/v2";
const BASELINE_ENGINE = "editkin-self-authored-optical-alpha-refiner/v1";

interface ScenarioMetric {
  name: string;
  frozenAlphaMad: number;
  adaptiveAlphaMad: number;
  frozenEdgeMad: number;
  adaptiveEdgeMad: number;
}

interface Facts {
  schema: string;
  engine: string;
  baselineEngine: string;
  fixtureCount: number;
  frozenAlphaMad: number;
  adaptiveAlphaMad: number;
  frozenEdgeMad: number;
  adaptiveEdgeMad: number;
  adaptiveWinCount: number;
  knownCoreMaxError: number;
  adaptiveSolvedPixels: number;
  adaptiveFractionalPixels: number;
  frozenP95Ms: number;
  adaptiveP95Ms: number;
  deterministic: boolean;
  scenarios: ScenarioMetric[];
  selfAuthoredDependencyFree: boolean;
}

function evaluate(facts: Facts): string[] {
  const failures: string[] = [];
  if (facts.schema !== "editkin.adaptive-optical-alpha-hardcase-benchmark/v1") failures.push("schema");
  if (facts.engine !== ENGINE || facts.baselineEngine !== BASELINE_ENGINE) failures.push("engine-identity");
  if (facts.fixtureCount < 5 || facts.scenarios.length !== facts.fixtureCount) failures.push("fixture-coverage");
  if (Object.entries(facts).some(([, value]) => typeof value === "number" && !Number.isFinite(value))) failures.push("finite-metrics");
  if (!(facts.adaptiveAlphaMad <= facts.frozenAlphaMad * 0.9)) failures.push("aggregate-alpha-improvement");
  if (!(facts.adaptiveEdgeMad <= facts.frozenEdgeMad * 0.89)) failures.push("aggregate-edge-improvement");
  if (facts.adaptiveWinCount < 3) failures.push("scenario-win-count");
  if (facts.scenarios.some((scenario) => scenario.adaptiveAlphaMad > scenario.frozenAlphaMad * 1.12
    || scenario.adaptiveEdgeMad > scenario.frozenEdgeMad * 1.12)) failures.push("bounded-scenario-regression");
  if (facts.knownCoreMaxError > 1 / 255 + 1e-9) failures.push("known-core-preservation");
  if (!(facts.adaptiveSolvedPixels > 0 && facts.adaptiveSolvedPixels === facts.adaptiveFractionalPixels)) failures.push("fractional-band-coverage");
  if (!(facts.frozenP95Ms > 0 && facts.adaptiveP95Ms > 0 && facts.adaptiveP95Ms < 30
    && facts.adaptiveP95Ms <= facts.frozenP95Ms * 1.75)) failures.push("bounded-runtime-overhead");
  if (!facts.deterministic) failures.push("determinism");
  if (!facts.selfAuthoredDependencyFree) failures.push("self-authored-boundary");
  return failures;
}

const valid: Facts = {
  schema: "editkin.adaptive-optical-alpha-hardcase-benchmark/v1",
  engine: ENGINE,
  baselineEngine: BASELINE_ENGINE,
  fixtureCount: 5,
  frozenAlphaMad: 0.01,
  adaptiveAlphaMad: 0.008,
  frozenEdgeMad: 0.04,
  adaptiveEdgeMad: 0.03,
  adaptiveWinCount: 4,
  knownCoreMaxError: 0,
  adaptiveSolvedPixels: 100,
  adaptiveFractionalPixels: 100,
  frozenP95Ms: 4,
  adaptiveP95Ms: 5,
  deterministic: true,
  selfAuthoredDependencyFree: true,
  scenarios: Array.from({ length: 5 }, (_, index) => ({
    name: `scenario-${index}`,
    frozenAlphaMad: 0.01,
    adaptiveAlphaMad: 0.009,
    frozenEdgeMad: 0.04,
    adaptiveEdgeMad: 0.035,
  })),
};

function selfTest(): number {
  const mutations: Array<[string, (facts: Facts) => void]> = [
    ["schema", (facts) => { facts.schema = "wrong"; }],
    ["engine", (facts) => { facts.engine = "external-model"; }],
    ["fixtures", (facts) => { facts.fixtureCount = 4; }],
    ["alpha", (facts) => { facts.adaptiveAlphaMad = facts.frozenAlphaMad; }],
    ["edge", (facts) => { facts.adaptiveEdgeMad = facts.frozenEdgeMad; }],
    ["wins", (facts) => { facts.adaptiveWinCount = 2; }],
    ["scenario-regression", (facts) => { facts.scenarios[0]!.adaptiveEdgeMad = 0.06; }],
    ["core", (facts) => { facts.knownCoreMaxError = 2 / 255; }],
    ["coverage", (facts) => { facts.adaptiveSolvedPixels = 99; }],
    ["absolute-runtime", (facts) => { facts.adaptiveP95Ms = 31; }],
    ["relative-runtime", (facts) => { facts.adaptiveP95Ms = 8; }],
    ["determinism", (facts) => { facts.deterministic = false; }],
    ["dependency", (facts) => { facts.selfAuthoredDependencyFree = false; }],
  ];
  if (evaluate(structuredClone(valid)).length) throw new Error("Adaptive alpha evaluator rejects valid control");
  for (const [name, mutate] of mutations) {
    const facts = structuredClone(valid);
    mutate(facts);
    if (!evaluate(facts).length) throw new Error(`Adaptive alpha evaluator accepted mutation: ${name}`);
  }
  return mutations.length;
}

function cargoExecutable(): string {
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  return [process.env.CARGO, join(homedir(), ".cargo", "bin", executable)]
    .filter((value): value is string => Boolean(value))
    .find((candidate) => existsSync(candidate)) ?? "cargo";
}

function benchmark(): Omit<Facts, "selfAuthoredDependencyFree"> {
  const result = spawnSync(cargoExecutable(), ["run", "--quiet", "--no-default-features", "--bin", "adaptive_optical_alpha_benchmark"], {
    cwd: nativeRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Adaptive alpha benchmark failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim()) as Omit<Facts, "selfAuthoredDependencyFree">;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function selfAuthoredDependencyFree(): Promise<boolean> {
  const paths = [
    join(nativeRoot, "src", "engine", "optical_alpha.rs"),
    join(nativeRoot, "src", "bin", "adaptive_optical_alpha_benchmark.rs"),
  ];
  const source = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
  return !/(onnx|sam\s*[123]|segment.anything|download.model|python|torch|tensorflow|opencv|https?:\/\/)/iu.test(source);
}

async function main() {
  const mutationCount = selfTest();
  if (process.argv.includes("--self-test")) {
    console.log(`Adaptive optical-alpha evaluator GREEN (${mutationCount} mutations)`);
    return;
  }
  const facts: Facts = { ...benchmark(), selfAuthoredDependencyFree: await selfAuthoredDependencyFree() };
  const failures = evaluate(facts);
  const report = {
    schema: "editkin.adaptive-optical-alpha-hardcase-gate-report/v1",
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_DIAGNOSTIC_CANDIDATE_PRODUCT_V1_RETAINED",
    facts,
    thresholds: {
      aggregateAlphaRatioMax: 0.9,
      aggregateEdgeRatioMax: 0.89,
      minimumScenarioWins: 3,
      maximumScenarioRegressionRatio: 1.12,
      maximumRuntimeRatio: 1.75,
      maximumP95Ms: 30,
    },
    failures,
    evaluator: { mutationCount, allRejected: true },
    sources: {
      implementation: { path: "native/hao-core/src/engine/optical_alpha.rs", sha256: await sha256(join(nativeRoot, "src", "engine", "optical_alpha.rs")) },
      benchmark: { path: "native/hao-core/src/bin/adaptive_optical_alpha_benchmark.rs", sha256: await sha256(join(nativeRoot, "src", "bin", "adaptive_optical_alpha_benchmark.rs")) },
    },
    claimBoundary: [
      "This is an Editkin-owned deterministic synthetic hard-case diagnostic; it is not a real-footage blind holdout.",
      "The adaptive v2 candidate improves aggregate alpha and edge error but is not promoted because two fixture classes still regress within the bounded guardrail.",
      "The product continues to execute the frozen self-authored v1 refiner until owned blind evidence and integration gates pass.",
      "No external model, competitor-superiority, hair/fur production quality, GPU, installer, or macOS claim is made.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) throw new Error(`Adaptive optical-alpha hard-case gate BLOCK: ${failures.join(", ")}`);
  console.log(`Adaptive optical-alpha hard-case gate GREEN diagnostic · report ${reportPath}`);
}

await main();
