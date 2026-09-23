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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-blend");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const modes = ["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"];
const opacity = 0.65;
const pixelThresholds = {
  maxChannelError: 25,
  p95MaxChannelError: 1,
  meanMaxChannelError: 1,
  withinThreeCodeValuesRatio: 0.997,
};

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function clamp(value, low = 0, high = 1) { return Math.min(high, Math.max(low, value)); }
function srgbToLinear(value) { const x = value / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(value) { const x = clamp(value); return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)); }

function blendChannel(backdrop, source, mode) {
  if (mode === "normal") return source;
  if (mode === "add") return Math.min(1, backdrop + source);
  if (mode === "screen") return 1 - (1 - backdrop) * (1 - source);
  if (mode === "multiply") return backdrop * source;
  if (mode === "overlay") return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "soft_light") return (1 - 2 * source) * backdrop * backdrop + 2 * source * backdrop;
  if (mode === "hard_light") return source <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "difference") return Math.abs(backdrop - source);
  if (mode === "darken") return Math.min(backdrop, source);
  if (mode === "lighten") return Math.max(backdrop, source);
  if (mode === "color_dodge") return Math.min(1, backdrop / Math.max(0.000001, 1 - source));
  if (mode === "color_burn") return 1 - Math.min(1, (1 - backdrop) / Math.max(0.000001, source));
  throw new Error(`unknown blend mode: ${mode}`);
}

function cpuReference(base, source, mode) {
  if (base.width !== source.width || base.height !== source.height) throw new Error("reference dimensions differ");
  const output = Buffer.alloc(base.data.length);
  for (let offset = 0; offset < output.length; offset += 4) {
    const backdropAlpha = base.data[offset + 3] / 255;
    const sourceAlpha = source.data[offset + 3] / 255 * opacity;
    const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
    for (let channel = 0; channel < 3; channel += 1) {
      const backdrop = srgbToLinear(base.data[offset + channel]);
      const foreground = srgbToLinear(source.data[offset + channel]);
      const blended = blendChannel(backdrop, foreground, mode);
      const premultiplied = backdrop * backdropAlpha * (1 - sourceAlpha)
        + foreground * sourceAlpha * (1 - backdropAlpha)
        + blended * backdropAlpha * sourceAlpha;
      output[offset + channel] = linearToSrgb(outputAlpha > 0.000001 ? premultiplied / outputAlpha : 0);
    }
    output[offset + 3] = Math.round(clamp(outputAlpha) * 255);
  }
  return output;
}

function comparePixels(actual, expected) {
  if (actual.length !== expected.length) throw new Error("pixel cardinality differs");
  const errors = [];
  let total = 0;
  let withinTolerance = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    let pixelError = 0;
    for (let channel = 0; channel < 4; channel += 1) pixelError = Math.max(pixelError, Math.abs(actual[offset + channel] - expected[offset + channel]));
    errors.push(pixelError); total += pixelError; if (pixelError <= 3) withinTolerance += 1;
  }
  errors.sort((left, right) => left - right);
  return {
    pixels: errors.length,
    maxChannelError: errors.at(-1),
    meanMaxChannelError: total / errors.length,
    p95MaxChannelError: errors[Math.floor((errors.length - 1) * 0.95)],
    withinThreeCodeValuesRatio: withinTolerance / errors.length,
  };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-blend-gate/v1" || report.status !== "GREEN") throw new Error("blend report is not GREEN");
  if (!report.directExecution || report.modeResults.length !== modes.length || modes.some((mode) => !report.modeResults.some((item) => item.mode === mode))) throw new Error("12-mode execution coverage is incomplete");
  if (JSON.stringify(report.pixelThresholds) !== JSON.stringify(pixelThresholds)) throw new Error("blend pixel thresholds are not the frozen contract");
  if (report.modeResults.some((item) => item.pixels !== 960 * 540 || item.maxChannelError > pixelThresholds.maxChannelError || item.p95MaxChannelError > pixelThresholds.p95MaxChannelError || item.meanMaxChannelError > pixelThresholds.meanMaxChannelError || item.withinThreeCodeValuesRatio < pixelThresholds.withinThreeCodeValuesRatio)) throw new Error("decoded blend pixels diverge from the independent CPU oracle");
  if (report.modeResults.some((item) => item.receiptBlendMode !== item.expectedBlendCode || Math.abs(item.receiptCompositeOpacity - opacity) > 0.000001)) throw new Error("blend/opacity receipt does not match the graph");
  if (report.productPathCpuPixelCopies !== 0 || report.presentedFrames < 60 || report.presentP95Ms > 1000 / 30) throw new Error("blend product path missed zero-copy or 30 fps budget");
  if (report.rejectedNegativeControls.length !== 6) throw new Error("blend negative controls are incomplete");
  if (!report.releaseFences || report.releaseFences.pendingFenceCount !== 0 || report.releaseFences.retiredSubmissionSequences.length < 2) throw new Error("blend release left pending GPU fences");
  if (!/^[0-9a-f]{64}$/.test(report.executableSha256) || !/^[0-9a-f]{64}$/.test(report.baseArtifactSha256) || !/^[0-9a-f]{64}$/.test(report.sourceArtifactSha256)) throw new Error("blend evidence identity is incomplete");
}

function syntheticSelfTest() {
  const modeResults = modes.map((mode, expectedBlendCode) => ({ mode, expectedBlendCode, receiptBlendMode: expectedBlendCode, receiptCompositeOpacity: opacity, pixels: 960 * 540, maxChannelError: 2, meanMaxChannelError: 0.2, p95MaxChannelError: 1, withinThreeCodeValuesRatio: 1 }));
  const valid = { schema: "editkin.common-engine-video-blend-gate/v1", status: "GREEN", directExecution: true, modeResults, pixelThresholds, productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 20, rejectedNegativeControls: ["unknown-mode", "opacity-high", "matte", "disabled", "right-nested", "missing-binding"], releaseFences: { pendingFenceCount: 0, retiredSubmissionSequences: [1, 2] }, executableSha256: "a".repeat(64), baseArtifactSha256: "b".repeat(64), sourceArtifactSha256: "c".repeat(64) };
  assertGreen(valid);
  const negatives = [
    { ...valid, modeResults: valid.modeResults.slice(1) },
    { ...valid, modeResults: valid.modeResults.map((item, index) => index === 4 ? { ...item, p95MaxChannelError: 2 } : item) },
    { ...valid, modeResults: valid.modeResults.map((item, index) => index === 5 ? { ...item, receiptBlendMode: 0 } : item) },
    { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, presentP95Ms: 34 },
    { ...valid, rejectedNegativeControls: valid.rejectedNegativeControls.slice(1) },
  ];
  for (const negative of negatives) {
    let rejected = false; try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("blend evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length }));
}

function branch(id, sourceStartFrame) {
  return {
    tail: `color:${id}`,
    nodes: [
      { id: `source:${id}`, inputs: [], enabled: true, kind: "source", assetId: id, mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame, durationFrames: 180 } },
      { id: `transform:${id}`, inputs: [`source:${id}`], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: `color:${id}`, inputs: [`transform:${id}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
    ],
  };
}

function singleGraph(id, sourceStartFrame) {
  const item = branch(id, sourceStartFrame);
  return { schema: "editkin.engine-graph/v1", graphId: `blend-${id}`, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes: [...item.nodes, { id: "output", inputs: [item.tail], enabled: true, kind: "output", format: "rgba16_float" }], outputNode: "output" };
}

function blendGraph(mode) {
  const base = branch("base", 0); const source = branch("source", 45);
  return { schema: "editkin.engine-graph/v1", graphId: `blend-${mode}`, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 96, nodes: [...base.nodes, ...source.nodes, { id: "composite", inputs: [base.tail, source.tail], enabled: true, kind: "composite", blendMode: mode, opacity }, { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" }], outputNode: "output" };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-blend-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `blend-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const fixture = resolve(root, "public/demo-source.mp4"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ base: fixture, source: fixture }));
    if (baseline) {
      const graphPath = join(temporary, "baseline-screen.json"); await writeFile(graphPath, JSON.stringify(blendGraph("screen")));
      const observed = await request("engine_video_load", { sessionId: "blend-baseline", graphPath, bindingsPath, timelineFrame: 30 });
      if (observed.ok || !String(observed.error).includes("normal blend mode")) throw new Error(`old binary did not expose the blend gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "native common-video path only accepts normal source-over", observedError: observed.error, requiredModes: modes };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const verifySingle = async (id, sourceStartFrame) => { const graphPath = join(temporary, `${id}.json`); const outputPath = join(temporary, `${id}.png`); await writeFile(graphPath, JSON.stringify(singleGraph(id, sourceStartFrame))); const loaded = await request("engine_video_load", { sessionId: id, graphPath, bindingsPath, timelineFrame: 30 }); const verified = loaded.ok ? await request("engine_video_verify_frame", { sessionId: id, timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath }) : undefined; const released = loaded.ok ? await request("engine_video_release", { sessionId: id }) : undefined; if (!loaded.ok || !verified?.ok || !released?.ok) throw new Error(`single-source oracle failed: ${JSON.stringify({ loaded, verified, released })}`); return readFile(outputPath); };
    const baseBytes = await verifySingle("base", 0); const sourceBytes = await verifySingle("source", 45); const base = PNG.sync.read(baseBytes); const source = PNG.sync.read(sourceBytes);
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "base.png"), baseBytes); await writeFile(join(evidenceRoot, "source.png"), sourceBytes);
    const modeResults = []; let performanceSession; let last; const times = [];
    for (const [expectedBlendCode, mode] of modes.entries()) {
      const graphPath = join(temporary, `${mode}.json`); const outputPath = join(temporary, `${mode}.png`); await writeFile(graphPath, JSON.stringify(blendGraph(mode)));
      const loaded = await request("engine_video_load", { sessionId: `mode-${mode}`, graphPath, bindingsPath, timelineFrame: 30 }); if (!loaded.ok) throw new Error(`${mode} load failed: ${JSON.stringify(loaded)}`);
      const verified = await request("engine_video_verify_frame", { sessionId: `mode-${mode}`, timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath }); if (!verified.ok) throw new Error(`${mode} verify failed: ${JSON.stringify(verified)}`);
      const bytes = await readFile(outputPath); await writeFile(join(evidenceRoot, `${mode}.png`), bytes); const decoded = PNG.sync.read(bytes); const expected = cpuReference(base, source, mode); const comparison = comparePixels(decoded.data, expected);
      const style = verified.result.visualLayers?.[1]; modeResults.push({ mode, expectedBlendCode, receiptBlendMode: style?.blendMode, receiptCompositeOpacity: style?.compositeOpacity, artifactSha256: sha256(bytes), ...comparison });
      if (mode === "overlay") performanceSession = { id: `mode-${mode}`, loaded, verified }; else await request("engine_video_release", { sessionId: `mode-${mode}` });
    }
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: performanceSession.id, timelineFrame: 31 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`blend present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, mutate, marker, bindings = bindingsPath) => { const candidate = blendGraph("screen"); mutate(candidate); const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath: bindings, timelineFrame: 30 }); if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    await negative("unknown-mode", (candidate) => { candidate.nodes.find((node) => node.id === "composite").blendMode = "mystery"; }, "blend");
    await negative("opacity-high", (candidate) => { candidate.nodes.find((node) => node.id === "composite").opacity = 1.1; }, "invalid composite");
    await negative("matte", (candidate) => { const node = candidate.nodes.find((item) => item.id === "composite"); node.matteInput = "color:base"; }, "invalid composite");
    await negative("disabled", (candidate) => { candidate.nodes.find((node) => node.id === "composite").enabled = false; }, "disabled");
    await negative("right-nested", (candidate) => { const extra = branch("extra", 0); candidate.nodes.splice(-1, 0, ...extra.nodes, { id: "right", inputs: ["color:source", extra.tail], enabled: true, kind: "composite", blendMode: "multiply", opacity: 0.5 }); candidate.nodes.find((node) => node.id === "composite").inputs[1] = "right"; }, "right-nested");
    const missingBindingsPath = join(temporary, "missing-bindings.json"); await writeFile(missingBindingsPath, JSON.stringify({ base: fixture })); await negative("missing-binding", () => {}, "missing asset binding", missingBindingsPath);
    const released = await request("engine_video_release", { sessionId: performanceSession.id }); await request("surface_release"); await request("shutdown");
    const frames = last.result.layerFrames ?? [];
    return { status: "GREEN", directExecution: performanceSession.loaded.result.engineGraph.directExecution, modeResults, opacity, pixelThresholds, oracleInput: "decoded single-layer PNG artifacts; discontinuous blend singularities are governed by p95, mean, outlier-ratio, and maximum caps", baseArtifactSha256: sha256(baseBytes), sourceArtifactSha256: sha256(sourceBytes), productPathCpuPixelCopies: Math.max(0, ...frames.flatMap((frame) => [frame.decodePathCpuPixelCopies, frame.stagingCpuPixelReadbacks, frame.nativeSurfaceCpuPixelReadbacks]).filter(Number.isFinite)), presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * 0.5)], presentP95Ms: times[Math.floor((times.length - 1) * 0.95)], rejectedNegativeControls, releaseFences: released.result.fences, bound: bound.result };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); let report = { schema: "editkin.common-engine-video-blend-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  if (!baseline) {
    try { assertGreen(report); }
    catch (error) { report = { ...report, status: "BLOCK", gateFailure: error instanceof Error ? error.message : String(error) }; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw error; }
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
}

await main();
