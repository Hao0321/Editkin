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
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-temporal-adjustment");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const fixture = resolve(root, "public/demo-source.mp4");
const sampleFrame = 24;
const sampleCount = 8;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function graphFor({ graphId = "decoded-temporal-plus-adjustment", adjustment = true, timeline = { timelineStartFrame: 8, sourceStartFrame: 0, durationFrames: 40 }, affectedInputs = ["motion-blur"], budgetMb = 160 } = {}) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: .94, scaleY: .94, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
    { id: "motion-blur", inputs: ["color"], enabled: true, kind: "motion_blur", shutterAngle: 360, samples: sampleCount, sourceSampling: "decoded_temporal" },
  ];
  let tail = "motion-blur";
  if (adjustment) {
    nodes.push(
      { id: "adjustment", inputs: [tail], enabled: true, kind: "adjustment", affectedInputs, timeline },
      { id: "adjustment-color", inputs: ["adjustment"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: { brightness: .04, contrast: 1.15, saturation: .8, hue: 0, exposure: .35, temperature: .2, tint: -.1, pivot: .45, shadows: .15, highlights: -.1, blacks: .08, whites: -.04 } },
      { id: "adjustment-effect", inputs: ["adjustment-color"], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} },
    );
    tail = "adjustment-effect";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: budgetMb, nodes, outputNode: "output" };
}

function changedPixels(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) throw new Error("temporal adjustment artifacts differ in dimensions");
  let changed = 0; let highDelta = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta = Math.abs(left.data[offset] - right.data[offset]) + Math.abs(left.data[offset + 1] - right.data[offset + 1]) + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    if (delta > 8) changed += 1;
    if (delta > 48) highDelta += 1;
  }
  return { changedPixels: changed, highDeltaPixels: highDelta };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-temporal-adjustment-gate/v1" || report.status !== "GREEN") throw new Error("temporal adjustment report is not GREEN");
  if (!report.directExecution || report.videoLayerCount !== 1 || report.adjustmentCount !== 1 || report.adjustmentPassCount !== 1 || report.adjustmentExecutionMode !== "trailing-full-frame/v1") throw new Error("temporal adjustment topology did not execute directly");
  if (report.temporalSampling?.sampleCount !== sampleCount || report.temporalSampling?.distinctDecodedTimestampCount < 2 || report.temporalSampling?.residentFrameRingSize < sampleCount) throw new Error("decoded temporal receipt is incomplete");
  if (report.activeAdjustmentCount !== 1 || report.artifactDelta.changedPixels < 1000 || report.artifactDelta.highDeltaPixels < 500 || !report.repeatExact) throw new Error("adjustment artifact or determinism oracle failed");
  if (report.adjustmentWorkingBytes <= 0 || report.presentedFrames < 30 || report.presentP95Ms > 25 || report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 4 || report.releaseFences?.pendingFenceCount !== 0) throw new Error("resource, realtime, zero-copy, fail-closed, or fence evidence is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-temporal-adjustment-gate/v1", status: "GREEN", directExecution: true, videoLayerCount: 1, adjustmentCount: 1, adjustmentPassCount: 1, adjustmentExecutionMode: "trailing-full-frame/v1", temporalSampling: { sampleCount, distinctDecodedTimestampCount: 2, residentFrameRingSize: 8 }, activeAdjustmentCount: 1, artifactDelta: { changedPixels: 3000, highDeltaPixels: 2000 }, repeatExact: true, adjustmentWorkingBytes: 1000, presentedFrames: 30, presentP95Ms: 20, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["range", "target", "stack", "budget"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, status: "BLOCK" }, { ...valid, adjustmentPassCount: 0 }, { ...valid, temporalSampling: { sampleCount: 1 } }, { ...valid, artifactDelta: { changedPixels: 0, highDeltaPixels: 0 } }, { ...valid, presentP95Ms: 26 }, { ...valid, productPathCpuPixelCopies: 1 }]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("temporal adjustment evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives }));
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-temporal-adjustment-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `temporal-adjustment-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const graphPath = join(temporary, "mixed.json"); await writeFile(graphPath, JSON.stringify(graphFor()));
    await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const loaded = await request("engine_video_load", { sessionId: "mixed", graphPath, bindingsPath, timelineFrame: sampleFrame });
    if (baseline) { await request("surface_release"); await request("shutdown"); return { status: "BLOCK", expectedContract: "decoded-temporal-plus-trailing-adjustment/v1", loadOk: loaded.ok, reason: loaded.ok ? "old executor accepted an unverified temporal adjustment topology" : loaded.error, rejected: !loaded.ok && /without matte, adjustment, or particle/.test(String(loaded.error)) }; }
    if (!loaded.ok) throw new Error(`temporal adjustment load failed: ${JSON.stringify(loaded)}`);
    const controlPath = join(temporary, "temporal.json"); await writeFile(controlPath, JSON.stringify(graphFor({ graphId: "temporal-control", adjustment: false })));
    const repeatPath = join(temporary, "repeat.json"); await writeFile(repeatPath, JSON.stringify(graphFor({ graphId: "adjustment-repeat" })));
    for (const [id, path] of [["temporal", controlPath], ["repeat", repeatPath]]) { const response = await request("engine_video_load", { sessionId: id, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (!response.ok) throw new Error(`${id} load failed: ${JSON.stringify(response)}`); }
    const outputs = { mixed: join(temporary, "mixed.png"), temporal: join(temporary, "temporal.png"), repeat: join(temporary, "repeat.png") }; const verified = {};
    for (const [id, outputPath] of Object.entries(outputs)) { verified[id] = await request("engine_video_verify_frame", { sessionId: id, timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath }); if (!verified[id].ok) throw new Error(`${id} verification failed: ${JSON.stringify(verified[id])}`); }
    const bytes = Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([id, path]) => [id, await readFile(path)]))); await mkdir(evidenceRoot, { recursive: true }); await Promise.all(Object.entries(bytes).map(([id, value]) => writeFile(join(evidenceRoot, `${id}-frame-${sampleFrame}.png`), value)));
    const times = []; let last; for (let index = 0; index < 34; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "mixed", timelineFrame: 10 + index % 34, toleranceSeconds: 1 / 60 }); if (!last.ok) throw new Error(`temporal adjustment present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = []; async function negative(name, graph, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graph)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("range", graphFor({ graphId: "negative-range", timeline: { timelineStartFrame: 55, sourceStartFrame: 0, durationFrames: 20 } }), "must be fully covered");
    await negative("target", graphFor({ graphId: "negative-target", affectedInputs: ["color"] }), "target exactly its one direct input");
    const stacked = graphFor({ graphId: "negative-stack" }); stacked.nodes.splice(-1, 0, { id: "adjustment-two", inputs: ["adjustment-effect"], enabled: true, kind: "adjustment", affectedInputs: ["adjustment-effect"], timeline: { timelineStartFrame: 8, sourceStartFrame: 0, durationFrames: 40 } }); stacked.nodes.at(-1).inputs = ["adjustment-two"]; await negative("stack", stacked, "trailing adjustment");
    const overBudget = graphFor({ graphId: "negative-budget", budgetMb: 64 }); overBudget.width = 1920; overBudget.height = 1080;
    await negative("budget", overBudget, "resource budget is insufficient");
    const released = await request("engine_video_release", { sessionId: "mixed" }); for (const id of ["temporal", "repeat"]) await request("engine_video_release", { sessionId: id }); await request("surface_release"); await request("shutdown");
    const result = verified.mixed.result; return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, videoLayerCount: loaded.result.layerCount, adjustmentCount: loaded.result.adjustmentCount, adjustmentPassCount: result.adjustmentPassCount, adjustmentExecutionMode: result.adjustmentExecutionMode, activeAdjustmentCount: result.activeAdjustments?.length ?? 0, temporalSampling: result.temporalSampling, adjustmentWorkingBytes: loaded.result.resourcePlan.adjustmentWorkingBytes, artifactDelta: changedPixels(bytes.temporal, bytes.mixed), repeatExact: sha256(bytes.mixed) === sha256(bytes.repeat), artifacts: Object.fromEntries(Object.entries(bytes).map(([id, value]) => [`${id}Sha256`, sha256(value)])), presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], productPathCpuPixelCopies: Math.max(last.result.productPathCpuPixelCopies ?? 0, result.productPathCpuPixelCopies ?? 0, result.temporalSampling?.productPathCpuPixelCopies ?? 0), rejectedNegativeControls, releaseFences: released.result.fences };
  } finally { lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null) child.kill(); child.removeAllListeners(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-temporal-adjustment-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
