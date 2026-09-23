import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(root, "../..");
const evidenceRoot = resolve(root, ".rd/benchmarks/native-effect-plugin-internal");
const outputPath = resolve(evidenceRoot, "report.json");
const smokePath = resolve(
  process.env.EDITKIN_TAURI_SMOKE_REPORT
    ?? resolve(workspaceRoot, ".rd/benchmarks/editkin-tauri-cdp-smoke.json"),
);

const refreshScripts = [
  "effect-plugin:gate",
  "effect-plugin:sequence-gate",
  "effect-plugin:project-render-gate",
  "effect-plugin:preview-bridge-gate",
  "gpu:effect-sdk-gate",
  "gpu:effect-sdk-project-render-gate",
];

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

function refreshEvidence() {
  const npmCli = process.env.npm_execpath;
  assert(npmCli, "npm_execpath is unavailable; run this gate through npm");
  for (const script of refreshScripts) {
    const result = spawnSync(process.execPath, [npmCli, "run", script, "--silent"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`${script} failed (status ${String(result.status)}, ${result.error?.message ?? "no spawn error"})\n${result.stderr || result.stdout || "no child output"}`);
    }
    process.stderr.write(`[plugin-abi] ${script} GREEN\n`);
  }
}

export function evaluatePluginAbiInternal(inputs) {
  const findings = [];
  const reject = (code, detail) => findings.push({ code, detail });
  const { native, sequence, project, preview, sdk, sdkProject, smoke, currentManifest } = inputs;

  if (native?.status !== "GREEN" || native?.isolated !== true) reject("native-worker", "C ABI worker is not isolated and GREEN");
  if (!Array.isArray(native?.negativeControls) || native.negativeControls.length < 4) reject("native-negatives", "native ABI lacks hash/timeout/crash/output controls");
  if (native?.concurrency?.status !== "GREEN" || native?.concurrency?.workers < 4 || native?.postCrashRecovery !== "GREEN") reject("native-recovery", "concurrency or post-crash recovery is missing");

  if (sequence?.status !== "GREEN" || sequence?.isolated !== true || sequence?.frameCount < 120 || sequence?.libraryLoads !== 1) reject("sequence-worker", "persistent sequence worker contract is incomplete");
  if (sequence?.maxPixelError > 1e-5 || sequence?.repeatRuns < 8 || sequence?.concurrentWorkers < 4) reject("sequence-quality", "sequence oracle/repeat/concurrency stress failed");
  if (!Array.isArray(sequence?.negativeControls) || sequence.negativeControls.length < 5) reject("sequence-negatives", "sequence failure controls are incomplete");

  if (project?.status !== "GREEN" || !String(project?.planner ?? "").includes("native-effect-sequence/v1")) reject("cpu-product-render", "native ABI is not bound to formal project rendering");
  if (project?.frameCount < 12 || project?.libraryLoads !== 1 || project?.workerOutputSha256 !== project?.expectedFloatSha256 || project?.preview?.audioSourceRetained !== true) reject("cpu-product-parity", "formal CPU effect output lost the worker oracle or audio");
  if (preview?.status !== "GREEN" || preview?.journey?.mode !== "cached-cpu-native-sequence/v1" || preview?.journey?.firstCacheHit !== false || preview?.journey?.secondCacheHit !== true || preview?.journey?.audioSourceRetained !== true) reject("cpu-preview", "preview does not reuse the isolated formal executor/cache");

  if (sdk?.status !== "GREEN" || sdk?.authoringRuntime !== "gpu_effect_module" || sdk?.bindingResolved !== true) reject("gpu-sdk", "data-only GPU module did not compile and bind");
  if (sdk?.shaderOpCount !== 4 || sdk?.artifactChanged !== true || sdk?.decodePathCpuPixelCopies !== 0 || sdk?.stagingCpuPixelReadbacks !== 0 || sdk?.nativeSurfaceCpuPixelReadbacks !== 0) reject("gpu-sdk-execution", "GPU SDK runtime evidence is incomplete");
  if (!Array.isArray(sdk?.rejectedNegativeControls) || sdk.rejectedNegativeControls.length < 2) reject("gpu-sdk-negatives", "GPU SDK failure controls are incomplete");
  if (sdkProject?.status !== "GREEN" || sdkProject?.executionMode !== "resident-gpu-shader-sequence/v1") reject("gpu-product-render", "GPU module is not bound to formal project rendering");
  if (sdkProject?.frameCount < 15 || sdkProject?.losslessPixelDifferences !== 0 || sdkProject?.productPathCpuPixelCopies !== 0 || sdkProject?.audioSourceRetained !== true) reject("gpu-product-parity", "formal GPU module output lost parity, zero-copy, or audio");

  if (smoke?.status !== "GREEN" || smoke?.bridge?.userPlugin?.status !== "GREEN") reject("delivered-plugin-install", "delivered app did not discover the per-user plugin root");
  if (smoke?.bridge?.gpuBundledPlugin?.status !== "GREEN" || smoke.bridge.gpuBundledPlugin.runtimeGreen !== true) reject("delivered-gpu-plugin", "delivered app did not execute the GPU plugin module");
  const programs = smoke?.bridge?.gpuBundledPlugin?.loaded?.gpuEffects?.programs ?? [];
  if (programs.length !== 2 || programs.some((program) => !/^[a-f0-9]{64}$/.test(program.programSha256 ?? "") || !String(program.pluginIdentity ?? "").includes("#"))) reject("delivered-program-identity", "delivered program receipts are not manifest/hash pinned");
  const frame = smoke?.bridge?.gpuBundledPlugin?.presented?.receipt?.frame;
  if (frame?.decodePathCpuPixelCopies !== 0 || frame?.stagingCpuPixelReadbacks !== 0 || frame?.nativeSurfaceCpuPixelReadbacks !== 0) reject("delivered-zero-copy", "delivered plugin frame crossed a CPU pixel path");
  const deliveredInput = smoke?.buildManifest?.inputIdentity;
  const currentInput = currentManifest?.inputIdentity;
  if (deliveredInput?.files !== currentInput?.files || deliveredInput?.bytes !== currentInput?.bytes || deliveredInput?.sha256 !== currentInput?.sha256) reject("stale-delivered-build", "delivered smoke does not match the current release input identity");

  return { status: findings.length === 0 ? "GREEN" : "BLOCK", findings };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const valid = {
      native: { status: "GREEN", isolated: true, negativeControls: [1, 2, 3, 4], concurrency: { status: "GREEN", workers: 8 }, postCrashRecovery: "GREEN" },
      sequence: { status: "GREEN", isolated: true, frameCount: 120, libraryLoads: 1, maxPixelError: 0, repeatRuns: 8, concurrentWorkers: 4, negativeControls: [1, 2, 3, 4, 5] },
      project: { status: "GREEN", planner: "x+native-effect-sequence/v1", frameCount: 12, libraryLoads: 1, workerOutputSha256: "x", expectedFloatSha256: "x", preview: { audioSourceRetained: true } },
      preview: { status: "GREEN", journey: { mode: "cached-cpu-native-sequence/v1", firstCacheHit: false, secondCacheHit: true, audioSourceRetained: true } },
      sdk: { status: "GREEN", authoringRuntime: "gpu_effect_module", bindingResolved: true, shaderOpCount: 4, artifactChanged: true, decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0, rejectedNegativeControls: [1, 2] },
      sdkProject: { status: "GREEN", executionMode: "resident-gpu-shader-sequence/v1", frameCount: 15, losslessPixelDifferences: 0, productPathCpuPixelCopies: 0, audioSourceRetained: true },
      smoke: { status: "GREEN", bridge: { userPlugin: { status: "GREEN" }, gpuBundledPlugin: { status: "GREEN", runtimeGreen: true, loaded: { gpuEffects: { programs: [{ programSha256: "a".repeat(64), pluginIdentity: "p/c@1.0.0#hash" }, { programSha256: "b".repeat(64), pluginIdentity: "p/d@1.0.0#hash" }] } }, presented: { receipt: { frame: { decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0 } } } } }, buildManifest: { inputIdentity: { files: 1, bytes: 2, sha256: "x" } } },
      currentManifest: { inputIdentity: { files: 1, bytes: 2, sha256: "x" } },
    };
    assert(evaluatePluginAbiInternal(valid).status === "GREEN", "valid fixture did not pass");
    for (const mutate of [
      (value) => { value.native.isolated = false; },
      (value) => { value.sequence.libraryLoads = 2; },
      (value) => { value.project.preview.audioSourceRetained = false; },
      (value) => { value.sdk.decodePathCpuPixelCopies = 1; },
      (value) => { value.smoke.bridge.gpuBundledPlugin.loaded.gpuEffects.programs[0].programSha256 = "0"; },
      (value) => { value.currentManifest.inputIdentity.sha256 = "stale"; },
    ]) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      assert(evaluatePluginAbiInternal(candidate).status === "BLOCK", "negative control was not rejected");
    }
    process.stdout.write(`${JSON.stringify({ schema: "editkin.plugin-abi-internal-self-test/v1", status: "GREEN", negativeControls: 6 }, null, 2)}\n`);
    return;
  }

  if (process.argv.includes("--refresh")) refreshEvidence();
  const paths = {
    native: resolve(workspaceRoot, ".rd/benchmarks/editkin-native-effect-plugin/report.json"),
    sequence: resolve(workspaceRoot, ".rd/benchmarks/editkin-native-effect-sequence/report.json"),
    project: resolve(workspaceRoot, ".rd/benchmarks/editkin-native-effect-project-render/report.json"),
    preview: resolve(workspaceRoot, ".rd/benchmarks/editkin-native-effect-preview-bridge/report.json"),
    sdk: resolve(workspaceRoot, ".rd/benchmarks/editkin-gpu-effect-sdk/report.json"),
    sdkProject: resolve(workspaceRoot, ".rd/benchmarks/editkin-gpu-effect-sdk-project-render/report.json"),
    currentManifest: resolve(root, ".release-input-manifest.json"),
  };
  const values = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readJson(path)])));
  values.smoke = await readJson(smokePath);
  const evaluated = evaluatePluginAbiInternal(values);
  const executablePath = values.smoke.executable;
  await stat(executablePath);
  const report = {
    schema: "editkin.native-effect-plugin-internal/v1",
    measuredAt: new Date().toISOString(),
    ...evaluated,
    scope: "Windows internal bounded plugin host: C ABI v1/v2 isolated CPU workers plus data-only GPU effect graph/module SDK; this is not arbitrary shader, OFX, HDR/Log, temporal-neighbor, or cross-platform parity.",
    deliveredExecutable: await fileIdentity(executablePath),
    releaseInputIdentity: values.currentManifest.inputIdentity,
    contracts: {
      nativeAbi: { isolated: values.native.isolated, concurrentWorkers: values.native.concurrency?.workers, postCrashRecovery: values.native.postCrashRecovery, negativeControls: values.native.negativeControls?.length },
      nativeSequence: { frames: values.sequence.frameCount, libraryLoads: values.sequence.libraryLoads, maxPixelError: values.sequence.maxPixelError, repeatRuns: values.sequence.repeatRuns, concurrentWorkers: values.sequence.concurrentWorkers, negativeControls: values.sequence.negativeControls?.length },
      cpuFormalOutput: { frames: values.project.frameCount, workerOracleMatched: values.project.workerOutputSha256 === values.project.expectedFloatSha256, audioRetained: values.project.preview?.audioSourceRetained },
      gpuModule: { shaderOperations: values.sdk.shaderOpCount, decodePathCpuPixelCopies: values.sdk.decodePathCpuPixelCopies, stagingCpuPixelReadbacks: values.sdk.stagingCpuPixelReadbacks, nativeSurfaceCpuPixelReadbacks: values.sdk.nativeSurfaceCpuPixelReadbacks, negativeControls: values.sdk.rejectedNegativeControls?.length },
      gpuFormalOutput: { frames: values.sdkProject.frameCount, losslessPixelDifferences: values.sdkProject.losslessPixelDifferences, productPathCpuPixelCopies: values.sdkProject.productPathCpuPixelCopies, audioRetained: values.sdkProject.audioSourceRetained },
      deliveredJourney: { userPluginInstall: values.smoke.bridge.userPlugin.status, gpuPluginRuntime: values.smoke.bridge.gpuBundledPlugin.status, programCount: values.smoke.bridge.gpuBundledPlugin.loaded.gpuEffects.programs.length },
    },
    inputs: Object.fromEntries(await Promise.all(Object.entries({ ...paths, smoke: smokePath }).map(async ([key, path]) => [key, await fileIdentity(path)]))),
  };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
