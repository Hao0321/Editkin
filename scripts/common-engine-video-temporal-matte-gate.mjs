import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const executable = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-temporal-matte");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const fixture = resolve(root, "public/demo-source.mp4");
const sampleFrame = 24;
const sampleCount = 8;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function graphFor({ graphId = "decoded-temporal-track-matte", matte = true, matteTimeline = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 }, targetTimeline = { timelineStartFrame: 8, sourceStartFrame: 18, durationFrames: 40 }, mode = "luma", budgetMb = 192 } = {}) {
  const nodes = [
    { id: "matte-source", inputs: [], enabled: true, kind: "source", assetId: "matte", mediaKind: "video", inputColorSpace: "rec709", timeline: matteTimeline },
    { id: "matte-transform", inputs: ["matte-source"], enabled: true, kind: "transform2d", x: -32, y: 10, scaleX: .9, scaleY: .9, rotationRadians: .03, opacity: 1 },
    { id: "matte-color", inputs: ["matte-transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: { brightness: .08, contrast: 1.3, saturation: .2, hue: 0, exposure: .15, temperature: 0, tint: 0, pivot: .45, shadows: -.2, highlights: .15, blacks: -.1, whites: .1 } },
    { id: "matte-blur", inputs: ["matte-color"], enabled: true, kind: "motion_blur", shutterAngle: 360, samples: sampleCount, sourceSampling: "decoded_temporal" },
    { id: "target-source", inputs: [], enabled: true, kind: "source", assetId: "target", mediaKind: "video", inputColorSpace: "rec709", timeline: targetTimeline },
    { id: "target-transform", inputs: ["target-source"], enabled: true, kind: "transform2d", x: 110, y: -30, scaleX: .62, scaleY: .62, rotationRadians: -.04, opacity: .9 },
    { id: "target-color", inputs: ["target-transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: { brightness: -.03, contrast: 1.12, saturation: 1.2, hue: 0, exposure: .1, temperature: -.08, tint: .04, pivot: .5, shadows: .1, highlights: -.08, blacks: 0, whites: 0 } },
  ];
  const composite = { id: "composite", inputs: ["matte-blur", "target-color"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 };
  if (matte) Object.assign(composite, { matteInput: "matte-blur", matteMode: mode });
  nodes.push(composite, { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: budgetMb, nodes, outputNode: "output" };
}

function changedPixels(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) throw new Error("temporal matte artifacts differ in dimensions");
  let changed = 0; let highDelta = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta = Math.abs(left.data[offset] - right.data[offset]) + Math.abs(left.data[offset + 1] - right.data[offset + 1]) + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    if (delta > 8) changed += 1;
    if (delta > 48) highDelta += 1;
  }
  return { changedPixels: changed, highDeltaPixels: highDelta };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-temporal-matte-gate/v1" || report.status !== "GREEN") throw new Error("temporal matte report is not GREEN");
  if (!report.directExecution || report.videoLayerCount !== 2 || report.matteCount !== 1 || report.mattePassCount !== 1 || report.matteExecutionMode !== "sampled-track-matte/v1") throw new Error("temporal matte topology did not execute directly");
  if (report.temporalLayerIndex !== 0 || report.matteTargetLayerIndex !== 1 || report.matteSourceLayerIndex !== 0 || report.matteMode !== "luma") throw new Error("temporal matte source/target identity is incomplete");
  if (report.temporalSampling?.sampleCount !== sampleCount || report.temporalSampling?.distinctDecodedTimestampCount < 2 || report.temporalSampling?.residentFrameRingSize < sampleCount) throw new Error("decoded temporal matte receipt is incomplete");
  if (report.artifactDelta.changedPixels < 1000 || report.artifactDelta.highDeltaPixels < 500 || !report.repeatExact) throw new Error("temporal matte artifact or determinism oracle failed");
  if (report.presentedFrames < 30 || report.presentP95Ms > 25 || report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 5 || report.releaseFences?.pendingFenceCount !== 0) throw new Error("temporal matte realtime, zero-copy, fail-closed, or fence evidence is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-temporal-matte-gate/v1", status: "GREEN", directExecution: true, videoLayerCount: 2, matteCount: 1, mattePassCount: 1, matteExecutionMode: "sampled-track-matte/v1", temporalLayerIndex: 0, matteTargetLayerIndex: 1, matteSourceLayerIndex: 0, matteMode: "luma", temporalSampling: { sampleCount, distinctDecodedTimestampCount: 2, residentFrameRingSize: 8 }, artifactDelta: { changedPixels: 3000, highDeltaPixels: 2000 }, repeatExact: true, presentedFrames: 30, presentP95Ms: 20, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["coverage", "self", "dual-temporal", "adjustment-mixture", "budget"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, status: "BLOCK" }, { ...valid, mattePassCount: 0 }, { ...valid, temporalLayerIndex: 1 }, { ...valid, temporalSampling: { sampleCount: 1 } }, { ...valid, artifactDelta: { changedPixels: 0, highDeltaPixels: 0 } }, { ...valid, productPathCpuPixelCopies: 1 }]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("temporal matte evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives }));
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-temporal-matte-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `temporal-matte-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ matte: fixture, target: fixture }));
    const graphPath = join(temporary, "mixed.json"); await writeFile(graphPath, JSON.stringify(graphFor()));
    await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const loaded = await request("engine_video_load", { sessionId: "mixed", graphPath, bindingsPath, timelineFrame: sampleFrame });
    if (baseline) { await request("surface_release"); await request("shutdown"); return { status: "BLOCK", expectedContract: "decoded-temporal-track-matte/v1", loadOk: loaded.ok, reason: loaded.ok ? "old executor accepted an unverified temporal matte topology" : loaded.error, rejected: !loaded.ok && /without matte or particle overlays/.test(String(loaded.error)) }; }
    if (!loaded.ok) throw new Error(`temporal matte load failed: ${JSON.stringify(loaded)}`);
    const controlPath = join(temporary, "control.json"); await writeFile(controlPath, JSON.stringify(graphFor({ graphId: "temporal-composite-control", matte: false })));
    const repeatPath = join(temporary, "repeat.json"); await writeFile(repeatPath, JSON.stringify(graphFor({ graphId: "temporal-matte-repeat" })));
    for (const [id, path] of [["control", controlPath], ["repeat", repeatPath]]) { const response = await request("engine_video_load", { sessionId: id, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (!response.ok) throw new Error(`${id} load failed: ${JSON.stringify(response)}`); }
    const outputs = { mixed: join(temporary, "mixed.png"), control: join(temporary, "control.png"), repeat: join(temporary, "repeat.png") }; const verified = {};
    for (const [id, outputPath] of Object.entries(outputs)) { verified[id] = await request("engine_video_verify_frame", { sessionId: id, timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath }); if (!verified[id].ok) throw new Error(`${id} verification failed: ${JSON.stringify(verified[id])}`); }
    const bytes = Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([id, path]) => [id, await readFile(path)]))); await mkdir(evidenceRoot, { recursive: true }); await Promise.all(Object.entries(bytes).map(([id, value]) => writeFile(join(evidenceRoot, `${id}-frame-${sampleFrame}.png`), value)));
    const times = []; let last; for (let index = 0; index < 34; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "mixed", timelineFrame: 12 + index % 32, toleranceSeconds: 1 / 60 }); if (!last.ok) throw new Error(`temporal matte present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = []; async function negative(name, graph, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graph)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("coverage", graphFor({ graphId: "negative-coverage", matteTimeline: { timelineStartFrame: 10, sourceStartFrame: 0, durationFrames: 20 } }), "must fully cover");
    const self = graphFor({ graphId: "negative-self" }); Object.assign(self.nodes.find((node) => node.id === "composite"), { matteInput: "target-color" }); await negative("self", self, "cannot reference its target");
    const dualTemporal = graphFor({ graphId: "negative-dual-temporal" }); dualTemporal.nodes.find((node) => node.id === "composite").inputs = ["matte-blur", "target-blur"]; dualTemporal.nodes.splice(7, 0, { id: "target-blur", inputs: ["target-color"], enabled: true, kind: "motion_blur", shutterAngle: 360, samples: sampleCount, sourceSampling: "decoded_temporal" }); await negative("dual-temporal", dualTemporal, "exactly one decoded temporal motion-blur layer");
    const adjustment = graphFor({ graphId: "negative-adjustment-mixture" }); adjustment.nodes.splice(-1, 0, { id: "adjustment", inputs: ["composite"], enabled: true, kind: "adjustment", affectedInputs: ["composite"], timeline: { timelineStartFrame: 8, sourceStartFrame: 0, durationFrames: 40 } }); adjustment.nodes.at(-1).inputs = ["adjustment"]; await negative("adjustment-mixture", adjustment, "temporal matte topology cannot mix");
    const overBudget = graphFor({ graphId: "negative-budget", budgetMb: 64 }); overBudget.width = 1920; overBudget.height = 1080; await negative("budget", overBudget, "resource budget is insufficient");
    const released = await request("engine_video_release", { sessionId: "mixed" }); for (const id of ["control", "repeat"]) await request("engine_video_release", { sessionId: id }); await request("surface_release"); await request("shutdown");
    const result = verified.mixed.result; const layers = result.layers ?? []; const temporalLayerIndex = layers.findIndex((layer) => layer.motionBlur?.sourceSampling === "decoded_temporal"); const matteTargetLayerIndex = layers.findIndex((layer) => layer.matteLayerIndex !== null && layer.matteLayerIndex !== undefined);
    return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, videoLayerCount: loaded.result.layerCount, matteCount: loaded.result.matteCount, mattePassCount: result.mattePassCount, matteExecutionMode: result.matteExecutionMode, temporalLayerIndex, matteTargetLayerIndex, matteSourceLayerIndex: layers[matteTargetLayerIndex]?.matteLayerIndex, matteMode: layers[matteTargetLayerIndex]?.matteMode, temporalSampling: result.temporalSampling, artifactDelta: changedPixels(bytes.control, bytes.mixed), repeatExact: sha256(bytes.mixed) === sha256(bytes.repeat), artifacts: Object.fromEntries(Object.entries(bytes).map(([id, value]) => [`${id}Sha256`, sha256(value)])), presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], productPathCpuPixelCopies: Math.max(last.result.productPathCpuPixelCopies ?? 0, result.productPathCpuPixelCopies ?? 0, result.temporalSampling?.productPathCpuPixelCopies ?? 0), rejectedNegativeControls, resourcePlan: loaded.result.resourcePlan, releaseFences: released.result.fences };
  } finally { lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null) child.kill(); child.removeAllListeners(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-temporal-matte-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
