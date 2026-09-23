import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-transform-motion-blur");
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
function graphFor({ blur = true, angle = shutterAngle, samples = sampleCount, selectedKeyframes = keyframes, graphId = "transform-motion-blur" } = {}) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", ...transformBase, keyframes: selectedKeyframes },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  if (blur) {
    nodes.push({ id: "motion-blur", inputs: [tail], enabled: true, kind: "motion_blur", shutterAngle: angle, samples });
    tail = "motion-blur";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}
function expectedSampleFrames() {
  const interval = shutterAngle / 360;
  return Array.from({ length: sampleCount }, (_, index) => sampleFrame + interval * ((index + 0.5) / sampleCount - 0.5));
}
function expectedSampleTransforms() {
  return expectedSampleFrames().map((frame) => {
    const ratio = Math.max(0, Math.min(1, frame / keyframes[0].frame));
    return [
      transformBase.x + (keyframes[0].x - transformBase.x) * ratio,
      0,
      0.62,
      transformBase.rotationRadians + (keyframes[0].rotationRadians - transformBase.rotationRadians) * ratio,
    ];
  });
}
function close(left, right, epsilon = 0.0001) { return Number.isFinite(left) && Math.abs(left - right) <= epsilon; }
function changedStats(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) throw new Error("motion-blur artifacts differ in dimensions");
  let changed = 0; let absolute = 0; let edgeSpread = 0; const pixels = left.width * left.height;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4; let delta = 0;
    for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(left.data[offset + channel] - right.data[offset + channel]);
    if (delta > 8) changed += 1;
    absolute += delta;
    if (delta > 32) edgeSpread += 1;
  }
  return { changedPixels: changed, changedPixelRatio: changed / pixels, meanAbsoluteChannelDelta: absolute / (pixels * 4), highDeltaPixels: edgeSpread };
}
function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-transform-motion-blur-gate/v1" || report.status !== "GREEN") throw new Error("transform motion-blur report is not GREEN");
  if (!report.directExecution || report.requiredNodeIds.length !== 5 || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("motion-blur graph did not execute every node");
  if (report.motionBlur?.contract !== "transform-shutter-accumulation/v1" || report.motionBlur?.sampleCount !== sampleCount || report.motionBlur?.shutterAngle !== shutterAngle) throw new Error("motion-blur receipt is incomplete");
  if (!report.motionBlur.samplesMatchOracle || report.motionBlur.sampleTransforms.length !== sampleCount) throw new Error("motion-blur shutter samples diverged from the independent oracle");
  if (!report.repeatExact || report.artifactDelta.changedPixelRatio < 0.002 || report.artifactDelta.highDeltaPixels < 250) throw new Error("motion-blur artifact did not prove a deterministic spatial shutter accumulation");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20) throw new Error("motion-blur presentation missed the frame budget");
  if (report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 7 || report.releaseFences.pendingFenceCount !== 0) throw new Error("motion-blur zero-copy, fail-closed, or fence evidence is incomplete");
}
function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-transform-motion-blur-gate/v1", status: "GREEN", directExecution: true, requiredNodeIds: ["source", "transform", "color", "motion-blur", "output"], executedNodeIds: ["source", "transform", "color", "motion-blur", "output"], motionBlur: { contract: "transform-shutter-accumulation/v1", sampleCount, shutterAngle, samplesMatchOracle: true, sampleTransforms: expectedSampleTransforms() }, repeatExact: true, artifactDelta: { changedPixelRatio: 0.03, highDeltaPixels: 1200 }, presentedFrames: 60, presentP95Ms: 15, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["zero-angle", "one-sample", "too-many-samples", "static", "opacity", "stack", "outer-effect"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, status: "BLOCK" }, { ...valid, motionBlur: { ...valid.motionBlur, samplesMatchOracle: false } }, { ...valid, repeatExact: false }, { ...valid, artifactDelta: { changedPixelRatio: 0, highDeltaPixels: 0 } }, { ...valid, presentP95Ms: 21 }, { ...valid, productPathCpuPixelCopies: 1 }]) {
    let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("motion-blur evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives }));
}
async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-transform-motion-blur-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `motion-blur-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const blurPath = join(temporary, "blur.json"); const sharpPath = join(temporary, "sharp.json"); await writeFile(blurPath, JSON.stringify(graphFor())); await writeFile(sharpPath, JSON.stringify(graphFor({ blur: false, graphId: "sharp-control" })));
    await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const blurLoaded = await request("engine_video_load", { sessionId: "blur", graphPath: blurPath, bindingsPath, timelineFrame: sampleFrame });
    if (baseline) {
      await request("surface_release"); await request("shutdown");
      return { status: "BLOCK", reason: "common-video lowering rejects the typed motion_blur node", loadOk: blurLoaded.ok, loadError: blurLoaded.error, expectedFailureMarker: "unsupported common video node kind: motion_blur" };
    }
    if (!blurLoaded.ok) throw new Error(`motion-blur load failed: ${JSON.stringify(blurLoaded)}`);
    const repeatLoaded = await request("engine_video_load", { sessionId: "blur-repeat", graphPath: blurPath, bindingsPath, timelineFrame: sampleFrame }); if (!repeatLoaded.ok) throw new Error(`motion-blur repeat load failed: ${JSON.stringify(repeatLoaded)}`);
    const sharpLoaded = await request("engine_video_load", { sessionId: "sharp", graphPath: sharpPath, bindingsPath, timelineFrame: sampleFrame }); if (!sharpLoaded.ok) throw new Error(`sharp control load failed: ${JSON.stringify(sharpLoaded)}`);
    const blurOutput = join(temporary, "blur.png"); const repeatOutput = join(temporary, "blur-repeat.png"); const sharpOutput = join(temporary, "sharp.png");
    const blurred = await request("engine_video_verify_frame", { sessionId: "blur", timelineFrame: sampleFrame, toleranceSeconds: 1 / 30, outputPath: blurOutput });
    const repeated = await request("engine_video_verify_frame", { sessionId: "blur-repeat", timelineFrame: sampleFrame, toleranceSeconds: 1 / 30, outputPath: repeatOutput });
    const sharp = await request("engine_video_verify_frame", { sessionId: "sharp", timelineFrame: sampleFrame, toleranceSeconds: 1 / 30, outputPath: sharpOutput });
    if (!blurred.ok || !repeated.ok || !sharp.ok) throw new Error(`motion-blur verification failed: ${JSON.stringify({ blurred, repeated, sharp })}`);
    const blurBytes = await readFile(blurOutput); const repeatBytes = await readFile(repeatOutput); const sharpBytes = await readFile(sharpOutput);
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "blurred-frame-15.png"), blurBytes); await writeFile(join(evidenceRoot, "blurred-repeat-frame-15.png"), repeatBytes); await writeFile(join(evidenceRoot, "sharp-control-frame-15.png"), sharpBytes);
    const observedTransforms = (blurred.result.visualGraph.motionSamples ?? []).slice(0, sampleCount);
    const oracle = expectedSampleTransforms();
    const samplesMatchOracle = observedTransforms.length === oracle.length && observedTransforms.every((sample, index) => sample.every((value, channel) => close(value, oracle[index][channel])));
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "blur", timelineFrame: 5 + index % 25, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`motion-blur present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); }
    times.sort((left, right) => left - right);
    const rejectedNegativeControls = [];
    async function negative(name, options, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graphFor({ ...options, graphId: `negative-${name}` }))); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("zero-angle", { angle: 0 }, "shutter angle");
    await negative("one-sample", { samples: 1 }, "2..=8");
    await negative("too-many-samples", { samples: 9 }, "2..=8");
    await negative("static", { selectedKeyframes: [] }, "animated transform");
    await negative("opacity", { selectedKeyframes: [{ ...keyframes[0], opacity: 0.5 }] }, "constant opacity");
    const stackedPath = join(temporary, "negative-stack.json"); const stacked = graphFor({ graphId: "negative-stack" }); stacked.nodes.splice(-1, 0, { id: "motion-blur-2", inputs: ["motion-blur"], enabled: true, kind: "motion_blur", shutterAngle, samples: sampleCount }); stacked.nodes.at(-1).inputs = ["motion-blur-2"]; await writeFile(stackedPath, JSON.stringify(stacked)); const stackedResponse = await request("engine_video_load", { sessionId: "negative-stack", graphPath: stackedPath, bindingsPath, timelineFrame: sampleFrame }); if (stackedResponse.ok || !String(stackedResponse.error).includes("one motion blur")) throw new Error(`negative stack was not rejected: ${JSON.stringify(stackedResponse)}`); rejectedNegativeControls.push("stack");
    const outerPath = join(temporary, "negative-outer-effect.json"); const outer = graphFor({ graphId: "negative-outer-effect" }); outer.nodes.splice(-1, 0, { id: "outer-effect", inputs: ["motion-blur"], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} }); outer.nodes.at(-1).inputs = ["outer-effect"]; await writeFile(outerPath, JSON.stringify(outer)); const outerResponse = await request("engine_video_load", { sessionId: "negative-outer-effect", graphPath: outerPath, bindingsPath, timelineFrame: sampleFrame }); if (outerResponse.ok || !String(outerResponse.error).includes("final visual node")) throw new Error(`negative outer effect was not rejected: ${JSON.stringify(outerResponse)}`); rejectedNegativeControls.push("outer-effect");
    const released = await request("engine_video_release", { sessionId: "blur" }); await request("engine_video_release", { sessionId: "blur-repeat" }); await request("engine_video_release", { sessionId: "sharp" }); await request("surface_release"); await request("shutdown");
    const productPathCpuPixelCopies = Math.max(last.result.frame.decodePathCpuPixelCopies, last.result.frame.stagingCpuPixelReadbacks, last.result.frame.nativeSurfaceCpuPixelReadbacks);
    const visual = blurred.result.visualGraph;
    const loadMotionBlur = blurLoaded.result.layers[0].motionBlur;
    return { status: "GREEN", directExecution: blurLoaded.result.engineGraph.directExecution, requiredNodeIds: graphFor().nodes.map((node) => node.id), executedNodeIds: blurLoaded.result.engineGraph.executedNodeIds, motionBlur: { contract: loadMotionBlur.contract, nodeId: loadMotionBlur.nodeId, shutterAngle: visual.motionShutterAngle, sampleCount: visual.motionSampleCount, sampleFrames: (visual.motionSampleFrames ?? []).flat().slice(0, sampleCount), sampleTransforms: observedTransforms, samplesMatchOracle }, repeatExact: sha256(blurBytes) === sha256(repeatBytes), repeatDelta: changedStats(blurBytes, repeatBytes), artifactDelta: changedStats(sharpBytes, blurBytes), artifacts: { blurredSha256: sha256(blurBytes), repeatSha256: sha256(repeatBytes), sharpSha256: sha256(sharpBytes) }, presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * 0.5)], presentP95Ms: times[Math.floor((times.length - 1) * 0.95)], productPathCpuPixelCopies, rejectedNegativeControls, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-transform-motion-blur-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
