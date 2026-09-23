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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-grade");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const grade = { brightness: .04, contrast: 1.15, saturation: 1.2, hue: 0, exposure: .35, temperature: .25, tint: -.15, pivot: .45, shadows: .2, highlights: -.1, blacks: .1, whites: -.05 };
const identityGrade = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };

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
  const curve = (value) => { const next = points.findIndex(([x]) => x >= value); if (next < 0) return points.at(-1)[1]; if (next === 0) return points[0][1]; const [x0, y0] = points[next - 1]; const [x1, y1] = points[next]; return y0 + (y1 - y0) * ((value - x0) / Math.max(.0001, x1 - x0)); };
  const exposure = 2 ** clamp(color.exposure, -3, 3);
  let channels = rgb.map((value) => clamp(((curve(value) - color.pivot) * color.contrast + color.pivot) * exposure + color.brightness, 0, 1));
  channels[0] = clamp(channels[0] + color.temperature * .055, 0, 1); channels[1] = clamp(channels[1] + color.tint * .045, 0, 1); channels[2] = clamp(channels[2] - color.temperature * .055, 0, 1);
  const luma = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return channels.map((value) => clamp(luma + (value - luma) * color.saturation, 0, 1));
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-grade-gate/v1" || report.status !== "GREEN") throw new Error("grade report is not GREEN");
  if (!report.directExecution || report.requiredNodeIds.length !== 4 || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("grade graph coverage failed");
  if (!report.artifactChanged || report.changedPixelRatio < .5 || report.temperatureRedBlueShift < .01) throw new Error("grade artifact did not visibly change");
  if (report.cpuOracleMeanChannelError > 1.5 || report.cpuOracleP99ChannelError > 5 || report.cpuOracleMaxChannelError > 16) throw new Error("native grade diverged from the independent CPU oracle");
  if (!report.verificationReadbackIsolated || !report.visualGradeApplied || !report.gradeHandshake) throw new Error("grade execution receipt is incomplete");
  if (report.frame.decodePathCpuPixelCopies !== 0 || report.frame.stagingCpuPixelReadbacks !== 0 || report.frame.nativeSurfaceCpuPixelReadbacks !== 0) throw new Error("grade product path performed a CPU pixel transfer");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20) throw new Error("graded resident presentation missed its frame budget");
  if (report.rejectedNegativeControls.length !== 4 || report.releaseFences.pendingFenceCount !== 0) throw new Error("grade fail-closed or fence evidence is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-grade-gate/v1", status: "GREEN", directExecution: true, requiredNodeIds: ["source", "transform", "color", "output"], executedNodeIds: ["source", "transform", "color", "output"], artifactChanged: true, changedPixelRatio: .9, temperatureRedBlueShift: .04, cpuOracleMeanChannelError: .5, cpuOracleP99ChannelError: 2, cpuOracleMaxChannelError: 4, verificationReadbackIsolated: true, visualGradeApplied: true, gradeHandshake: true, frame: { decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0 }, presentedFrames: 60, presentP95Ms: 15, rejectedNegativeControls: ["hue", "contrast", "exposure", "processor"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid);
  for (const negative of [{ ...valid, changedPixelRatio: .1 }, { ...valid, cpuOracleP99ChannelError: 6 }, { ...valid, gradeHandshake: false }, { ...valid, frame: { ...valid.frame, stagingCpuPixelReadbacks: 1 } }, { ...valid, presentP95Ms: 21 }]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; } if (!rejected) throw new Error("grade evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 5 }));
}

function graphFor(selectedGrade, graphId = "video-primary-grade") {
  const timeline = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 };
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes: [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: selectedGrade },
    { id: "output", inputs: ["color"], enabled: true, kind: "output", format: "rgba16_float" },
  ], outputNode: "output" };
}

function inspectArtifacts(baseBytes, gradedBytes) {
  const base = PNG.sync.read(baseBytes); const graded = PNG.sync.read(gradedBytes); const errors = [];
  let changed = 0; let baseRedBlue = 0; let gradedRedBlue = 0; let channelCount = 0;
  for (let offset = 0; offset < base.data.length; offset += 4) {
    const source = [0, 1, 2].map((channel) => srgbToLinear(base.data[offset + channel] / 255));
    const expected = gradeLinearRgb(source, grade).map((value) => Math.round(linearToSrgb(value) * 255));
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) { const actual = graded.data[offset + channel]; errors.push(Math.abs(actual - expected[channel])); if (Math.abs(actual - base.data[offset + channel]) > 2) pixelChanged = true; channelCount += 1; }
    if (pixelChanged) changed += 1;
    baseRedBlue += (base.data[offset] - base.data[offset + 2]) / 255; gradedRedBlue += (graded.data[offset] - graded.data[offset + 2]) / 255;
  }
  errors.sort((a, b) => a - b); const pixels = base.width * base.height;
  return { changedPixelRatio: changed / pixels, temperatureRedBlueShift: (gradedRedBlue - baseRedBlue) / pixels, cpuOracleMeanChannelError: errors.reduce((sum, value) => sum + value, 0) / channelCount, cpuOracleP99ChannelError: errors[Math.floor((errors.length - 1) * .99)], cpuOracleMaxChannelError: errors.at(-1) };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-grade-")); const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve; const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); }); lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `grade-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const graph = graphFor(grade); const graphPath = join(temporary, "grade.json"); const basePath = join(temporary, "base.json"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(graphPath, JSON.stringify(graph)); await writeFile(basePath, JSON.stringify(graphFor(identityGrade, "video-primary-grade-base"))); await writeFile(bindingsPath, JSON.stringify({ video: resolve(root, "public/demo-source.mp4") }));
    if (baseline) { const observed = await request("engine_video_load", { sessionId: "grade-baseline", graphPath, bindingsPath, timelineFrame: 0 }); if (observed.ok || !String(observed.error).includes("requires identity Rec.709 color")) throw new Error(`old release did not expose grade gap: ${JSON.stringify(observed)}`); return { status: "BLOCK", reason: "decoded common-video rejects every non-identity primary grade", observedError: observed.error }; }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const baseLoaded = await request("engine_video_load", { sessionId: "grade-base", graphPath: basePath, bindingsPath, timelineFrame: 0 }); const basePng = join(temporary, "base.png"); const baseVerified = await request("engine_video_verify_frame", { sessionId: "grade-base", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: basePng }); await request("engine_video_release", { sessionId: "grade-base" });
    const loaded = await request("engine_video_load", { sessionId: "grade", graphPath, bindingsPath, timelineFrame: 0 }); const gradedPng = join(temporary, "graded.png"); const verified = await request("engine_video_verify_frame", { sessionId: "grade", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: gradedPng });
    if (!bound.ok || !baseLoaded.ok || !baseVerified.ok || !loaded.ok || !verified.ok) throw new Error(`grade verification failed: ${JSON.stringify({ bound, baseLoaded, baseVerified, loaded, verified })}`);
    const baseBytes = await readFile(basePng); const gradedBytes = await readFile(gradedPng); await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "base.png"), baseBytes); await writeFile(join(evidenceRoot, "graded.png"), gradedBytes); const artifact = inspectArtifacts(baseBytes, gradedBytes);
    const times = []; let last; for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "grade", timelineFrame: 31 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`grade present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = []; const negative = async (name, mutate, marker) => { const candidate = structuredClone(graph); mutate(candidate.nodes.find((node) => node.id === "color")); const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    await negative("hue", (node) => { node.grade.hue = 5; }, "hue"); await negative("contrast", (node) => { node.grade.contrast = 0; }, "grade bounds"); await negative("exposure", (node) => { node.grade.exposure = 4; }, "grade bounds"); await negative("processor", (node) => { node.processor = "unknown"; }, "Rec.709");
    const released = await request("engine_video_release", { sessionId: "grade" }); await request("surface_release"); await request("shutdown"); const visual = loaded.result.visualGraph; const gradeHandshake = Object.entries(grade).every(([key, value]) => Math.abs(visual[key] - value) <= .00001); const frame = last.result.frame;
    return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, requiredNodeIds: graph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds, artifactChanged: !baseBytes.equals(gradedBytes), baseArtifactSha256: sha256(baseBytes), gradedArtifactSha256: sha256(gradedBytes), ...artifact, verificationReadbackIsolated: verified.result.verificationReadback === true && verified.result.productPathCpuPixelCopies === 0, visualGradeApplied: last.result.visualGraphApplied === true, gradeHandshake, visualGraph: visual, frame, presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-grade-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
await main();
