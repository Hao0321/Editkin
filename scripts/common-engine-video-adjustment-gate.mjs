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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-adjustment");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const adjustmentRange = { timelineStartFrame: 30, sourceStartFrame: 0, durationFrames: 180 };
const grade = { brightness: .04, contrast: 1.15, saturation: 1.2, hue: 0, exposure: .35, temperature: .25, tint: -.15, pivot: .45, shadows: .2, highlights: -.1, blacks: .1, whites: -.05 };

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
function srgbToLinear(value) { return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }
function linearToSrgb(value) { const bounded = clamp(value, 0, 1); return bounded <= .0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - .055; }

function tonePoints(color) {
  const points = [[0, clamp(color.blacks * .08, 0, .18)], [.18, clamp(.18 + color.shadows * .13, .02, .42)], [.5, clamp(.5 + (.5 - color.pivot) * .26, .24, .76)], [.82, clamp(.82 + color.highlights * .13, .58, .98)], [1, clamp(1 + color.whites * .08, .82, 1)]];
  for (let index = 1; index < points.length; index += 1) points[index][1] = Math.max(points[index][1], points[index - 1][1] + .002);
  for (let index = points.length - 2; index >= 0; index -= 1) points[index][1] = Math.min(points[index][1], points[index + 1][1] - .002);
  return points.map(([x, y]) => [x, clamp(y, 0, 1)]);
}

function gradeLinearRgb(rgb, color) {
  const points = tonePoints(color);
  const curve = (value) => {
    const next = points.findIndex(([x]) => x >= value);
    if (next < 0) return points.at(-1)[1];
    if (next === 0) return points[0][1];
    const [x0, y0] = points[next - 1]; const [x1, y1] = points[next];
    return y0 + (y1 - y0) * ((value - x0) / Math.max(.0001, x1 - x0));
  };
  const exposure = 2 ** clamp(color.exposure, -3, 3);
  let channels = rgb.map((value) => clamp(((curve(value) - color.pivot) * color.contrast + color.pivot) * exposure + color.brightness, 0, 1));
  channels[0] = clamp(channels[0] + color.temperature * .055, 0, 1);
  channels[1] = clamp(channels[1] + color.tint * .045, 0, 1);
  channels[2] = clamp(channels[2] - color.temperature * .055, 0, 1);
  const luma = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return channels.map((value) => clamp(luma + (value - luma) * color.saturation, 0, 1));
}

function graph({ adjusted = true, effect = false, graphId = "video-trailing-adjustment" } = {}) {
  const contentRange = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 240 };
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: contentRange },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "base-color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "base-color";
  if (adjusted) {
    nodes.push({ id: "adjustment", inputs: [tail], enabled: true, kind: "adjustment", affectedInputs: [tail], timeline: { ...adjustmentRange } });
    tail = "adjustment";
    nodes.push({ id: "adjustment-color", inputs: [tail], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade });
    tail = "adjustment-color";
    if (effect) {
      nodes.push({ id: "adjustment-effect", inputs: [tail], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} });
      tail = "adjustment-effect";
    }
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}

function appendAdjustment(candidate, index) {
  const output = candidate.nodes.at(-1); const tail = output.inputs[0]; candidate.nodes.pop();
  candidate.nodes.push({ id: `extra-adjustment-${index}`, inputs: [tail], enabled: true, kind: "adjustment", affectedInputs: [tail], timeline: { ...adjustmentRange } });
  candidate.nodes.push({ id: `extra-color-${index}`, inputs: [`extra-adjustment-${index}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade });
  output.inputs = [`extra-color-${index}`]; candidate.nodes.push(output);
}

function inspectOracle(baseBytes, adjustedBytes) {
  const base = PNG.sync.read(baseBytes); const adjusted = PNG.sync.read(adjustedBytes);
  const errors = []; let changed = 0; let channelCount = 0;
  for (let offset = 0; offset < base.data.length; offset += 4) {
    const source = [0, 1, 2].map((channel) => srgbToLinear(base.data[offset + channel] / 255));
    const expected = gradeLinearRgb(source, grade).map((value) => Math.round(linearToSrgb(value) * 255));
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const actual = adjusted.data[offset + channel];
      errors.push(Math.abs(actual - expected[channel]));
      if (Math.abs(actual - base.data[offset + channel]) > 2) pixelChanged = true;
      channelCount += 1;
    }
    if (pixelChanged) changed += 1;
  }
  errors.sort((a, b) => a - b);
  return {
    changedPixelRatio: changed / (base.width * base.height),
    cpuOracleMeanChannelError: errors.reduce((sum, value) => sum + value, 0) / channelCount,
    cpuOracleP99ChannelError: errors[Math.floor((errors.length - 1) * .99)],
    cpuOracleMaxChannelError: errors.at(-1),
  };
}

function inspectMonochrome(bytes) {
  const png = PNG.sync.read(bytes); let maximum = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) maximum = Math.max(maximum, Math.abs(png.data[offset] - png.data[offset + 1]), Math.abs(png.data[offset + 1] - png.data[offset + 2]), Math.abs(png.data[offset] - png.data[offset + 2]));
  return maximum;
}

function timelineMatches(observed, expected) {
  return observed?.timelineStartFrame === expected.timelineStartFrame
    && observed?.sourceStartFrame === expected.sourceStartFrame
    && observed?.durationFrames === expected.durationFrames;
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-adjustment-gate/v1" || report.status !== "GREEN") throw new Error("adjustment report is not GREEN");
  if (!report.directExecution || report.compositeMode !== "video-trailing-adjustment/v1" || report.adjustmentCount !== 1) throw new Error("adjustment graph was not admitted directly");
  if (!report.coverageComplete || !report.timelineHandshake || !report.gradeHandshake || !report.effectHandshake || !report.inactivePresentHandshake) throw new Error("adjustment execution handshake is incomplete");
  if (!report.preRangeIdentity || !report.postRangeIdentity || !report.activeArtifactChanged || report.changedPixelRatio < .5) throw new Error("adjustment timeline did not bound the pixel change");
  if (report.cpuOracleMeanChannelError > 1.5 || report.cpuOracleP99ChannelError > 5 || report.cpuOracleMaxChannelError > 16) throw new Error("adjustment pixels diverged from the independent oracle");
  if (report.effectMonochromeMaxChannelError > 1) throw new Error("adjustment effect chain did not execute");
  if (!report.resourceHandshake || report.adjustmentWorkingBytes !== 4_147_200 || report.requiredBytes !== 29_030_400) throw new Error("adjustment resource plan is not closed");
  if (!report.verificationReadbackIsolated || report.presentDecodePathCpuPixelCopies !== 0 || report.presentStagingCpuPixelReadbacks !== 0 || report.presentNativeSurfaceCpuPixelReadbacks !== 0) throw new Error("adjustment product path performed a CPU pixel transfer");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20 || report.adjustmentPassCount !== 1 || report.adjustmentExecutionMode !== "trailing-full-frame/v1") throw new Error("adjustment presentation missed its native frame contract");
  if (report.rejectedNegativeControls.length !== 8 || report.releaseFences.pendingFenceCount !== 0) throw new Error("adjustment fail-closed or fence evidence is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-adjustment-gate/v1", status: "GREEN", directExecution: true, compositeMode: "video-trailing-adjustment/v1", adjustmentCount: 1, coverageComplete: true, timelineHandshake: true, gradeHandshake: true, effectHandshake: true, inactivePresentHandshake: true, preRangeIdentity: true, postRangeIdentity: true, activeArtifactChanged: true, changedPixelRatio: .9, cpuOracleMeanChannelError: .5, cpuOracleP99ChannelError: 2, cpuOracleMaxChannelError: 4, effectMonochromeMaxChannelError: 0, resourceHandshake: true, adjustmentWorkingBytes: 4_147_200, requiredBytes: 29_030_400, verificationReadbackIsolated: true, presentDecodePathCpuPixelCopies: 0, presentStagingCpuPixelReadbacks: 0, presentNativeSurfaceCpuPixelReadbacks: 0, presentedFrames: 60, presentP95Ms: 15, adjustmentPassCount: 1, adjustmentExecutionMode: "trailing-full-frame/v1", rejectedNegativeControls: Array.from({ length: 8 }, (_, index) => `negative-${index}`), releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid);
  for (const negative of [{ ...valid, preRangeIdentity: false }, { ...valid, cpuOracleP99ChannelError: 6 }, { ...valid, adjustmentWorkingBytes: 0 }, { ...valid, adjustmentExecutionMode: "none" }, { ...valid, presentDecodePathCpuPixelCopies: 1 }, { ...valid, rejectedNegativeControls: [] }]) {
    let rejected = false; try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("adjustment evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 6 }));
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-adjustment-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `adjustment-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const bindingsPath = join(temporary, "bindings.json"); const adjustedGraph = graph(); const adjustedPath = join(temporary, "adjusted.json");
    await writeFile(bindingsPath, JSON.stringify({ video: resolve(root, "public/demo-source.mp4") })); await writeFile(adjustedPath, JSON.stringify(adjustedGraph));
    if (baseline) {
      const observed = await request("engine_video_load", { sessionId: "adjustment-baseline", graphPath: adjustedPath, bindingsPath, timelineFrame: 45 });
      if (observed.ok || !String(observed.error).toLowerCase().includes("adjustment")) throw new Error(`old release did not expose adjustment gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "decoded common-video has no native trailing adjustment stage", observedError: observed.error };
    }

    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    if (!bound.ok) throw new Error(`native surface bind failed: ${JSON.stringify(bound)}`);
    const basePath = join(temporary, "base.json"); await writeFile(basePath, JSON.stringify(graph({ adjusted: false, graphId: "adjustment-control" })));
    const baseLoaded = await request("engine_video_load", { sessionId: "base", graphPath: basePath, bindingsPath, timelineFrame: 0 });
    const points = { pre: 15, active: 45, post: 220 }; const baseArtifacts = {};
    for (const [name, timelineFrame] of Object.entries(points)) {
      const outputPath = join(temporary, `base-${name}.png`); const verified = await request("engine_video_verify_frame", { sessionId: "base", timelineFrame, toleranceSeconds: 1 / 30, outputPath });
      if (!verified.ok) throw new Error(`base ${name} verification failed: ${JSON.stringify(verified)}`); baseArtifacts[name] = await readFile(outputPath);
    }
    await request("engine_video_release", { sessionId: "base" });

    const loaded = await request("engine_video_load", { sessionId: "adjusted", graphPath: adjustedPath, bindingsPath, timelineFrame: 45 });
    if (!baseLoaded.ok || !loaded.ok) throw new Error(`adjustment load failed: ${JSON.stringify({ baseLoaded, loaded })}`);
    const adjustedArtifacts = {}; const verifications = {};
    for (const [name, timelineFrame] of Object.entries(points)) {
      const outputPath = join(temporary, `adjusted-${name}.png`); const verified = await request("engine_video_verify_frame", { sessionId: "adjusted", timelineFrame, toleranceSeconds: 1 / 30, outputPath });
      if (!verified.ok) throw new Error(`adjusted ${name} verification failed: ${JSON.stringify(verified)}`); verifications[name] = verified.result; adjustedArtifacts[name] = await readFile(outputPath);
    }
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "base-active.png"), baseArtifacts.active); await writeFile(join(evidenceRoot, "adjusted-active.png"), adjustedArtifacts.active);
    const oracle = inspectOracle(baseArtifacts.active, adjustedArtifacts.active);

    const effectPath = join(temporary, "effect.json"); await writeFile(effectPath, JSON.stringify(graph({ effect: true, graphId: "adjustment-effect" })));
    const effectLoaded = await request("engine_video_load", { sessionId: "effect", graphPath: effectPath, bindingsPath, timelineFrame: 45 }); const effectOutput = join(temporary, "effect.png");
    const effectVerified = await request("engine_video_verify_frame", { sessionId: "effect", timelineFrame: 45, toleranceSeconds: 1 / 30, outputPath: effectOutput });
    if (!effectLoaded.ok || !effectVerified.ok) throw new Error(`adjustment effect verification failed: ${JSON.stringify({ effectLoaded, effectVerified })}`);
    const effectBytes = await readFile(effectOutput); await writeFile(join(evidenceRoot, "adjusted-effect-active.png"), effectBytes); await request("engine_video_release", { sessionId: "effect" });

    const inactivePresented = await request("engine_video_present_frame", { sessionId: "adjusted", timelineFrame: points.pre, toleranceSeconds: 1 / 30 });
    const postPresented = await request("engine_video_present_frame", { sessionId: "adjusted", timelineFrame: points.post, toleranceSeconds: 1 / 30 });
    if (!inactivePresented.ok || !postPresented.ok) throw new Error(`inactive adjustment present failed: ${JSON.stringify({ inactivePresented, postPresented })}`);
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "adjusted", timelineFrame: 46 + index, toleranceSeconds: 1 / 30 });
      if (!last.ok) throw new Error(`adjustment present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);

    const rejectedNegativeControls = [];
    const negative = async (name, candidate, marker) => {
      const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 45 });
      if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`);
      rejectedNegativeControls.push(name);
    };
    let candidate = graph(); delete candidate.nodes.find((node) => node.id === "adjustment").timeline; await negative("missing-timeline", candidate, "timeline");
    candidate = graph(); candidate.nodes.find((node) => node.id === "adjustment").affectedInputs = ["source"]; await negative("wrong-target", candidate, "target exactly");
    candidate = graph(); candidate.nodes.find((node) => node.id === "adjustment-color").processor = "aces-1.3"; await negative("aces-processor", candidate, "adjustment color processor");
    candidate = graph({ effect: true }); candidate.nodes.find((node) => node.id === "adjustment-effect").pluginId = "third.party.unknown"; await negative("unknown-effect", candidate, "missing GPU effect binding");
    candidate = graph({ effect: true }); candidate.nodes.find((node) => node.id === "adjustment-effect").temporalRadius = 1; await negative("temporal-effect", candidate, "effect contract");
    candidate = graph(); candidate.nodes.find((node) => node.id === "adjustment").timeline.durationFrames = 0; await negative("zero-duration", candidate, "no targets");
    candidate = graph(); for (let index = 0; index < 4; index += 1) appendAdjustment(candidate, index); await negative("five-adjustments", candidate, "at most 4");
    candidate = graph(); const output = candidate.nodes.pop(); const adjustmentColor = candidate.nodes.find((node) => node.id === "adjustment-color"); candidate.nodes.push({ id: "non-trailing-composite", inputs: ["base-color", adjustmentColor.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 }); output.inputs = ["non-trailing-composite"]; candidate.nodes.push(output); await negative("non-trailing", candidate, "adjustment");

    const released = await request("engine_video_release", { sessionId: "adjusted" }); await request("surface_release"); await request("shutdown");
    const loadAdjustment = loaded.result.adjustments[0]; const activeAdjustment = verifications.active.activeAdjustments[0]; const frame = last.result.frame; const resource = loaded.result.resourcePlan;
    const requiredNodeIds = adjustedGraph.nodes.map((node) => node.id); const executedNodeIds = loaded.result.engineGraph.executedNodeIds;
    return {
      status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, requiredNodeIds, executedNodeIds, coverageComplete: requiredNodeIds.every((id) => executedNodeIds.includes(id)),
      compositeMode: loaded.result.compositeMode, adjustmentCount: loaded.result.adjustmentCount,
      timelineHandshake: timelineMatches(loadAdjustment.timeline, adjustmentRange) && timelineMatches(activeAdjustment.timeline, adjustmentRange) && verifications.pre.adjustmentPassCount === 0 && verifications.active.adjustmentPassCount === 1 && verifications.post.adjustmentPassCount === 0,
      gradeHandshake: Object.entries(grade).every(([key, value]) => Math.abs(loadAdjustment.visualGraph[key] - value) <= .00001),
      effectHandshake: effectLoaded.result.adjustments[0].visualGraph.effectKind === 1 && effectVerified.result.adjustmentPassCount === 1,
      inactivePresentHandshake: [inactivePresented, postPresented].every((response) => response.result.adjustmentPassCount === 0 && response.result.activeAdjustments?.length === 0 && (response.result.surface?.adjustmentExecutionMode === undefined || response.result.surface?.adjustmentExecutionMode === "none") && (response.result.surface?.adjustmentPassCount === undefined || response.result.surface?.adjustmentPassCount === 0)),
      inactivePresentDiagnostics: [inactivePresented, postPresented].map((response) => ({ adjustmentPassCount: response.result.adjustmentPassCount, activeAdjustmentCount: response.result.activeAdjustments?.length, surface: response.result.surface })),
      preRangeIdentity: baseArtifacts.pre.equals(adjustedArtifacts.pre), postRangeIdentity: baseArtifacts.post.equals(adjustedArtifacts.post), activeArtifactChanged: !baseArtifacts.active.equals(adjustedArtifacts.active),
      baseActiveSha256: sha256(baseArtifacts.active), adjustedActiveSha256: sha256(adjustedArtifacts.active), effectActiveSha256: sha256(effectBytes), ...oracle, effectMonochromeMaxChannelError: inspectMonochrome(effectBytes),
      verificationReadbackIsolated: verifications.active.verificationReadback === true && verifications.active.productPathCpuPixelCopies === 0,
      resourceHandshake: resource.adjustmentCount === 1 && resource.videoLayerCount === 1 && resource.adjustmentWorkingBytes === 4_147_200 && resource.requiredBytes === 29_030_400,
      adjustmentWorkingBytes: resource.adjustmentWorkingBytes, requiredBytes: resource.requiredBytes,
      adjustmentExecutionMode: last.result.surface.adjustmentExecutionMode, adjustmentPassCount: last.result.adjustmentPassCount,
      presentDecodePathCpuPixelCopies: frame.decodePathCpuPixelCopies, presentStagingCpuPixelReadbacks: frame.stagingCpuPixelReadbacks, presentNativeSurfaceCpuPixelReadbacks: frame.nativeSurfaceCpuPixelReadbacks,
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences, bound: bound.result,
    };
  } finally {
    lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); const report = { schema: "editkin.common-engine-video-adjustment-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2));
}

await main();
