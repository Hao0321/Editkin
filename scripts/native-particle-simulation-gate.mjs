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
const defaultReport = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-native-particle-simulation", "report.json");
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
}

async function pngError(leftPath, rightPath) {
  const left = PNG.sync.read(await readFile(leftPath));
  const right = PNG.sync.read(await readFile(rightPath));
  if (left.width !== right.width || left.height !== right.height) return 255;
  let maximum = 0;
  for (let index = 0; index < left.data.length; index += 1) maximum = Math.max(maximum, Math.abs(left.data[index] - right.data[index]));
  return maximum;
}

function particleGraph() {
  return {
    schema: "editkin.engine-graph/v1", graphId: "native-bounded-particle-simulation", width: 320, height: 180,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [
      {
        id: "particles", inputs: [], enabled: true, kind: "particle_emitter", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 120 }, seed: 32021,
        ratePerSecond: 48, lifetimeSeconds: 1.25, initialVelocity: [18, -76, 0], gravity: [0, 82, 0],
        maxParticles: 64, emitterPosition: [0.5, 0.72], radiusPixels: 3.25, color: [1, 0.42, 0.06, 0.92],
      },
      { id: "output", inputs: ["particles"], enabled: true, kind: "output", format: "rgba16_float" },
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
    const id = `particles-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await ready;
    const loaded = await request("engine_load", { sessionId: "particles", graphPath, bindingsPath, timelineFrame: 18 });
    if (!loaded.ok) throw new Error(`resident load failed: ${JSON.stringify(loaded)}`);
    const rendered = await request("render", { sessionId: "particles", outputPath });
    if (!rendered.ok) throw new Error(`resident render failed: ${JSON.stringify(rendered)}`);
    const timings = [];
    const hashes = [];
    for (let frame = 0; frame < 34; frame += 1) {
      const updated = await request("engine_update_frame", { sessionId: "particles", timelineFrame: frame + 8 });
      if (!updated.ok) throw new Error(`resident frame update failed: ${JSON.stringify(updated)}`);
      const sample = await request("render", { sessionId: "particles" });
      if (!sample.ok) throw new Error(`resident sample failed: ${JSON.stringify(sample)}`);
      if (frame >= 4) timings.push(sample.result.renderMilliseconds);
      hashes.push(sample.result.outputHash);
    }
    timings.sort((a, b) => a - b);
    await request("release", { sessionId: "particles" });
    await request("shutdown");
    child.stdin.end();
    await new Promise((resolvePromise, reject) => child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `serve exited ${code}`))));
    return {
      loaded: loaded.result, rendered: rendered.result, frames: timings.length,
      p95Ms: timings[Math.floor((timings.length - 1) * 0.95)], distinctFrameHashes: new Set(hashes).size,
    };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

function assertReport(report) {
  if (report.schema !== "editkin.native-particle-simulation-gate/v1" || report.status !== "GREEN") throw new Error("particle simulation gate is not GREEN");
  if (!report.baselineRejected || !report.directExecution || report.cpuGpuMaxChannelError > 1 || report.previewExportMaxChannelError > 1) throw new Error("particle simulation parity is incomplete");
  if (report.simulationContract !== "screen_space_analytic_particles/v1" || report.executor !== "wgpu-bounded-particle-compute/v1" || report.emitterCount !== 1 || report.particleCeiling !== 64) throw new Error("bounded particle receipt is incomplete");
  if (!report.repeatDeterministic || !report.timeEvolves || report.distinctResidentFrameHashes < 24) throw new Error("particle temporal determinism is incomplete");
  if (report.residentFrames < 30 || !Number.isFinite(report.residentP95Ms) || report.residentP95Ms > 8) throw new Error("particle resident performance ceiling failed");
  if (report.blockedNodeIds.length || report.ignoredNodeIds.length || report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("particle node coverage is incomplete");
  if (report.rejectedNegativeControls.length !== 4) throw new Error("particle negative controls are incomplete");
}

function selfTest() {
  const valid = {
    schema: "editkin.native-particle-simulation-gate/v1", status: "GREEN", baselineRejected: true, directExecution: true,
    cpuGpuMaxChannelError: 1, previewExportMaxChannelError: 0, simulationContract: "screen_space_analytic_particles/v1",
    executor: "wgpu-bounded-particle-compute/v1", emitterCount: 1, particleCeiling: 64, repeatDeterministic: true,
    timeEvolves: true, distinctResidentFrameHashes: 30, residentFrames: 30, residentP95Ms: 3,
    requiredNodeIds: ["particles", "output"], executedNodeIds: ["particles", "output"], blockedNodeIds: [], ignoredNodeIds: [],
    rejectedNegativeControls: ["ceiling", "z-motion", "multiple", "disabled"],
  };
  assertReport(valid);
  for (const invalid of [{ ...valid, baselineRejected: false }, { ...valid, cpuGpuMaxChannelError: 2 }, { ...valid, repeatDeterministic: false }, { ...valid, particleCeiling: 128 }, { ...valid, ignoredNodeIds: ["particles"] }]) {
    let rejected = false; try { assertReport(invalid); } catch { rejected = true; }
    if (!rejected) throw new Error("self-test accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 5 })}\n`);
}

async function main(executable, baseline, reportPath) {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-particles-"));
  try {
    const graph = particleGraph();
    const graphPath = join(temporary, "particles.json");
    const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graph));
    await writeFile(bindingsPath, "{}");
    let baselineRejected = baseline === null;
    if (baseline) {
      const result = await run(baseline, ["engine-render", graphPath, bindingsPath, "18", join(temporary, "baseline.png"), "gpu"]);
      baselineRejected = result.code !== 0 && /particle_emitter|unsupported/i.test(`${result.stderr}\n${result.stdout}`);
    }
    const cpuPath = join(temporary, "cpu.png");
    const gpuPath = join(temporary, "gpu.png");
    const repeatPath = join(temporary, "repeat.png");
    const nextPath = join(temporary, "next.png");
    const previewPath = join(temporary, "preview.png");
    const cpu = receipt(await run(executable, ["engine-render", graphPath, bindingsPath, "18", cpuPath, "cpu"]), "particle CPU oracle");
    const gpu = receipt(await run(executable, ["engine-render", graphPath, bindingsPath, "18", gpuPath, "gpu"]), "particle GPU export");
    receipt(await run(executable, ["engine-render", graphPath, bindingsPath, "18", repeatPath, "gpu"]), "particle repeat export");
    receipt(await run(executable, ["engine-render", graphPath, bindingsPath, "19", nextPath, "gpu"]), "particle next-frame export");
    const resident = await residentRender(executable, graphPath, bindingsPath, previewPath);

    const negativeControls = [];
    const negative = async (name, mutate, marker) => {
      const value = structuredClone(graph); mutate(value);
      const path = join(temporary, `negative-${name}.json`);
      await writeFile(path, JSON.stringify(value));
      await expectRejected(executable, ["engine-render", path, bindingsPath, "18", join(temporary, `negative-${name}.png`), "gpu"], marker);
      negativeControls.push(name);
    };
    await negative("particle-ceiling", (value) => { value.nodes[0].maxParticles = 65; }, "ceiling|64");
    await negative("z-motion", (value) => { value.nodes[0].initialVelocity[2] = 1; }, "screen.space|z|2d");
    await negative("multiple-emitter", (value) => { value.nodes.splice(1, 0, { ...structuredClone(value.nodes[0]), id: "particles-2" }); }, "one emitter|unreachable|exactly one");
    await negative("disabled-emitter", (value) => { value.nodes[0].enabled = false; }, "disabled.*particle");

    const requiredNodeIds = graph.nodes.map((node) => node.id);
    const simulation = gpu.vfxSimulation ?? resident.loaded.vfxSimulation;
    const gpuHash = hash(await readFile(gpuPath));
    const report = {
      schema: "editkin.native-particle-simulation-gate/v1", status: "GREEN", baselineRejected,
      simulationContract: simulation?.simulationContract, executor: simulation?.executor,
      emitterCount: simulation?.emitterCount, particleCeiling: simulation?.particleCeiling,
      directExecution: gpu.directExecution === true && resident.loaded.engineGraph?.directExecution === true,
      cpuGpuMaxChannelError: await pngError(cpuPath, gpuPath), previewExportMaxChannelError: await pngError(gpuPath, previewPath),
      repeatDeterministic: gpuHash === hash(await readFile(repeatPath)), timeEvolves: gpuHash !== hash(await readFile(nextPath)),
      distinctResidentFrameHashes: resident.distinctFrameHashes, residentFrames: resident.frames, residentP95Ms: resident.p95Ms,
      requiredNodeIds, executedNodeIds: cpu.executedNodeIds, blockedNodeIds: gpu.blockedNodeIds, ignoredNodeIds: gpu.ignoredNodeIds,
      rejectedNegativeControls: negativeControls, outputSha256: gpuHash, graphSha256: hash(await readFile(graphPath)),
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
    const report = { schema: "editkin.native-particle-simulation-gate/v1", status: "BLOCK", error: String(error?.stack ?? error), executable, baseline };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${report.error}\n`);
    process.exitCode = 1;
  }
}
