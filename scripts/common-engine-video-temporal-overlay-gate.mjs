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
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-temporal-overlay");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const baseFixture = resolve(root, "public/demo-source.mp4");
const overlayFixture = resolve(root, "public/benchmarks/layer-overlay.mp4");
const sampleFrame = 15;
const sampleCount = 8;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const close = (left, right, epsilon = .0001) => Number.isFinite(left) && Math.abs(left - right) <= epsilon;
const expectedTargets = () => Array.from({ length: sampleCount }, (_, index) => (sampleFrame + ((index + .5) / sampleCount - .5)) / 30);

function graphFor({ temporalLayers = [0], graphId = "decoded-temporal-plus-overlay", includeOverlay = true, overlayOpacity = 1, budgetMb = 192 } = {}) {
  const definitions = [
    { assetId: "base", x: 0, y: 0, scale: .94 },
    { assetId: "overlay", x: 285, y: 145, scale: .32 },
  ];
  const branches = [];
  const nodes = [];
  for (let index = 0; index < (includeOverlay ? 2 : 1); index += 1) {
    const suffix = `-${index}`;
    const layer = definitions[index];
    nodes.push(
      { id: `source${suffix}`, inputs: [], enabled: true, kind: "source", assetId: layer.assetId, mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
      { id: `transform${suffix}`, inputs: [`source${suffix}`], enabled: true, kind: "transform2d", x: layer.x, y: layer.y, scaleX: layer.scale, scaleY: layer.scale, rotationRadians: 0, opacity: index === 1 ? overlayOpacity : 1 },
      { id: `color${suffix}`, inputs: [`transform${suffix}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
    );
    let tail = `color${suffix}`;
    if (temporalLayers.includes(index)) {
      nodes.push({ id: `motion-blur${suffix}`, inputs: [tail], enabled: true, kind: "motion_blur", shutterAngle: 360, samples: sampleCount, sourceSampling: "decoded_temporal" });
      tail = `motion-blur${suffix}`;
    }
    branches.push(tail);
  }
  let tail = branches[0];
  if (branches.length === 2) {
    nodes.push({ id: "composite", inputs: branches, enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
    tail = "composite";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: budgetMb, nodes, outputNode: "output" };
}

function changedStats(leftBytes, rightBytes, region) {
  const left = PNG.sync.read(leftBytes);
  const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) throw new Error("temporal-overlay artifacts differ in dimensions");
  let changedPixels = 0;
  let highDeltaPixels = 0;
  let regionChangedPixels = 0;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const offset = (y * left.width + x) * 4;
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(left.data[offset + channel] - right.data[offset + channel]);
      if (delta > 8) changedPixels += 1;
      if (delta > 32) highDeltaPixels += 1;
      if (region && x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height && delta > 8) regionChangedPixels += 1;
    }
  }
  return { changedPixels, highDeltaPixels, regionChangedPixels };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-temporal-overlay-gate/v1" || report.status !== "GREEN") throw new Error("temporal-overlay report is not GREEN");
  if (!report.directExecution || report.layerCount !== 2 || report.compositeLayerCount !== 2) throw new Error("two-layer temporal composite did not execute directly");
  if (report.motionBlur?.contract !== "decoded-temporal-shutter-accumulation/v1" || report.motionBlur?.sourceSampling !== "decoded_temporal") throw new Error("decoded temporal layer contract is missing");
  if (report.temporalSampling?.sampleCount !== sampleCount || report.temporalSampling?.distinctDecodedTimestampCount < 2 || report.temporalSampling?.sampleReceipts?.length !== sampleCount) throw new Error("temporal source window evidence is incomplete");
  if (!report.temporalSampling.targetsMatchOracle || report.temporalSampling.residentFrameRingSize < sampleCount || report.temporalSampling.gpuCopyCount < 2) throw new Error("temporal source clocks or resident resources are incomplete");
  if (!report.repeatExact || report.temporalVsCurrentFrame.changedPixels < 500 || report.temporalVsCurrentFrame.highDeltaPixels < 100) throw new Error("mixed graph did not prove deterministic temporal pixels");
  if (report.overlayVsNoOverlay.regionChangedPixels < 500 || report.overlayVsNoOverlay.changedPixels < 500) throw new Error("independent overlay is not visibly present");
  if (report.presentedFrames < 30 || report.presentP95Ms > 25) throw new Error("mixed temporal graph missed the bounded realtime budget");
  if (report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls?.length !== 4 || report.releaseFences?.pendingFenceCount !== 0) throw new Error("mixed graph zero-copy, fail-closed, or fence evidence is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-temporal-overlay-gate/v1", status: "GREEN", directExecution: true, layerCount: 2, compositeLayerCount: 2, motionBlur: { contract: "decoded-temporal-shutter-accumulation/v1", sourceSampling: "decoded_temporal" }, temporalSampling: { sampleCount, distinctDecodedTimestampCount: 2, sampleReceipts: Array.from({ length: sampleCount }, () => ({})), targetsMatchOracle: true, residentFrameRingSize: 8, gpuCopyCount: 2 }, repeatExact: true, temporalVsCurrentFrame: { changedPixels: 1000, highDeltaPixels: 200 }, overlayVsNoOverlay: { changedPixels: 1000, regionChangedPixels: 600 }, presentedFrames: 30, presentP95Ms: 25, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["second-layer-temporal", "two-temporal", "adjustment-stack", "budget"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid);
  let calibratedNegatives = 0;
  for (const negative of [
    { ...valid, status: "BLOCK" },
    { ...valid, layerCount: 1 },
    { ...valid, temporalSampling: { ...valid.temporalSampling, distinctDecodedTimestampCount: 1 } },
    { ...valid, overlayVsNoOverlay: { changedPixels: 0, regionChangedPixels: 0 } },
    { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, presentP95Ms: 26 },
  ]) {
    let rejected = false;
    try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("temporal-overlay evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives }));
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-temporal-overlay-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "ready") readyResolve(message);
    else {
      const handler = pending.get(message.id);
      if (handler) { pending.delete(message.id); handler(message); }
    }
  });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `temporal-overlay-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const bindingsPath = join(temporary, "bindings.json");
    await writeFile(bindingsPath, JSON.stringify({ base: baseFixture, overlay: overlayFixture }));
    const graphPath = join(temporary, "mixed.json");
    await writeFile(graphPath, JSON.stringify(graphFor()));
    await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const loaded = await request("engine_video_load", { sessionId: "mixed", graphPath, bindingsPath, timelineFrame: sampleFrame });
    if (baseline) {
      await request("surface_release"); await request("shutdown");
      return { status: "BLOCK", expectedContract: "decoded-temporal-plus-overlay/v1", loadOk: loaded.ok, reason: loaded.ok ? "old executor accepted an unverified mixed temporal topology" : loaded.error };
    }
    if (!loaded.ok) throw new Error(`temporal-overlay load failed: ${JSON.stringify(loaded)}`);
    const repeatLoaded = await request("engine_video_load", { sessionId: "repeat", graphPath, bindingsPath, timelineFrame: sampleFrame });
    const currentPath = join(temporary, "current.json");
    const current = graphFor({ temporalLayers: [], graphId: "current-frame-plus-overlay" });
    await writeFile(currentPath, JSON.stringify(current));
    const currentLoaded = await request("engine_video_load", { sessionId: "current", graphPath: currentPath, bindingsPath, timelineFrame: sampleFrame });
    const noOverlayPath = join(temporary, "no-overlay.json"); await writeFile(noOverlayPath, JSON.stringify(graphFor({ overlayOpacity: 0, graphId: "temporal-no-overlay" })));
    const noOverlayLoaded = await request("engine_video_load", { sessionId: "no-overlay", graphPath: noOverlayPath, bindingsPath, timelineFrame: sampleFrame });
    if (!repeatLoaded.ok || !currentLoaded.ok || !noOverlayLoaded.ok) throw new Error(`mixed controls failed to load: ${JSON.stringify({ repeatLoaded, currentLoaded, noOverlayLoaded })}`);
    const outputs = { mixed: join(temporary, "mixed.png"), repeat: join(temporary, "repeat.png"), current: join(temporary, "current.png"), noOverlay: join(temporary, "no-overlay.png") };
    const verified = {};
    for (const [key, sessionId] of [["mixed", "mixed"], ["repeat", "repeat"], ["current", "current"], ["noOverlay", "no-overlay"]]) {
      verified[key] = await request("engine_video_verify_frame", { sessionId, timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath: outputs[key] });
    }
    if (Object.values(verified).some((value) => !value.ok)) throw new Error(`mixed verification failed: ${JSON.stringify(verified)}`);
    const bytes = Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([key, path]) => [key, await readFile(path)])));
    await mkdir(evidenceRoot, { recursive: true });
    await Promise.all(Object.entries(bytes).map(([key, value]) => writeFile(join(evidenceRoot, `${key}-frame-15.png`), value)));
    const times = [];
    let last;
    for (let index = 0; index < 34; index += 1) {
      const started = performance.now();
      last = await request("engine_video_present_frame", { sessionId: "mixed", timelineFrame: 5 + index % 25, toleranceSeconds: 1 / 60 });
      if (!last.ok) throw new Error(`mixed temporal present failed: ${JSON.stringify(last)}`);
      if (index >= 4) times.push(performance.now() - started);
    }
    times.sort((left, right) => left - right);
    const rejectedNegativeControls = [];
    async function negative(name, graph, marker) {
      const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graph));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: sampleFrame });
      if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`);
      rejectedNegativeControls.push(name);
    }
    await negative("second-layer-temporal", graphFor({ temporalLayers: [1], graphId: "negative-second-layer" }), "first resident video layer");
    await negative("two-temporal", graphFor({ temporalLayers: [0, 1], graphId: "negative-two-temporal" }), "exactly one decoded temporal");
    const adjustment = graphFor({ graphId: "negative-adjustment-stack" });
    const output = adjustment.nodes.pop(); adjustment.nodes.push(
      { id: "adjustment", inputs: ["composite"], enabled: true, kind: "adjustment", affectedInputs: ["composite"], timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
      { id: "adjustment-color", inputs: ["adjustment"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "adjustment-two", inputs: ["adjustment-color"], enabled: true, kind: "adjustment", affectedInputs: ["adjustment-color"], timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
      { id: "adjustment-color-two", inputs: ["adjustment-two"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { ...output, inputs: ["adjustment-color-two"] },
    );
    await negative("adjustment-stack", adjustment, "at most one trailing adjustment");
    await negative("budget", { ...graphFor({ graphId: "negative-budget", budgetMb: 64 }), width: 1920, height: 1080 }, "resource budget is insufficient");
    const released = await request("engine_video_release", { sessionId: "mixed" });
    for (const id of ["repeat", "current", "no-overlay"]) await request("engine_video_release", { sessionId: id });
    await request("surface_release"); await request("shutdown");
    const temporalSampling = verified.mixed.result.temporalSampling;
    const expected = expectedTargets();
    temporalSampling.targetsMatchOracle = temporalSampling.sampleReceipts.map((receipt) => receipt.targetSeconds).every((value, index) => close(value, expected[index]));
    return {
      status: "GREEN",
      directExecution: loaded.result.engineGraph.directExecution,
      layerCount: loaded.result.layerCount,
      compositeLayerCount: verified.mixed.result.compositeLayerCount,
      compositeExecutionMode: verified.mixed.result.compositeExecutionMode,
      motionBlur: loaded.result.layers[0].motionBlur,
      temporalSampling,
      repeatExact: sha256(bytes.mixed) === sha256(bytes.repeat),
      temporalVsCurrentFrame: changedStats(bytes.current, bytes.mixed),
      overlayVsNoOverlay: changedStats(bytes.noOverlay, bytes.mixed, { x: 590, y: 270, width: 330, height: 250 }),
      artifacts: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [`${key}Sha256`, sha256(value)])),
      presentedFrames: times.length,
      presentP50Ms: times[Math.floor(times.length * .5)],
      presentP95Ms: times[Math.floor((times.length - 1) * .95)],
      productPathCpuPixelCopies: Math.max(last.result.productPathCpuPixelCopies ?? 0, temporalSampling.productPathCpuPixelCopies ?? 0, ...last.result.layerFrames.map((frame) => Math.max(frame.decodePathCpuPixelCopies ?? 0, frame.stagingCpuPixelReadbacks ?? 0))),
      rejectedNegativeControls,
      releaseFences: released.result.fences,
    };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run();
  const report = { schema: "editkin.common-engine-video-temporal-overlay-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!baseline) assertGreen(report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
