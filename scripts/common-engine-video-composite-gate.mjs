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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-composite");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-composite-gate/v1" || report.status !== "GREEN") throw new Error("composite report is not GREEN");
  if (!report.directExecution || report.requiredNodeIds.length !== report.executedNodeIds.length || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("composite graph coverage failed");
  if (!report.artifactChanged || report.changedPixelRatio < .02 || report.overlayMonochromeRatio < .95 || report.outsideChromaticPixels < 100) throw new Error("composite artifact did not prove two visually distinct video layers");
  if (!report.verificationReadbackIsolated || !report.visualLayersApplied || report.layerFrames.length !== 2) throw new Error("composite execution receipt is incomplete");
  if (report.layerFrames.some((frame) => frame.decodePathCpuPixelCopies !== 0 || frame.stagingCpuPixelReadbacks !== 0 || frame.nativeSurfaceCpuPixelReadbacks !== 0)) throw new Error("composite product path performed a CPU pixel transfer");
  if (report.presentedFrames < 60 || report.presentP95Ms > 25) throw new Error("composite resident presentation missed its frame budget");
  if (report.rejectedNegativeControls.length !== 4) throw new Error("composite negative controls are incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.baseArtifactSha256) || !/^[0-9a-f]{64}$/.test(report.compositeArtifactSha256)) throw new Error("composite artifact identity is missing");
}

function syntheticSelfTest() {
  const frame = { decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0 };
  const valid = {
    schema: "editkin.common-engine-video-composite-gate/v1", status: "GREEN", directExecution: true,
    requiredNodeIds: ["source:base", "transform:base", "color:base", "source:overlay", "transform:overlay", "color:overlay", "effect:overlay", "composite", "output"],
    executedNodeIds: ["source:base", "transform:base", "color:base", "source:overlay", "transform:overlay", "color:overlay", "effect:overlay", "composite", "output"],
    artifactChanged: true, changedPixelRatio: .15, overlayMonochromeRatio: .99, outsideChromaticPixels: 1_000,
    verificationReadbackIsolated: true, visualLayersApplied: true, layerFrames: [frame, frame],
    presentedFrames: 60, presentP95Ms: 18, rejectedNegativeControls: ["right-nested", "opacity-high", "unpaired-matte", "under-budget"],
    baseArtifactSha256: "a".repeat(64), compositeArtifactSha256: "b".repeat(64),
  };
  assertGreen(valid);
  for (const negative of [
    { ...valid, changedPixelRatio: .001 }, { ...valid, overlayMonochromeRatio: .8 },
    { ...valid, layerFrames: [frame] }, { ...valid, layerFrames: [frame, { ...frame, stagingCpuPixelReadbacks: 1 }] },
    { ...valid, executedNodeIds: valid.executedNodeIds.slice(1) },
  ]) {
    let rejected = false;
    try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("composite evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 5 }));
}

function branch(id, assetId, sourceStartFrame, transform, effect = false) {
  const nodes = [
    { id: `source:${id}`, inputs: [], enabled: true, kind: "source", assetId, mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame, durationFrames: 180 } },
    { id: `transform:${id}`, inputs: [`source:${id}`], enabled: true, kind: "transform2d", x: transform.x, y: transform.y, scaleX: transform.scale, scaleY: transform.scale, rotationRadians: transform.rotation, opacity: transform.opacity },
    { id: `color:${id}`, inputs: [`transform:${id}`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = `color:${id}`;
  if (effect) {
    nodes.push({ id: `effect:${id}`, inputs: [tail], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} });
    tail = `effect:${id}`;
  }
  return { nodes, tail };
}

function compositeGraph() {
  const base = branch("base", "base", 0, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
  const overlay = branch("overlay", "overlay", 45, { x: 250, y: 120, scale: .4, rotation: 0, opacity: 1 }, true);
  return {
    schema: "editkin.engine-graph/v1", graphId: "video-composite", width: 960, height: 540,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 96,
    nodes: [...base.nodes, ...overlay.nodes,
      { id: "composite", inputs: [base.tail, overlay.tail], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
      { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" }],
    outputNode: "output",
  };
}

function baseGraph() {
  const base = branch("base", "base", 0, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
  return {
    schema: "editkin.engine-graph/v1", graphId: "video-composite-base", width: 960, height: 540,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [...base.nodes, { id: "output", inputs: [base.tail], enabled: true, kind: "output", format: "rgba16_float" }], outputNode: "output",
  };
}

function inspectArtifacts(baseBytes, compositeBytes) {
  const base = PNG.sync.read(baseBytes);
  const composite = PNG.sync.read(compositeBytes);
  if (base.width !== composite.width || base.height !== composite.height) throw new Error("artifact dimensions differ");
  let changed = 0;
  let overlayPixels = 0;
  let overlayMonochrome = 0;
  let outsideChromaticPixels = 0;
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const offset = (y * base.width + x) * 4;
      const delta = Math.max(...[0, 1, 2].map((channel) => Math.abs(base.data[offset + channel] - composite.data[offset + channel])));
      if (delta > 2) changed += 1;
      const r = composite.data[offset]; const g = composite.data[offset + 1]; const b = composite.data[offset + 2];
      if (x >= 570 && x < 890 && y >= 315 && y < 485) {
        overlayPixels += 1;
        if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) <= 1) overlayMonochrome += 1;
      } else if (x < 420 && y < 220 && Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) >= 8) outsideChromaticPixels += 1;
    }
  }
  return { changedPixelRatio: changed / (base.width * base.height), overlayMonochromeRatio: overlayMonochrome / overlayPixels, outsideChromaticPixels };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-composite-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "ready") return readyResolve(message);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `composite-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const graph = compositeGraph();
    const graphPath = join(temporary, "composite.json");
    const basePath = join(temporary, "base.json");
    const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graph));
    await writeFile(basePath, JSON.stringify(baseGraph()));
    await writeFile(bindingsPath, JSON.stringify({ base: resolve(root, "public/demo-source.mp4"), overlay: resolve(root, "public/demo-source.mp4") }));
    if (baseline) {
      const observed = await request("engine_video_load", { sessionId: "composite-baseline", graphPath, bindingsPath, timelineFrame: 0 });
      const gap = String(observed.error);
      if (observed.ok || !gap.includes("unsupported common video node kind: composite")) throw new Error(`old release did not expose composite gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "common video has no multi-source composite executor", observedError: observed.error, executedNodeIds: ["output"] };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const baseLoaded = await request("engine_video_load", { sessionId: "base-only", graphPath: basePath, bindingsPath, timelineFrame: 0 });
    const basePng = join(temporary, "base.png");
    const baseVerified = await request("engine_video_verify_frame", { sessionId: "base-only", timelineFrame: 30, toleranceSeconds: 1 / 60, outputPath: basePng });
    await request("engine_video_release", { sessionId: "base-only" });
    const loaded = await request("engine_video_load", { sessionId: "composite", graphPath, bindingsPath, timelineFrame: 0 });
    const compositePng = join(temporary, "composite.png");
    const verified = await request("engine_video_verify_frame", { sessionId: "composite", timelineFrame: 30, toleranceSeconds: 1 / 60, outputPath: compositePng });
    if (!baseLoaded.ok || !baseVerified.ok || !loaded.ok || !verified.ok) throw new Error(`composite verification failed: ${JSON.stringify({ baseLoaded, baseVerified, loaded, verified })}`);
    const baseBytes = await readFile(basePng); const compositeBytes = await readFile(compositePng);
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "base.png"), baseBytes);
    await writeFile(join(evidenceRoot, "composite.png"), compositeBytes);
    const artifact = inspectArtifacts(baseBytes, compositeBytes);
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      last = await request("engine_video_present_frame", { sessionId: "composite", timelineFrame: 31 + index, toleranceSeconds: 1 / 60 });
      if (!last.ok) throw new Error(`composite present failed: ${JSON.stringify(last)}`);
      if (index >= 4) times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, mutate, marker) => {
      const candidate = structuredClone(graph); mutate(candidate);
      const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 });
      if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`);
      rejectedNegativeControls.push(name);
    };
    await negative("right-nested", (candidate) => {
      const extra = branch("right-extra", "base", 90, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
      candidate.nodes.splice(-1, 0, ...extra.nodes, { id: "right-composite", inputs: ["color:overlay", extra.tail], enabled: true, kind: "composite", blendMode: "multiply", opacity: .5 });
      candidate.nodes.find((node) => node.id === "composite").inputs[1] = "right-composite";
    }, "right-nested");
    await negative("opacity-high", (candidate) => { candidate.nodes.find((node) => node.id === "composite").opacity = 1.1; }, "invalid composite");
    await negative("unpaired-matte", (candidate) => {
      const composite = candidate.nodes.find((node) => node.id === "composite");
      composite.matteInput = "color:base";
      delete composite.matteMode;
    }, "invalid composite");
    await negative("under-budget", (candidate) => {
      let tail = "composite";
      for (let index = 3; index <= 7; index += 1) {
        const extra = branch(`extra-${index}`, "base", 0, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
        const composite = `composite:extra-${index}`;
        candidate.nodes.splice(-1, 0, ...extra.nodes, { id: composite, inputs: [tail, extra.tail], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
        tail = composite;
      }
      candidate.nodes.find((node) => node.id === "output").inputs = [tail];
    }, "resource budget");
    const released = await request("engine_video_release", { sessionId: "composite" });
    await request("surface_release"); await request("shutdown");
    const result = last.result; const layerFrames = result.layerFrames ?? [];
    return {
      status: "GREEN", directExecution: loaded.result.engineGraph.directExecution,
      requiredNodeIds: graph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds,
      artifactChanged: !baseBytes.equals(compositeBytes), baseArtifactSha256: sha256(baseBytes), compositeArtifactSha256: sha256(compositeBytes), ...artifact,
      verificationReadbackIsolated: verified.result.verificationReadback === true && verified.result.productPathCpuPixelCopies === 0,
      visualLayersApplied: result.visualLayersApplied === true, layerFrames,
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)],
      rejectedNegativeControls, bound: bound.result, releaseFences: released.result.fences,
    };
  } finally {
    lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run();
  const report = { schema: "editkin.common-engine-video-composite-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!baseline) assertGreen(report);
  console.log(JSON.stringify(report, null, 2));
}

await main();
