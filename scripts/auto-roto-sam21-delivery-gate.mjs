import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const releaseManifestPath = join(appRoot, ".release-input-manifest.json");
const smokePath = join(repoRoot, ".rd/benchmarks/editkin-tauri-cdp-smoke.json");
const servicePath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-service-bridge/report.json");
const lifecyclePath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-tauri-model-lifecycle/report.json");
const packPath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-portable-pack-gate/report.json");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-delivery");
const outputPath = join(outputRoot, "report.json");
const requiredInputs = [
  "src/application/autoRotoVideoPack.ts", "src/application/autoRotoVideoModel.ts", "src/application/autoRotoModelRouter.ts", "src/application/autoRoto.ts",
  "src/service/cli.ts", "src-tauri/src/main.rs", "src/ui/MaskStudio.tsx", "src/desktop/tauriBridge.ts",
  "scripts/auto-roto-tauri-model-lifecycle-gate.mjs",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identityMatches = (left, right) => left?.files === right?.files && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;

function evaluate(facts) {
  return {
    tauriSmokeGreen: facts.smokeStatus === "GREEN" && facts.smokeExecutableMatches,
    fullJourneyCoverage: facts.journeySteps >= 55 && facts.requiredJourneysPresent,
    sourceBoundRelease: facts.smokeInputIdentityMatches && facts.stagedInputIdentityMatches && facts.stagedOutputIdentityMatches,
    requiredSourcesFrozen: facts.requiredInputsPresent && facts.requiredInputHashesCurrent && facts.pythonCacheInputs === 0,
    productionServiceBridge: facts.serviceStatus === "GREEN_PRODUCT_SERVICE_BRIDGE" && facts.serviceChecksGreen,
    signedOptionalPack: facts.packStatus === "GREEN" && facts.packChecksGreen,
    freshInstallRepairJourney: facts.lifecycleStatus === "GREEN_TAURI_MODEL_LIFECYCLE" && facts.lifecycleChecksGreen && facts.lifecycleExecutableMatches,
    modelNotEmbedded: facts.packagedModelArtifacts === 0 && !facts.packagedPythonRuntime && !facts.packagedSamSource && !facts.packagedAutoRotoHost,
    nativeFallbackAvailable: facts.nativeFallbackAvailable,
  };
}

if (process.argv.includes("--self-test")) {
  const valid = {
    smokeStatus: "GREEN", smokeExecutableMatches: true, journeySteps: 60, requiredJourneysPresent: true,
    smokeInputIdentityMatches: true, stagedInputIdentityMatches: true, stagedOutputIdentityMatches: true,
    requiredInputsPresent: true, requiredInputHashesCurrent: true, pythonCacheInputs: 0,
    serviceStatus: "GREEN_PRODUCT_SERVICE_BRIDGE", serviceChecksGreen: true, packStatus: "GREEN", packChecksGreen: true,
    lifecycleStatus: "GREEN_TAURI_MODEL_LIFECYCLE", lifecycleChecksGreen: true, lifecycleExecutableMatches: true,
    packagedModelArtifacts: 0, packagedPythonRuntime: false, packagedSamSource: false, packagedAutoRotoHost: false, nativeFallbackAvailable: true,
  };
  if (!Object.values(evaluate(valid)).every(Boolean)) throw new Error("delivery evaluator rejected valid fixture");
  const keys = ["smokeStatus", "smokeExecutableMatches", "requiredJourneysPresent", "stagedInputIdentityMatches", "requiredInputsPresent", "requiredInputHashesCurrent", "serviceChecksGreen", "packChecksGreen", "lifecycleChecksGreen", "lifecycleExecutableMatches", "nativeFallbackAvailable"];
  const mutations = keys.map((key) => ({ name: key, mutate: (fixture) => { fixture[key] = key === "smokeStatus" ? "FAIL" : false; } }));
  mutations.push({ name: "model-smuggle", mutate: (fixture) => { fixture.packagedModelArtifacts = 1; } });
  for (const { name, mutate } of mutations) { const fixture = structuredClone(valid); mutate(fixture); if (Object.values(evaluate(fixture)).every(Boolean)) throw new Error(`delivery evaluator missed ${name}`); }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: mutations.length })}\n`); process.exit(0);
}

function argumentValue(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const [releaseBytes, smokeBytes, serviceBytes, lifecycleBytes, packBytes] = await Promise.all([releaseManifestPath, smokePath, servicePath, lifecyclePath, packPath].map((path) => readFile(path)));
const release = JSON.parse(releaseBytes); const smoke = JSON.parse(smokeBytes); const service = JSON.parse(serviceBytes); const lifecycle = JSON.parse(lifecycleBytes); const pack = JSON.parse(packBytes);
const executablePath = resolve(argumentValue("--executable") ?? smoke.executable);
const releaseRoot = dirname(executablePath); const runtimeRoot = join(releaseRoot, "runtime");
const stagedManifestBytes = await readFile(join(runtimeRoot, "BUILD-MANIFEST.json")); const stagedManifest = JSON.parse(stagedManifestBytes);
const inputByPath = new Map(release.inputs.map((entry) => [entry.path.replaceAll("\\", "/"), entry]));
const requiredHashes = await Promise.all(requiredInputs.map(async (path) => ({ path, actual: sha256(await readFile(join(appRoot, path))), frozen: inputByPath.get(path)?.sha256 })));
const runtimeFiles = [];
async function walk(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const absolute = join(directory, entry.name); if (entry.isDirectory()) await walk(absolute); else runtimeFiles.push(relative(runtimeRoot, absolute).replaceAll("\\", "/")); } }
await walk(runtimeRoot);
const modelArtifacts = runtimeFiles.filter((path) => /\.(?:pt|pth|onnx|safetensors|engine|plan)$/i.test(path));
const journeyNames = new Set((smoke.journeySteps ?? []).map((step) => step.name));
const requiredJourneys = ["app-ready", "build-manifest", "gpu-common-video-temporal-matte-bridge", "render", "gpu-product-fallback-project-truth"];
const executableBytes = await readFile(executablePath); const executableSha256 = sha256(executableBytes);
const facts = {
  smokeStatus: smoke.status, smokeExecutableMatches: resolve(smoke.executable) === executablePath,
  journeySteps: smoke.journeySteps?.length ?? 0, requiredJourneysPresent: requiredJourneys.every((name) => journeyNames.has(name)),
  smokeInputIdentityMatches: identityMatches(smoke.buildManifest?.inputIdentity, release.inputIdentity),
  stagedInputIdentityMatches: identityMatches(stagedManifest.inputIdentity, release.inputIdentity), stagedOutputIdentityMatches: identityMatches(stagedManifest.outputIdentity, release.outputIdentity),
  requiredInputsPresent: requiredInputs.every((path) => inputByPath.has(path)), requiredInputHashesCurrent: requiredHashes.every((entry) => entry.actual === entry.frozen),
  pythonCacheInputs: release.inputs.filter((entry) => /(^|\/)(__pycache__\/|[^/]+\.py[co]$)/i.test(entry.path.replaceAll("\\", "/"))).length,
  serviceStatus: service.status, serviceChecksGreen: Object.values(service.checks ?? {}).every(Boolean), packStatus: pack.status, packChecksGreen: Object.values(pack.checks ?? {}).every(Boolean),
  lifecycleStatus: lifecycle.status, lifecycleChecksGreen: Object.values(lifecycle.checks ?? {}).every(Boolean), lifecycleExecutableMatches: lifecycle.delivery?.executableSha256 === executableSha256,
  packagedModelArtifacts: modelArtifacts.length, packagedPythonRuntime: runtimeFiles.some((path) => /python(?:\.exe|\d+\.dll)$|site-packages/i.test(path)),
  packagedSamSource: runtimeFiles.some((path) => /(^|\/)sam2(\/|$)|checkpoint/i.test(path)), packagedAutoRotoHost: runtimeFiles.some((path) => /auto-roto-sam21-video-host\.py$/i.test(path)),
  nativeFallbackAvailable: lifecycle.checks?.freshInstallMissing === true && lifecycle.checks?.corruptionDetected === true,
};
const checks = evaluate(facts); const status = Object.values(checks).every(Boolean) ? "GREEN_OPTIONAL_MODEL_DELIVERY" : "FAIL";
const report = {
  schema: "editkin.auto-roto-sam21-delivery-gate/v2", status, checks,
  artifact: { path: executablePath, bytes: executableBytes.length, sha256: executableSha256 }, buildIdentity: release.inputIdentity,
  staged: { runtimeRoot, runtimeFiles, modelArtifacts }, facts,
  inputs: { releaseManifest: { path: releaseManifestPath, bytes: releaseBytes.length, sha256: sha256(releaseBytes) }, smoke: { path: smokePath, sha256: sha256(smokeBytes) }, service: { path: servicePath, sha256: sha256(serviceBytes) }, lifecycle: { path: lifecyclePath, sha256: sha256(lifecycleBytes) }, pack: { path: packPath, sha256: sha256(packBytes) }, requiredHashes },
  claimBoundary: "Proves the source-bound Windows executable keeps the 4.85 GB model outside the app, offers native fallback, and can install/verify/repair the separately signed pack. Public download transport and Authenticode are external release scope; macOS is parity scope.",
};
await mkdir(outputRoot, { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(`AUTO_ROTO_SAM21_DELIVERY status=${status} executable=${executableSha256} report=${outputPath}\n`); if (status === "FAIL") process.exitCode = 1;
