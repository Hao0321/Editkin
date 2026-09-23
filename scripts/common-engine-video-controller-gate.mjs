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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-controller");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const timelineFrames = [15, 45, 75];
const thresholds = { maxChannelError: 3, p99MaxChannelError: 1, meanMaxChannelError: .15, transformEpsilon: .0001 };

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
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
  if (report.schema !== "editkin.common-engine-video-controller-gate/v1" || report.status !== "GREEN") throw new Error("controller report is not GREEN");
  if (!report.directExecution || report.compositeMode !== "typed-controller-parent/v1" || report.layerCount !== 1 || report.decoderBindingCount !== 1 || report.controllerCount !== 1 || report.parentCount !== 1) throw new Error("controller execution coverage is incomplete");
  if (report.parentReceipt.transformNodeId !== "transform:child" || report.parentReceipt.parentTransformNodeId !== "transform:controller" || report.parentReceipt.parentLayerIndex !== null || report.parentReceipt.parentControllerIndex !== 0 || report.parentReceipt.parentDepth !== 1) throw new Error("controller parent receipt is incomplete");
  if (report.controllerReceipt.transformNodeId !== "transform:controller" || report.controllerReceipt.parentDepth !== 0) throw new Error("controller identity receipt is incomplete");
  if (report.frameResults.length !== timelineFrames.length || report.frameResults.some((item) => item.pixels !== 960 * 540 || item.maxChannelError > thresholds.maxChannelError || item.p99MaxChannelError > thresholds.p99MaxChannelError || item.meanMaxChannelError > thresholds.meanMaxChannelError || item.transformOracleMaxError > thresholds.transformEpsilon)) throw new Error("controller pixels or transform oracle diverged");
  if (report.resourceBytesDelta !== 0 || report.productPathCpuPixelCopies !== 0 || report.presentedFrames < 60 || report.presentP95Ms > 1000 / 30) throw new Error("controller path allocated video resources, copied pixels or missed 30 fps");
  if (report.rejectedNegativeControls.length !== 5 || report.releaseFences.pendingFenceCount !== 0) throw new Error("controller fail-closed or release evidence is incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.executableSha256) || report.frameResults.some((item) => !/^[0-9a-f]{64}$/.test(item.parentedArtifactSha256) || !/^[0-9a-f]{64}$/.test(item.flattenedArtifactSha256))) throw new Error("controller evidence identity is incomplete");
}
function syntheticSelfTest() {
  const frameResults = timelineFrames.map((timelineFrame) => ({ timelineFrame, pixels: 960 * 540, maxChannelError: 1, p99MaxChannelError: 1, meanMaxChannelError: .05, transformOracleMaxError: .00001, parentedArtifactSha256: "a".repeat(64), flattenedArtifactSha256: "b".repeat(64) }));
  const valid = { schema: "editkin.common-engine-video-controller-gate/v1", status: "GREEN", directExecution: true, compositeMode: "typed-controller-parent/v1", layerCount: 1, decoderBindingCount: 1, controllerCount: 1, parentCount: 1,
    parentReceipt: { transformNodeId: "transform:child", parentTransformNodeId: "transform:controller", parentLayerIndex: null, parentControllerIndex: 0, parentDepth: 1 }, controllerReceipt: { transformNodeId: "transform:controller", parentDepth: 0 }, frameResults,
    resourceBytesDelta: 0, productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 20, rejectedNegativeControls: [1, 2, 3, 4, 5], releaseFences: { pendingFenceCount: 0 }, executableSha256: "c".repeat(64) };
  assertGreen(valid);
  const negatives = [{ ...valid, controllerCount: 0 }, { ...valid, parentReceipt: { ...valid.parentReceipt, parentControllerIndex: null } }, { ...valid, resourceBytesDelta: 1 }, { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, presentP95Ms: 34 }, { ...valid, rejectedNegativeControls: [] }];
  for (const candidate of negatives) { let rejected = false; try { assertGreen(candidate); } catch { rejected = true; } if (!rejected) throw new Error("controller evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length }));
}

const grade = { brightness: 0, contrast: 1, saturation: .86, hue: 0, exposure: .12, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
const range = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 };
const controllerBase = { x: 80, y: -35, scaleX: .8, rotationRadians: .2, opacity: .9 };
const childBase = { x: -70, y: 55, scaleX: .45, rotationRadians: -.1, opacity: .8 };
const controllerKeys = [{ frame: 45, x: 120, y: 20, scaleX: .7, rotationRadians: .35, opacity: .75, easing: "linear" }, { frame: 90, x: -40, y: 60, scaleX: .9, rotationRadians: -.15, opacity: .85, easing: "linear" }];
const childKeys = [{ frame: 30, x: 40, y: -25, scaleX: .6, rotationRadians: .05, opacity: .65, easing: "linear" }, { frame: 75, x: -20, y: 80, scaleX: .35, rotationRadians: .25, opacity: .9, easing: "linear" }];
function sample(base, keyframes, frame) {
  const points = [{ frame: 0, ...base }, ...keyframes]; const nextIndex = points.findIndex((point) => point.frame >= frame);
  if (nextIndex < 0) return points.at(-1); if (nextIndex === 0) return points[0];
  const previous = points[nextIndex - 1]; const next = points[nextIndex]; const ratio = (frame - previous.frame) / (next.frame - previous.frame);
  return Object.fromEntries(["x", "y", "scaleX", "rotationRadians", "opacity"].map((key) => [key, previous[key] + (next[key] - previous[key]) * ratio]));
}
function compose(parent, child) {
  const cosine = Math.cos(parent.rotationRadians); const sine = Math.sin(parent.rotationRadians);
  return { x: parent.x + (child.x * cosine - child.y * sine) * parent.scaleX, y: parent.y + (child.x * sine + child.y * cosine) * parent.scaleX, scaleX: parent.scaleX * child.scaleX, rotationRadians: parent.rotationRadians + child.rotationRadians, opacity: parent.opacity * child.opacity };
}
function transformNode(id, input, values, keyframes = [], parent) {
  return { id: `transform:${id}`, inputs: [input], enabled: true, kind: "transform2d", x: values.x, y: values.y, scaleX: values.scaleX, scaleY: values.scaleX, rotationRadians: values.rotationRadians, opacity: values.opacity,
    ...(keyframes.length ? { keyframes: keyframes.map((item) => ({ ...item, scaleY: item.scaleX })) } : {}), ...(parent ? { parent } : {}) };
}
function graph(frame, controlled) {
  const flattened = compose(sample(controllerBase, controllerKeys, frame), sample(childBase, childKeys, frame));
  const childValues = controlled ? childBase : flattened;
  const nodes = [];
  if (controlled) nodes.push(
    { id: "source:controller", inputs: [], enabled: true, kind: "source", assetId: "editkin.generator.null", mediaKind: "generator", inputColorSpace: "rec709", timeline: { ...range } },
    transformNode("controller", "source:controller", controllerBase, controllerKeys),
  );
  nodes.push(
    { id: "source:child", inputs: [], enabled: true, kind: "source", assetId: "child", mediaKind: "video", inputColorSpace: "rec709", timeline: { ...range, sourceStartFrame: 24 } },
    transformNode("child", "source:child", childValues, controlled ? childKeys : [], controlled ? "transform:controller" : undefined),
    { id: "color:child", inputs: ["transform:child"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade },
    { id: "output", inputs: ["color:child"], enabled: true, kind: "output", format: "rgba16_float" },
  );
  return { schema: "editkin.engine-graph/v1", graphId: controlled ? "typed-null-controller" : `flattened-controller-oracle-${frame}`, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}
function badControllerGraph(kind) {
  const candidate = graph(30, true); const controller = candidate.nodes.find((node) => node.id === "transform:controller"); const child = candidate.nodes.find((node) => node.id === "transform:child");
  if (kind === "wrong-generator") candidate.nodes.find((node) => node.id === "source:controller").assetId = "editkin.generator.unknown";
  if (kind === "self") controller.parent = controller.id;
  if (kind === "cycle") controller.parent = child.id;
  if (kind === "uncovered") { candidate.nodes.find((node) => node.id === "source:controller").timeline.durationFrames = 20; controller.keyframes = []; }
  if (kind === "effect") candidate.nodes.splice(candidate.nodes.indexOf(controller) + 1, 0, { id: "effect:controller", inputs: [controller.id], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} });
  return candidate;
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-controller-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `controller-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const fixture = resolve(root, "public/demo-source.mp4"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ child: fixture }));
    if (baseline) {
      const path = join(temporary, "baseline.json"); await writeFile(path, JSON.stringify(graph(30, true)));
      const observed = await request("engine_video_load", { sessionId: "baseline", graphPath: path, bindingsPath, timelineFrame: 30 });
      if (observed.ok || !String(observed.error).includes("visible resident video transform")) throw new Error(`old binary did not expose the controller gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "native decoded-video graph rejected a non-rendering transform controller", observedError: observed.error };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    await mkdir(evidenceRoot, { recursive: true }); const frameResults = []; let performanceSession; let parentReceipt; let controllerReceipt; let resourceBytesDelta;
    const verify = async (id, candidate, frame) => { const graphPath = join(temporary, `${id}.json`); const outputPath = join(temporary, `${id}.png`); await writeFile(graphPath, JSON.stringify(candidate)); const loaded = await request("engine_video_load", { sessionId: id, graphPath, bindingsPath, timelineFrame: frame }); const verified = loaded.ok ? await request("engine_video_verify_frame", { sessionId: id, timelineFrame: frame, toleranceSeconds: 1 / 30, outputPath }) : undefined; if (!loaded.ok || !verified?.ok) throw new Error(`${id} verify failed: ${JSON.stringify({ loaded, verified })}`); return { loaded, verified, bytes: await readFile(outputPath) }; };
    for (const frame of timelineFrames) {
      const parented = await verify(`controlled-${frame}`, graph(frame, true), frame); const flattened = await verify(`flattened-${frame}`, graph(frame, false), frame);
      const parentedPath = join(evidenceRoot, `controlled-${frame}.png`); const flattenedPath = join(evidenceRoot, `flattened-${frame}.png`); await writeFile(parentedPath, parented.bytes); await writeFile(flattenedPath, flattened.bytes);
      const expected = compose(sample(controllerBase, controllerKeys, frame), sample(childBase, childKeys, frame)); const visual = parented.verified.result.visualLayers[0];
      const transformOracleMaxError = Math.max(Math.abs(visual.translateX - expected.x), Math.abs(visual.translateY - expected.y), Math.abs(visual.scale - expected.scaleX), Math.abs(visual.rotation - expected.rotationRadians), Math.abs(visual.opacity - expected.opacity));
      frameResults.push({ timelineFrame: frame, parentedArtifactSha256: sha256(parented.bytes), flattenedArtifactSha256: sha256(flattened.bytes), transformOracleMaxError, ...comparePixels(PNG.sync.read(parented.bytes).data, PNG.sync.read(flattened.bytes).data) });
      resourceBytesDelta ??= parented.loaded.result.resourcePlan.requiredBytes - flattened.loaded.result.resourcePlan.requiredBytes;
      await request("engine_video_release", { sessionId: `flattened-${frame}` });
      if (frame === timelineFrames[1]) { performanceSession = { id: `controlled-${frame}`, loaded: parented.loaded }; parentReceipt = parented.loaded.result.layers[0]; controllerReceipt = parented.loaded.result.controllers[0]; } else await request("engine_video_release", { sessionId: `controlled-${frame}` });
    }
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: performanceSession.id, timelineFrame: 30 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`controller present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, marker) => { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(badControllerGraph(name))); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 30 }); if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    await negative("wrong-generator", "editkin.generator.null"); await negative("self", "cycle"); await negative("cycle", "cycle"); await negative("uncovered", "fully cover"); await negative("effect", "unreachable");
    const released = await request("engine_video_release", { sessionId: performanceSession.id }); await request("surface_release"); await request("shutdown");
    const frames = last.result.layerFrames ?? [];
    return { status: "GREEN", directExecution: performanceSession.loaded.result.engineGraph.directExecution, compositeMode: performanceSession.loaded.result.compositeMode, layerCount: performanceSession.loaded.result.layerCount, decoderBindingCount: 1, controllerCount: performanceSession.loaded.result.controllerCount, parentCount: performanceSession.loaded.result.parentCount, parentReceipt, controllerReceipt, frameResults, thresholds, resourceBytesDelta,
      productPathCpuPixelCopies: Math.max(0, ...frames.flatMap((frame) => [frame.decodePathCpuPixelCopies, frame.stagingCpuPixelReadbacks, frame.nativeSurfaceCpuPixelReadbacks]).filter(Number.isFinite)), presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences, bound: bound.result };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}
async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); let report = { schema: "editkin.common-engine-video-controller-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  if (!baseline) { try { assertGreen(report); } catch (error) { report = { ...report, status: "BLOCK", gateFailure: error instanceof Error ? error.message : String(error) }; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw error; } }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
}
await main();
