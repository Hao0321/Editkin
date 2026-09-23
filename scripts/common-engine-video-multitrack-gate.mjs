import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-multitrack");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const layerIds = ["base", "pip-1", "pip-2", "pip-3", "pip-4", "pip-5"];
const pipCenters = [110, 295, 480, 665, 850];
const overlayProxyWidth = 384;
const overlayProxyHeight = 216;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-multitrack-gate/v2" || report.status !== "GREEN") throw new Error("multitrack report is not GREEN");
  if (!report.directExecution || report.requiredNodeIds.length !== 29 || report.executedNodeIds.length !== 29 || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("six-layer graph coverage failed");
  if (report.layerCount !== 6 || report.layerFrames.length !== 6 || report.sourceClockMappings.length !== 6 || report.sourceClockMappings.some((item) => !item.matches)) throw new Error("six-layer execution or clock receipt is incomplete");
  if (report.physicalSourceCount !== 6 || report.decoderInstanceCount !== 6) throw new Error("six independent physical sources and decoder instances were not proved");
  if (!report.proxyDecodeApplied || report.decoderDimensions.length !== 6 || report.decoderDimensions[0].width !== 960 || report.decoderDimensions[0].height !== 540 || report.decoderDimensions.slice(1).some((item) => item.width !== overlayProxyWidth || item.height !== overlayProxyHeight)) throw new Error("six-layer product preview did not use the bounded performance-overlay proxy contract");
  if (!report.artifactChanged || report.changedPixelRatio < .05 || report.pipRegions.length !== 5 || report.pipRegions.some((region) => region.changedPixelRatio < .15 || region.monochromeRatio < .95) || report.outsideChromaticPixels < 100) throw new Error("six visually distinct video layers were not proved");
  if (!report.verificationReadbackIsolated || !report.visualLayersApplied) throw new Error("multitrack verification receipt is incomplete");
  if (report.layerFrames.some((frame) => frame.decodePathCpuPixelCopies !== 0 || frame.stagingCpuPixelReadbacks !== 0 || frame.nativeSurfaceCpuPixelReadbacks !== 0)) throw new Error("multitrack product path performed a CPU pixel transfer");
  if (report.layerFrames.some((frame) => Math.abs(frame.clockDriftMilliseconds ?? Infinity) > (1_000 / 30) + .001)) throw new Error("multitrack decode clocks drifted by more than one frame");
  if (report.decodeSchedule?.fullRateLayerCount !== 1 || report.decodeSchedule?.adaptiveLayerCount !== 5 || report.decodeSchedule?.maximumDecodeCadenceDivisor !== 2 || report.decodeSchedule?.maximumReuseAgeFrames !== 1) throw new Error("six-layer preview did not apply the bounded small-overlay cadence schedule");
  if (report.fullRateLayerIds.length !== 1 || report.adaptiveLayerIds.length !== 5 || !report.scheduleSamplesValid || report.fullRateReusedSamples !== 0 || report.adaptiveDecodedSamples < 140 || report.adaptiveSourceCacheHitSamples < 140 || report.adaptiveReusedSamples !== 0 || report.maximumObservedReuseAgeFrames !== 0) throw new Error("bounded six-layer adaptive decode and timestamp cache cadence were not proved across the presentation run");
  if (report.decodedLayerCounts.join(",") !== "3,4") throw new Error("per-frame hardware decode fan-out was not bounded to three or four layers");
  if (report.presentedFrames < 60 || report.presentP95Ms > (1_000 / 30)) throw new Error("six-layer resident presentation missed the 30 fps frame budget");
  if (report.rejectedNegativeControls.length !== 4) throw new Error("multitrack negative controls are incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.baseArtifactSha256) || !/^[0-9a-f]{64}$/.test(report.multitrackArtifactSha256)) throw new Error("multitrack artifact identity is missing");
  if (!report.releaseFences || report.releaseFences.pendingFenceCount !== 0 || report.releaseFences.retiredSubmissionSequences.length < 6) throw new Error("multitrack release left pending GPU fences");
}

function syntheticSelfTest() {
  const frame = { decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0, clockDriftMilliseconds: 0 };
  const valid = {
    schema: "editkin.common-engine-video-multitrack-gate/v2", status: "GREEN", directExecution: true,
    requiredNodeIds: Array.from({ length: 29 }, (_, index) => `node-${index}`), executedNodeIds: Array.from({ length: 29 }, (_, index) => `node-${index}`),
    layerCount: 6, physicalSourceCount: 6, decoderInstanceCount: 6, layerFrames: Array.from({ length: 6 }, () => frame), sourceClockMappings: Array.from({ length: 6 }, () => ({ matches: true })),
    proxyDecodeApplied: true, decoderDimensions: [{ width: 960, height: 540 }, ...Array.from({ length: 5 }, () => ({ width: overlayProxyWidth, height: overlayProxyHeight }))],
    artifactChanged: true, changedPixelRatio: .2, pipRegions: Array.from({ length: 5 }, () => ({ changedPixelRatio: .6, monochromeRatio: .99 })), outsideChromaticPixels: 1_000,
    verificationReadbackIsolated: true, visualLayersApplied: true, presentedFrames: 60, presentP95Ms: 20,
    decodeSchedule: { fullRateLayerCount: 1, adaptiveLayerCount: 5, maximumDecodeCadenceDivisor: 2, maximumReuseAgeFrames: 1 },
    fullRateLayerIds: ["source:base"], adaptiveLayerIds: ["source:pip-1", "source:pip-2", "source:pip-3", "source:pip-4", "source:pip-5"],
    scheduleSamplesValid: true, fullRateReusedSamples: 0, adaptiveDecodedSamples: 150, adaptiveSourceCacheHitSamples: 150, adaptiveReusedSamples: 0, maximumObservedReuseAgeFrames: 0,
    decodedLayerCounts: [3, 4],
    rejectedNegativeControls: ["right-nested", "unpaired-matte", "disabled-composite", "under-budget"], releaseFences: { pendingFenceCount: 0, retiredSubmissionSequences: [1, 2, 3, 4, 5, 6] },
    baseArtifactSha256: "a".repeat(64), multitrackArtifactSha256: "b".repeat(64),
  };
  assertGreen(valid);
  for (const negative of [
    { ...valid, executedNodeIds: valid.executedNodeIds.slice(1) },
    { ...valid, layerFrames: valid.layerFrames.slice(1) },
    { ...valid, decoderInstanceCount: 5 },
    { ...valid, sourceClockMappings: valid.sourceClockMappings.map((item, index) => index === 3 ? { matches: false } : item) },
    { ...valid, decoderDimensions: valid.decoderDimensions.map((item, index) => index === 4 ? { width: 960, height: 540 } : item) },
    { ...valid, pipRegions: valid.pipRegions.map((item, index) => index === 4 ? { ...item, monochromeRatio: .5 } : item) },
    { ...valid, layerFrames: valid.layerFrames.map((item, index) => index === 2 ? { ...item, stagingCpuPixelReadbacks: 1 } : item) },
    { ...valid, layerFrames: valid.layerFrames.map((item, index) => index === 2 ? { ...item, clockDriftMilliseconds: 40 } : { ...item, clockDriftMilliseconds: 0 }) },
    { ...valid, decodeSchedule: { ...valid.decodeSchedule, adaptiveLayerCount: 4 } },
    { ...valid, adaptiveSourceCacheHitSamples: 0 },
    { ...valid, decodedLayerCounts: [6] },
    { ...valid, scheduleSamplesValid: false },
    { ...valid, presentP95Ms: 34 },
  ]) {
    let rejected = false;
    try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("multitrack evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 13 }));
}

function runBinary(executablePath, args, timeoutMs = 60_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; const timer = setTimeout(() => { child.kill(); reject(new Error(`${executablePath} timed out`)); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error(`${executablePath} exit ${code}: ${stderr}`)); });
  });
}

function branch(id, sourceStartFrame, transform, effect = false) {
  const nodes = [
    { id: `source:${id}`, inputs: [], enabled: true, kind: "source", assetId: id, mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame, durationFrames: 180 } },
    { id: `transform:${id}`, inputs: [`source:${id}`], enabled: true, kind: "transform2d", x: transform.x, y: transform.y, scaleX: transform.scale, scaleY: transform.scale, rotationRadians: 0, opacity: 1 },
    { id: `color:${id}`, inputs: [`transform:${id}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = `color:${id}`;
  if (effect) {
    nodes.push({ id: `effect:${id}`, inputs: [tail], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} });
    tail = `effect:${id}`;
  }
  return { nodes, tail };
}

function multitrackGraph(extraLayer = false) {
  const branches = [branch("base", 0, { x: 0, y: 0, scale: 1 })];
  for (let index = 0; index < 5; index += 1) branches.push(branch(`pip-${index + 1}`, 15 * (index + 1), { x: pipCenters[index] - 480, y: -190, scale: .18 }, true));
  if (extraLayer) branches.push(branch("pip-6", 90, { x: 0, y: 180, scale: .18 }, true));
  const nodes = branches.flatMap((item) => item.nodes);
  let tail = branches[0].tail;
  for (let index = 1; index < branches.length; index += 1) {
    const id = `composite:${index}`;
    nodes.push({ id, inputs: [tail, branches[index].tail], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
    tail = id;
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId: extraLayer ? "video-under-budget-negative" : "video-six-layer", width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: extraLayer ? 64 : 192, nodes, outputNode: "output" };
}

function baseGraph() {
  const base = branch("base", 0, { x: 0, y: 0, scale: 1 });
  return { schema: "editkin.engine-graph/v1", graphId: "video-six-layer-base", width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes: [...base.nodes, { id: "output", inputs: [base.tail], enabled: true, kind: "output", format: "rgba16_float" }], outputNode: "output" };
}

function inspectArtifacts(baseBytes, multitrackBytes) {
  const base = PNG.sync.read(baseBytes); const multitrack = PNG.sync.read(multitrackBytes);
  if (base.width !== multitrack.width || base.height !== multitrack.height) throw new Error("artifact dimensions differ");
  let changed = 0; let outsideChromaticPixels = 0;
  const regions = pipCenters.map((center) => ({ x0: center - 60, x1: center + 60, y0: 50, y1: 110, pixels: 0, changed: 0, monochrome: 0 }));
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const offset = (y * base.width + x) * 4;
      const delta = Math.max(...[0, 1, 2].map((channel) => Math.abs(base.data[offset + channel] - multitrack.data[offset + channel])));
      if (delta > 2) changed += 1;
      const r = multitrack.data[offset]; const g = multitrack.data[offset + 1]; const b = multitrack.data[offset + 2];
      const region = regions.find((candidate) => x >= candidate.x0 && x < candidate.x1 && y >= candidate.y0 && y < candidate.y1);
      if (region) {
        region.pixels += 1;
        if (delta > 2) region.changed += 1;
        if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) <= 1) region.monochrome += 1;
      } else if (y >= 260 && x < 420 && Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) >= 8) outsideChromaticPixels += 1;
    }
  }
  return {
    changedPixelRatio: changed / (base.width * base.height), outsideChromaticPixels,
    pipRegions: regions.map((region, index) => ({ id: `pip-${index + 1}`, changedPixelRatio: region.changed / region.pixels, monochromeRatio: region.monochrome / region.pixels })),
  };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-multitrack-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `multitrack-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const graph = multitrackGraph(); const graphPath = join(temporary, "multitrack.json"); const basePath = join(temporary, "base.json"); const bindingsPath = join(temporary, "bindings.json");
    const fixture = resolve(root, "public/demo-source.mp4"); const proxyTemplate = join(temporary, `proxy-template-${overlayProxyWidth}x${overlayProxyHeight}.mp4`);
    await runBinary(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", fixture, "-map", "0:v:0", "-an", "-vf", `fps=15,scale=${overlayProxyWidth}:${overlayProxyHeight}`, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode", "-profile:v", "baseline", "-crf", "28", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "0", "-movflags", "+faststart", proxyTemplate]);
    const overlayProxyPaths = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const path = join(temporary, `proxy-pip-${index + 1}-${overlayProxyWidth}x${overlayProxyHeight}.mp4`);
      await copyFile(proxyTemplate, path);
      return path;
    }));
    const productBindings = Object.fromEntries(layerIds.map((id, index) => [id, index === 0 ? fixture : overlayProxyPaths[index - 1]]));
    await writeFile(graphPath, JSON.stringify(graph)); await writeFile(basePath, JSON.stringify(baseGraph())); await writeFile(bindingsPath, JSON.stringify(productBindings));
    if (baseline) {
      const observed = await request("engine_video_load", { sessionId: "multitrack-baseline", graphPath, bindingsPath, timelineFrame: 0 });
      const gap = String(observed.error);
      if (observed.ok || !gap.includes("nested common video composite")) throw new Error(`old release did not expose six-layer gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "resident native video compositor is bounded to a single two-branch composite", observedError: observed.error, requiredLayerCount: 6 };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const baseLoaded = await request("engine_video_load", { sessionId: "base-only", graphPath: basePath, bindingsPath, timelineFrame: 0 });
    const basePng = join(temporary, "base.png"); const baseVerified = await request("engine_video_verify_frame", { sessionId: "base-only", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: basePng }); await request("engine_video_release", { sessionId: "base-only" });
    const loaded = await request("engine_video_load", { sessionId: "multitrack", graphPath, bindingsPath, timelineFrame: 0 });
    const multitrackPng = join(temporary, "multitrack.png"); const verified = await request("engine_video_verify_frame", { sessionId: "multitrack", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: multitrackPng });
    if (!bound.ok || !baseLoaded.ok || !baseVerified.ok || !loaded.ok || !verified.ok) throw new Error(`multitrack verification failed: ${JSON.stringify({ bound, baseLoaded, baseVerified, loaded, verified })}`);
    const baseBytes = await readFile(basePng); const multitrackBytes = await readFile(multitrackPng); await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "base.png"), baseBytes); await writeFile(join(evidenceRoot, "multitrack.png"), multitrackBytes);
    const artifact = inspectArtifacts(baseBytes, multitrackBytes);
    const clockSample = await request("engine_video_present_frame", { sessionId: "multitrack", timelineFrame: 30, toleranceSeconds: 1 / 30 });
    const sourceClockMappings = (clockSample.result?.layers ?? []).map((layer, index) => {
      const expectedSeconds = (30 + index * 15) / 30;
      const ageFrames = layer.frame?.adaptiveFrameAgeFrames;
      const presentationSeconds = layer.frame?.presentationTargetSeconds;
      const decodedSeconds = layer.frame?.clockTargetSeconds;
      const decodedExpectedSeconds = expectedSeconds - ageFrames / 30;
      return { sourceNodeId: layer.sourceNodeId, expectedSeconds, presentationSeconds, decodedSeconds, decodedExpectedSeconds, ageFrames, driftMilliseconds: layer.frame?.clockDriftMilliseconds, clockWithinTolerance: layer.frame?.clockWithinTolerance, matches: Number.isInteger(ageFrames) && ageFrames >= 0 && ageFrames <= 1 && Number.isFinite(presentationSeconds) && Math.abs(presentationSeconds - expectedSeconds) <= 1e-6 && Number.isFinite(decodedSeconds) && Math.abs(decodedSeconds - decodedExpectedSeconds) <= 1e-6 && layer.frame?.clockWithinTolerance === true && Math.abs(layer.frame?.clockDriftMilliseconds ?? Infinity) <= (1_000 / 30) + .001 };
    });
    const times = []; const decodeStageTimes = []; const compositePresentTimes = []; const decodedLayerCounts = []; const scheduleSamples = []; let last;
    for (let index = 0; index < 64; index += 1) {
      const timelineFrame = 31 + index; const started = performance.now();
      last = await request("engine_video_present_frame", { sessionId: "multitrack", timelineFrame, toleranceSeconds: 1 / 30 });
      if (!last.ok) throw new Error(`multitrack present failed: ${JSON.stringify(last)}`);
      if (index >= 4) {
        times.push(performance.now() - started);
        decodeStageTimes.push(last.result.adaptiveDecodeStageMilliseconds);
        compositePresentTimes.push(last.result.compositePresentMilliseconds);
        decodedLayerCounts.push(last.result.layers.filter((layer) => !layer.frame.adaptiveFrameReused && layer.frame.decoderSourceCacheHit !== true).length);
        for (let layerIndex = 0; layerIndex < last.result.layers.length; layerIndex += 1) {
          const layer = last.result.layers[layerIndex]; const frame = layer.frame;
          const expectedSeconds = (timelineFrame + layerIndex * 15) / 30;
          const ageFrames = frame.adaptiveFrameAgeFrames;
          scheduleSamples.push({ timelineFrame, sourceNodeId: layer.sourceNodeId, divisor: frame.decodeCadenceDivisor, phase: frame.decodeCadencePhase, reused: frame.adaptiveFrameReused, ageFrames, decoderSourceCacheHit: frame.decoderSourceCacheHit === true, timestampSeconds: frame.timestampSeconds, clockTargetSeconds: frame.clockTargetSeconds, clockDriftMilliseconds: frame.clockDriftMilliseconds, clockWithinTolerance: frame.clockWithinTolerance, decodePrepareMilliseconds: frame.decodePrepareMilliseconds, valid: Number.isInteger(ageFrames) && ageFrames >= 0 && ageFrames <= frame.decodeCadenceDivisor - 1 && Math.abs(frame.presentationTargetSeconds - expectedSeconds) <= 1e-6 && Math.abs(frame.clockTargetSeconds - (expectedSeconds - ageFrames / 30)) <= 1e-6 });
        }
      }
    }
    times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, candidate, mutate, marker, candidateBindings = bindingsPath) => { mutate(candidate); const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath: candidateBindings, timelineFrame: 0 }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    await negative("right-nested", structuredClone(graph), (candidate) => {
      candidate.nodes.splice(-1, 0, { id: "right-negative", inputs: ["effect:pip-3", "effect:pip-4"], enabled: true, kind: "composite", blendMode: "screen", opacity: .5 });
      candidate.nodes.find((node) => node.id === "composite:3").inputs[1] = "right-negative";
    }, "right-nested");
    await negative("unpaired-matte", structuredClone(graph), (candidate) => { const node = candidate.nodes.find((item) => item.id === "composite:4"); node.matteInput = "color:base"; delete node.matteMode; }, "invalid composite");
    await negative("disabled-composite", structuredClone(graph), (candidate) => { candidate.nodes.find((node) => node.id === "composite:2").enabled = false; }, "cannot be disabled");
    const sevenGraph = multitrackGraph(true); const sevenBindingsPath = join(temporary, "bindings-seven.json"); await writeFile(sevenBindingsPath, JSON.stringify({ ...productBindings, "pip-6": proxyTemplate }));
    await negative("under-budget", sevenGraph, () => {}, "resource budget", sevenBindingsPath);
    const released = await request("engine_video_release", { sessionId: "multitrack" }); await request("surface_release"); await request("shutdown");
    const result = last.result; const layerFrames = result.layerFrames ?? [];
    const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * quantile)];
    const fullRateLayerIds = loaded.result.layers.filter((layer) => layer.decodeCadenceDivisor === 1).map((layer) => layer.sourceNodeId);
    const adaptiveLayerIds = loaded.result.layers.filter((layer) => layer.decodeCadenceDivisor > 1).map((layer) => layer.sourceNodeId);
    const fullRateSamples = scheduleSamples.filter((sample) => sample.divisor === 1); const adaptiveSamples = scheduleSamples.filter((sample) => sample.divisor > 1);
    const decoderPrepareByLayer = loaded.result.layers.map((layer) => { const values = scheduleSamples.filter((sample) => sample.sourceNodeId === layer.sourceNodeId && !sample.reused && !sample.decoderSourceCacheHit).map((sample) => sample.decodePrepareMilliseconds); return { sourceNodeId: layer.sourceNodeId, sampleCount: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: Math.max(...values) }; });
    const decoderDimensions = loaded.result.layers.map((layer) => ({ sourceNodeId: layer.sourceNodeId, width: layer.decoder.width, height: layer.decoder.height }));
    const decoderContracts = loaded.result.layers.map((layer) => ({ sourceNodeId: layer.sourceNodeId, ...layer.decoder }));
    return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, requiredNodeIds: graph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds, layerCount: loaded.result.layerCount, physicalSourceCount: new Set(Object.values(productBindings)).size, decoderInstanceCount: new Set(decoderContracts.map((decoder) => decoder.decoderInstanceId)).size, proxyDecodeApplied: decoderDimensions[0]?.width === 960 && decoderDimensions[0]?.height === 540 && decoderDimensions.slice(1).every((item) => item.width === overlayProxyWidth && item.height === overlayProxyHeight), decoderDimensions, decoderContracts, artifactChanged: !baseBytes.equals(multitrackBytes), baseArtifactSha256: sha256(baseBytes), multitrackArtifactSha256: sha256(multitrackBytes), ...artifact, verificationReadbackIsolated: verified.result.verificationReadback === true && verified.result.productPathCpuPixelCopies === 0, visualLayersApplied: result.visualLayersApplied === true, layerFrames, sourceClockMappings, decodeSchedule: loaded.result.decodeSchedule, fullRateLayerIds, adaptiveLayerIds, scheduleSamples, scheduleSamplesValid: scheduleSamples.every((sample) => sample.valid), fullRateReusedSamples: fullRateSamples.filter((sample) => sample.reused).length, adaptiveDecodedSamples: adaptiveSamples.filter((sample) => !sample.reused && !sample.decoderSourceCacheHit).length, adaptiveSourceCacheHitSamples: adaptiveSamples.filter((sample) => sample.decoderSourceCacheHit).length, adaptiveReusedSamples: adaptiveSamples.filter((sample) => sample.reused).length, maximumObservedReuseAgeFrames: Math.max(...scheduleSamples.map((sample) => sample.ageFrames)), presentedFrames: times.length, decodedLayerCounts: [...new Set(decodedLayerCounts)].sort(), decoderPrepareByLayer, decodeStageP50Ms: percentile(decodeStageTimes, .5), decodeStageP95Ms: percentile(decodeStageTimes, .95), compositePresentP50Ms: percentile(compositePresentTimes, .5), compositePresentP95Ms: percentile(compositePresentTimes, .95), presentP50Ms: percentile(times, .5), presentP95Ms: percentile(times, .95), rejectedNegativeControls, bound: bound.result, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); const report = { schema: "editkin.common-engine-video-multitrack-gate/v2", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  let evaluationError;
  if (!baseline) {
    try { assertGreen(report); } catch (error) { report.status = "BLOCK"; report.failure = error instanceof Error ? error.message : String(error); evaluationError = error; }
  }
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ schema: report.schema, status: report.status, executableSha256: report.executableSha256, presentP95Ms: report.presentP95Ms, decodedLayerCounts: report.decodedLayerCounts, failure: report.failure ?? null }));
  if (evaluationError) throw evaluationError;
}

await main();
