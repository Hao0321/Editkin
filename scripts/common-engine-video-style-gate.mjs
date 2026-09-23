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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-style");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-style-gate/v1" || report.status !== "GREEN") throw new Error("style report is not GREEN");
  if (!report.directExecution || report.executedNodeIds.length !== report.requiredNodeIds.length || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("style graph coverage failed");
  if (!report.artifactChanged || report.monochromeMaxChannelError > 1 || report.styledBlackPixels <= report.plainBlackPixels) throw new Error("GPU visual-style artifact did not prove effect and transform");
  if (!report.verificationReadbackIsolated || report.presentDecodePathCpuPixelCopies !== 0 || report.presentStagingCpuPixelReadbacks !== 0 || report.presentNativeSurfaceCpuPixelReadbacks !== 0) throw new Error("product preview path performed a CPU pixel transfer");
  if (!report.visualGraphApplied || report.presentedFrames < 60 || report.presentP95Ms > 20) throw new Error("styled resident presentation failed");
  if (report.rejectedNegativeControls.length !== 4) throw new Error("style negatives are incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.plainArtifactSha256) || !/^[0-9a-f]{64}$/.test(report.styledArtifactSha256)) throw new Error("artifact identity missing");
}

function syntheticSelfTest() {
  const valid = {
    schema: "editkin.common-engine-video-style-gate/v1", status: "GREEN", directExecution: true,
    requiredNodeIds: ["source", "transform", "color", "effect", "output"], executedNodeIds: ["source", "transform", "color", "effect", "output"],
    artifactChanged: true, monochromeMaxChannelError: 1, styledBlackPixels: 10, plainBlackPixels: 0,
    verificationReadbackIsolated: true, presentDecodePathCpuPixelCopies: 0, presentStagingCpuPixelReadbacks: 0,
    presentNativeSurfaceCpuPixelReadbacks: 0, visualGraphApplied: true, presentedFrames: 60, presentP95Ms: 17,
    rejectedNegativeControls: ["unknown", "temporal", "stacked", "parent"], plainArtifactSha256: "a".repeat(64), styledArtifactSha256: "b".repeat(64),
  };
  assertGreen(valid);
  for (const negative of [
    { ...valid, artifactChanged: false }, { ...valid, monochromeMaxChannelError: 2 },
    { ...valid, verificationReadbackIsolated: false }, { ...valid, visualGraphApplied: false },
    { ...valid, executedNodeIds: valid.executedNodeIds.slice(1) },
  ]) {
    let rejected = false;
    try { assertGreen(negative); } catch { rejected = true; }
    if (!rejected) throw new Error("style evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 5 }));
}

function graph(styled) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 240 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: styled ? 42 : 0, y: styled ? -24 : 0, scaleX: styled ? .82 : 1, scaleY: styled ? .82 : 1, rotationRadians: styled ? .09 : 0, opacity: styled ? .88 : 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  if (styled) {
    nodes.push({ id: "effect", inputs: [tail], enabled: true, kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {} });
    tail = "effect";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId: styled ? "video-style" : "video-plain", width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}

async function inspectPng(path) {
  const png = PNG.sync.read(await readFile(path));
  let monochromeMaxChannelError = 0;
  let blackPixels = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const [r, g, b] = [png.data[index], png.data[index + 1], png.data[index + 2]];
    monochromeMaxChannelError = Math.max(monochromeMaxChannelError, Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
    if (r <= 1 && g <= 1 && b <= 1) blackPixels += 1;
  }
  return { monochromeMaxChannelError, blackPixels };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-style-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let readyResolve;
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
    const id = `style-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const bindingsPath = join(temporary, "bindings.json");
    const plainPath = join(temporary, "plain.json");
    const styledPath = join(temporary, "styled.json");
    await writeFile(bindingsPath, JSON.stringify({ video: resolve(root, "public/demo-source.mp4") }));
    await writeFile(plainPath, JSON.stringify(graph(false)));
    await writeFile(styledPath, JSON.stringify(graph(true)));
    if (baseline) {
      const observed = await request("engine_video_load", { sessionId: "style-baseline", graphPath: styledPath, bindingsPath, timelineFrame: 0 });
      const gap = String(observed.error);
      if (observed.ok || (!gap.includes("identity transform") && !gap.includes("unsupported common video node kind: effect"))) throw new Error(`old release did not expose style gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "common video requires identity transform and has no effect stage", observedError: observed.error };
    }

    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 64, height: 36 });
    if (!bound.ok) throw new Error(`native surface bind failed: ${JSON.stringify(bound)}`);
    const plainLoaded = await request("engine_video_load", { sessionId: "plain", graphPath: plainPath, bindingsPath, timelineFrame: 0 });
    const plainPng = join(temporary, "plain.png");
    const plainVerified = await request("engine_video_verify_frame", { sessionId: "plain", timelineFrame: 15, toleranceSeconds: 1 / 60, outputPath: plainPng });
    await request("engine_video_release", { sessionId: "plain" });
    if (!plainLoaded.ok || !plainVerified.ok) throw new Error(`plain verification failed: ${JSON.stringify({ plainLoaded, plainVerified })}`);

    const styledGraph = graph(true);
    const styledLoaded = await request("engine_video_load", { sessionId: "styled", graphPath: styledPath, bindingsPath, timelineFrame: 0 });
    const styledPng = join(temporary, "styled.png");
    const styledVerified = await request("engine_video_verify_frame", { sessionId: "styled", timelineFrame: 15, toleranceSeconds: 1 / 60, outputPath: styledPng });
    if (!styledLoaded.ok || !styledVerified.ok) throw new Error(`styled verification failed: ${JSON.stringify({ styledLoaded, styledVerified })}`);
    const plainBytes = await readFile(plainPng);
    const styledBytes = await readFile(styledPng);
    const plainAnalysis = await inspectPng(plainPng);
    const styledAnalysis = await inspectPng(styledPng);
    const times = [];
    let last;
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      last = await request("engine_video_present_frame", { sessionId: "styled", timelineFrame: 16 + index, toleranceSeconds: 1 / 60 });
      if (!last.ok) throw new Error(`styled present failed: ${JSON.stringify(last)}`);
      if (index >= 4) times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, mutate, marker) => {
      const candidate = structuredClone(styledGraph);
      mutate(candidate);
      const path = join(temporary, `negative-${name}.json`);
      await writeFile(path, JSON.stringify(candidate));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 });
      if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`);
      rejectedNegativeControls.push(name);
    };
    await negative("unknown", (candidate) => { candidate.nodes.find((node) => node.id === "effect").pluginId = "third.party.unknown"; }, "missing GPU effect binding");
    await negative("temporal", (candidate) => { candidate.nodes.find((node) => node.id === "effect").temporalRadius = 1; }, "unsupported common video effect contract");
    await negative("stacked", (candidate) => { candidate.nodes.splice(-1, 0, { id: "effect2", inputs: ["effect"], enabled: true, kind: "effect", pluginId: "editkin.builtin.xerox_pulse", abiVersion: 1, temporalRadius: 0, parameters: {} }); candidate.nodes.at(-1).inputs = ["effect2"]; }, "built-in effects cannot be stacked");
    await negative("parent", (candidate) => { candidate.nodes.find((node) => node.id === "transform").parent = "other"; }, "parent");
    const released = await request("engine_video_release", { sessionId: "styled" });
    await request("surface_release");
    await request("shutdown");
    const frame = last.result.frame;
    return {
      status: "GREEN", directExecution: styledLoaded.result.engineGraph.directExecution,
      requiredNodeIds: styledGraph.nodes.map((node) => node.id), executedNodeIds: styledLoaded.result.engineGraph.executedNodeIds,
      artifactChanged: !plainBytes.equals(styledBytes), plainArtifactSha256: sha256(plainBytes), styledArtifactSha256: sha256(styledBytes),
      monochromeMaxChannelError: styledAnalysis.monochromeMaxChannelError, plainBlackPixels: plainAnalysis.blackPixels, styledBlackPixels: styledAnalysis.blackPixels,
      verificationReadbackIsolated: plainVerified.result.verificationReadback === true && styledVerified.result.verificationReadback === true && styledVerified.result.productPathCpuPixelCopies === 0,
      visualGraphApplied: last.result.visualGraphApplied === true && last.result.visualGraph.effectKind === 1,
      presentDecodePathCpuPixelCopies: frame.decodePathCpuPixelCopies, presentStagingCpuPixelReadbacks: frame.stagingCpuPixelReadbacks,
      presentNativeSurfaceCpuPixelReadbacks: frame.nativeSurfaceCpuPixelReadbacks, presentedFrames: times.length,
      presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)],
      rejectedNegativeControls, bound: bound.result, releaseFences: released.result.fences,
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
  const report = { schema: "editkin.common-engine-video-style-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!baseline) assertGreen(report);
  console.log(JSON.stringify(report, null, 2));
}

await main();
