import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-animation");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const fixture = resolve(root, "public/demo-source.mp4");

const base = { x: -180, y: -60, scaleX: .55, scaleY: .55, rotationRadians: -.12, opacity: .35 };
const keyframes = [
  { frame: 30, x: 0, y: 80, scaleX: .85, scaleY: .85, rotationRadians: .12, opacity: .75, easing: "ease_in_out" },
  { frame: 60, x: 180, y: -40, scaleX: .45, scaleY: .45, rotationRadians: -.08, opacity: .5, easing: "hold" },
];
const sampleFrames = [0, 15, 30, 45, 60, 75];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function close(actual, expected, epsilon = .00001) { return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon; }
function easingProgress(ratio, easing) {
  const value = Math.max(0, Math.min(1, ratio));
  if (easing === "hold") return 0;
  if (easing === "ease_in") return value * value;
  if (easing === "ease_out") return 1 - (1 - value) * (1 - value);
  if (easing === "ease_in_out") return value < .5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
  if (easing === "spring_soft") return Math.max(0, Math.min(1.08, 1 - Math.exp(-6 * value) * Math.cos(8 * value)));
  return value;
}
function expectedVisual(frame) {
  const points = [{ frame: 0, ...base, easing: "linear" }, ...keyframes];
  const nextIndex = points.findIndex((point) => point.frame >= frame);
  if (nextIndex < 0) return points.at(-1);
  if (nextIndex === 0) return points[0];
  const previous = points[nextIndex - 1]; const next = points[nextIndex];
  if (previous.easing === "hold" || next.frame === previous.frame) return previous;
  const ratio = easingProgress((frame - previous.frame) / (next.frame - previous.frame), previous.easing);
  return Object.fromEntries(Object.keys(base).map((key) => [key, previous[key] + (next[key] - previous[key]) * ratio]));
}
function graphFor(selectedKeyframes = keyframes, graphId = "video-transform-animation") {
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes: [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 90 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", ...base, keyframes: selectedKeyframes },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 } },
    { id: "output", inputs: ["color"], enabled: true, kind: "output", format: "rgba16_float" },
  ], outputNode: "output" };
}
function imageStats(bytes) {
  const png = PNG.sync.read(bytes); let count = 0; let sumX = 0; let sumY = 0; let minX = png.width; let minY = png.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
    const offset = (y * png.width + x) * 4; const energy = png.data[offset] + png.data[offset + 1] + png.data[offset + 2];
    if (energy <= 24) continue; count += 1; sumX += x; sumY += y; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { activePixels: count, centroidX: count ? sumX / count : null, centroidY: count ? sumY / count : null, bounds: count ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : null };
}
function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-animation-gate/v1" || report.status !== "GREEN") throw new Error("animation report is not GREEN");
  if (!report.directExecution || report.requiredNodeIds.length !== 4 || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("animation graph coverage failed");
  if (!report.dynamicVisualHandshake || report.samples.length !== sampleFrames.length || report.samples.some((sample) => !sample.matchesOracle)) throw new Error("dynamic visual receipt diverged from oracle");
  if (report.uniqueArtifactCount < 5 || report.minimumAnimatedChangedPixelRatio < .04 || !report.centroidMovesRight) throw new Error("animation artifact did not prove spatial motion");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20) throw new Error("animated presentation missed frame budget");
  if (report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 5 || report.releaseFences.pendingFenceCount !== 0) throw new Error("animation fail-closed or zero-copy evidence is incomplete");
}
function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-animation-gate/v1", status: "GREEN", directExecution: true, requiredNodeIds: ["source", "transform", "color", "output"], executedNodeIds: ["source", "transform", "color", "output"], dynamicVisualHandshake: true, samples: sampleFrames.map((frame) => ({ frame, matchesOracle: true })), uniqueArtifactCount: 6, minimumAnimatedChangedPixelRatio: .1, centroidMovesRight: true, presentedFrames: 60, presentP95Ms: 15, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["order", "duplicate", "count", "easing", "opacity"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, dynamicVisualHandshake: false }, { ...valid, uniqueArtifactCount: 3 }, { ...valid, minimumAnimatedChangedPixelRatio: .01 }, { ...valid, presentP95Ms: 21 }, { ...valid, productPathCpuPixelCopies: 1 }]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("animation evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: "editkin.common-engine-video-animation-gate/v1", calibratedNegatives }));
}
function changedPixelRatio(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes); let changed = 0; const pixels = left.width * left.height;
  for (let pixel = 0; pixel < pixels; pixel += 1) { const offset = pixel * 4; if ([0, 1, 2, 3].some((channel) => Math.abs(left.data[offset + channel] - right.data[offset + channel]) > 2)) changed += 1; }
  return changed / pixels;
}
async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-animation-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve; const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `animation-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const graph = graphFor(); const graphPath = join(temporary, "animation.json"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(graphPath, JSON.stringify(graph)); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); const loaded = await request("engine_video_load", { sessionId: "animation", graphPath, bindingsPath, timelineFrame: 0 });
    if (!loaded.ok) throw new Error(`animation load failed: ${JSON.stringify(loaded)}`);
    if (baseline) {
      const first = await request("engine_video_present_frame", { sessionId: "animation", timelineFrame: 30, toleranceSeconds: 1 / 30 }); const later = await request("engine_video_present_frame", { sessionId: "animation", timelineFrame: 45, toleranceSeconds: 1 / 30 });
      await request("engine_video_release", { sessionId: "animation" }); await request("surface_release"); await request("shutdown");
      const silentlyStatic = later.ok && close(loaded.result.visualGraph.translateX, base.x) && close(later.result.visualGraph?.translateX, base.x);
      return { status: "BLOCK", reason: "decoded common-video silently projects transform keyframes to the static base transform", silentlyStatic, loadVisualGraph: loaded.result.visualGraph, firstOk: first.ok, firstError: first.error, firstVisualGraph: first.result?.visualGraph, laterOk: later.ok, laterError: later.error, laterVisualGraph: later.result?.visualGraph };
    }
    if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const samples = []; const artifacts = []; const stats = [];
    for (const frame of sampleFrames) {
      const outputPath = join(temporary, `frame-${frame}.png`); const verified = await request("engine_video_verify_frame", { sessionId: "animation", timelineFrame: frame, toleranceSeconds: 1 / 30, outputPath });
      if (!verified.ok) throw new Error(`animation verify failed at ${frame}: ${JSON.stringify(verified)}`);
      const bytes = await readFile(outputPath); const expected = expectedVisual(frame); const observed = verified.result.visualGraph;
      const matchesOracle = ["x", "y", "scaleX", "rotationRadians", "opacity"].every((key) => close(observed[key === "x" ? "translateX" : key === "y" ? "translateY" : key === "scaleX" ? "scale" : key === "rotationRadians" ? "rotation" : key], expected[key]));
      samples.push({ frame, expected, observed, matchesOracle }); artifacts.push(bytes); stats.push({ frame, ...imageStats(bytes), sha256: sha256(bytes) });
    }
    await mkdir(evidenceRoot, { recursive: true }); for (let index = 0; index < artifacts.length; index += 1) await writeFile(join(evidenceRoot, `frame-${sampleFrames[index]}.png`), artifacts[index]);
    const adjacentChangedPixelRatios = artifacts.slice(1).map((bytes, index) => changedPixelRatio(artifacts[index], bytes));
    const times = []; let last; for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "animation", timelineFrame: index % 76, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`animation present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    async function negative(name, selectedKeyframes, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graphFor(selectedKeyframes, `negative-${name}`))); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("order", [keyframes[1], keyframes[0]], "strictly increasing");
    await negative("duplicate", [{ ...keyframes[0] }, { ...keyframes[1], frame: 30 }], "strictly increasing");
    await negative("count", Array.from({ length: 65 }, (_, frame) => ({ ...keyframes[0], frame })), "at most 64");
    await negative("easing", [{ ...keyframes[0], easing: "elastic" }], "parse");
    await negative("opacity", [{ ...keyframes[0], opacity: 1.1 }], "invalid 2d transform keyframe");
    const released = await request("engine_video_release", { sessionId: "animation" }); await request("surface_release"); await request("shutdown");
    const productPathCpuPixelCopies = Math.max(...samples.map((sample) => sample.observed ? 0 : 1), last.result.frame.decodePathCpuPixelCopies, last.result.frame.stagingCpuPixelReadbacks, last.result.frame.nativeSurfaceCpuPixelReadbacks);
    return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, requiredNodeIds: graph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds, dynamicVisualHandshake: samples.every((sample) => sample.matchesOracle), samples, artifacts: stats, uniqueArtifactCount: new Set(stats.map((item) => item.sha256)).size, adjacentChangedPixelRatios, minimumAdjacentChangedPixelRatio: Math.min(...adjacentChangedPixelRatios), minimumAnimatedChangedPixelRatio: Math.min(...adjacentChangedPixelRatios.slice(0, 4)), centroidMovesRight: stats[0].centroidX < stats[2].centroidX && stats[2].centroidX < stats[4].centroidX, presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], productPathCpuPixelCopies, rejectedNegativeControls, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-animation-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
