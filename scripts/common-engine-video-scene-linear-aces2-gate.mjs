import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return resolve(index >= 0 ? process.argv[index + 1] : fallback);
};
const candidate = argument("--candidate", join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline") ? argument("--baseline", "") : undefined;
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-video-scene-linear-aces2");
const reportPath = join(evidenceRoot, "report.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const displayProcessor = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const inputProcessor = "editkin-srgb-to-linear-rec709-primary/v1";
const configSha256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a";
const identity = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
const grade = process.argv.includes("--identity-adjustment") ? identity : { ...identity, exposure: .25, contrast: 1.05, saturation: .94, temperature: .08, tint: -.04 };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

function graph(options = {}) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "linear", inputs: ["transform"], enabled: true, kind: "color", processor: options.inputProcessor ?? inputProcessor, inputSpace: "rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709", grade: identity },
  ];
  let tail = "linear";
  if (!process.argv.includes("--no-adjustment")) {
    nodes.push({ id: "adjustment", inputs: [tail], enabled: true, kind: "adjustment", affectedInputs: [tail], timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 } });
    tail = "adjustment";
    nodes.push({ id: "grade", inputs: [tail], enabled: true, kind: "color", processor: "editkin-linear-primary/v1", inputSpace: "linear_rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709", grade });
    tail = "grade";
  }
  if (options.effect) {
    nodes.push({ id: "effect", inputs: [tail], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: options.effectTemporalRadius ?? 0, parameters: {} });
    tail = "effect";
  }
  nodes.push({ id: "display", inputs: [tail], enabled: true, kind: "color", processor: displayProcessor, inputSpace: options.displayInput ?? "linear_rec709", workingSpace: "ACEScct", outputSpace: options.displayOutput ?? "rec709_sdr", grade: options.displayGrade ?? identity });
  tail = "display";
  if (options.duplicateDisplay) {
    nodes.push({ id: "display-two", inputs: [tail], enabled: true, kind: "color", processor: displayProcessor, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709_sdr", grade: identity });
    tail = "display-two";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: options.outputFormat ?? "rgba32_float" });
  return {
    schema: "editkin.engine-graph/v1", graphId: options.graphId ?? "resident-scene-linear-aces2",
    width: 960, height: 540, timebase: { numerator: 1, denominator: 30 },
    workingFormat: options.workingFormat ?? "rgba32_float", cacheBudgetMb: options.cacheBudgetMb ?? 64,
    nodes, outputNode: "output",
    ...(options.audio ? { audio: { sampleRate: 48_000, channels: 2, masterNode: "audio:output", nodes: [] } } : {}),
  };
}

function parseCube(source) {
  let size = 0; const values = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith("TITLE")) continue;
    const fields = line.split(/\s+/); if (fields[0] === "LUT_3D_SIZE") { size = Number(fields[1]); continue; }
    if (fields.length >= 3 && fields.slice(0, 3).every((field) => Number.isFinite(Number(field)))) values.push(...fields.slice(0, 3).map(Number));
  }
  if (size !== 65 || values.length !== size ** 3 * 3) throw new Error("calibrated ACES2 LUT is incomplete");
  return { size, values };
}

function sampleCube(lut, rgb) {
  const scaled = rgb.map((value) => clamp(value) * (lut.size - 1));
  const low = scaled.map((value) => Math.min(lut.size - 2, Math.floor(value)));
  const [fr, fg, fb] = scaled.map((value, index) => value - low[index]);
  const [r, g, b] = low; const index = (rr, gg, bb, channel) => ((rr + gg * lut.size + bb * lut.size * lut.size) * 3) + channel;
  return [0, 1, 2].map((channel) => {
    const value = (rr, gg, bb) => lut.values[index(rr, gg, bb, channel)];
    const c000 = value(r, g, b); const c100 = value(r + 1, g, b); const c010 = value(r, g + 1, b); const c001 = value(r, g, b + 1);
    const c110 = value(r + 1, g + 1, b); const c101 = value(r + 1, g, b + 1); const c011 = value(r, g + 1, b + 1); const c111 = value(r + 1, g + 1, b + 1);
    if (fr >= fg) {
      if (fg >= fb) return c000 + fr * (c100 - c000) + fg * (c110 - c100) + fb * (c111 - c110);
      if (fr >= fb) return c000 + fr * (c100 - c000) + fb * (c101 - c100) + fg * (c111 - c101);
      return c000 + fb * (c001 - c000) + fr * (c101 - c001) + fg * (c111 - c101);
    }
    if (fb >= fg) return c000 + fb * (c001 - c000) + fg * (c011 - c001) + fr * (c111 - c011);
    if (fb >= fr) return c000 + fg * (c010 - c000) + fb * (c011 - c010) + fr * (c111 - c011);
    return c000 + fg * (c010 - c000) + fr * (c110 - c010) + fb * (c111 - c110);
  });
}

function srgbToLinear(value) { return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }
function acesCct(rgb) {
  const ap1 = [
    .61309740240118826 * rgb[0] + .33952314618410551 * rgb[1] + .047379451414707258 * rgb[2],
    .070193722469581596 * rgb[0] + .91635387905734134 * rgb[1] + .013452398473073862 * rgb[2],
    .020615592882227002 * rgb[0] + .10956977293813569 * rgb[1] + .86981463417963978 * rgb[2],
  ];
  return ap1.map((value) => value > .0078125 ? .0823456049 * Math.log(Math.max(value, 1.17549435e-38)) + .5547945205479452 : value * 10.5402374 + .0729055703);
}
function tonePoints(style) {
  const points = [[0, clamp(style.blacks * .08, 0, .18)], [.18, clamp(.18 + style.shadows * .13, .02, .42)], [.5, clamp(.5 + (.5 - style.pivot) * .26, .24, .76)], [.82, clamp(.82 + style.highlights * .13, .58, .98)], [1, clamp(1 + style.whites * .08, .82, 1)]];
  for (let index = 1; index < points.length; index += 1) points[index][1] = Math.max(points[index][1], points[index - 1][1] + .002);
  for (let index = points.length - 2; index >= 0; index -= 1) points[index][1] = Math.min(points[index][1], points[index + 1][1] - .002);
  return points;
}
function primary(rgb, style) {
  const points = tonePoints(style); const curve = (value) => {
    const bounded = clamp(value); const upper = points.findIndex(([x]) => x >= bounded); if (upper <= 0) return points[0][1];
    const [x0, y0] = points[upper - 1]; const [x1, y1] = points[upper]; return y0 + (y1 - y0) * ((bounded - x0) / (x1 - x0));
  };
  const exposure = 2 ** clamp(style.exposure, -3, 3); const channels = rgb.map((value) => clamp(((curve(value) - style.pivot) * style.contrast + style.pivot) * exposure + style.brightness));
  channels[0] = clamp(channels[0] + style.temperature * .055); channels[1] = clamp(channels[1] + style.tint * .045); channels[2] = clamp(channels[2] - style.temperature * .055);
  const luma = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722; return channels.map((value) => clamp(luma + (value - luma) * style.saturation));
}
function oracle(raw, lut) {
  const expected = Buffer.alloc(raw.data.length);
  for (let offset = 0; offset < raw.data.length; offset += 4) {
    const linear = [0, 1, 2].map((channel) => srgbToLinear(raw.data[offset + channel] / 255));
    const working = process.argv.includes("--no-adjustment") ? primary(linear, identity) : primary(primary(linear, identity), grade);
    const displayed = sampleCube(lut, acesCct(working));
    for (let channel = 0; channel < 3; channel += 1) expected[offset + channel] = Math.round(clamp(displayed[channel]) * 255);
    expected[offset + 3] = raw.data[offset + 3];
  }
  return expected;
}
function metrics(actual, expected) {
  const errors = []; let sum = 0;
  for (let offset = 0; offset < actual.length; offset += 4) for (let channel = 0; channel < 3; channel += 1) { const error = Math.abs(actual[offset + channel] - expected[offset + channel]); errors.push(error); sum += error; }
  errors.sort((a, b) => a - b); return { meanCodeError: sum / errors.length, p99CodeError: errors[Math.floor((errors.length - 1) * .99)], maxCodeError: errors.at(-1) };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-video-scene-linear-aces2-gate/v1" || report.status !== "GREEN") throw new Error("scene-linear video report is not GREEN");
  if (!report.baselineRejected || !report.sceneLinearExecution || !report.contractReceipt || !report.resourceReceipt) throw new Error("scene-linear execution contract is incomplete");
  if (report.productPathCpuPixelCopies !== 0 || report.presentedFrames < 24 || report.presentP95Ms > 30) throw new Error("scene-linear product path missed its zero-copy/frame gate");
  if (report.measurements.meanCodeError > .8 || report.measurements.p99CodeError > 3 || report.measurements.maxCodeError > 12) throw new Error("scene-linear output diverged from the independent LUT oracle");
  if (report.rejectedNegativeControls.length !== 9 || report.releaseFences.pendingFenceCount !== 0) throw new Error("scene-linear fail-closed/fence evidence is incomplete");
}
function syntheticSelfTest() {
  const valid = { schema: "editkin.common-video-scene-linear-aces2-gate/v1", status: "GREEN", baselineRejected: true, sceneLinearExecution: true, contractReceipt: true, resourceReceipt: true, productPathCpuPixelCopies: 0, presentedFrames: 30, presentP95Ms: 18, measurements: { meanCodeError: .2, p99CodeError: 1, maxCodeError: 4 }, rejectedNegativeControls: Array.from({ length: 9 }, (_, index) => `negative-${index}`), releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); for (const broken of [{ ...valid, sceneLinearExecution: false }, { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, measurements: { meanCodeError: 1, p99CodeError: 4, maxCodeError: 13 } }, { ...valid, rejectedNegativeControls: [] }]) { let rejected = false; try { assertGreen(broken); } catch { rejected = true; } if (!rejected) throw new Error("scene-linear evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 4 }));
}

async function run(executable, baselineMode) {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-scene-linear-video-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `scene-linear-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const graphPath = join(temporary, "graph.json"); const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graph())); await writeFile(bindingsPath, JSON.stringify({ video: resolve(root, "public/demo-source.mp4") }));
    const loaded = await request("engine_video_load", { sessionId: "scene-linear", graphPath, bindingsPath, timelineFrame: 45 });
    if (baselineMode) {
      if (loaded.ok) throw new Error("frozen baseline unexpectedly admitted scene-linear decoded video");
      return { status: "BLOCK", baselineRejected: true, observedError: loaded.error };
    }
    if (!loaded.ok) throw new Error(`scene-linear load failed: ${JSON.stringify(loaded)}`);
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54, surfaceColorSpace: "srgb" }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const rawPath = join(temporary, "raw.png"); const opened = await request("video_open", { sessionId: "raw", inputPath: resolve(root, "public/demo-source.mp4") }); const decoded = await request("video_decode_at", { sessionId: "raw", timeSeconds: 1.5, toleranceSeconds: 1 / 30, outputPath: rawPath });
    if (!opened.ok || !decoded.ok) throw new Error(`raw decoder oracle source failed: ${JSON.stringify({ opened, decoded })}`);
    const outputPath = join(temporary, "output.png"); const verified = await request("engine_video_verify_frame", { sessionId: "scene-linear", timelineFrame: 45, toleranceSeconds: 1 / 30, outputPath }); if (!verified.ok) throw new Error(`scene-linear verification failed: ${JSON.stringify(verified)}`);
    const raw = PNG.sync.read(await readFile(rawPath)); const actual = PNG.sync.read(await readFile(outputPath)); const lut = parseCube(await readFile(resolve(root, "public/color/aces2/luts/output-acescct-to-rec709_sdr.cube"), "utf8")); const measured = metrics(actual.data, oracle(raw, lut));
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "raw-decoded.png"), PNG.sync.write(raw)); await writeFile(join(evidenceRoot, "scene-linear-aces2.png"), PNG.sync.write(actual));
    const times = []; let last;
    for (let index = 0; index < 36; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "scene-linear", timelineFrame: 46 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`scene-linear present failed: ${JSON.stringify(last)}`); if (index >= 6) times.push(performance.now() - started); }
    times.sort((a, b) => a - b);
    const rejectedNegativeControls = []; const negative = async (name, candidateGraph) => { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidateGraph)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 45 }); if (response.ok) throw new Error(`${name} negative was admitted`); rejectedNegativeControls.push(name); };
    await negative("input-bypass", graph({ inputProcessor: "editkin-linear-primary/v1" }));
    await negative("wrong-display-input", graph({ displayInput: "rec709" }));
    await negative("wrong-display-output", graph({ displayOutput: "rec2100_pq_1000" }));
    await negative("graded-display", graph({ displayGrade: { ...identity, exposure: .1 } }));
    await negative("duplicate-display", graph({ duplicateDisplay: true }));
    await negative("rgba8-working", graph({ workingFormat: "rgba8", outputFormat: "rgba8" }));
    await negative("audio-graph", graph({ audio: true }));
    await negative("temporal-effect", graph({ effect: true, effectTemporalRadius: 1 }));
    await negative("insufficient-budget", graph({ cacheBudgetMb: 8 }));
    const released = await request("engine_video_release", { sessionId: "scene-linear" }); await request("video_release", { sessionId: "raw" }); await request("surface_release"); await request("shutdown");
    return {
      status: "GREEN", loaded: loaded.result, verified: verified.result, bound: bound.result,
      sceneLinearExecution: verified.result.sceneLinearExecution === true,
      contractReceipt: verified.result.workingColorSpace === "linear_rec709" && verified.result.workingFormat === "rgba16_float" && verified.result.displayTransform === displayProcessor && verified.result.inputTransform === inputProcessor && verified.result.ocioVersion === "2.5.2" && verified.result.acesVersion === "2.0" && verified.result.configSha256 === configSha256,
      resourceReceipt: loaded.result.resourcePlan.workingBytesPerPixel === 8 && loaded.result.resourcePlan.adjustmentCount === 1 && loaded.result.resourcePlan.requiredBytes <= loaded.result.resourcePlan.budgetBytes,
      productPathCpuPixelCopies: last.result.productPathCpuPixelCopies,
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], measurements: measured, rejectedNegativeControls, releaseFences: released.result.fences,
    };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  await mkdir(evidenceRoot, { recursive: true });
  if (baseline) {
    const observed = await run(baseline, true); const report = { schema: "editkin.common-video-scene-linear-aces2-baseline/v1", measuredAt: new Date().toISOString(), executable: baseline, executableSha256: sha256(await readFile(baseline)), ...observed };
    await writeFile(baselineReportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2)); return;
  }
  const frozen = JSON.parse(await readFile(baselineReportPath, "utf8")); const observed = await run(candidate, false);
  const report = { schema: "editkin.common-video-scene-linear-aces2-gate/v1", measuredAt: new Date().toISOString(), executable: candidate, executableSha256: sha256(await readFile(candidate)), baselineExecutableSha256: frozen.executableSha256, baselineRejected: frozen.status === "BLOCK" && frozen.baselineRejected === true, ...observed };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); console.log(JSON.stringify(report, null, 2));
}

await main();
