import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGpuRuntimeClosure, REQUIRED_GPU_RUNTIME_EVIDENCE_IDS } from "./lib/gpu-runtime-closure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(root, "..", "..");
const nodeExecutable = resolve(root, "vendor", "node", "win32-x64", "node.exe");
const tauriExecutable = resolve(process.env.EDITKIN_GPU_CLOSURE_TAURI_EXECUTABLE
  ?? resolve(root, "src-tauri", "target", "release", "editkin.exe"));
const tauriReportPath = resolve(workspaceRoot, ".rd", "benchmarks", "editkin-tauri-cdp-smoke.json");
const outputDirectory = resolve(root, ".rd", "benchmarks", "gpu-runtime-internal");
const outputPath = resolve(outputDirectory, "report.json");

function runJson(executable, args, timeout) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${executable} ${args[0] ?? ""} timed out after ${timeout} ms`);
  if (result.status !== 0) {
    let summary = String(result.stdout ?? "").trim().slice(-4_000);
    try {
      const report = JSON.parse(String(result.stdout ?? "").trim());
      summary = JSON.stringify({
        status: report.status,
        gpuProductFallback: report.gpuProductFallback,
        lastJourneySteps: report.journeySteps?.slice(-5),
      }, null, 2);
    } catch { /* retain the bounded stdout tail */ }
    const stderr = String(result.stderr ?? "").trim().slice(-4_000);
    throw new Error(`${executable} ${args.join(" ")} failed (${result.status})\n${summary}${stderr ? `\n${stderr}` : ""}`);
  }
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    throw new Error(`child did not emit exactly one JSON document: ${args[0] ?? executable}\n${String(error)}`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function evidenceIdentity(id, path, publicPath) {
  return { id, path: publicPath, sha256: await sha256(path) };
}

function normalizeTauri(report) {
  const image = report.bridge.gpuCommonEngine;
  const video = report.bridge.gpuCommonVideoEngine;
  const videoFrame = video.first.receipt.frame;
  const multitrack = report.bridge.gpuCommonVideoMultitrack;
  const surface = report.bridge.gpuNativeSurface;
  const adjustment = report.bridge.gpuCommonVideoAdjustment;
  const fault = report.bridge.gpuFaultRecovery;
  const fallback = report.gpuProductFallback;
  return {
    status: report.status,
    buildManifestStatus: report.buildManifest.status,
    product: report.buildManifest.product,
    productVersion: report.buildManifest.productVersion,
    rootMounted: report.coldRuntime.rootMounted,
    timelineInteractive: report.coldRuntime.timelineInteractive,
    renderInteractive: report.coldRuntime.renderInteractive,
    typedImage: {
      status: image.status,
      graph: image.loaded.engineGraph,
      timelineChanged: image.renderedHash !== image.outsideHash,
      legacyOverrideRejected: image.legacyOverrideRejected,
    },
    typedVideo: {
      status: video.status,
      graph: video.loaded.engineGraph,
      resourcePlan: video.loaded.resourcePlan,
      residentFrameRingSize: video.loaded.decoder.residentFrameRingSize,
      decodePathCpuPixelCopies: videoFrame.decodePathCpuPixelCopies,
      stagingCpuPixelReadbacks: videoFrame.stagingCpuPixelReadbacks,
      nativeSurfaceCpuPixelReadbacks: videoFrame.nativeSurfaceCpuPixelReadbacks,
      nativeSurfacePresented: videoFrame.nativeSurfacePresented,
    },
    multitrack: {
      status: multitrack.status,
      coverageComplete: multitrack.coverageComplete,
      resourcePlanGreen: multitrack.resourcePlanGreen,
      scheduleGreen: multitrack.scheduleGreen,
      decoderGroupingGreen: multitrack.decoderGroupingGreen,
      dirtyFallbackGreen: multitrack.dirtyFallbackGreen,
      direct: multitrack.direct,
      missingBindingRejected: multitrack.missingBindingRejected,
      extraBindingRejected: multitrack.extraBindingRejected,
    },
    surface: {
      status: surface.status,
      invalidRejected: surface.invalidRejected,
      dimensionsMatchDpi: surface.dimensionsMatchDpi,
      nativeSwapChain: surface.bound.nativeSwapChain,
      backend: surface.bound.backend,
      firstPresentCount: surface.first.receipt.frame.nativeSurfacePresentCount,
      secondPresentCount: surface.second.receipt.frame.nativeSurfacePresentCount,
      cpuPixelReadbacks: Math.max(surface.bound.cpuPixelReadbacks, surface.first.receipt.frame.nativeSurfaceCpuPixelReadbacks, surface.second.receipt.frame.nativeSurfaceCpuPixelReadbacks),
      rejectedAfterRelease: surface.rejectedAfterSurfaceRelease,
      released: surface.surfaceReleased.released && surface.videoReleased.released && surface.videoReleased.fences.pendingFenceCount === 0,
    },
    typedRecovery: {
      status: adjustment.status,
      coverageComplete: adjustment.coverageComplete,
      loadHandshake: adjustment.loadHandshake,
      activeHandshake: adjustment.activeHandshake,
      armed: adjustment.armed.armed,
      rejectedWithDeviceLost: adjustment.rejected,
      replayHandshake: adjustment.replayHandshake,
      generationBefore: adjustment.before.status.generation,
      generationAfter: adjustment.recovered.generation,
    },
    surfaceRecovery: {
      status: fault.status,
      armed: fault.armed.armed,
      rejectedWithDeviceLost: fault.rejected,
      generationBefore: fault.before.status.generation,
      generationAfter: fault.recovered.generation,
      residentSessionsAfter: fault.recovered.residentSessions,
      residentVideoSessionsAfter: fault.recovered.residentVideoSessions,
      residentEngineVideoSessionsAfter: fault.recovered.residentEngineVideoSessions,
      reopenedGeneration: fault.reopenedGeneration,
      nativeSurfacePresented: fault.frame.nativeSurfacePresented,
      cpuPixelReadbacks: Math.max(fault.frame.stagingCpuPixelReadbacks, fault.frame.nativeSurfaceCpuPixelReadbacks, fault.frame.decodePathCpuPixelCopies),
    },
    productFallback: {
      status: fallback.status,
      acceleratedBefore: fallback.acceleratedBefore,
      forcedCalls: fallback.forcedCalls,
      compatiblePreview: fallback.compatiblePreview,
      acceleratedRestored: fallback.acceleratedRestored,
      projectTruthStable: fallback.projectTruthStable,
      projectWriteDelta: fallback.projectWriteDelta,
      runtimeStable: fallback.runtimeStable,
      generationBefore: fallback.engineBefore.generation,
      generationAfter: fallback.engineAfter.generation,
      videoBackend: fallback.engineAfter.videoBackend,
    },
  };
}

function positiveFixture() {
  const graph = { graphSchema: "editkin.engine-graph/v1", directExecution: true, executionFormat: "rgba32_float", blockedNodeIds: [], ignoredNodeIds: [], executedNodeIds: ["source", "transform", "color", "output"] };
  return {
    schema: "editkin.gpu-runtime-closure/v1",
    platform: "win32",
    adapter: "fixture-adapter",
    claimBoundary: { scope: "internal", aggregate: "planned", public: "planned", parity: "unmeasured" },
    tauri: {
      status: "GREEN", buildManifestStatus: "GREEN", product: "Editkin", productVersion: "0.15.0",
      rootMounted: true, timelineInteractive: true, renderInteractive: true,
      typedImage: { status: "GREEN", graph, timelineChanged: true, legacyOverrideRejected: true },
      typedVideo: { status: "GREEN", graph, resourcePlan: { schema: "editkin.resident-video-resource-plan/v1", requiredBytes: 1, remainingBytes: 1 }, residentFrameRingSize: 3, decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0, nativeSurfacePresented: true },
      multitrack: { status: "GREEN", coverageComplete: true, resourcePlanGreen: true, scheduleGreen: true, decoderGroupingGreen: true, dirtyFallbackGreen: true, direct: true, missingBindingRejected: true, extraBindingRejected: true },
      surface: { status: "GREEN", invalidRejected: true, dimensionsMatchDpi: true, nativeSwapChain: true, backend: "Dx12", firstPresentCount: 1, secondPresentCount: 2, cpuPixelReadbacks: 0, rejectedAfterRelease: true, released: true },
      typedRecovery: { status: "GREEN", coverageComplete: true, loadHandshake: true, activeHandshake: true, armed: true, rejectedWithDeviceLost: true, replayHandshake: true, generationBefore: 2, generationAfter: 3 },
      surfaceRecovery: { status: "GREEN", armed: true, rejectedWithDeviceLost: true, generationBefore: 3, generationAfter: 4, residentSessionsAfter: 0, residentVideoSessionsAfter: 0, residentEngineVideoSessionsAfter: 0, reopenedGeneration: 4, nativeSurfacePresented: true, cpuPixelReadbacks: 0 },
      productFallback: { status: "GREEN", acceleratedBefore: true, forcedCalls: 1, compatiblePreview: true, acceleratedRestored: true, projectTruthStable: true, projectWriteDelta: 0, runtimeStable: true, generationBefore: 4, generationAfter: 5, videoBackend: "Dx12" },
    },
    resident: { status: "GREEN", engine: "editkin-wgpu-resident-engine/v1", frames: 12, outputHash: "a".repeat(64), faultInjection: { armed: true, rejectedWithDeviceLost: true, deterministicRenderRestored: true }, negativeControl: "unknown-session-rejected" },
    evidence: REQUIRED_GPU_RUNTIME_EVIDENCE_IDS.map((id, index) => ({ id, sha256: String(index % 10).repeat(64) })),
  };
}

function selfTest() {
  const positive = positiveFixture();
  if (evaluateGpuRuntimeClosure(positive).status !== "GREEN") throw new Error("positive GPU runtime closure fixture failed");
  const mutations = [
    ["scope", (item) => { item.claimBoundary.public = "verified"; }, "claim-boundary"],
    ["window", (item) => { item.tauri.rootMounted = false; }, "window-lifecycle"],
    ["typed graph", (item) => { item.tauri.typedImage.graph.ignoredNodeIds.push("fake"); }, "typed-image-graph"],
    ["budget", (item) => { item.tauri.typedVideo.resourcePlan.requiredBytes = 0; }, "typed-video-graph"],
    ["dirty", (item) => { item.tauri.multitrack.dirtyFallbackGreen = false; }, "multitrack-resource-dirty"],
    ["resize", (item) => { item.tauri.surface.secondPresentCount = 1; }, "native-surface"],
    ["typed recovery", (item) => { item.tauri.typedRecovery.generationAfter = 2; }, "typed-device-recovery"],
    ["stale sessions", (item) => { item.tauri.surfaceRecovery.residentVideoSessionsAfter = 1; }, "surface-device-recovery"],
    ["no injected product fault", (item) => { item.tauri.productFallback.forcedCalls = 0; }, "product-fallback"],
    ["no fallback", (item) => { item.tauri.productFallback.compatiblePreview = false; }, "product-fallback"],
    ["project mutation", (item) => { item.tauri.productFallback.projectWriteDelta = 1; }, "product-fallback"],
    ["resident hash", (item) => { item.resident.outputHash = "bad"; }, "resident-runtime"],
    ["missing evaluator", (item) => { item.evidence = item.evidence.filter((entry) => entry.id !== "closure-evaluator"); }, "missing-evidence-id"],
  ];
  const detected = mutations.map(([name, mutate, code]) => {
    const fixture = structuredClone(positive);
    mutate(fixture);
    const decision = evaluateGpuRuntimeClosure(fixture);
    if (decision.status !== "BLOCK" || !decision.findings.some((item) => item.code === code)) throw new Error(`${name} fixture missed ${code}`);
    return code;
  });
  process.stdout.write(`${JSON.stringify({ status: "GREEN", detected })}\n`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  if (process.platform !== "win32") throw new Error("GPU runtime internal closure currently requires Windows");
  await mkdir(outputDirectory, { recursive: true });
  const tauri = runJson(nodeExecutable, [resolve(root, "scripts", "tauri-cdp-smoke.mjs"), tauriExecutable], 1_200_000);
  const resident = runJson(nodeExecutable, [resolve(root, "scripts", "gpu-resident-engine-gate.mjs")], 300_000);
  const report = {
    schema: "editkin.gpu-runtime-closure/v1",
    platform: process.platform,
    adapter: tauri.bridge.gpuFaultRecovery.before.ready.adapter,
    productVersion: tauri.buildManifest.productVersion,
    claimBoundary: {
      scope: "internal",
      aggregate: "planned",
      public: "planned",
      parity: "unmeasured",
      excluded: ["extracted-installer-replay", "macos-metal-parity", "direct-hardware-encoder-surface", "arbitrary-mesh-material-shadow-graph"],
    },
    tauri: normalizeTauri(tauri),
    resident,
    evidence: await Promise.all([
      evidenceIdentity("tauri-report", tauriReportPath, "workspace/.rd/benchmarks/editkin-tauri-cdp-smoke.json"),
      evidenceIdentity("resident-report", resident.evidence, "workspace/.rd/benchmarks/editkin-gpu-resident-engine/report.json"),
      evidenceIdentity("closure-runner", resolve(root, "scripts", "gpu-runtime-closure-gate.mjs"), "scripts/gpu-runtime-closure-gate.mjs"),
      evidenceIdentity("closure-evaluator", resolve(root, "scripts", "lib", "gpu-runtime-closure.mjs"), "scripts/lib/gpu-runtime-closure.mjs"),
      evidenceIdentity("tauri-runner", resolve(root, "scripts", "tauri-cdp-smoke.mjs"), "scripts/tauri-cdp-smoke.mjs"),
      evidenceIdentity("resident-runner", resolve(root, "scripts", "gpu-resident-engine-gate.mjs"), "scripts/gpu-resident-engine-gate.mjs"),
      evidenceIdentity("tauri-executable", tauriExecutable, "src-tauri/target/release/editkin.exe"),
      evidenceIdentity("node-executable", nodeExecutable, "runtime/node.exe"),
      evidenceIdentity("rust-resident-server", resolve(root, "spikes", "gpu-compositor", "src", "main.rs"), "spikes/gpu-compositor/src/main.rs"),
      evidenceIdentity("rust-native-surface", resolve(root, "spikes", "gpu-compositor", "src", "windows_video.rs"), "spikes/gpu-compositor/src/windows_video.rs"),
      evidenceIdentity("tauri-host-bridge", resolve(root, "src-tauri", "src", "main.rs"), "src-tauri/src/main.rs"),
      evidenceIdentity("frontend-preview-runtime", resolve(root, "src", "desktop", "useResidentGpuPreview.ts"), "src/desktop/useResidentGpuPreview.ts"),
    ]),
  };
  const decision = evaluateGpuRuntimeClosure(report);
  const envelope = { ...report, decision };
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: decision.status, output: outputPath, adapter: report.adapter, claimBoundary: report.claimBoundary, findings: decision.findings })}\n`);
  if (decision.status !== "GREEN") process.exitCode = 1;
}
