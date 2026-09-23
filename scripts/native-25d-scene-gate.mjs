import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const platformDirectory = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const binaryName = process.platform === "win32" ? "editkin-gpu-compositor.exe" : "editkin-gpu-compositor";
const defaultExecutable = resolve(root, "native", "bin", platformDirectory, binaryName);
const defaultBaseline = process.platform === "win32"
  ? resolve(root, "native", "bin", platformDirectory, "editkin-gpu-compositor.previous-ab251f73.exe")
  : null;
const defaultReport = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-native-25d-scene", "report.json");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(executable, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

function receipt(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout); } catch (error) { throw new Error(`${label} returned invalid JSON: ${error}`); }
}

async function expectRejected(executable, args, marker) {
  const result = await run(executable, args);
  if (result.code === 0 || !new RegExp(marker, "i").test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error(`negative control did not fail closed with ${marker}: ${result.stderr || result.stdout}`);
  }
  return true;
}

async function pngError(leftPath, rightPath) {
  const left = PNG.sync.read(await readFile(leftPath));
  const right = PNG.sync.read(await readFile(rightPath));
  if (left.width !== right.width || left.height !== right.height) return 255;
  let maximum = 0;
  for (let index = 0; index < left.data.length; index += 1) maximum = Math.max(maximum, Math.abs(left.data[index] - right.data[index]));
  return maximum;
}

function sourceGraph(width, height, source) {
  return { schema: "hao.gpu-render-graph/v1", width, height, layers: [{ id: "source", source, blendMode: "normal", opacity: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, enabled: true }] };
}

function sceneGraph() {
  const timeline = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 };
  return {
    schema: "editkin.engine-graph/v1", graphId: "native-25d-plane-scene", width: 320, height: 180,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [
      { id: "back-source", inputs: [], enabled: true, kind: "source", assetId: "back", mediaKind: "image", inputColorSpace: "rec709", timeline },
      { id: "back-3d", inputs: ["back-source"], enabled: true, kind: "transform3d", position: [0, 0, 0], rotationRadians: [0, 0, 0], scale: [1.3, 1.3, 1] },
      { id: "front-source", inputs: [], enabled: true, kind: "source", assetId: "front", mediaKind: "image", inputColorSpace: "rec709", timeline },
      { id: "front-3d", inputs: ["front-source"], enabled: true, kind: "transform3d", position: [0.22, -0.08, 0.72], rotationRadians: [-0.12, 0.42, 0.08], scale: [0.56, 0.56, 1], parent: "back-3d" },
      { id: "scene-composite", inputs: ["back-3d", "front-3d"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
      { id: "camera", inputs: [], enabled: true, kind: "camera", position: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0], verticalFovRadians: 1.0471975512, near: 0.1, far: 20 },
      { id: "ambient", inputs: [], enabled: true, kind: "light", lightKind: "ambient", color: [1, 1, 1], intensity: 0.28, position: [0, 0, 0], direction: [0, 0, -1] },
      { id: "key", inputs: [], enabled: true, kind: "light", lightKind: "directional", color: [1, 0.92, 0.78], intensity: 0.92, position: [0, 0, 0], direction: [0.2, -0.25, 1] },
      { id: "output", inputs: ["scene-composite"], enabled: true, kind: "output", format: "rgba16_float" },
    ],
    outputNode: "output",
  };
}

async function residentRender(executable, graphPath, bindingsPath, outputPath) {
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "ready") return readyResolve(message);
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback(message); }
  });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `scene-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await ready;
    const loaded = await request("engine_load", { sessionId: "scene", graphPath, bindingsPath, timelineFrame: 0 });
    if (!loaded.ok) throw new Error(`resident load failed: ${JSON.stringify(loaded)}`);
    const rendered = await request("render", { sessionId: "scene", outputPath });
    if (!rendered.ok) throw new Error(`resident render failed: ${JSON.stringify(rendered)}`);
    const timings = [];
    for (let index = 0; index < 34; index += 1) {
      const sample = await request("render", { sessionId: "scene" });
      if (!sample.ok) throw new Error(`resident sample failed: ${JSON.stringify(sample)}`);
      if (index >= 4) timings.push(sample.result.renderMilliseconds);
    }
    timings.sort((a, b) => a - b);
    await request("release", { sessionId: "scene" });
    await request("shutdown");
    child.stdin.end();
    await new Promise((resolvePromise, reject) => child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `serve exited ${code}`))));
    return { loaded: loaded.result, rendered: rendered.result, frames: timings.length, p95Ms: timings[Math.floor((timings.length - 1) * 0.95)] };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

function assertReport(report) {
  if (report.schema !== "editkin.native-25d-scene-gate/v1" || report.status !== "GREEN") throw new Error("2.5D gate is not GREEN");
  if (!report.baselineRejected || !report.directExecution || report.previewExportMaxChannelError > 1 || report.cpuGpuMaxChannelError > 1) throw new Error("2.5D execution parity is incomplete");
  if (report.sceneContract !== "single_camera_textured_planes/v1" || report.planeCount !== 2 || report.parentedPlaneCount !== 1 || report.directionalLightCount !== 1 || report.ambientLightCount !== 1) throw new Error("2.5D bounded contract receipt is incomplete");
  if (report.residentFrames < 30 || !Number.isFinite(report.residentP95Ms) || report.residentP95Ms > 8) throw new Error("2.5D resident GPU performance ceiling failed");
  if (report.blockedNodeIds.length || report.ignoredNodeIds.length || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("2.5D node coverage is incomplete");
  if (report.rejectedNegativeControls.length !== 4) throw new Error("2.5D negative controls are incomplete");
}

function selfTest() {
  const valid = { schema: "editkin.native-25d-scene-gate/v1", status: "GREEN", baselineRejected: true, directExecution: true, previewExportMaxChannelError: 0, cpuGpuMaxChannelError: 1, sceneContract: "single_camera_textured_planes/v1", planeCount: 2, parentedPlaneCount: 1, directionalLightCount: 1, ambientLightCount: 1, residentFrames: 30, residentP95Ms: 2, requiredNodeIds: ["a"], executedNodeIds: ["a"], blockedNodeIds: [], ignoredNodeIds: [], rejectedNegativeControls: ["camera", "light", "cycle", "clip"] };
  assertReport(valid);
  for (const invalid of [{ ...valid, baselineRejected: false }, { ...valid, previewExportMaxChannelError: 2 }, { ...valid, planeCount: 1 }, { ...valid, ignoredNodeIds: ["camera"] }]) {
    let rejected = false; try { assertReport(invalid); } catch { rejected = true; }
    if (!rejected) throw new Error("self-test accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 4 })}\n`);
}

async function main(executable, baseline, reportPath) {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-25d-"));
  try {
    const backGraph = join(temporary, "back.json");
    const frontGraph = join(temporary, "front.json");
    const back = join(temporary, "back.png");
    const front = join(temporary, "front.png");
    await writeFile(backGraph, JSON.stringify(sourceGraph(320, 180, { kind: "gradient", start: [12, 20, 45, 255], end: [34, 91, 148, 255], horizontal: false })));
    await writeFile(frontGraph, JSON.stringify(sourceGraph(320, 180, { kind: "radial", inner: [255, 226, 85, 255], outer: [220, 42, 25, 0], center: [0.5, 0.5], radius: 0.47 })));
    receipt(await run(executable, ["render", backGraph, back, "cpu"]), "back source generation");
    receipt(await run(executable, ["render", frontGraph, front, "cpu"]), "front source generation");
    const graph = sceneGraph();
    const graphPath = join(temporary, "scene.json");
    const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graph));
    await writeFile(bindingsPath, JSON.stringify({ back, front }));
    const cpuPath = join(temporary, "cpu.png");
    const gpuPath = join(temporary, "gpu.png");
    const previewPath = join(temporary, "preview.png");
    let baselineRejected = baseline === null;
    if (baseline) {
      const result = await run(baseline, ["engine-render", graphPath, bindingsPath, "0", join(temporary, "baseline.png"), "gpu"]);
      baselineRejected = result.code !== 0 && /transform3d|camera|unreachable|unsupported/i.test(`${result.stderr}\n${result.stdout}`);
    }
    const cpu = receipt(await run(executable, ["engine-render", graphPath, bindingsPath, "0", cpuPath, "cpu"]), "2.5D CPU oracle");
    const gpu = receipt(await run(executable, ["engine-render", graphPath, bindingsPath, "0", gpuPath, "gpu"]), "2.5D GPU export");
    const resident = await residentRender(executable, graphPath, bindingsPath, previewPath);

    const negativeControls = [];
    const negative = async (name, mutate, marker) => {
      const value = structuredClone(graph); mutate(value);
      const path = join(temporary, `negative-${name}.json`);
      await writeFile(path, JSON.stringify(value));
      await expectRejected(executable, ["engine-render", path, bindingsPath, "0", join(temporary, `negative-${name}.png`), "gpu"], marker);
      negativeControls.push(name);
    };
    await negative("multiple-camera", (value) => value.nodes.splice(-1, 0, { ...value.nodes.find((node) => node.id === "camera"), id: "camera-2" }), "exactly one.*camera");
    await negative("unsupported-light", (value) => { value.nodes.find((node) => node.id === "key").lightKind = "point"; }, "point|directional");
    await negative("parent-cycle", (value) => { value.nodes.find((node) => node.id === "back-3d").parent = "front-3d"; }, "cycle");
    await negative("camera-clipping", (value) => { value.nodes.find((node) => node.id === "front-3d").position[2] = 8; }, "clip|camera");

    const requiredNodeIds = graph.nodes.map((node) => node.id);
    const scene = gpu.scene25d ?? resident.loaded.scene25d;
    const report = {
      schema: "editkin.native-25d-scene-gate/v1", status: "GREEN", baselineRejected,
      sceneContract: scene?.sceneContract, planeCount: scene?.planeCount, parentedPlaneCount: scene?.parentedPlaneCount,
      directionalLightCount: scene?.directionalLightCount, ambientLightCount: scene?.ambientLightCount,
      directExecution: gpu.directExecution === true && resident.loaded.engineGraph?.directExecution === true,
      cpuGpuMaxChannelError: await pngError(cpuPath, gpuPath), previewExportMaxChannelError: await pngError(gpuPath, previewPath),
      residentFrames: resident.frames, residentP95Ms: resident.p95Ms,
      requiredNodeIds, executedNodeIds: gpu.executedNodeIds, blockedNodeIds: gpu.blockedNodeIds, ignoredNodeIds: gpu.ignoredNodeIds,
      rejectedNegativeControls: negativeControls, outputSha256: hash(await readFile(gpuPath)), graphSha256: hash(await readFile(graphPath)),
      candidate: { path: executable, sha256: hash(await readFile(executable)) }, baseline: baseline ? { path: baseline, sha256: hash(await readFile(baseline)) } : null,
    };
    assertReport(report);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) selfTest();
else {
  const executableIndex = args.indexOf("--executable");
  const baselineIndex = args.indexOf("--baseline");
  const outputIndex = args.indexOf("--output");
  const executable = executableIndex >= 0 ? resolve(args[executableIndex + 1]) : defaultExecutable;
  const baseline = baselineIndex >= 0 ? resolve(args[baselineIndex + 1]) : defaultBaseline;
  const reportPath = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : defaultReport;
  try { await main(executable, baseline, reportPath); }
  catch (error) {
    const report = { schema: "editkin.native-25d-scene-gate/v1", status: "BLOCK", error: String(error?.stack ?? error), executable, baseline };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${report.error}\n`);
    process.exitCode = 1;
  }
}
