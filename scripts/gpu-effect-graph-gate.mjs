import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const executableArgument = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const executable = resolve(executableArgument ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-gpu-effect-graph");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertGreen(report) {
  if (report.schema !== "editkin.gpu-effect-graph-gate/v2" || report.status !== "GREEN") throw new Error("GPU effect graph report is not GREEN");
  if (report.runtime !== "editkin.gpu-effect-graph/v1" || report.shaderOpCount !== 8 || report.programCount !== 2 || report.stackOrderResolved !== true || report.effectBindingResolved !== true) throw new Error("ordered GPU effect stack was not executed");
  if (!report.artifactChanged || report.pixelOracleMaxChannelError > 1 || report.pixelOracleP99ChannelError > 1) throw new Error("GPU effect graph pixel oracle failed");
  if (report.decodePathCpuPixelCopies !== 0 || report.stagingCpuPixelReadbacks !== 0 || report.nativeSurfaceCpuPixelReadbacks !== 0) throw new Error("GPU effect graph entered a CPU pixel path");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20) throw new Error("GPU effect graph resident performance gate failed");
  if (report.rejectedNegativeControls.length !== 8) throw new Error("GPU effect graph negative controls are incomplete");
  for (const value of [report.executableSha256, report.stackSha256, ...report.programSha256s, report.plainArtifactSha256, report.effectArtifactSha256]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("GPU effect graph identity is incomplete");
  }
}

function runSelfTest() {
  const valid = {
    schema: "editkin.gpu-effect-graph-gate/v2", status: "GREEN", runtime: "editkin.gpu-effect-graph/v1",
    shaderOpCount: 8, programCount: 2, stackOrderResolved: true, effectBindingResolved: true, artifactChanged: true, pixelOracleMaxChannelError: 1,
    pixelOracleP99ChannelError: 1, decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0,
    nativeSurfaceCpuPixelReadbacks: 0, presentedFrames: 60, presentP95Ms: 10,
    rejectedNegativeControls: ["missing", "identity", "parameters", "operation-overflow", "stack-overflow", "opcode", "tampered", "orphan"],
    executableSha256: "a".repeat(64), stackSha256: "b".repeat(64), programSha256s: ["c".repeat(64), "d".repeat(64)], plainArtifactSha256: "e".repeat(64), effectArtifactSha256: "f".repeat(64),
  };
  assertGreen(valid);
  for (const candidate of [
    { ...valid, effectBindingResolved: false }, { ...valid, artifactChanged: false },
    { ...valid, pixelOracleMaxChannelError: 2 }, { ...valid, decodePathCpuPixelCopies: 1 },
    { ...valid, presentedFrames: 59 }, { ...valid, rejectedNegativeControls: valid.rejectedNegativeControls.slice(1) },
  ]) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("GPU effect graph evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 8 })}\n`);
}

const parameterMap = { gain: 0.8, invert: 0.25, grayscale: 0.4, contrast: 1.15, pivot: 0.5 };
const operations = [
  { opcode: 1, args: [parameterMap.gain, 0, 0] },
  { opcode: 2, args: [parameterMap.invert, 0, 0] },
  { opcode: 3, args: [parameterMap.grayscale, 0, 0] },
  { opcode: 5, args: [parameterMap.contrast, parameterMap.pivot, 0] },
];
const pluginIdentity = `editkin.gate.gpu-effect/gain-invert@1.0.0#${"a".repeat(64)}`;
const parameterMap2 = { gain: 1.35, invert: 0.8, grayscale: 0.05, contrast: 0.72, pivot: 0.42 };
const operations2 = [
  { opcode: 1, args: [parameterMap2.gain, 0, 0] },
  { opcode: 2, args: [parameterMap2.invert, 0, 0] },
  { opcode: 3, args: [parameterMap2.grayscale, 0, 0] },
  { opcode: 5, args: [parameterMap2.contrast, parameterMap2.pivot, 0] },
];
const pluginIdentity2 = `editkin.gate.gpu-effect/second-look@1.0.0#${"b".repeat(64)}`;
function gpuEffectProgramSha256(identity, parameters, programOperations) {
  const chunks = [];
  const appendU32 = (value) => { const chunk = Buffer.allocUnsafe(4); chunk.writeUInt32LE(value); chunks.push(chunk); };
  const appendString = (value) => { const chunk = Buffer.from(value, "utf8"); appendU32(chunk.length); chunks.push(chunk); };
  appendString("editkin.gpu-effect-graph/v1"); appendString(identity);
  const entries = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right));
  appendU32(entries.length);
  for (const [key, value] of entries) { appendString(key); const chunk = Buffer.allocUnsafe(8); chunk.writeDoubleLE(value); chunks.push(chunk); }
  appendU32(programOperations.length);
  for (const operation of programOperations) {
    appendU32(operation.opcode);
    for (const argument of operation.args) { const chunk = Buffer.allocUnsafe(4); chunk.writeFloatLE(argument); chunks.push(chunk); }
  }
  return sha256(Buffer.concat(chunks));
}
const programSha256 = gpuEffectProgramSha256(pluginIdentity, parameterMap, operations);
const programSha2562 = gpuEffectProgramSha256(pluginIdentity2, parameterMap2, operations2);

function graph(withEffect) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  if (withEffect) {
    nodes.push({ id: "effect-a", inputs: [tail], enabled: true, kind: "effect", pluginId: pluginIdentity, abiVersion: 1, temporalRadius: 0, parameters: parameterMap });
    tail = "effect-a";
    nodes.push({ id: "effect-b", inputs: [tail], enabled: true, kind: "effect", pluginId: pluginIdentity2, abiVersion: 1, temporalRadius: 0, parameters: parameterMap2 });
    tail = "effect-b";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId: withEffect ? "gpu-effect" : "gpu-effect-plain", width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}

function binding(overrides = {}) {
  return {
    schema: "editkin.gpu-effect-bindings/v1",
    bindings: {
      "effect-a": {
        schema: "editkin.gpu-effect-graph/v1", nodeId: "effect-a", pluginIdentity,
        parameters: parameterMap, programSha256, operations,
        ...overrides,
      },
      "effect-b": {
        schema: "editkin.gpu-effect-graph/v1", nodeId: "effect-b", pluginIdentity: pluginIdentity2,
        parameters: parameterMap2, programSha256: programSha2562, operations: operations2,
      },
    },
  };
}

function expectedPixel(r, g, b) {
  const srgbToLinear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const linearToSrgb = (value) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  let color = [r / 255, g / 255, b / 255].map(srgbToLinear);
  const applyLook = (input, parameters) => {
    let output = input.map((value) => value * parameters.gain);
    output = output.map((value) => value * (1 - parameters.invert) + (1 - value) * parameters.invert);
    const luma = output[0] * 0.2126 + output[1] * 0.7152 + output[2] * 0.0722;
    output = output.map((value) => value * (1 - parameters.grayscale) + luma * parameters.grayscale);
    return output.map((value) => Math.max(0, Math.min(1, (value - parameters.pivot) * parameters.contrast + parameters.pivot)));
  };
  color = applyLook(color, parameterMap);
  color = applyLook(color, parameterMap2);
  return color.map((value) => Math.round(linearToSrgb(Math.max(0, Math.min(1, value))) * 255));
}

function pixelOracle(plainBytes, effectBytes) {
  const plain = PNG.sync.read(plainBytes);
  const effect = PNG.sync.read(effectBytes);
  if (plain.width !== effect.width || plain.height !== effect.height) throw new Error("GPU effect graph artifact dimensions differ");
  const errors = [];
  for (let offset = 0; offset < plain.data.length; offset += 4) {
    const expected = expectedPixel(plain.data[offset], plain.data[offset + 1], plain.data[offset + 2]);
    errors.push(Math.abs(expected[0] - effect.data[offset]), Math.abs(expected[1] - effect.data[offset + 1]), Math.abs(expected[2] - effect.data[offset + 2]));
  }
  errors.sort((left, right) => left - right);
  return { max: errors.at(-1), p99: errors[Math.floor((errors.length - 1) * 0.99)] };
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-gpu-effect-graph-"));
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
    const id = `gpu-effect-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const bindingsPath = join(temporary, "assets.json");
    const plainGraphPath = join(temporary, "plain.json");
    const effectGraphPath = join(temporary, "effect.json");
    const effectBindingsPath = join(temporary, "effects.json");
    await writeFile(bindingsPath, JSON.stringify({ video: resolve(root, "public/demo-source.mp4") }));
    await writeFile(plainGraphPath, JSON.stringify(graph(false)));
    await writeFile(effectGraphPath, JSON.stringify(graph(true)));
    await writeFile(effectBindingsPath, JSON.stringify(binding()));
    const observed = await request("engine_video_load", { sessionId: "gpu-effect-baseline", graphPath: effectGraphPath, bindingsPath, effectBindingsPath, timelineFrame: 0 });
    if (baseline) {
      if (observed.ok || !String(observed.error).includes("stacked common video effects")) throw new Error(`baseline did not expose the single-graph limit: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "a second third-party GPU effect graph is not admitted", observedError: observed.error };
    }
    if (!observed.ok) throw new Error(`GPU effect graph load failed: ${JSON.stringify(observed)}`);
    await request("engine_video_release", { sessionId: "gpu-effect-baseline" });
    const bound = await request("surface_bind", { parentHwnd: "0", x: 24, y: 24, width: 64, height: 36 });
    if (!bound.ok) throw new Error(`GPU effect graph surface bind failed: ${JSON.stringify(bound)}`);
    const plainLoaded = await request("engine_video_load", { sessionId: "gpu-effect-plain", graphPath: plainGraphPath, bindingsPath, timelineFrame: 0 });
    const plainPath = join(temporary, "plain.png");
    const plainVerified = await request("engine_video_verify_frame", { sessionId: "gpu-effect-plain", timelineFrame: 15, toleranceSeconds: 1 / 60, outputPath: plainPath });
    await request("engine_video_release", { sessionId: "gpu-effect-plain" });
    if (!plainLoaded.ok || !plainVerified.ok) throw new Error(`GPU effect plain oracle failed: ${JSON.stringify({ plainLoaded, plainVerified })}`);
    const effectLoaded = await request("engine_video_load", { sessionId: "gpu-effect-active", graphPath: effectGraphPath, bindingsPath, effectBindingsPath, timelineFrame: 0 });
    const effectPath = join(temporary, "effect.png");
    const effectVerified = await request("engine_video_verify_frame", { sessionId: "gpu-effect-active", timelineFrame: 15, toleranceSeconds: 1 / 60, outputPath: effectPath });
    if (!effectLoaded.ok || !effectVerified.ok) throw new Error(`GPU effect oracle failed: ${JSON.stringify({ effectLoaded, effectVerified })}`);
    const resolvedPrograms = effectLoaded.result.gpuEffects?.programs ?? [];
    const stackOrderResolved = resolvedPrograms.length === 2
      && resolvedPrograms[0]?.nodeId === "effect-a" && resolvedPrograms[0]?.programSha256 === programSha256
      && resolvedPrograms[1]?.nodeId === "effect-b" && resolvedPrograms[1]?.programSha256 === programSha2562;
    if (!stackOrderResolved) throw new Error(`GPU effect stack identity/order receipt failed: ${JSON.stringify(resolvedPrograms)}`);
    const plainBytes = await readFile(plainPath);
    const effectBytes = await readFile(effectPath);
    const oracle = pixelOracle(plainBytes, effectBytes);
    const times = [];
    let last;
    for (let index = 0; index < 64; index += 1) {
      const started = performance.now();
      last = await request("engine_video_present_frame", { sessionId: "gpu-effect-active", timelineFrame: 16 + index, toleranceSeconds: 1 / 60 });
      if (!last.ok) throw new Error(`GPU effect present failed: ${JSON.stringify(last)}`);
      if (index >= 4) times.push(performance.now() - started);
    }
    times.sort((left, right) => left - right);
    const rejectedNegativeControls = [];
    const negative = async (name, candidateBinding, mutateGraph, marker) => {
      const selectedGraph = graph(true);
      mutateGraph?.(selectedGraph);
      const graphPath = join(temporary, `negative-${name}-graph.json`);
      const effectPath = join(temporary, `negative-${name}-effects.json`);
      await writeFile(graphPath, JSON.stringify(selectedGraph));
      await writeFile(effectPath, JSON.stringify(candidateBinding));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath, bindingsPath, effectBindingsPath: effectPath, timelineFrame: 0 });
      if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} negative was not rejected: ${JSON.stringify(response)}`);
      rejectedNegativeControls.push(name);
    };
    await negative("missing", { ...binding(), bindings: { "effect-b": binding().bindings["effect-b"] } }, undefined, "missing GPU effect binding");
    await negative("identity", binding({ pluginIdentity: `${pluginIdentity}x` }), undefined, "identity mismatch");
    await negative("parameters", binding({ parameters: { ...parameterMap, gain: 0.7 } }), undefined, "parameters mismatch");
    await negative("operation-overflow", binding({ operations: [...operations, operations[0]] }), undefined, "supports at most 4 operations");
    const overflowGraph = graph(true);
    let overflowTail = "effect-b";
    const overflowBindings = binding();
    for (let index = 2; index < 5; index += 1) {
      const id = `effect-${index}`;
      overflowGraph.nodes.splice(-1, 0, { id, inputs: [overflowTail], enabled: true, kind: "effect", pluginId: pluginIdentity, abiVersion: 1, temporalRadius: 0, parameters: parameterMap });
      overflowBindings.bindings[id] = { ...overflowBindings.bindings["effect-a"], nodeId: id };
      overflowTail = id;
    }
    overflowGraph.nodes.at(-1).inputs = [overflowTail];
    await negative("stack-overflow", overflowBindings, (selectedGraph) => Object.assign(selectedGraph, overflowGraph), "supports at most 4 graphs");
    await negative("opcode", binding({ operations: [{ opcode: 99, args: [1, 0, 0] }] }), undefined, "unsupported GPU effect opcode");
    await negative("tampered", binding({ operations: [{ opcode: 1, args: [0.7, 0, 0] }, ...operations.slice(1)] }), undefined, "program hash mismatch");
    const orphan = binding(); orphan.bindings.orphan = { ...orphan.bindings["effect-a"], nodeId: "orphan" };
    await negative("orphan", orphan, undefined, "orphan GPU effect binding");
    const released = await request("engine_video_release", { sessionId: "gpu-effect-active" });
    await request("surface_release");
    await request("shutdown");
    const frame = last.result.frame;
    return {
      status: "GREEN", runtime: effectLoaded.result.gpuEffects?.runtime, effectBindingResolved: effectLoaded.result.gpuEffects?.resolved === true,
      shaderOpCount: last.result.visualGraph?.shaderOpCount, programCount: resolvedPrograms.length, stackOrderResolved,
      programSha256s: [programSha256, programSha2562], stackSha256: sha256(JSON.stringify(resolvedPrograms)),
      artifactChanged: !plainBytes.equals(effectBytes), plainArtifactSha256: sha256(plainBytes), effectArtifactSha256: sha256(effectBytes),
      pixelOracleMaxChannelError: oracle.max, pixelOracleP99ChannelError: oracle.p99,
      decodePathCpuPixelCopies: frame.decodePathCpuPixelCopies, stagingCpuPixelReadbacks: frame.stagingCpuPixelReadbacks,
      nativeSurfaceCpuPixelReadbacks: frame.nativeSurfaceCpuPixelReadbacks, presentedFrames: times.length,
      presentP50Ms: times[Math.floor(times.length * 0.5)], presentP95Ms: times[Math.floor((times.length - 1) * 0.95)],
      rejectedNegativeControls, releaseFences: released.result.fences,
    };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return runSelfTest();
  const observed = await run();
  const report = { schema: "editkin.gpu-effect-graph-gate/v2", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!baseline) assertGreen(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
