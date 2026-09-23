import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-resource");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const width = 960;
const height = 540;
const layerCount = 12;
const cacheBudgetMb = 384;
const fixture = resolve(root, "public/demo-source.mp4");
const blendModes = ["normal", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn", "add"];
const blendCodes = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1];
const compositeOpacities = [1, .78, .83, .72, .69, .76, .81, .74, .79, .68, .73, .77];
const gridCenters = Array.from({ length: 11 }, (_, index) => ({
  x: 120 + (index % 4) * 240,
  y: 90 + Math.floor(index / 4) * 180,
}));

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function percentile(values, ratio) { return values.toSorted((a, b) => a - b)[Math.round((values.length - 1) * ratio)]; }

function expectedResourcePlan(selectedLayers, selectedBudgetMb, overlays = 0) {
  const pixels = width * height;
  const bytesPerVideoLayer = pixels * 36;
  const compositorWorkingBytes = pixels * 12;
  const overlayBytes = pixels * 4 * overlays;
  const requiredBytes = bytesPerVideoLayer * selectedLayers + compositorWorkingBytes + overlayBytes;
  const budgetBytes = selectedBudgetMb * 1024 * 1024;
  const maxVideoLayers = Math.max(0, Math.floor((budgetBytes - compositorWorkingBytes - overlayBytes) / bytesPerVideoLayer));
  return { pixels, bytesPerVideoLayer, compositorWorkingBytes, overlayBytes, requiredBytes, budgetBytes, maxVideoLayers };
}

function expectedCadence(index) { return index === 0 ? { divisor: 1, phase: 0 } : { divisor: 2, phase: index % 2 }; }
function expectedDecodeSchedule() {
  return {
    schema: "editkin.resident-video-decode-schedule/v1",
    fullRateLayerCount: 1,
    adaptiveLayerCount: layerCount - 1,
    maximumDecodeCadenceDivisor: 2,
    maximumReuseAgeFrames: 1,
  };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-resource-gate/v1" || report.status !== "GREEN") throw new Error("resource-adaptive report is not GREEN");
  if (!report.directExecution || report.layerCount !== layerCount || report.layerFrames.length !== layerCount) throw new Error("twelve-layer direct execution is incomplete");
  if (report.requiredNodeIds.length !== 59 || report.executedNodeIds.length !== 59 || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("twelve-layer graph coverage is incomplete");
  if (report.sourceClockMappings.length !== layerCount || report.sourceClockMappings.some((item) => !item.matches)) throw new Error("twelve independent source clocks were not preserved");
  if (report.layerContracts.length !== layerCount || report.layerContracts.some((item) => !item.matches)) throw new Error("typed blend/opacity layer receipts are incomplete");
  if (report.layerFrames.some((frame) => frame.decodePathCpuPixelCopies !== 0 || frame.stagingCpuPixelReadbacks !== 0 || frame.nativeSurfaceCpuPixelReadbacks !== 0)) throw new Error("product path performed a CPU pixel transfer");
  if (report.layerFrames.some((frame) => frame.decodeDispatchMode !== "parallel-com-apartment/v1" || !["batched-copy/v1", "source-cache-hit/v1"].includes(frame.gpuCopySubmissionMode) || !Number.isInteger(frame.gpuCopySubmissionLayerCount) || frame.gpuCopySubmissionLayerCount < 0 || frame.gpuCopySubmissionLayerCount > layerCount)) throw new Error("decoded layers did not retain parallel COM and bounded source-cache/copy receipts");
  if (!report.verificationReadbackIsolated || !report.visualLayersApplied || !report.artifactChanged || report.changedPixelRatio < .2) throw new Error("decoded twelve-layer artifact evidence is incomplete");
  if (report.regions.length !== 11 || report.regions.some((region) => region.changedPixelRatio < .08)) throw new Error("one or more decoded PIP regions is not visible");
  if (report.presentedFrames < 60 || report.presentP95Ms > 1_000 / 30) throw new Error("twelve-layer native presentation missed the 30 fps budget");
  if (!report.resourcePlanMatches || report.resourcePlan.requiredBytes > report.resourcePlan.budgetBytes || report.resourcePlan.maxVideoLayers < layerCount) throw new Error("resource plan receipt does not match the independent oracle");
  if (!report.decodeScheduleMatches) throw new Error("native adaptive decode schedule does not match the independent oracle");
  if (!report.fusedCompositeMatches) throw new Error("twelve layers did not use the declared four-layer fused compositor path");
  if (!report.verificationCompositeMatches) throw new Error("decoded artifact verification did not execute the same fused compositor path");
  const telemetry = report.adaptiveTelemetry;
  if (!telemetry || telemetry.performanceFrameCount !== 64 || telemetry.layerSampleCount !== 64 * layerCount || telemetry.cadenceMismatchCount !== 0 || telemetry.presentationTargetMismatchCount !== 0 || telemetry.batchSubmissionMismatchCount !== 0) throw new Error("adaptive decode telemetry is incomplete or inconsistent");
  if (telemetry.decodedLayerSamples <= 0 || telemetry.reusedLayerSamples <= 0 || telemetry.fullRateReuseCount !== 0 || telemetry.maximumFrameAgeFrames !== 1 || JSON.stringify(telemetry.performanceDecodeCounts) !== JSON.stringify([6, 7])) throw new Error("adaptive decode did not preserve the base layer while staggering small PIP sources");
  const cache = report.sourceCacheTelemetry;
  if (!cache || cache.decoderInstanceCount !== 2 || cache.cacheHitScheduledSamples <= 0 || cache.cacheMissScheduledSamples <= 0 || cache.contractMismatchCount !== 0 || JSON.stringify(cache.performanceCopyCounts) !== JSON.stringify([1, 2])) throw new Error("shared physical-source decoder cache is incomplete or dishonest");
  if (report.rejectedNegativeControls.length !== 5) throw new Error("resource-adaptive negative controls are incomplete");
  if (!report.releaseFences || report.releaseFences.pendingFenceCount !== 0 || report.releaseFences.retiredSubmissionSequences.length < layerCount) throw new Error("release left pending GPU fences");
  if (!/^[0-9a-f]{64}$/.test(report.artifactSha256) || !/^[0-9a-f]{64}$/.test(report.executableSha256)) throw new Error("artifact identity is incomplete");
}

function syntheticSelfTest() {
  const plan = expectedResourcePlan(layerCount, cacheBudgetMb);
  const frame = { decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0, gpuCopySubmissionMode: "source-cache-hit/v1", gpuCopySubmissionLayerCount: 0, decodeDispatchMode: "parallel-com-apartment/v1" };
  const valid = {
    schema: "editkin.common-engine-video-resource-gate/v1", status: "GREEN", directExecution: true,
    layerCount, layerFrames: Array.from({ length: layerCount }, () => frame),
    requiredNodeIds: Array.from({ length: 59 }, (_, index) => `node-${index}`), executedNodeIds: Array.from({ length: 59 }, (_, index) => `node-${index}`),
    sourceClockMappings: Array.from({ length: layerCount }, () => ({ matches: true })), layerContracts: Array.from({ length: layerCount }, () => ({ matches: true })),
    verificationReadbackIsolated: true, visualLayersApplied: true, artifactChanged: true, changedPixelRatio: .5,
    regions: Array.from({ length: 11 }, () => ({ changedPixelRatio: .5 })), presentedFrames: 60, presentP95Ms: 25,
    resourcePlan: plan, resourcePlanMatches: true, rejectedNegativeControls: ["under-budget", "budget-floor", "right-nested", "unpaired-matte", "disabled-composite"],
    decodeSchedule: expectedDecodeSchedule(), decodeScheduleMatches: true,
    fusedComposite: { compositeExecutionMode: "fused-four-layer/v1", compositeLayerCount: 12, compositeDirtyRectLayerCount: 0, compositeTextureCopyCount: 0, compositeFullFramePassCount: 3, compositeMaximumLayersPerPass: 4 }, fusedCompositeMatches: true,
    verificationCompositeMatches: true,
    adaptiveTelemetry: { performanceFrameCount: 64, layerSampleCount: 768, decodedLayerSamples: 416, reusedLayerSamples: 352, fullRateReuseCount: 0, maximumFrameAgeFrames: 1, cadenceMismatchCount: 0, presentationTargetMismatchCount: 0, batchSubmissionMismatchCount: 0, performanceDecodeCounts: [6, 7] },
    sourceCacheTelemetry: { decoderInstanceCount: 2, cacheHitScheduledSamples: 300, cacheMissScheduledSamples: 116, contractMismatchCount: 0, performanceCopyCounts: [1, 2] },
    releaseFences: { pendingFenceCount: 0, retiredSubmissionSequences: Array.from({ length: layerCount }, (_, index) => index + 1) },
    artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64),
  };
  assertGreen(valid);
  const negatives = [
    { ...valid, layerCount: 11 },
    { ...valid, executedNodeIds: valid.executedNodeIds.slice(1) },
    { ...valid, sourceClockMappings: valid.sourceClockMappings.map((item, index) => index === 9 ? { matches: false } : item) },
    { ...valid, layerContracts: valid.layerContracts.map((item, index) => index === 5 ? { matches: false } : item) },
    { ...valid, layerFrames: valid.layerFrames.map((item, index) => index === 4 ? { ...item, nativeSurfaceCpuPixelReadbacks: 1 } : item) },
    { ...valid, layerFrames: valid.layerFrames.map((item, index) => index === 4 ? { ...item, gpuCopySubmissionMode: "single-copy/v1" } : item) },
    { ...valid, layerFrames: valid.layerFrames.map((item, index) => index === 4 ? { ...item, decodeDispatchMode: "serial-main-thread/v1" } : item) },
    { ...valid, regions: valid.regions.map((item, index) => index === 7 ? { changedPixelRatio: .01 } : item) },
    { ...valid, presentP95Ms: 34 },
    { ...valid, resourcePlanMatches: false },
    { ...valid, resourcePlan: { ...plan, requiredBytes: plan.budgetBytes + 1 } },
    { ...valid, decodeScheduleMatches: false },
    { ...valid, fusedCompositeMatches: false },
    { ...valid, verificationCompositeMatches: false },
    { ...valid, adaptiveTelemetry: { ...valid.adaptiveTelemetry, reusedLayerSamples: 0 } },
    { ...valid, sourceCacheTelemetry: { ...valid.sourceCacheTelemetry, decoderInstanceCount: 12 } },
    { ...valid, rejectedNegativeControls: valid.rejectedNegativeControls.slice(1) },
  ];
  for (const negative of negatives) {
    let rejected = false;
    try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("resource evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length }));
}

function branch(index) {
  const id = `layer-${index}`;
  const isBase = index === 0;
  const center = isBase ? { x: width / 2, y: height / 2 } : gridCenters[index - 1];
  const nodes = [
    { id: `source:${id}`, inputs: [], enabled: true, kind: "source", assetId: id, mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: index, durationFrames: 180 } },
    { id: `transform:${id}`, inputs: [`source:${id}`], enabled: true, kind: "transform2d", x: center.x - width / 2, y: center.y - height / 2, scaleX: isBase ? 1 : .22, scaleY: isBase ? 1 : .22, rotationRadians: isBase ? 0 : ((index % 3) - 1) * .025, opacity: 1 },
    { id: `color:${id}`, inputs: [`transform:${id}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = `color:${id}`;
  if (!isBase) {
    nodes.push({ id: `effect:${id}`, inputs: [tail], enabled: true, kind: "effect", pluginId: index % 2 ? "editkin.builtin.mono_halftone" : "editkin.builtin.xerox_pulse", abiVersion: 1, temporalRadius: 0, parameters: {} });
    tail = `effect:${id}`;
  }
  return { id, nodes, tail, sourceStartFrame: index };
}

function graph(selectedLayerCount = layerCount, selectedBudgetMb = cacheBudgetMb) {
  const branches = Array.from({ length: selectedLayerCount }, (_, index) => branch(index));
  const nodes = branches.flatMap((item) => item.nodes);
  let tail = branches[0].tail;
  for (let index = 1; index < branches.length; index += 1) {
    const id = `composite:${index}`;
    nodes.push({ id, inputs: [tail, branches[index].tail], enabled: true, kind: "composite", blendMode: blendModes[index], opacity: compositeOpacities[index] });
    tail = id;
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId: `video-resource-${selectedLayerCount}-${selectedBudgetMb}`, width, height, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: selectedBudgetMb, nodes, outputNode: "output" };
}

function inspectArtifact(baseBytes, artifactBytes) {
  const base = PNG.sync.read(baseBytes); const artifact = PNG.sync.read(artifactBytes);
  if (base.width !== width || base.height !== height || artifact.width !== width || artifact.height !== height) throw new Error("resource artifact dimensions are invalid");
  let changed = 0;
  const regions = gridCenters.map((center, index) => ({ id: `layer-${index + 1}`, x0: center.x - 80, x1: center.x + 80, y0: center.y - 45, y1: center.y + 45, pixels: 0, changed: 0 }));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const delta = Math.max(Math.abs(base.data[offset] - artifact.data[offset]), Math.abs(base.data[offset + 1] - artifact.data[offset + 1]), Math.abs(base.data[offset + 2] - artifact.data[offset + 2]));
    if (delta > 2) changed += 1;
    const region = regions.find((candidate) => x >= candidate.x0 && x < candidate.x1 && y >= candidate.y0 && y < candidate.y1);
    if (region) { region.pixels += 1; if (delta > 2) region.changed += 1; }
  }
  return { changedPixelRatio: changed / (width * height), regions: regions.map((region) => ({ id: region.id, changedPixelRatio: region.changed / region.pixels })) };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-resource-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `resource-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 90_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const candidateGraph = graph(); const candidatePath = join(temporary, "candidate.json"); const basePath = join(temporary, "base.json"); const bindingsPath = join(temporary, "bindings.json");
    await writeFile(candidatePath, JSON.stringify(candidateGraph)); await writeFile(basePath, JSON.stringify(graph(1, 64))); await writeFile(bindingsPath, JSON.stringify(Object.fromEntries(Array.from({ length: layerCount }, (_, index) => [`layer-${index}`, fixture]))));
    if (baseline) {
      const observed = await request("engine_video_load", { sessionId: "resource-baseline", graphPath: candidatePath, bindingsPath, timelineFrame: 0 });
      if (observed.ok || !String(observed.error).includes("layer count must be 1..=6")) throw new Error(`baseline did not expose fixed six-layer limit: ${JSON.stringify(observed)}`);
      await request("shutdown");
      return { status: "BLOCK", reason: "native common-video graph uses a fixed six-layer ceiling", observedError: observed.error, requiredLayerCount: layerCount };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const baseLoaded = await request("engine_video_load", { sessionId: "resource-base", graphPath: basePath, bindingsPath, timelineFrame: 0 });
    const basePng = join(temporary, "base.png"); const baseVerified = await request("engine_video_verify_frame", { sessionId: "resource-base", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: basePng }); await request("engine_video_release", { sessionId: "resource-base" });
    const loaded = await request("engine_video_load", { sessionId: "resource-candidate", graphPath: candidatePath, bindingsPath, timelineFrame: 0 });
    if (!bound.ok || !baseLoaded.ok || !baseVerified.ok || !loaded.ok) throw new Error(`resource load failed: ${JSON.stringify({ bound, baseLoaded, baseVerified, loaded })}`);
    const artifactPng = join(temporary, "twelve-layer.png"); const verified = await request("engine_video_verify_frame", { sessionId: "resource-candidate", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: artifactPng });
    if (!verified.ok) throw new Error(`resource verification failed: ${JSON.stringify(verified)}`);
    const baseBytes = await readFile(basePng); const artifactBytes = await readFile(artifactPng); const artifactInspection = inspectArtifact(baseBytes, artifactBytes);
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "base.png"), baseBytes); await writeFile(join(evidenceRoot, "twelve-layer.png"), artifactBytes);
    const clockSample = await request("engine_video_present_frame", { sessionId: "resource-candidate", timelineFrame: 30, toleranceSeconds: 1 / 30 });
    if (!clockSample.ok) throw new Error(`resource clock sample failed: ${JSON.stringify(clockSample)}`);
    const layerReceipts = loaded.result.layers ?? []; const presentLayers = clockSample.result.layers ?? [];
    const decoderInstanceIds = new Set(layerReceipts.map((layer) => layer.decoder?.decoderInstanceId));
    const adaptiveDecoderId = layerReceipts[1]?.decoder?.decoderInstanceId;
    const sourceCacheTelemetry = {
      decoderInstanceCount: decoderInstanceIds.size,
      cacheHitScheduledSamples: 0,
      cacheMissScheduledSamples: 0,
      contractMismatchCount: layerReceipts.filter((layer, index) => layer.decoder?.sourceCacheSchema !== "editkin.shared-source-frame-cache/v1" || !Number.isInteger(layer.decoder?.decoderInstanceId) || layer.sharedDecoderLayerCount !== (index === 0 ? 1 : layerCount - 1) || layer.decoder?.residentFrameRingSize !== (index === 0 ? 3 : (layerCount - 1) * 3) || (index === 0 ? layer.decoder?.decoderInstanceId === adaptiveDecoderId : layer.decoder?.decoderInstanceId !== adaptiveDecoderId)).length,
      performanceCopyCounts: [],
    };
    const sourceCacheCopyCounts = new Set();
    const sourceClockMappings = presentLayers.map((layer, index) => { const expectedSeconds = (30 + index) / 30; const actualSeconds = layer.frame?.clockTargetSeconds; return { sourceNodeId: layer.sourceNodeId, expectedSeconds, actualSeconds, matches: Number.isFinite(actualSeconds) && Math.abs(actualSeconds - expectedSeconds) <= 1e-6 && layer.frame?.clockWithinTolerance === true }; });
    const layerContracts = layerReceipts.map((layer, index) => ({ sourceNodeId: layer.sourceNodeId, expectedBlendMode: blendCodes[index], actualBlendMode: layer.visualGraph?.blendMode, expectedCompositeOpacity: compositeOpacities[index], actualCompositeOpacity: layer.visualGraph?.compositeOpacity, matches: layer.visualGraph?.blendMode === blendCodes[index] && Math.abs((layer.visualGraph?.compositeOpacity ?? Infinity) - compositeOpacities[index]) < 1e-5 }));
    const times = []; const adaptiveStageTimes = []; const compositePresentTimes = []; const timingSamples = []; let last = clockSample;
    const adaptiveTelemetry = { performanceFrameCount: 0, layerSampleCount: 0, decodedLayerSamples: 0, reusedLayerSamples: 0, fullRateReuseCount: 0, maximumFrameAgeFrames: 0, cadenceMismatchCount: 0, presentationTargetMismatchCount: 0, batchSubmissionMismatchCount: 0, performanceDecodeCounts: [] };
    const decodeCounts = new Set();
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      last = await request("engine_video_present_frame", { sessionId: "resource-candidate", timelineFrame: 31 + index, toleranceSeconds: 1 / 30 });
      if (!last.ok) throw new Error(`resource present failed: ${JSON.stringify(last)}`);
      const elapsed = performance.now() - started;
      if (index >= 4) times.push(elapsed);
      if (index >= 4) { adaptiveStageTimes.push(last.result.adaptiveDecodeStageMilliseconds); compositePresentTimes.push(last.result.compositePresentMilliseconds); }
      const layerFrames = last.result.layerFrames ?? []; const presentedLayers = last.result.layers ?? [];
      if (layerFrames.length !== layerCount || presentedLayers.length !== layerCount) throw new Error("adaptive present omitted one or more active layers");
      const decodedCount = layerFrames.filter((frame) => frame.adaptiveFrameReused === false).length;
      const scheduledFrames = layerFrames.filter((frame) => !frame.adaptiveFrameReused);
      const copyCount = Math.max(...scheduledFrames.map((frame) => frame.gpuCopySubmissionLayerCount ?? 0));
      const cacheHitCount = scheduledFrames.filter((frame) => frame.decoderSourceCacheHit === true).length;
      const cacheMissCount = scheduledFrames.length - cacheHitCount;
      if (index >= 4) { timingSamples.push({ timelineFrame: 31 + index, elapsedMs: elapsed, stageMs: last.result.adaptiveDecodeStageMilliseconds, copyCount, cacheHitCount }); sourceCacheCopyCounts.add(copyCount); sourceCacheTelemetry.cacheHitScheduledSamples += cacheHitCount; sourceCacheTelemetry.cacheMissScheduledSamples += cacheMissCount; }
      decodeCounts.add(decodedCount); adaptiveTelemetry.performanceFrameCount += 1; adaptiveTelemetry.layerSampleCount += layerFrames.length;
      layerFrames.forEach((frame, layerIndex) => {
        const cadence = expectedCadence(layerIndex); const age = frame.adaptiveFrameAgeFrames;
        if (frame.adaptiveFrameReused) adaptiveTelemetry.reusedLayerSamples += 1; else adaptiveTelemetry.decodedLayerSamples += 1;
        if (layerIndex === 0 && frame.adaptiveFrameReused) adaptiveTelemetry.fullRateReuseCount += 1;
        adaptiveTelemetry.maximumFrameAgeFrames = Math.max(adaptiveTelemetry.maximumFrameAgeFrames, Number(age ?? Infinity));
        if (frame.decodeCadenceDivisor !== cadence.divisor || frame.decodeCadencePhase !== cadence.phase || !Number.isInteger(age) || age < 0 || age > cadence.divisor - 1 || frame.adaptiveFrameReused !== (age > 0)) adaptiveTelemetry.cadenceMismatchCount += 1;
        if (Math.abs((frame.presentationTargetSeconds ?? Infinity) - presentedLayers[layerIndex].sourceTimeSeconds) > 1e-6) adaptiveTelemetry.presentationTargetMismatchCount += 1;
        const copyContractMatches = frame.adaptiveFrameReused || (frame.decoderSourceCacheHit === true
          ? frame.gpuCopySubmissionMode === "source-cache-hit/v1" && frame.gpuCopySubmissionLayerCount === 0
          : frame.decoderSourceCacheHit === false && frame.gpuCopySubmissionMode === "batched-copy/v1" && frame.gpuCopySubmissionLayerCount === copyCount);
        if (frame.decodeDispatchMode !== "parallel-com-apartment/v1" || !copyContractMatches) adaptiveTelemetry.batchSubmissionMismatchCount += 1;
      });
      if (index >= 4 && cacheMissCount !== copyCount) sourceCacheTelemetry.contractMismatchCount += 1;
    }
    adaptiveTelemetry.performanceDecodeCounts = [...decodeCounts].sort((a, b) => a - b);
    sourceCacheTelemetry.performanceCopyCounts = [...sourceCacheCopyCounts].sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, candidate, marker) => { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    const oracle = expectedResourcePlan(layerCount, cacheBudgetMb); const underBudgetMb = Math.ceil(oracle.requiredBytes / (1024 * 1024)) - 1;
    await negative("under-budget", graph(layerCount, underBudgetMb), "resource budget");
    await negative("budget-floor", graph(layerCount, 63), "cache budget must be 64");
    const rightNested = structuredClone(candidateGraph); rightNested.nodes.splice(-1, 0, { id: "right-negative", inputs: ["effect:layer-9", "effect:layer-10"], enabled: true, kind: "composite", blendMode: "screen", opacity: .5 }); rightNested.nodes.find((node) => node.id === "composite:9").inputs[1] = "right-negative";
    await negative("right-nested", rightNested, "right-nested");
    const matte = structuredClone(candidateGraph); Object.assign(matte.nodes.find((node) => node.id === "composite:8"), { matteInput: "color:layer-0" });
    await negative("unpaired-matte", matte, "invalid composite");
    const disabled = structuredClone(candidateGraph); disabled.nodes.find((node) => node.id === "composite:4").enabled = false;
    await negative("disabled-composite", disabled, "cannot be disabled");
    const released = await request("engine_video_release", { sessionId: "resource-candidate" }); await request("surface_release"); await request("shutdown");
    const productPlan = loaded.result.resourcePlan; const resourcePlanMatches = productPlan?.schema === "editkin.resident-video-resource-plan/v1" && ["bytesPerVideoLayer", "compositorWorkingBytes", "overlayBytes", "requiredBytes", "budgetBytes", "maxVideoLayers"].every((key) => productPlan[key] === oracle[key]);
    const decodeSchedule = loaded.result.decodeSchedule; const scheduleOracle = expectedDecodeSchedule();
    const decodeScheduleMatches = Object.entries(scheduleOracle).every(([key, value]) => decodeSchedule?.[key] === value)
      && layerReceipts.every((layer, index) => { const cadence = expectedCadence(index); return layer.decodeCadenceDivisor === cadence.divisor && layer.decodeCadencePhase === cadence.phase && layer.decoder?.decodeDispatchMode === "parallel-com-apartment/v1"; });
    const fusedComposite = last.result.surface;
    const fusedCompositeMatches = fusedComposite?.compositeExecutionMode === "fused-four-layer/v1" && fusedComposite.compositeLayerCount === layerCount && fusedComposite.compositeDirtyRectLayerCount === 0 && fusedComposite.compositeTextureCopyCount === 0 && fusedComposite.compositeFullFramePassCount === Math.ceil(layerCount / 4) && fusedComposite.compositeMaximumLayersPerPass === 4;
    const verificationCompositeMatches = verified.result.compositeExecutionMode === "fused-four-layer/v1" && verified.result.compositeLayerCount === layerCount && verified.result.compositeFullFramePassCount === Math.ceil(layerCount / 4) && verified.result.compositeMaximumLayersPerPass === 4;
    return {
      status: "GREEN", directExecution: loaded.result.engineGraph?.directExecution === true, layerCount: loaded.result.layerCount,
      requiredNodeIds: candidateGraph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph?.executedNodeIds ?? [],
      layerFrames: last.result.layerFrames ?? [], sourceClockMappings, layerContracts,
      verificationReadbackIsolated: verified.result.verificationReadback === true && verified.result.productPathCpuPixelCopies === 0,
      visualLayersApplied: last.result.visualLayersApplied === true, artifactChanged: !baseBytes.equals(artifactBytes), artifactSha256: sha256(artifactBytes), ...artifactInspection,
      presentedFrames: times.length, presentP50Ms: percentile(times, .5), presentP95Ms: percentile(times, .95),
      nativeTimingBreakdown: { adaptiveStageP50Ms: percentile(adaptiveStageTimes, .5), adaptiveStageP95Ms: percentile(adaptiveStageTimes, .95), compositePresentP50Ms: percentile(compositePresentTimes, .5), compositePresentP95Ms: percentile(compositePresentTimes, .95) },
      timingSamples,
      resourcePlan: productPlan, resourcePlanOracle: oracle, resourcePlanMatches, decodeSchedule, decodeScheduleOracle: scheduleOracle, decodeScheduleMatches, adaptiveTelemetry, sourceCacheTelemetry, fusedComposite, fusedCompositeMatches, verificationCompositeMatches, rejectedNegativeControls, releaseFences: released.result.fences, bound: bound.result,
    };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  let observed;
  try { observed = await run(); }
  catch (error) { observed = { status: "BLOCK", reason: String(error?.stack ?? error) }; }
  let report = { schema: "editkin.common-engine-video-resource-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  let gateFailure;
  if (!baseline) {
    try { assertGreen(report); }
    catch (error) { gateFailure = error; report = { ...report, status: "BLOCK", measuredStatus: observed.status, gateFailure: String(error?.stack ?? error) }; }
  }
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (gateFailure) throw gateFailure;
  console.log(JSON.stringify(report, null, 2));
}

await main();
