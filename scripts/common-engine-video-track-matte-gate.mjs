import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--"))
  ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-track-matte");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const modes = ["alpha", "alpha_inverted", "luma", "luma_inverted"];
const modeCodes = { alpha: 1, alpha_inverted: 2, luma: 3, luma_inverted: 4 };
const thresholds = { maxChannelError: 3, p99MaxChannelError: 1, meanMaxChannelError: .35 };

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function clamp(value, low = 0, high = 1) { return Math.min(high, Math.max(low, value)); }
function srgbToLinear(value) { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }
function linearToSrgb(value) { const x = clamp(value); return Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055)); }

function cpuReference(matte, target, mode) {
  const output = Buffer.alloc(matte.data.length);
  for (let offset = 0; offset < output.length; offset += 4) {
    const matteAlpha = matte.data[offset + 3] / 255;
    const matteRgb = [0, 1, 2].map((channel) => srgbToLinear(matte.data[offset + channel]));
    let factor = mode.startsWith("alpha") ? matteAlpha : (.2126 * matteRgb[0] + .7152 * matteRgb[1] + .0722 * matteRgb[2]) * matteAlpha;
    if (mode.endsWith("inverted")) factor = 1 - factor;
    const sourceAlpha = target.data[offset + 3] / 255 * clamp(factor);
    const backdropAlpha = matteAlpha;
    const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
    for (let channel = 0; channel < 3; channel += 1) {
      const backdrop = matteRgb[channel]; const source = srgbToLinear(target.data[offset + channel]);
      const premultiplied = backdrop * backdropAlpha * (1 - sourceAlpha) + source * sourceAlpha;
      output[offset + channel] = linearToSrgb(outputAlpha > .000001 ? premultiplied / outputAlpha : 0);
    }
    output[offset + 3] = Math.round(clamp(outputAlpha) * 255);
  }
  return output;
}

function comparePixels(actual, expected) {
  const errors = []; let sum = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    let error = 0;
    for (let channel = 0; channel < 4; channel += 1) error = Math.max(error, Math.abs(actual[offset + channel] - expected[offset + channel]));
    errors.push(error); sum += error;
  }
  errors.sort((left, right) => left - right);
  return { pixels: errors.length, maxChannelError: errors.at(-1), p99MaxChannelError: errors[Math.floor((errors.length - 1) * .99)], meanMaxChannelError: sum / errors.length };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-track-matte-gate/v1" || report.status !== "GREEN") throw new Error("track-matte report is not GREEN");
  if (!report.directExecution || report.modeResults.length !== 4 || report.modeResults.some((item) => item.receiptMode !== item.mode || item.receiptModeCode !== modeCodes[item.mode])) throw new Error("typed matte execution coverage is incomplete");
  if (report.modeResults.some((item) => item.pixels !== 960 * 540 || item.maxChannelError > thresholds.maxChannelError || item.p99MaxChannelError > thresholds.p99MaxChannelError || item.meanMaxChannelError > thresholds.meanMaxChannelError)) throw new Error("track-matte pixels diverge from the independent CPU oracle");
  if (report.modeResults.some((item) => item.matteExecutionMode !== "sampled-track-matte/v1" || item.mattePassCount !== 1 || item.matteLayerIndex !== 0)) throw new Error("track-matte execution receipts are incomplete");
  if (report.productPathCpuPixelCopies !== 0 || report.presentedFrames < 60 || report.presentP95Ms > 1000 / 30) throw new Error("track-matte product path missed zero-copy or 30 fps budget");
  if (report.rejectedNegativeControls.length !== 6) throw new Error("track-matte negative controls are incomplete");
  if (report.resourcePlan.matteCount !== 1 || report.resourcePlan.videoLayerCount !== 2) throw new Error("track-matte resource receipt is incomplete");
  if (!report.releaseFences || report.releaseFences.pendingFenceCount !== 0) throw new Error("track-matte release left pending fences");
  if (![report.executableSha256, report.matteArtifactSha256, report.targetArtifactSha256].every((hash) => /^[0-9a-f]{64}$/.test(hash))) throw new Error("track-matte evidence identity is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-track-matte-gate/v1", status: "GREEN", directExecution: true, thresholds,
    modeResults: modes.map((mode) => ({ mode, receiptMode: mode, receiptModeCode: modeCodes[mode], matteLayerIndex: 0, matteExecutionMode: "sampled-track-matte/v1", mattePassCount: 1, pixels: 960 * 540, maxChannelError: 1, p99MaxChannelError: 1, meanMaxChannelError: .1 })),
    productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 20, rejectedNegativeControls: [1, 2, 3, 4, 5, 6], resourcePlan: { matteCount: 1, videoLayerCount: 2 }, releaseFences: { pendingFenceCount: 0 }, executableSha256: "a".repeat(64), matteArtifactSha256: "b".repeat(64), targetArtifactSha256: "c".repeat(64) };
  assertGreen(valid);
  const negatives = [
    { ...valid, modeResults: valid.modeResults.slice(1) }, { ...valid, modeResults: valid.modeResults.map((item, index) => index ? item : { ...item, p99MaxChannelError: 2 }) },
    { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, presentP95Ms: 34 }, { ...valid, rejectedNegativeControls: [1, 2] }, { ...valid, resourcePlan: { matteCount: 0, videoLayerCount: 2 } },
  ];
  for (const candidate of negatives) { let rejected = false; try { assertGreen(candidate); } catch { rejected = true; } if (!rejected) throw new Error("track-matte evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length }));
}

function branch(id, sourceStartFrame, timelineStartFrame = 0, durationFrames = 180) {
  return { tail: `color:${id}`, nodes: [
    { id: `source:${id}`, inputs: [], enabled: true, kind: "source", assetId: id, mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame, sourceStartFrame, durationFrames } },
    { id: `transform:${id}`, inputs: [`source:${id}`], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: `color:${id}`, inputs: [`transform:${id}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ] };
}
function graphHeader(graphId, nodes, outputNode = "output") { return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 96, nodes, outputNode }; }
function singleGraph(id, sourceStartFrame) { const item = branch(id, sourceStartFrame); return graphHeader(`matte-oracle-${id}`, [...item.nodes, { id: "output", inputs: [item.tail], enabled: true, kind: "output", format: "rgba16_float" }]); }
function matteGraph(mode) { const matte = branch("matte", 0); const target = branch("target", 45); return graphHeader(`track-matte-${mode}`, [...matte.nodes, ...target.nodes,
  { id: "composite", inputs: [matte.tail, target.tail], enabled: true, kind: "composite", blendMode: "normal", opacity: 1, matteInput: matte.tail, matteMode: mode },
  { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" }]); }

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-track-matte-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `matte-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const fixture = resolve(root, "public/demo-source.mp4"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ matte: fixture, target: fixture }));
    if (baseline) {
      const graphPath = join(temporary, "baseline.json"); await writeFile(graphPath, JSON.stringify(matteGraph("luma")));
      const observed = await request("engine_video_load", { sessionId: "baseline", graphPath, bindingsPath, timelineFrame: 30 });
      if (observed.ok || !String(observed.error).includes("does not support matte inputs")) throw new Error(`old binary did not expose the matte gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "native decoded-video composite rejected typed track mattes", observedError: observed.error };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const verifySingle = async (id, sourceStartFrame) => { const graphPath = join(temporary, `${id}.json`); const outputPath = join(temporary, `${id}.png`); await writeFile(graphPath, JSON.stringify(singleGraph(id, sourceStartFrame))); const loaded = await request("engine_video_load", { sessionId: `single-${id}`, graphPath, bindingsPath, timelineFrame: 30 }); const verified = loaded.ok ? await request("engine_video_verify_frame", { sessionId: `single-${id}`, timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath }) : undefined; if (!loaded.ok || !verified?.ok) throw new Error(`single oracle failed: ${JSON.stringify({ loaded, verified })}`); await request("engine_video_release", { sessionId: `single-${id}` }); return readFile(outputPath); };
    const matteBytes = await verifySingle("matte", 0); const targetBytes = await verifySingle("target", 45); const matte = PNG.sync.read(matteBytes); const target = PNG.sync.read(targetBytes);
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "matte.png"), matteBytes); await writeFile(join(evidenceRoot, "target.png"), targetBytes);
    const modeResults = []; let performanceSession; let last; const times = [];
    for (const mode of modes) {
      const graphPath = join(temporary, `${mode}.json`); const outputPath = join(temporary, `${mode}.png`); await writeFile(graphPath, JSON.stringify(matteGraph(mode)));
      const loaded = await request("engine_video_load", { sessionId: `mode-${mode}`, graphPath, bindingsPath, timelineFrame: 30 }); if (!loaded.ok) throw new Error(`${mode} load failed: ${JSON.stringify(loaded)}`);
      const verified = await request("engine_video_verify_frame", { sessionId: `mode-${mode}`, timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath }); if (!verified.ok) throw new Error(`${mode} verify failed: ${JSON.stringify(verified)}`);
      const bytes = await readFile(outputPath); await writeFile(join(evidenceRoot, `${mode}.png`), bytes); const comparison = comparePixels(PNG.sync.read(bytes).data, cpuReference(matte, target, mode));
      modeResults.push({ mode, receiptMode: verified.result.layers?.[1]?.matteMode, receiptModeCode: verified.result.visualLayers?.[1]?.matteMode, matteLayerIndex: verified.result.layers?.[1]?.matteLayerIndex, matteExecutionMode: verified.result.matteExecutionMode, mattePassCount: verified.result.mattePassCount, artifactSha256: sha256(bytes), ...comparison });
      if (mode === "luma") performanceSession = { id: `mode-${mode}`, loaded }; else await request("engine_video_release", { sessionId: `mode-${mode}` });
    }
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: performanceSession.id, timelineFrame: 31 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`matte present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, mutate, marker) => { const candidate = matteGraph("luma"); mutate(candidate); const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 30 }); if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    await negative("unpaired", (candidate) => { delete candidate.nodes.find((node) => node.id === "composite").matteMode; }, "invalid composite");
    await negative("unknown-mode", (candidate) => { candidate.nodes.find((node) => node.id === "composite").matteMode = "chroma"; }, "parse");
    await negative("missing-tail", (candidate) => { candidate.nodes.find((node) => node.id === "composite").matteInput = "missing"; }, "missing matte");
    await negative("non-tail", (candidate) => { candidate.nodes.find((node) => node.id === "composite").matteInput = "source:matte"; }, "visible video branch tail");
    await negative("self", (candidate) => { candidate.nodes.find((node) => node.id === "composite").matteInput = "color:target"; }, "cannot reference its target");
    await negative("uncovered", (candidate) => { candidate.nodes.find((node) => node.id === "source:matte").timeline.durationFrames = 40; }, "must fully cover");
    const released = await request("engine_video_release", { sessionId: performanceSession.id }); await request("surface_release"); await request("shutdown");
    const frames = last.result.layerFrames ?? [];
    return { status: "GREEN", directExecution: performanceSession.loaded.result.engineGraph.directExecution, modeResults, thresholds, resourcePlan: performanceSession.loaded.result.resourcePlan,
      productPathCpuPixelCopies: Math.max(0, ...frames.flatMap((frame) => [frame.decodePathCpuPixelCopies, frame.stagingCpuPixelReadbacks, frame.nativeSurfaceCpuPixelReadbacks]).filter(Number.isFinite)),
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences,
      matteArtifactSha256: sha256(matteBytes), targetArtifactSha256: sha256(targetBytes), bound: bound.result };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); let report = { schema: "editkin.common-engine-video-track-matte-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  if (!baseline) { try { assertGreen(report); } catch (error) { report = { ...report, status: "BLOCK", gateFailure: error instanceof Error ? error.message : String(error) }; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw error; } }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
}
await main();
