import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const executable = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-decoded-temporal-motion-blur");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const fixture = resolve(root, "public/demo-source.mp4");
const sampleFrame = 15;
const sampleCount = 8;
const shutterAngle = 360;
const transformBase = { x: -210, y: 0, scaleX: 0.62, scaleY: 0.62, rotationRadians: -0.08, opacity: 1 };
const keyframes = [{ frame: 30, x: 210, y: 0, scaleX: 0.62, scaleY: 0.62, rotationRadians: 0.08, opacity: 1, easing: "linear" }];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function graphFor({ sourceSampling = "decoded_temporal", blur = true, graphId = "decoded-temporal-motion-blur", layers = 1, temporalLayers = [0] } = {}) {
  const branches = [];
  const nodes = [];
  for (let index = 0; index < layers; index += 1) {
    const suffix = layers === 1 ? "" : `-${index}`;
    nodes.push(
      { id: `source${suffix}`, inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
      { id: `transform${suffix}`, inputs: [`source${suffix}`], enabled: true, kind: "transform2d", ...transformBase, keyframes },
      { id: `color${suffix}`, inputs: [`transform${suffix}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
    );
    let tail = `color${suffix}`;
    if (blur && temporalLayers.includes(index)) {
      nodes.push({ id: `motion-blur${suffix}`, inputs: [tail], enabled: true, kind: "motion_blur", shutterAngle, samples: sampleCount, sourceSampling });
      tail = `motion-blur${suffix}`;
    }
    branches.push(tail);
  }
  let tail = branches[0];
  if (branches.length > 1) {
    nodes.push({ id: "composite", inputs: branches, enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
    tail = "composite";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 160, nodes, outputNode: "output" };
}
function expectedSampleFrames() {
  return Array.from({ length: sampleCount }, (_, index) => sampleFrame + shutterAngle / 360 * ((index + .5) / sampleCount - .5));
}
function expectedTargetSeconds() { return expectedSampleFrames().map((frame) => frame / 30); }
function close(left, right, epsilon = .0001) { return Number.isFinite(left) && Math.abs(left - right) <= epsilon; }
function changedStats(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) throw new Error("temporal motion-blur artifacts differ in dimensions");
  let changedPixels = 0; let absolute = 0; let highDeltaPixels = 0; const pixels = left.width * left.height;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4; let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(left.data[offset + channel] - right.data[offset + channel]);
    if (delta > 8) changedPixels += 1;
    if (delta > 32) highDeltaPixels += 1;
    absolute += delta;
  }
  return { changedPixels, changedPixelRatio: changedPixels / pixels, meanAbsoluteChannelDelta: absolute / (pixels * 4), highDeltaPixels };
}
function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-decoded-temporal-motion-blur-gate/v1" || report.status !== "GREEN") throw new Error("decoded temporal motion-blur report is not GREEN");
  if (!report.directExecution || report.motionBlur?.contract !== "decoded-temporal-shutter-accumulation/v1" || report.motionBlur?.sourceSampling !== "decoded_temporal") throw new Error("decoded temporal contract was not executed");
  if (report.motionBlur.sampleCount !== sampleCount || report.motionBlur.distinctDecodedTimestampCount < 2 || report.motionBlur.sampleReceipts.length !== sampleCount) throw new Error("decoded temporal samples did not retain at least two real decoded source timestamps");
  if (!report.motionBlur.targetsMatchOracle || report.motionBlur.residentFrameRingSize < sampleCount || report.motionBlur.residentBytes <= 0) throw new Error("decoded temporal shutter oracle or resident resource receipt is incomplete");
  if (!report.repeatExact || report.temporalVsSpatialDelta.changedPixelRatio < .0005 || report.temporalVsSpatialDelta.highDeltaPixels < 100) throw new Error("decoded temporal output did not prove deterministic source-time accumulation");
  if (report.presentedFrames < 30 || report.presentP95Ms > 20) throw new Error("decoded temporal presentation missed the bounded realtime budget");
  if (report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 4 || report.releaseFences.pendingFenceCount !== 0) throw new Error("decoded temporal zero-copy, fail-closed, or fence evidence is incomplete");
}
function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-decoded-temporal-motion-blur-gate/v1", status: "GREEN", directExecution: true, motionBlur: { contract: "decoded-temporal-shutter-accumulation/v1", sourceSampling: "decoded_temporal", sampleCount, distinctDecodedTimestampCount: 2, sampleReceipts: Array.from({ length: sampleCount }, () => ({})), targetsMatchOracle: true, residentFrameRingSize: 8, residentBytes: 49_766_400 }, repeatExact: true, temporalVsSpatialDelta: { changedPixelRatio: .02, highDeltaPixels: 800 }, presentedFrames: 30, presentP95Ms: 20, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["unknown-source-sampling", "second-layer-temporal", "two-temporal", "insufficient-budget"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, status: "BLOCK" }, { ...valid, motionBlur: { ...valid.motionBlur, distinctDecodedTimestampCount: 1 } }, { ...valid, repeatExact: false }, { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, presentP95Ms: 21 }]) {
    let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("decoded temporal evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives }));
}
async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-decoded-temporal-motion-blur-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `decoded-temporal-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const temporalPath = join(temporary, "temporal.json"); await writeFile(temporalPath, JSON.stringify(graphFor()));
    await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const temporalLoaded = await request("engine_video_load", { sessionId: "temporal", graphPath: temporalPath, bindingsPath, timelineFrame: sampleFrame });
    const observedContract = temporalLoaded.result?.layers?.[0]?.motionBlur?.contract;
    if (baseline) {
      await request("surface_release"); await request("shutdown");
      return { status: "BLOCK", expectedContract: "decoded-temporal-shutter-accumulation/v1", observedContract: observedContract ?? null, loadOk: temporalLoaded.ok, reason: temporalLoaded.ok ? "old executor accepted the field but still lowered one decoded texture" : temporalLoaded.error };
    }
    if (!temporalLoaded.ok) throw new Error(`decoded temporal load failed: ${JSON.stringify(temporalLoaded)}`);
    const repeatLoaded = await request("engine_video_load", { sessionId: "temporal-repeat", graphPath: temporalPath, bindingsPath, timelineFrame: sampleFrame });
    const spatialPath = join(temporary, "spatial.json"); await writeFile(spatialPath, JSON.stringify(graphFor({ sourceSampling: "current_frame", graphId: "spatial-control" })));
    const spatialLoaded = await request("engine_video_load", { sessionId: "spatial", graphPath: spatialPath, bindingsPath, timelineFrame: sampleFrame });
    if (!repeatLoaded.ok || !spatialLoaded.ok) throw new Error(`temporal controls failed to load: ${JSON.stringify({ repeatLoaded, spatialLoaded })}`);
    const temporalOutput = join(temporary, "temporal.png"); const repeatOutput = join(temporary, "temporal-repeat.png"); const spatialOutput = join(temporary, "spatial.png");
    const temporal = await request("engine_video_verify_frame", { sessionId: "temporal", timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath: temporalOutput });
    const repeated = await request("engine_video_verify_frame", { sessionId: "temporal-repeat", timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath: repeatOutput });
    const spatial = await request("engine_video_verify_frame", { sessionId: "spatial", timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath: spatialOutput });
    if (!temporal.ok || !repeated.ok || !spatial.ok) throw new Error(`decoded temporal verification failed: ${JSON.stringify({ temporal, repeated, spatial })}`);
    const temporalBytes = await readFile(temporalOutput); const repeatBytes = await readFile(repeatOutput); const spatialBytes = await readFile(spatialOutput);
    await mkdir(evidenceRoot, { recursive: true });
    await Promise.all([writeFile(join(evidenceRoot, "decoded-temporal-frame-15.png"), temporalBytes), writeFile(join(evidenceRoot, "decoded-temporal-repeat-frame-15.png"), repeatBytes), writeFile(join(evidenceRoot, "current-frame-control-15.png"), spatialBytes)]);
    const times = []; let last;
    for (let index = 0; index < 34; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "temporal", timelineFrame: 5 + index % 25, toleranceSeconds: 1 / 60 }); if (!last.ok) throw new Error(`decoded temporal present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); }
    times.sort((left, right) => left - right);
    const rejectedNegativeControls = [];
    async function negative(name, graph, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graph)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("unknown-source-sampling", graphFor({ sourceSampling: "invented", graphId: "negative-source-sampling" }), "parse");
    await negative("second-layer-temporal", graphFor({ layers: 2, temporalLayers: [1], graphId: "negative-second-layer-temporal" }), "first resident video layer");
    await negative("two-temporal", graphFor({ layers: 2, temporalLayers: [0, 1], graphId: "negative-two-temporal" }), "exactly one decoded temporal");
    await negative("insufficient-budget", { ...graphFor({ graphId: "negative-budget" }), width: 1920, height: 1080, cacheBudgetMb: 64 }, "resource budget is insufficient");
    const released = await request("engine_video_release", { sessionId: "temporal" });
    for (const id of ["temporal-repeat", "spatial"]) await request("engine_video_release", { sessionId: id });
    await request("surface_release"); await request("shutdown");
    const sampling = temporal.result.temporalSampling;
    const expectedTargets = expectedTargetSeconds();
    const observedTargets = sampling.sampleReceipts.map((receipt) => receipt.targetSeconds);
    const productPathCpuPixelCopies = Math.max(last.result.frame.decodePathCpuPixelCopies, last.result.frame.stagingCpuPixelReadbacks, last.result.frame.nativeSurfaceCpuPixelReadbacks, sampling.productPathCpuPixelCopies);
    return { status: "GREEN", directExecution: temporalLoaded.result.engineGraph.directExecution, motionBlur: { ...temporalLoaded.result.layers[0].motionBlur, ...sampling, targetsMatchOracle: observedTargets.length === expectedTargets.length && observedTargets.every((value, index) => close(value, expectedTargets[index])) }, repeatExact: sha256(temporalBytes) === sha256(repeatBytes), temporalVsSpatialDelta: changedStats(spatialBytes, temporalBytes), artifacts: { temporalSha256: sha256(temporalBytes), repeatSha256: sha256(repeatBytes), spatialSha256: sha256(spatialBytes) }, presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], productPathCpuPixelCopies, rejectedNegativeControls, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-decoded-temporal-motion-blur-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
