import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(root, "../..");
const configPath = resolve(root, "config/auto-roto-sam21-candidate.json");
const outputPath = resolve(
  workspaceRoot,
  ".rd/benchmarks/editkin-auto-roto-sam21-candidate-gate/report.json",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function everyContractGreen(report) {
  const contracts = Object.values(report?.contracts ?? {});
  return contracts.length > 0 && contracts.every((value) => value === true);
}

function includesClaim(report, pattern) {
  return (report?.claimBoundary?.doesNotProve ?? []).some((value) => pattern.test(String(value)));
}

export function evaluateCandidate({ config, reports, identities, checkpoint, license }) {
  const findings = [];
  const reject = (code, detail) => findings.push({ code, detail });
  const bf16Feasibility = reports.bfloat16Feasibility;
  const fp16Feasibility = reports.float16Feasibility;
  const bf16Natural = reports.bfloat16Natural;
  const fp16Natural = reports.float16Natural;
  const thresholds = config.thresholds ?? {};

  if (config.schema !== "editkin.auto-roto-model-candidate/v1"
    || config.tier !== "research_candidate"
    || config.productPromotion !== "BLOCKED") {
    reject("claim-tier", "candidate must remain research-only and product-blocked");
  }
  if (config.deploymentArchitecture?.measuredRealtime !== false
    || config.deploymentArchitecture?.packagedInEditkin !== false
    || config.deploymentArchitecture?.nativeVideoMemoryRuntime !== false
    || config.deploymentArchitecture?.interactivePreview !== "proxy-cache"
    || config.deploymentArchitecture?.formalPropagation !== "background-fp16") {
    reject("deployment-truth", "candidate architecture overstates measured delivery or runtime support");
  }
  if (config.officialOnnxAssessment?.imageEncoderDecoderAvailable !== true
    || config.officialOnnxAssessment?.videoMemoryPropagationAvailable !== false) {
    reject("onnx-boundary", "official image-only ONNX export was misrepresented as video-memory propagation");
  }
  if (!Array.isArray(config.requiredPromotionBlockers) || config.requiredPromotionBlockers.length < 8) {
    reject("promotion-blockers", "product promotion blockers are incomplete");
  }

  if (checkpoint.bytes !== config.upstream?.checkpointBytes
    || checkpoint.sha256 !== config.upstream?.checkpointSha256) {
    reject("checkpoint-identity", "SAM 2.1 checkpoint identity does not match the frozen candidate");
  }
  if (license.bytes !== config.upstream?.licenseBytes
    || license.sha256 !== config.upstream?.licenseSha256
    || config.upstream?.licenseSpdx !== "Apache-2.0") {
    reject("license-identity", "upstream license identity or SPDX declaration changed");
  }
  for (const [name, expected] of Object.entries(config.evidence ?? {})) {
    const actual = identities[name];
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      reject("evidence-identity", `${name} report identity changed`);
    }
  }

  if (bf16Feasibility?.status !== "GREEN_FEASIBILITY"
    || fp16Feasibility?.status !== "GREEN_FEASIBILITY"
    || bf16Natural?.status !== "GREEN_NATURAL_FIXTURE"
    || fp16Natural?.status !== "GREEN_NATURAL_FIXTURE") {
    reject("report-status", "one or more feasibility/natural reports are not GREEN");
  }
  if (![bf16Feasibility, fp16Feasibility, bf16Natural, fp16Natural].every(everyContractGreen)) {
    reject("report-contracts", "one or more source reports contain a failed structural or quality contract");
  }
  if (fp16Feasibility?.precision !== "float16" || fp16Natural?.precision !== "float16") {
    reject("precision-receipt", "FP16 reports do not declare float16 execution");
  }

  const reportsWithCommit = [bf16Feasibility, fp16Feasibility, bf16Natural, fp16Natural];
  if (reportsWithCommit.some((report) => report?.upstream?.sam2Commit !== config.upstream?.commit
    && report?.upstream?.commit !== config.upstream?.commit)) {
    reject("upstream-commit", "source reports do not share the frozen SAM 2 commit");
  }
  if ([bf16Feasibility, fp16Feasibility].some((report) => report?.upstream?.checkpoint?.sha256 !== config.upstream?.checkpointSha256)
    || [bf16Natural, fp16Natural].some((report) => report?.upstream?.checkpoint?.sha256 !== config.upstream?.checkpointSha256)) {
    reject("report-checkpoint", "source reports do not share the frozen checkpoint");
  }
  if (bf16Natural?.upstream?.fixtureVideo?.sha256 !== fp16Natural?.upstream?.fixtureVideo?.sha256
    || bf16Natural?.upstream?.fixtureAnnotations?.sha256 !== fp16Natural?.upstream?.fixtureAnnotations?.sha256
    || bf16Natural?.protocol?.objectIndex !== fp16Natural?.protocol?.objectIndex) {
    reject("natural-fixture", "BF16 and FP16 natural quality were not measured on the same fixture/object");
  }
  if ([bf16Feasibility, fp16Feasibility, bf16Natural, fp16Natural].some((report) => report?.host?.gpu !== config.targetCell?.gpu
    || report?.host?.computeCapability !== config.targetCell?.computeCapability)) {
    reject("hardware-cell", "source reports do not share the frozen GPU cell");
  }

  const fp16Quality = fp16Natural?.measurement?.quality ?? {};
  if (!(fp16Quality.jAndF >= thresholds.jAndFMin)
    || !(fp16Quality.j >= thresholds.jMin)
    || !(fp16Quality.f >= thresholds.fMin)) {
    reject("natural-quality", "FP16 natural J/F screen is below the frozen threshold");
  }
  const precisionDelta = Math.abs((bf16Natural?.measurement?.quality?.jAndF ?? Infinity) - (fp16Quality.jAndF ?? -Infinity));
  if (!(precisionDelta <= thresholds.precisionJAndFDeltaMax)) {
    reject("precision-quality", "FP16 J&F drift exceeds the BF16 reference allowance");
  }
  const bf16Mean = bf16Natural?.measurement?.latencyMs?.steadyMean;
  const fp16Mean = fp16Natural?.measurement?.latencyMs?.steadyMean;
  const fp16Speedup = bf16Mean / fp16Mean;
  if (!(fp16Speedup >= thresholds.fp16SpeedupMin)) {
    reject("precision-speed", "FP16 speedup is below the frozen minimum");
  }
  if (!(fp16Natural?.measurement?.latencyMs?.steadyP95 <= thresholds.fp16SteadyP95MsMax)
    || !(fp16Natural?.measurement?.cudaMemory?.peakReservedBytes <= thresholds.fp16PeakReservedBytesMax)
    || !(fp16Natural?.measurement?.modelLoadSeconds <= thresholds.modelLoadSecondsMax)
    || !(fp16Natural?.measurement?.stateInitializationSeconds <= thresholds.stateInitializationSecondsMax)
    || !(fp16Natural?.measurement?.promptSeconds * 1000 <= thresholds.promptMillisecondsMax)) {
    reject("target-cell-budget", "FP16 target-cell latency, memory, load, initialization, or prompt budget failed");
  }
  if (![bf16Feasibility, fp16Feasibility, bf16Natural, fp16Natural].every((report) => includesClaim(report, /product|commercial/i))) {
    reject("claim-boundary", "one or more reports can be mistaken for product readiness");
  }

  return {
    status: findings.length === 0 ? "GREEN" : "BLOCK",
    productPromotion: "BLOCKED",
    findings,
    measurements: {
      fp16NaturalJAndF: fp16Quality.jAndF,
      fp16NaturalJ: fp16Quality.j,
      fp16NaturalF: fp16Quality.f,
      bf16ToFp16JAndFDelta: precisionDelta,
      bf16ToFp16Speedup: fp16Speedup,
      fp16SteadyP95Ms: fp16Natural?.measurement?.latencyMs?.steadyP95,
      fp16SteadyFps: fp16Natural?.measurement?.latencyMs?.steadyFpsFromMean,
      fp16PeakReservedBytes: fp16Natural?.measurement?.cudaMemory?.peakReservedBytes,
    },
  };
}

function validSelfTestFixture() {
  const reportBase = {
    claimBoundary: { doesNotProve: ["commercial product readiness"] },
    contracts: { complete: true },
    host: { gpu: "GPU", computeCapability: "7.5" },
    upstream: { sam2Commit: "c", checkpoint: { sha256: "m" } },
  };
  const naturalBase = {
    ...structuredClone(reportBase),
    status: "GREEN_NATURAL_FIXTURE",
    upstream: { commit: "c", checkpoint: { sha256: "m" }, fixtureVideo: { sha256: "v" }, fixtureAnnotations: { sha256: "a" } },
    protocol: { objectIndex: 1 },
    measurement: {
      quality: { jAndF: 80, j: 80, f: 80 },
      latencyMs: { steadyMean: 300, steadyP95: 150, steadyFpsFromMean: 3.33 },
      cudaMemory: { peakReservedBytes: 1000 },
      modelLoadSeconds: 1,
      stateInitializationSeconds: 2,
      promptSeconds: 0.1,
    },
  };
  const fp16Natural = structuredClone(naturalBase);
  fp16Natural.precision = "float16";
  fp16Natural.measurement.latencyMs.steadyMean = 100;
  fp16Natural.measurement.latencyMs.steadyFpsFromMean = 10;
  const bf16Feasibility = { ...structuredClone(reportBase), status: "GREEN_FEASIBILITY" };
  const fp16Feasibility = { ...structuredClone(bf16Feasibility), precision: "float16" };
  const config = {
    schema: "editkin.auto-roto-model-candidate/v1",
    tier: "research_candidate",
    productPromotion: "BLOCKED",
    upstream: { commit: "c", checkpointBytes: 10, checkpointSha256: "m", licenseBytes: 20, licenseSha256: "l", licenseSpdx: "Apache-2.0" },
    officialOnnxAssessment: { imageEncoderDecoderAvailable: true, videoMemoryPropagationAvailable: false },
    targetCell: { gpu: "GPU", computeCapability: "7.5" },
    thresholds: { jAndFMin: 70, jMin: 70, fMin: 65, precisionJAndFDeltaMax: 0.05, fp16SpeedupMin: 2, fp16SteadyP95MsMax: 160, fp16PeakReservedBytesMax: 2000, modelLoadSecondsMax: 5, stateInitializationSecondsMax: 30, promptMillisecondsMax: 250 },
    evidence: { bfloat16Feasibility: { bytes: 1, sha256: "1" }, float16Feasibility: { bytes: 2, sha256: "2" }, bfloat16Natural: { bytes: 3, sha256: "3" }, float16Natural: { bytes: 4, sha256: "4" } },
    deploymentArchitecture: { measuredRealtime: false, packagedInEditkin: false, nativeVideoMemoryRuntime: false, interactivePreview: "proxy-cache", formalPropagation: "background-fp16" },
    requiredPromotionBlockers: Array.from({ length: 8 }, (_, index) => `b${index}`),
  };
  return {
    config,
    reports: { bfloat16Feasibility: bf16Feasibility, float16Feasibility: fp16Feasibility, bfloat16Natural: naturalBase, float16Natural: fp16Natural },
    identities: { bfloat16Feasibility: { bytes: 1, sha256: "1" }, float16Feasibility: { bytes: 2, sha256: "2" }, bfloat16Natural: { bytes: 3, sha256: "3" }, float16Natural: { bytes: 4, sha256: "4" } },
    checkpoint: { bytes: 10, sha256: "m" },
    license: { bytes: 20, sha256: "l" },
  };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const valid = validSelfTestFixture();
    assert(evaluateCandidate(valid).status === "GREEN", "valid candidate fixture did not pass");
    const mutations = [
      (value) => { value.config.productPromotion = "VERIFIED"; },
      (value) => { value.config.officialOnnxAssessment.videoMemoryPropagationAvailable = true; },
      (value) => { value.checkpoint.sha256 = "wrong"; },
      (value) => { value.identities.float16Natural.sha256 = "stale"; },
      (value) => { value.reports.float16Natural.measurement.quality.jAndF = 60; },
      (value) => { value.reports.float16Natural.measurement.latencyMs.steadyMean = 250; },
      (value) => { value.reports.float16Natural.measurement.latencyMs.steadyP95 = 200; },
      (value) => { value.reports.float16Natural.measurement.cudaMemory.peakReservedBytes = 3000; },
      (value) => { value.reports.float16Natural.claimBoundary.doesNotProve = []; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      assert(evaluateCandidate(candidate).status === "BLOCK", "negative control was not rejected");
    }
    process.stdout.write(`${JSON.stringify({ schema: "editkin.auto-roto-sam21-candidate-self-test/v1", status: "GREEN", negativeControls: mutations.length }, null, 2)}\n`);
    return;
  }

  const config = await readJson(configPath);
  const evidenceEntries = Object.entries(config.evidence);
  const reports = Object.fromEntries(await Promise.all(evidenceEntries.map(async ([name, evidence]) => [name, await readJson(resolve(workspaceRoot, evidence.path))])));
  const identities = Object.fromEntries(await Promise.all(evidenceEntries.map(async ([name, evidence]) => [name, await fileIdentity(resolve(workspaceRoot, evidence.path))])));
  const checkpoint = await fileIdentity(resolve(workspaceRoot, config.upstream.checkpointPath));
  const license = await fileIdentity(resolve(workspaceRoot, config.upstream.licensePath));
  const evaluated = evaluateCandidate({ config, reports, identities, checkpoint, license });
  const report = {
    schema: "editkin.auto-roto-sam21-candidate-gate/v1",
    measuredAt: new Date().toISOString(),
    candidateId: config.candidateId,
    ...evaluated,
    scope: "Windows RTX 2060 bounded R&D candidate: one official demo sequence plus one official SA-V training example/object. This is not packaged product execution, diverse natural quality, realtime preview, correction UX, or cross-platform parity.",
    model: checkpoint,
    license,
    inputs: identities,
    remainingBlockers: config.requiredPromotionBlockers,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
