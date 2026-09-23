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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-parenting");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const timelineFrames = [15, 45, 75];
const thresholds = { maxChannelError: 3, p99MaxChannelError: 1, meanMaxChannelError: .15, transformEpsilon: .0001 };

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function same(value, expected, epsilon = thresholds.transformEpsilon) { return Number.isFinite(value) && Math.abs(value - expected) <= epsilon; }
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
  if (report.schema !== "editkin.common-engine-video-parenting-gate/v1" || report.status !== "GREEN") throw new Error("parenting report is not GREEN");
  if (!report.directExecution || report.compositeMode !== "typed-parent-transform/v1" || report.layerCount !== 2 || report.decoderBindingCount !== 2 || report.parentCount !== 1) throw new Error("typed parent execution coverage is incomplete");
  if (report.parentReceipt.transformNodeId !== "transform:child" || report.parentReceipt.parentTransformNodeId !== "transform:parent" || report.parentReceipt.parentLayerIndex !== 0 || report.parentReceipt.parentDepth !== 1) throw new Error("parent relationship receipt is incomplete");
  if (report.frameResults.length !== timelineFrames.length || report.frameResults.some((item) => item.pixels !== 960 * 540 || item.maxChannelError > thresholds.maxChannelError || item.p99MaxChannelError > thresholds.p99MaxChannelError || item.meanMaxChannelError > thresholds.meanMaxChannelError || item.transformOracleMaxError > thresholds.transformEpsilon)) throw new Error("parented pixels or sampled transform diverge from the flattened oracle");
  if (report.productPathCpuPixelCopies !== 0 || report.presentedFrames < 60 || report.presentP95Ms > 1000 / 30) throw new Error("parent path missed zero-copy or 30 fps budget");
  if (report.rejectedNegativeControls.length !== 6 || report.releaseFences.pendingFenceCount !== 0) throw new Error("parent fail-closed or release evidence is incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.executableSha256) || report.frameResults.some((item) => !/^[0-9a-f]{64}$/.test(item.parentedArtifactSha256) || !/^[0-9a-f]{64}$/.test(item.flattenedArtifactSha256))) throw new Error("parent evidence identity is incomplete");
}

function syntheticSelfTest() {
  const frameResults = timelineFrames.map((timelineFrame) => ({ timelineFrame, pixels: 960 * 540, maxChannelError: 1, p99MaxChannelError: 1, meanMaxChannelError: .05, transformOracleMaxError: .00001, parentedArtifactSha256: "a".repeat(64), flattenedArtifactSha256: "b".repeat(64) }));
  const valid = { schema: "editkin.common-engine-video-parenting-gate/v1", status: "GREEN", directExecution: true, compositeMode: "typed-parent-transform/v1", layerCount: 2, decoderBindingCount: 2, parentCount: 1,
    parentReceipt: { transformNodeId: "transform:child", parentTransformNodeId: "transform:parent", parentLayerIndex: 0, parentDepth: 1 }, frameResults,
    productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 20, rejectedNegativeControls: [1, 2, 3, 4, 5, 6], releaseFences: { pendingFenceCount: 0 }, executableSha256: "c".repeat(64) };
  assertGreen(valid);
  const negatives = [{ ...valid, parentCount: 0 }, { ...valid, parentReceipt: { ...valid.parentReceipt, parentDepth: 0 } }, { ...valid, frameResults: frameResults.map((item, index) => index ? item : { ...item, p99MaxChannelError: 2 }) }, { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, presentP95Ms: 34 }, { ...valid, rejectedNegativeControls: [] }];
  for (const candidate of negatives) { let rejected = false; try { assertGreen(candidate); } catch { rejected = true; } if (!rejected) throw new Error("parenting evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length }));
}

const grade = (overrides = {}) => ({ brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0, ...overrides });
const range = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 };
const parentBase = { x: 80, y: -35, scaleX: .8, rotationRadians: .2, opacity: .9 };
const childBase = { x: -70, y: 55, scaleX: .45, rotationRadians: -.1, opacity: .8 };
const parentKeys = [{ frame: 45, x: 120, y: 20, scaleX: .7, rotationRadians: .35, opacity: .75, easing: "linear" }, { frame: 90, x: -40, y: 60, scaleX: .9, rotationRadians: -.15, opacity: .85, easing: "linear" }];
const childKeys = [{ frame: 30, x: 40, y: -25, scaleX: .6, rotationRadians: .05, opacity: .65, easing: "linear" }, { frame: 75, x: -20, y: 80, scaleX: .35, rotationRadians: .25, opacity: .9, easing: "linear" }];

function sample(base, keyframes, frame) {
  const points = [{ frame: 0, ...base }, ...keyframes];
  const nextIndex = points.findIndex((point) => point.frame >= frame);
  if (nextIndex < 0) return points.at(-1);
  if (nextIndex === 0) return points[0];
  const previous = points[nextIndex - 1]; const next = points[nextIndex];
  const ratio = (frame - previous.frame) / (next.frame - previous.frame);
  return Object.fromEntries(["x", "y", "scaleX", "rotationRadians", "opacity"].map((key) => [key, previous[key] + (next[key] - previous[key]) * ratio]));
}
function compose(parent, child) {
  const cosine = Math.cos(parent.rotationRadians); const sine = Math.sin(parent.rotationRadians);
  return { x: parent.x + (child.x * cosine - child.y * sine) * parent.scaleX, y: parent.y + (child.x * sine + child.y * cosine) * parent.scaleX,
    scaleX: parent.scaleX * child.scaleX, rotationRadians: parent.rotationRadians + child.rotationRadians, opacity: parent.opacity * child.opacity };
}
function transformNode(id, input, values, keyframes = [], parent) {
  return { id: `transform:${id}`, inputs: [input], enabled: true, kind: "transform2d", x: values.x, y: values.y, scaleX: values.scaleX, scaleY: values.scaleX, rotationRadians: values.rotationRadians, opacity: values.opacity,
    ...(keyframes.length ? { keyframes: keyframes.map((item) => ({ ...item, scaleY: item.scaleX })) } : {}), ...(parent ? { parent } : {}) };
}
function branch(id, sourceStartFrame, transform, keyframes = [], parent, colorGrade = grade()) {
  return { tail: `color:${id}`, nodes: [
    { id: `source:${id}`, inputs: [], enabled: true, kind: "source", assetId: id, mediaKind: "video", inputColorSpace: "rec709", timeline: { ...range, sourceStartFrame } },
    transformNode(id, `source:${id}`, transform, keyframes, parent),
    { id: `color:${id}`, inputs: [`transform:${id}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: colorGrade },
  ] };
}
function graphHeader(graphId, nodes, outputNode = "output", cacheBudgetMb = 96) { return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb, nodes, outputNode }; }
function twoLayerGraph(frame, parented) {
  const parentSample = sample(parentBase, parentKeys, frame); const childSample = sample(childBase, childKeys, frame); const flattened = compose(parentSample, childSample);
  const parent = branch("parent", 0, parented ? parentBase : parentSample, parented ? parentKeys : [], undefined, grade({ brightness: .02, contrast: 1.08 }));
  const child = branch("child", 24, parented ? childBase : flattened, parented ? childKeys : [], parented ? "transform:parent" : undefined, grade({ saturation: .82, exposure: .12 }));
  return graphHeader(parented ? "typed-parent-transform" : `flattened-parent-oracle-${frame}`, [...parent.nodes, ...child.nodes,
    { id: "composite", inputs: [parent.tail, child.tail], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
    { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" }]);
}
function depthFiveGraph() {
  const candidate = twoLayerGraph(30, true); candidate.cacheBudgetMb = 192;
  candidate.nodes = candidate.nodes.filter((node) => !["composite", "output"].includes(node.id));
  let parentId; const tails = [];
  for (let index = 3; index >= 0; index -= 1) {
    const ancestor = branch(`ancestor-${index}`, index * 3, { x: 2 * index, y: -3 * index, scaleX: .95, rotationRadians: .01 * index, opacity: .98 }, [], parentId);
    candidate.nodes.push(...ancestor.nodes); tails.unshift(ancestor.tail); parentId = `transform:ancestor-${index}`;
  }
  candidate.nodes.find((node) => node.id === "transform:parent").parent = parentId;
  tails.push("color:parent", "color:child");
  let composite = tails[0];
  for (let index = 1; index < tails.length; index += 1) { const id = `depth-composite-${index}`; candidate.nodes.push({ id, inputs: [composite, tails[index]], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 }); composite = id; }
  candidate.nodes.push({ id: "output", inputs: [composite], enabled: true, kind: "output", format: "rgba16_float" });
  return candidate;
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-parenting-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `parent-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const fixture = resolve(root, "public/demo-source.mp4"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ parent: fixture, child: fixture, ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`ancestor-${index}`, fixture])) }));
    if (baseline) {
      const path = join(temporary, "baseline.json"); await writeFile(path, JSON.stringify(twoLayerGraph(30, true)));
      const observed = await request("engine_video_load", { sessionId: "baseline", graphPath: path, bindingsPath, timelineFrame: 30 });
      if (observed.ok || !String(observed.error).includes("unsupported common video transform parent")) throw new Error(`old binary did not expose the parent gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "native decoded-video graph rejected typed transform parenting", observedError: observed.error };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    await mkdir(evidenceRoot, { recursive: true }); const frameResults = []; let performanceSession; let parentReceipt;
    const verify = async (id, candidate, frame) => { const graphPath = join(temporary, `${id}.json`); const outputPath = join(temporary, `${id}.png`); await writeFile(graphPath, JSON.stringify(candidate)); const loaded = await request("engine_video_load", { sessionId: id, graphPath, bindingsPath, timelineFrame: frame }); const verified = loaded.ok ? await request("engine_video_verify_frame", { sessionId: id, timelineFrame: frame, toleranceSeconds: 1 / 30, outputPath }) : undefined; if (!loaded.ok || !verified?.ok) throw new Error(`${id} verify failed: ${JSON.stringify({ loaded, verified })}`); return { loaded, verified, bytes: await readFile(outputPath) }; };
    for (const frame of timelineFrames) {
      const parented = await verify(`parented-${frame}`, twoLayerGraph(frame, true), frame); const flattened = await verify(`flattened-${frame}`, twoLayerGraph(frame, false), frame);
      const parentedPath = join(evidenceRoot, `parented-${frame}.png`); const flattenedPath = join(evidenceRoot, `flattened-${frame}.png`); await writeFile(parentedPath, parented.bytes); await writeFile(flattenedPath, flattened.bytes);
      const expected = compose(sample(parentBase, parentKeys, frame), sample(childBase, childKeys, frame)); const visual = parented.verified.result.visualLayers[1];
      const transformOracleMaxError = Math.max(Math.abs(visual.translateX - expected.x), Math.abs(visual.translateY - expected.y), Math.abs(visual.scale - expected.scaleX), Math.abs(visual.rotation - expected.rotationRadians), Math.abs(visual.opacity - expected.opacity));
      frameResults.push({ timelineFrame: frame, parentedArtifactSha256: sha256(parented.bytes), flattenedArtifactSha256: sha256(flattened.bytes), transformOracleMaxError, ...comparePixels(PNG.sync.read(parented.bytes).data, PNG.sync.read(flattened.bytes).data) });
      await request("engine_video_release", { sessionId: `flattened-${frame}` });
      if (frame === timelineFrames[1]) { performanceSession = { id: `parented-${frame}`, loaded: parented.loaded }; parentReceipt = parented.loaded.result.layers[1]; } else await request("engine_video_release", { sessionId: `parented-${frame}` });
    }
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: performanceSession.id, timelineFrame: 30 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`parent present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, candidate, marker) => { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 30 }); if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    { const candidate = twoLayerGraph(30, true); candidate.nodes.find((node) => node.id === "transform:child").parent = "transform:missing"; await negative("missing", candidate, "missing parent"); }
    { const candidate = twoLayerGraph(30, true); candidate.nodes.find((node) => node.id === "transform:child").parent = "source:parent"; await negative("non-transform", candidate, "visible resident video transform"); }
    { const candidate = twoLayerGraph(30, true); candidate.nodes.find((node) => node.id === "transform:child").parent = "transform:child"; await negative("self", candidate, "cycle"); }
    { const candidate = twoLayerGraph(30, true); candidate.nodes.find((node) => node.id === "transform:parent").parent = "transform:child"; await negative("cycle", candidate, "cycle"); }
    { const candidate = twoLayerGraph(30, true); candidate.nodes.find((node) => node.id === "source:parent").timeline.durationFrames = 40; candidate.nodes.find((node) => node.id === "transform:parent").keyframes = []; await negative("uncovered", candidate, "fully cover"); }
    await negative("depth-five", depthFiveGraph(), "depth 4");
    const released = await request("engine_video_release", { sessionId: performanceSession.id }); await request("surface_release"); await request("shutdown");
    const frames = last.result.layerFrames ?? [];
    return { status: "GREEN", directExecution: performanceSession.loaded.result.engineGraph.directExecution, compositeMode: performanceSession.loaded.result.compositeMode,
      layerCount: performanceSession.loaded.result.layerCount, decoderBindingCount: 2, parentCount: performanceSession.loaded.result.parentCount, parentReceipt, frameResults, thresholds,
      productPathCpuPixelCopies: Math.max(0, ...frames.flatMap((frame) => [frame.decodePathCpuPixelCopies, frame.stagingCpuPixelReadbacks, frame.nativeSurfaceCpuPixelReadbacks]).filter(Number.isFinite)),
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences, bound: bound.result };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); let report = { schema: "editkin.common-engine-video-parenting-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  if (!baseline) { try { assertGreen(report); } catch (error) { report = { ...report, status: "BLOCK", gateFailure: error instanceof Error ? error.message : String(error) }; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw error; } }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
}
await main();
