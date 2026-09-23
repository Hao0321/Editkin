import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(appRoot, "native", "hao-core");
const planPath = join(appRoot, ".rd", "experiments", "self-authored-texture-motion-alpha-v3-plan.json");
const reportPath = join(appRoot, ".rd", "benchmarks", "editkin-texture-aware-optical-alpha-v3", "report.json");
const V1 = "editkin-self-authored-optical-alpha-refiner/v1";
const V2 = "editkin-self-authored-adaptive-optical-alpha-refiner/v2";
const V3 = "editkin-self-authored-texture-aware-optical-alpha-refiner/v3";
const EPSILON = 1e-12;

interface ScenarioMetric {
  name: string;
  frozenAlphaMad: number;
  adaptiveAlphaMad: number;
  frozenEdgeMad: number;
  adaptiveEdgeMad: number;
  textureAwareAlphaMad: number;
  textureAwareEdgeMad: number;
}

interface Facts {
  schema: string;
  engine: string;
  textureAwareEngine: string;
  baselineEngine: string;
  fixtureCount: number;
  frozenAlphaMad: number;
  adaptiveAlphaMad: number;
  textureAwareAlphaMad: number;
  frozenEdgeMad: number;
  adaptiveEdgeMad: number;
  textureAwareEdgeMad: number;
  textureAwareWinCount: number;
  knownCoreMaxError: number;
  textureAwareSolvedPixels: number;
  textureAwareFractionalPixels: number;
  frozenP95Ms: number;
  textureAwareP95Ms: number;
  textureAwareDeterministic: boolean;
  scenarios: ScenarioMetric[];
  planBound: boolean;
  selfAuthoredDependencyFree: boolean;
}

function evaluate(facts: Facts): string[] {
  const failures: string[] = [];
  if (facts.schema !== "editkin.adaptive-optical-alpha-hardcase-benchmark/v1") failures.push("schema");
  if (facts.baselineEngine !== V1 || facts.engine !== V2 || facts.textureAwareEngine !== V3) failures.push("engine-identity");
  if (facts.fixtureCount < 5 || facts.scenarios.length !== facts.fixtureCount) failures.push("fixture-coverage");
  if (Object.entries(facts).some(([, value]) => typeof value === "number" && !Number.isFinite(value))) failures.push("finite-metrics");
  if (facts.textureAwareAlphaMad > 0.005315907613045237) failures.push("prospective-alpha-threshold");
  if (facts.textureAwareEdgeMad > 0.03401794426952943) failures.push("prospective-edge-threshold");
  if (facts.textureAwareAlphaMad > facts.adaptiveAlphaMad * 0.97) failures.push("v2-alpha-gain");
  if (facts.textureAwareEdgeMad > facts.adaptiveEdgeMad * 0.97) failures.push("v2-edge-gain");
  if (facts.textureAwareWinCount !== facts.fixtureCount) failures.push("all-scenario-wins");
  if (facts.scenarios.some((scenario) => scenario.textureAwareAlphaMad > scenario.frozenAlphaMad + EPSILON)) failures.push("scenario-alpha-regression");
  if (facts.scenarios.some((scenario) => scenario.textureAwareEdgeMad > scenario.frozenEdgeMad + EPSILON)) failures.push("scenario-edge-regression");
  if (facts.knownCoreMaxError > 1 / 255 + EPSILON) failures.push("known-core-preservation");
  if (!(facts.textureAwareSolvedPixels > 0 && facts.textureAwareSolvedPixels === facts.textureAwareFractionalPixels)) failures.push("fractional-band-coverage");
  if (!(facts.frozenP95Ms > 0 && facts.textureAwareP95Ms > 0 && facts.textureAwareP95Ms <= 30
    && facts.textureAwareP95Ms <= facts.frozenP95Ms * 1.75)) failures.push("bounded-runtime");
  if (!facts.textureAwareDeterministic) failures.push("determinism");
  if (!facts.planBound) failures.push("prospective-plan-binding");
  if (!facts.selfAuthoredDependencyFree) failures.push("self-authored-boundary");
  return failures;
}

const valid: Facts = {
  schema: "editkin.adaptive-optical-alpha-hardcase-benchmark/v1",
  baselineEngine: V1,
  engine: V2,
  textureAwareEngine: V3,
  fixtureCount: 5,
  frozenAlphaMad: 0.0062,
  adaptiveAlphaMad: 0.00548,
  textureAwareAlphaMad: 0.0051,
  frozenEdgeMad: 0.0407,
  adaptiveEdgeMad: 0.03507,
  textureAwareEdgeMad: 0.033,
  textureAwareWinCount: 5,
  knownCoreMaxError: 0,
  textureAwareSolvedPixels: 100,
  textureAwareFractionalPixels: 100,
  frozenP95Ms: 4,
  textureAwareP95Ms: 5,
  textureAwareDeterministic: true,
  planBound: true,
  selfAuthoredDependencyFree: true,
  scenarios: Array.from({ length: 5 }, (_, index) => ({
    name: `scenario-${index}`,
    frozenAlphaMad: 0.01,
    adaptiveAlphaMad: 0.009,
    textureAwareAlphaMad: 0.008,
    frozenEdgeMad: 0.04,
    adaptiveEdgeMad: 0.035,
    textureAwareEdgeMad: 0.03,
  })),
};

function selfTest(): number {
  const mutations: Array<[string, (facts: Facts) => void]> = [
    ["schema", (facts) => { facts.schema = "wrong"; }],
    ["engine", (facts) => { facts.textureAwareEngine = "external"; }],
    ["fixture", (facts) => { facts.fixtureCount = 4; }],
    ["finite", (facts) => { facts.textureAwareAlphaMad = Number.NaN; }],
    ["alpha-threshold", (facts) => { facts.textureAwareAlphaMad = 0.0054; }],
    ["edge-threshold", (facts) => { facts.textureAwareEdgeMad = 0.0341; }],
    ["v2-alpha", (facts) => { facts.textureAwareAlphaMad = facts.adaptiveAlphaMad; }],
    ["v2-edge", (facts) => { facts.textureAwareEdgeMad = facts.adaptiveEdgeMad; }],
    ["wins", (facts) => { facts.textureAwareWinCount = 4; }],
    ["scenario-alpha", (facts) => { facts.scenarios[0]!.textureAwareAlphaMad = 0.011; }],
    ["scenario-edge", (facts) => { facts.scenarios[0]!.textureAwareEdgeMad = 0.041; }],
    ["core", (facts) => { facts.knownCoreMaxError = 2 / 255; }],
    ["coverage", (facts) => { facts.textureAwareSolvedPixels = 99; }],
    ["absolute-runtime", (facts) => { facts.textureAwareP95Ms = 31; }],
    ["relative-runtime", (facts) => { facts.textureAwareP95Ms = 8; }],
    ["determinism", (facts) => { facts.textureAwareDeterministic = false; }],
    ["plan", (facts) => { facts.planBound = false; }],
    ["dependency", (facts) => { facts.selfAuthoredDependencyFree = false; }],
  ];
  if (evaluate(structuredClone(valid)).length) throw new Error("Texture-aware alpha evaluator rejects valid control");
  for (const [name, mutate] of mutations) {
    const facts = structuredClone(valid);
    mutate(facts);
    if (!evaluate(facts).length) throw new Error(`Texture-aware alpha evaluator accepted mutation: ${name}`);
  }
  return mutations.length;
}

function cargoExecutable(): string {
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  return [process.env.CARGO, join(homedir(), ".cargo", "bin", executable)]
    .filter((value): value is string => Boolean(value))
    .find((candidate) => existsSync(candidate)) ?? "cargo";
}

function benchmark(): Omit<Facts, "planBound" | "selfAuthoredDependencyFree"> {
  const result = spawnSync(cargoExecutable(), ["run", "--quiet", "--no-default-features", "--bin", "adaptive_optical_alpha_benchmark"], {
    cwd: nativeRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Texture-aware alpha benchmark failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim()) as Omit<Facts, "planBound" | "selfAuthoredDependencyFree">;
}

interface Plan {
  schema?: string;
  id?: string;
  prospectiveFreeze?: boolean;
  baseline?: { productEngine?: string; candidateEngine?: string; reportSha256?: string; implementationSha256?: string; facts?: Record<string, number> };
  candidate?: { engine?: string; productPolicy?: string };
}

async function planBound(facts: Omit<Facts, "planBound" | "selfAuthoredDependencyFree">): Promise<boolean> {
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
  const baseline = plan.baseline;
  const frozen = baseline?.facts;
  return plan.schema === "editkin.rd-experiment-plan/v1"
    && plan.id === "self-authored-texture-aware-alpha-v3"
    && plan.prospectiveFreeze === true
    && baseline?.productEngine === V1
    && baseline?.candidateEngine === V2
    && plan.candidate?.engine === V3
    && plan.candidate?.productPolicy === "diagnostic_only_until_owned_blind_holdout"
    && /^[a-f0-9]{64}$/u.test(baseline?.reportSha256 ?? "")
    && /^[a-f0-9]{64}$/u.test(baseline?.implementationSha256 ?? "")
    && Math.abs((frozen?.v1AlphaMad ?? Number.NaN) - facts.frozenAlphaMad) <= EPSILON
    && Math.abs((frozen?.v2AlphaMad ?? Number.NaN) - facts.adaptiveAlphaMad) <= EPSILON
    && Math.abs((frozen?.v1EdgeMad ?? Number.NaN) - facts.frozenEdgeMad) <= EPSILON
    && Math.abs((frozen?.v2EdgeMad ?? Number.NaN) - facts.adaptiveEdgeMad) <= EPSILON;
}

async function selfAuthoredDependencyFree(): Promise<boolean> {
  const source = await readFile(join(nativeRoot, "src", "engine", "optical_alpha.rs"), "utf8");
  const benchmarkSource = await readFile(join(nativeRoot, "src", "bin", "adaptive_optical_alpha_benchmark.rs"), "utf8");
  return !/(onnx|sam\s*[123]|segment.anything|download.model|python|torch|tensorflow|opencv|https?:\/\/)/iu.test(`${source}\n${benchmarkSource}`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  const mutationCount = selfTest();
  if (process.argv.includes("--self-test")) {
    console.log(`Texture-aware optical-alpha v3 evaluator GREEN (${mutationCount} mutations)`);
    return;
  }
  const measured = benchmark();
  const facts: Facts = {
    ...measured,
    planBound: await planBound(measured),
    selfAuthoredDependencyFree: await selfAuthoredDependencyFree(),
  };
  const failures = evaluate(facts);
  const report = {
    schema: "editkin.texture-aware-optical-alpha-v3-gate-report/v1",
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_PROSPECTIVE_SYNTHETIC_CANDIDATE_PRODUCT_V1_RETAINED",
    facts,
    failures,
    evaluator: { mutationCount, allRejected: true },
    evidence: {
      plan: { path: ".rd/experiments/self-authored-texture-motion-alpha-v3-plan.json", sha256: await sha256(planPath) },
      implementation: { path: "native/hao-core/src/engine/optical_alpha.rs", sha256: await sha256(join(nativeRoot, "src", "engine", "optical_alpha.rs")) },
      benchmark: { path: "native/hao-core/src/bin/adaptive_optical_alpha_benchmark.rs", sha256: await sha256(join(nativeRoot, "src", "bin", "adaptive_optical_alpha_benchmark.rs")) },
      evaluator: { path: "scripts/texture-aware-optical-alpha-v3-gate.ts", sha256: await sha256(fileURLToPath(import.meta.url)) },
    },
    claimBoundary: [
      "The prospectively frozen synthetic cell passes; v3 is still diagnostic and the product retains v1.",
      "All five synthetic classes beat frozen v1 and aggregate v3 beats v2, but no real-footage blind holdout or human correction-time evidence exists.",
      "This result does not prove dynamic-video temporal quality, SAM superiority, GPU delivery, installer readiness or macOS parity.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) throw new Error(`Texture-aware optical-alpha v3 gate BLOCK: ${failures.join(", ")}`);
  console.log(`Texture-aware optical-alpha v3 gate GREEN prospective synthetic · report ${reportPath}`);
}

await main();
