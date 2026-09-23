import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const defaultExecutable = resolve(root, "native", "bin", "win32-x64", "editkin-gpu-compositor.exe");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video");
const baselineMode = process.argv.includes("--baseline");
const selfTestMode = process.argv.includes("--self-test");
const executableArgument = process.argv.find((value) => !value.startsWith("--") && value !== process.argv[0] && value !== process.argv[1]);
const executable = executableArgument ? resolve(executableArgument) : defaultExecutable;
const reportPath = resolve(evidenceRoot, baselineMode ? "baseline-report.json" : "report.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-gpu-gate/v1" || report.status !== "GREEN") throw new Error("common video report is not GREEN");
  if (report.graphSchema !== "editkin.engine-graph/v1" || report.directExecution !== true) throw new Error("video did not execute through the common graph");
  if (report.executor !== "media-foundation-d3d11-d3d12-wgpu/v1") throw new Error("wrong native video executor");
  if (report.decodePathCpuPixelCopies !== 0 || report.stagingCpuPixelReadbacks !== 0 || report.nativeSurfaceCpuPixelReadbacks !== 0) throw new Error("CPU pixel transfer entered direct preview");
  if (report.requiredNodeIds.length !== report.executedNodeIds.length || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("common graph coverage is incomplete");
  if (report.blockedNodeIds.length || report.ignoredNodeIds.length) throw new Error("accepted graph blocked or ignored nodes");
  if (report.sourceTimeMapping !== true || report.timelineInactiveClear !== true || report.legacyBypassRejected !== true) throw new Error("timeline or bypass contract failed");
  if (report.presentedFrames < 60 || !Number.isFinite(report.presentP95Ms) || report.presentP95Ms > 20) throw new Error("resident common-video performance ceiling failed");
  if (!Array.isArray(report.rejectedNegativeControls) || report.rejectedNegativeControls.length !== 5) throw new Error("negative-control coverage is incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.executableSha256)) throw new Error("missing executable identity");
}

function selfTest() {
  const valid = {
    schema: "editkin.common-engine-video-gpu-gate/v1", status: "GREEN", graphSchema: "editkin.engine-graph/v1",
    directExecution: true, executor: "media-foundation-d3d11-d3d12-wgpu/v1", decodePathCpuPixelCopies: 0,
    stagingCpuPixelReadbacks: 0, nativeSurfaceCpuPixelReadbacks: 0, sourceTimeMapping: true,
    timelineInactiveClear: true, legacyBypassRejected: true, presentedFrames: 60, presentP95Ms: 8,
    requiredNodeIds: ["source", "transform", "color", "output"], executedNodeIds: ["source", "transform", "color", "output"],
    blockedNodeIds: [], ignoredNodeIds: [], rejectedNegativeControls: ["transform", "effect", "under-budget", "dimensions", "binding"],
    executableSha256: "a".repeat(64),
  };
  assertGreen(valid);
  const negatives = [
    { ...valid, directExecution: false },
    { ...valid, decodePathCpuPixelCopies: 1 },
    { ...valid, executedNodeIds: valid.executedNodeIds.slice(1) },
    { ...valid, sourceTimeMapping: false },
    { ...valid, presentP95Ms: 21 },
    { ...valid, ignoredNodeIds: ["color"] },
  ];
  for (const negative of negatives) {
    let rejected = false;
    try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length })}\n`);
}

function engineVideoGraph(overrides = {}) {
  const timeline = { timelineStartFrame: 30, sourceStartFrame: 15, durationFrames: 180 };
  const graph = {
    schema: "editkin.engine-graph/v1", graphId: "common-native-video", width: 960, height: 540,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [
      { id: "source", inputs: [], enabled: true, kind: "source", assetId: "fixture-video", mediaKind: "video", inputColorSpace: "rec709", timeline },
      { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "output", inputs: ["color"], enabled: true, kind: "output", format: "rgba16_float" },
    ],
    outputNode: "output",
  };
  return Object.assign(graph, overrides);
}

async function resident(executablePath, temporary, baseline) {
  const child = spawn(executablePath, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-40_000); });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "ready") { readyResolve(message); return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `common-video-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000);
      timer.unref();
    })]);
    const graph = engineVideoGraph();
    const graphPath = join(temporary, "graph.json");
    const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graph));
    await writeFile(bindingsPath, JSON.stringify({ "fixture-video": resolve(root, "public", "demo-source.mp4") }));
    const loaded = await request("engine_video_load", { sessionId: "common-video-gate", graphPath, bindingsPath, timelineFrame: 30 });
    if (baseline) {
      if (loaded.ok || !String(loaded.error).includes("unknown resident engine command")) throw new Error(`baseline did not expose missing common-video command: ${JSON.stringify(loaded)}`);
      return { status: "BLOCK", reason: "engine_video_load is absent", observedError: loaded.error };
    }
    if (!loaded.ok) throw new Error(`engine_video_load failed: ${JSON.stringify(loaded)}`);
    const coverage = loaded.result.engineGraph;
    const requiredNodeIds = graph.nodes.map((node) => node.id);
    const surface = await request("surface_bind", { parentHwnd: "0", x: 32, y: 32, width: 32, height: 24 });
    if (!surface.ok) throw new Error(`surface_bind failed: ${JSON.stringify(surface)}`);
    const frame30 = await request("engine_video_present_frame", { sessionId: "common-video-gate", timelineFrame: 30, toleranceSeconds: 1 / 60 });
    const frame60 = await request("engine_video_present_frame", { sessionId: "common-video-gate", timelineFrame: 60, toleranceSeconds: 1 / 60 });
    if (!frame30.ok || !frame60.ok) throw new Error(`common video present failed: ${JSON.stringify({ frame30, frame60 })}`);
    const expected30 = .5;
    const expected60 = 1.5;
    const sourceTimeMapping = Math.abs(frame30.result.sourceTimeSeconds - expected30) < 1e-9
      && Math.abs(frame60.result.sourceTimeSeconds - expected60) < 1e-9
      && Math.abs(frame30.result.frame.clockTargetSeconds - expected30) < 1e-9
      && Math.abs(frame60.result.frame.clockTargetSeconds - expected60) < 1e-9;
    const samples = [];
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      const sample = await request("engine_video_present_frame", { sessionId: "common-video-gate", timelineFrame: 61 + index, toleranceSeconds: 1 / 60 });
      if (!sample.ok || sample.result.frame?.decodePathCpuPixelCopies !== 0) throw new Error(`resident sample failed: ${JSON.stringify(sample)}`);
      if (index >= 4) samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const inactive = await request("engine_video_present_frame", { sessionId: "common-video-gate", timelineFrame: 240, toleranceSeconds: 1 / 60 });
    const bypass = await request("video_present_at", { sessionId: "common-video-gate", timeSeconds: 0, toleranceSeconds: 1 / 60 });

    const rejectedNegativeControls = [];
    const negative = async (name, mutate, marker) => {
      const candidate = structuredClone(graph);
      mutate(candidate);
      const candidatePath = join(temporary, `${name}.json`);
      await writeFile(candidatePath, JSON.stringify(candidate));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: candidatePath, bindingsPath, timelineFrame: 30 });
      if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} negative was not rejected with ${marker}: ${JSON.stringify(response)}`);
      rejectedNegativeControls.push(name);
    };
    await negative("transform", (candidate) => { candidate.nodes.find((node) => node.id === "transform").scaleY = 0.75; }, "finite uniform positive scale");
    await negative("effect", (candidate) => {
      candidate.nodes.splice(-1, 0, { id: "effect", inputs: ["color"], enabled: true, kind: "effect", pluginId: "third.party.unsupported", abiVersion: 1, temporalRadius: 0, parameters: {} });
      candidate.nodes.at(-1).inputs = ["effect"];
    }, "missing GPU effect binding");
    await negative("under-budget", (candidate) => {
      let tail = "color";
      for (let index = 1; index <= 6; index += 1) {
        const source = `extra:${index}`;
        const composite = `composite:${index}`;
        candidate.nodes.splice(-1, 0,
          { id: source, inputs: [], enabled: true, kind: "source", assetId: "fixture-video", mediaKind: "video", inputColorSpace: "rec709", timeline: candidate.nodes[0].timeline },
          { id: composite, inputs: [tail, source], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
        );
        tail = composite;
      }
      candidate.nodes.at(-1).inputs = [tail];
    }, "resource budget");
    await negative("dimensions", (candidate) => { candidate.width = 1280; }, "must preserve the graph aspect ratio");
    const missingPath = join(temporary, "missing-bindings.json");
    await writeFile(missingPath, "{}");
    const missing = await request("engine_video_load", { sessionId: "negative-binding", graphPath, bindingsPath: missingPath, timelineFrame: 30 });
    if (missing.ok || !String(missing.error).includes("missing asset binding")) throw new Error(`binding negative failed: ${JSON.stringify(missing)}`);
    rejectedNegativeControls.push("binding");

    const released = await request("engine_video_release", { sessionId: "common-video-gate" });
    await request("surface_release");
    await request("shutdown");
    child.stdin.end();
    return {
      status: "GREEN", graphSchema: coverage.graphSchema, directExecution: coverage.directExecution,
      executor: loaded.result.executor, decodePathCpuPixelCopies: frame60.result.frame.decodePathCpuPixelCopies,
      stagingCpuPixelReadbacks: frame60.result.frame.stagingCpuPixelReadbacks,
      nativeSurfaceCpuPixelReadbacks: frame60.result.frame.nativeSurfaceCpuPixelReadbacks,
      sourceTimeMapping, timelineInactiveClear: inactive.ok && inactive.result.active === false && inactive.result.nativeSurfaceCleared === true,
      legacyBypassRejected: !bypass.ok && String(bypass.error).includes("unknown resident video session"),
      presentedFrames: samples.length, presentP50Ms: samples[Math.floor(samples.length * .5)], presentP95Ms: samples[Math.floor((samples.length - 1) * .95)],
      requiredNodeIds, executedNodeIds: coverage.executedNodeIds, blockedNodeIds: coverage.blockedNodeIds, ignoredNodeIds: coverage.ignoredNodeIds,
      rejectedNegativeControls, releaseFences: released.result?.fences,
    };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

async function main() {
  if (selfTestMode) return selfTest();
  if (process.platform !== "win32") throw new Error("common native-video graph gate currently requires Windows");
  const temporary = await mkdtemp(join(tmpdir(), "editkin-common-video-"));
  try {
    const observed = await resident(executable, temporary, baselineMode);
    const report = {
      schema: "editkin.common-engine-video-gpu-gate/v1", measuredAt: new Date().toISOString(),
      executable, executableSha256: sha256(await readFile(executable)), ...observed,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!baselineMode) assertGreen(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
