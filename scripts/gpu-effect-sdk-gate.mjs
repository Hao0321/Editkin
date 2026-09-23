import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const selfTest = process.argv.includes("--self-test");
const executableArgument = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const executable = resolve(executableArgument ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const reportPath = resolve(root, "../../.rd/benchmarks/editkin-gpu-effect-sdk/report.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clamp = (value) => Math.max(0, Math.min(1, value));

function assertGreen(report) {
  if (report.schema !== "editkin.gpu-effect-sdk-gate/v1" || report.status !== "GREEN") throw new Error("GPU effect SDK report is not GREEN");
  if (report.authoringRuntime !== "gpu_effect_module" || report.runtime !== "editkin.gpu-effect-graph/v1") throw new Error("SDK module did not compile to the stable runtime ABI");
  if (report.shaderOpCount !== 4 || report.opcodes.join(",") !== "12,10,9,11" || !report.bindingResolved) throw new Error("SDK opcode order was not preserved");
  if (!report.artifactChanged || report.pixelOracleMaxChannelError > 2 || report.pixelOracleP99ChannelError > 1) throw new Error("SDK GPU pixel oracle failed");
  if (report.decodePathCpuPixelCopies !== 0 || report.stagingCpuPixelReadbacks !== 0 || report.nativeSurfaceCpuPixelReadbacks !== 0) throw new Error("SDK effect entered a CPU pixel path");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20) throw new Error("SDK resident performance gate failed");
  if (report.rejectedNegativeControls.join(",") !== "new-op-bounds,unknown-opcode") throw new Error("SDK runtime negative controls are incomplete");
  for (const value of [report.executableSha256, report.manifestSha256, report.programSha256, report.plainArtifactSha256, report.effectArtifactSha256]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("SDK identity receipt is incomplete");
  }
}

function runSelfTest() {
  const valid = {
    schema: "editkin.gpu-effect-sdk-gate/v1", status: "GREEN", authoringRuntime: "gpu_effect_module", runtime: "editkin.gpu-effect-graph/v1",
    shaderOpCount: 4, opcodes: [12, 10, 9, 11], bindingResolved: true, artifactChanged: true,
    pixelOracleMaxChannelError: 2, pixelOracleP99ChannelError: 1, decodePathCpuPixelCopies: 0, stagingCpuPixelReadbacks: 0,
    nativeSurfaceCpuPixelReadbacks: 0, presentedFrames: 60, presentP95Ms: 10,
    rejectedNegativeControls: ["new-op-bounds", "unknown-opcode"], executableSha256: "a".repeat(64), manifestSha256: "b".repeat(64),
    programSha256: "c".repeat(64), plainArtifactSha256: "d".repeat(64), effectArtifactSha256: "e".repeat(64),
  };
  assertGreen(valid);
  for (const candidate of [
    { ...valid, opcodes: [12, 9, 10, 11] }, { ...valid, pixelOracleP99ChannelError: 2 },
    { ...valid, decodePathCpuPixelCopies: 1 }, { ...valid, rejectedNegativeControls: ["new-op-bounds"] },
  ]) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("GPU effect SDK evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 4 })}\n`);
}

function compileBundledModule() {
  const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
  const kit = resolve(root, "scripts/editkin-plugin-kit.ts");
  const manifest = resolve(root, "plugins/gpu-color-lab/editkin-plugin.json");
  const completed = spawnSync(process.execPath, [tsx, kit, "validate", manifest], { cwd: root, encoding: "utf8", windowsHide: true });
  if (completed.status !== 0) throw new Error(`GPU effect SDK compile failed: ${completed.stderr || completed.stdout}`);
  const receipt = JSON.parse(completed.stdout);
  const program = receipt.gpuPrograms?.[0];
  if (receipt.status !== "GREEN" || !program) throw new Error("GPU effect SDK compile receipt is incomplete");
  return { receipt, program };
}

function graph(pluginIdentity, parameters, withEffect) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  if (withEffect) {
    nodes.push({ id: "sdk-effect", inputs: [tail], enabled: true, kind: "effect", pluginId: pluginIdentity, abiVersion: 1, temporalRadius: 0, parameters });
    tail = "sdk-effect";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId: withEffect ? "gpu-sdk" : "gpu-sdk-plain", width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}

function programSha256(pluginIdentity, parameters, operations) {
  const chunks = [];
  const appendU32 = (value) => { const chunk = Buffer.allocUnsafe(4); chunk.writeUInt32LE(value); chunks.push(chunk); };
  const appendString = (value) => { const chunk = Buffer.from(value, "utf8"); appendU32(chunk.length); chunks.push(chunk); };
  appendString("editkin.gpu-effect-graph/v1"); appendString(pluginIdentity);
  const entries = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right));
  appendU32(entries.length);
  for (const [key, value] of entries) { appendString(key); const chunk = Buffer.allocUnsafe(8); chunk.writeDoubleLE(value); chunks.push(chunk); }
  appendU32(operations.length);
  for (const operation of operations) { appendU32(operation.opcode); for (const argument of operation.args) { const chunk = Buffer.allocUnsafe(4); chunk.writeFloatLE(argument); chunks.push(chunk); } }
  return sha256(Buffer.concat(chunks));
}

function expectedPixel(r, g, b, parameters) {
  const srgbToLinear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const linearToSrgb = (value) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  let color = [r / 255, g / 255, b / 255].map(srgbToLinear);
  color = color.map((value, index) => clamp(value + [parameters.temperature * .06, parameters.tint * .045, -parameters.temperature * .06][index]));
  color = color.map((value) => clamp(Math.max(value + parameters.lift, 0) ** (1 / Math.max(parameters.gamma, .1)) * parameters.gain));
  const c = Math.cos(parameters.hue); const s = Math.sin(parameters.hue); const [red, green, blue] = color;
  color = [
    red * (.299 + .701 * c + .168 * s) + green * (.587 - .587 * c + .330 * s) + blue * (.114 - .114 * c - .497 * s),
    red * (.299 - .299 * c - .328 * s) + green * (.587 + .413 * c + .035 * s) + blue * (.114 - .114 * c + .292 * s),
    red * (.299 - .300 * c + 1.250 * s) + green * (.587 - .588 * c - 1.050 * s) + blue * (.114 + .886 * c - .203 * s),
  ].map(clamp);
  color = color.map((value) => {
    const toe = Math.max(value, 0) ** (1 + parameters.toe * 1.5);
    const shaped = 1 - Math.max(1 - toe, 0) ** (1 + parameters.shoulder * 1.5);
    return clamp(value * (1 - parameters.curve) + shaped * parameters.curve);
  });
  return color.map((value) => Math.round(linearToSrgb(clamp(value)) * 255));
}

function pixelOracle(plainBytes, effectBytes, parameters) {
  const plain = PNG.sync.read(plainBytes); const effect = PNG.sync.read(effectBytes);
  if (plain.width !== effect.width || plain.height !== effect.height) throw new Error("SDK artifacts have different dimensions");
  const errors = [];
  for (let offset = 0; offset < plain.data.length; offset += 4) {
    const expected = expectedPixel(plain.data[offset], plain.data[offset + 1], plain.data[offset + 2], parameters);
    errors.push(Math.abs(expected[0] - effect.data[offset]), Math.abs(expected[1] - effect.data[offset + 1]), Math.abs(expected[2] - effect.data[offset + 2]));
  }
  errors.sort((left, right) => left - right);
  return { max: errors.at(-1), p99: errors[Math.floor((errors.length - 1) * .99)] };
}

async function run() {
  const { receipt, program } = compileBundledModule();
  const temporary = await mkdtemp(join(tmpdir(), "editkin-gpu-effect-sdk-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `gpu-sdk-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    let readyTimer; await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); })]); clearTimeout(readyTimer);
    const bindingsPath = join(temporary, "assets.json"); const plainGraphPath = join(temporary, "plain.json"); const effectGraphPath = join(temporary, "effect.json"); const effectsPath = join(temporary, "effects.json");
    const effectBinding = { schema: "editkin.gpu-effect-bindings/v1", bindings: { "sdk-effect": { schema: "editkin.gpu-effect-graph/v1", nodeId: "sdk-effect", pluginIdentity: program.pluginIdentity, parameters: program.parameters, programSha256: program.programSha256, operations: program.operations } } };
    await writeFile(bindingsPath, JSON.stringify({ video: resolve(root, "public/demo-source.mp4") }));
    await writeFile(plainGraphPath, JSON.stringify(graph(program.pluginIdentity, program.parameters, false))); await writeFile(effectGraphPath, JSON.stringify(graph(program.pluginIdentity, program.parameters, true))); await writeFile(effectsPath, JSON.stringify(effectBinding));
    const bound = await request("surface_bind", { parentHwnd: "0", x: 24, y: 24, width: 64, height: 36 }); if (!bound.ok) throw new Error(`SDK surface bind failed: ${JSON.stringify(bound)}`);
    const plainLoaded = await request("engine_video_load", { sessionId: "gpu-sdk-plain", graphPath: plainGraphPath, bindingsPath, timelineFrame: 0 }); const plainPath = join(temporary, "plain.png");
    const plainVerified = await request("engine_video_verify_frame", { sessionId: "gpu-sdk-plain", timelineFrame: 15, toleranceSeconds: 1 / 60, outputPath: plainPath }); await request("engine_video_release", { sessionId: "gpu-sdk-plain" });
    if (!plainLoaded.ok || !plainVerified.ok) throw new Error(`SDK plain oracle failed: ${JSON.stringify({ plainLoaded, plainVerified })}`);
    const effectLoaded = await request("engine_video_load", { sessionId: "gpu-sdk-active", graphPath: effectGraphPath, bindingsPath, effectBindingsPath: effectsPath, timelineFrame: 0 }); const effectPath = join(temporary, "effect.png");
    const effectVerified = await request("engine_video_verify_frame", { sessionId: "gpu-sdk-active", timelineFrame: 15, toleranceSeconds: 1 / 60, outputPath: effectPath });
    if (!effectLoaded.ok || !effectVerified.ok) throw new Error(`SDK effect oracle failed: ${JSON.stringify({ effectLoaded, effectVerified })}`);
    const resolvedProgram = effectLoaded.result.gpuEffects?.programs?.[0];
    const bindingResolved = effectLoaded.result.gpuEffects?.count === 1 && resolvedProgram?.nodeId === "sdk-effect" && resolvedProgram?.pluginIdentity === program.pluginIdentity && resolvedProgram?.programSha256 === program.programSha256;
    const plainBytes = await readFile(plainPath); const effectBytes = await readFile(effectPath); const oracle = pixelOracle(plainBytes, effectBytes, program.parameters);
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "gpu-sdk-active", timelineFrame: 16 + index, toleranceSeconds: 1 / 60 }); if (!last.ok) throw new Error(`SDK present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); }
    times.sort((left, right) => left - right);
    const rejectedNegativeControls = [];
    const negative = async (name, operations, marker) => {
      const candidate = structuredClone(effectBinding); candidate.bindings["sdk-effect"].operations = operations; candidate.bindings["sdk-effect"].programSha256 = programSha256(program.pluginIdentity, program.parameters, operations);
      const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate));
      const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: effectGraphPath, bindingsPath, effectBindingsPath: path, timelineFrame: 0 });
      if (response.ok || !String(response.error).includes(marker)) throw new Error(`${name} negative was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name);
    };
    await negative("new-op-bounds", [{ opcode: 9, args: [4, 0, 0] }], "out of bounds");
    await negative("unknown-opcode", [{ opcode: 13, args: [0, 0, 0] }], "unsupported GPU effect opcode");
    const released = await request("engine_video_release", { sessionId: "gpu-sdk-active" }); await request("surface_release"); await request("shutdown"); child.stdin.end();
    const frame = last.result.frame;
    return {
      status: "GREEN", pluginId: receipt.pluginId, authoringRuntime: program.authoringRuntime, manifestSha256: receipt.manifestSha256,
      runtime: effectLoaded.result.gpuEffects?.runtime, bindingResolved, shaderOpCount: last.result.visualGraph?.shaderOpCount, opcodes: program.opcodes,
      programSha256: program.programSha256, artifactChanged: !plainBytes.equals(effectBytes), plainArtifactSha256: sha256(plainBytes), effectArtifactSha256: sha256(effectBytes),
      pixelOracleMaxChannelError: oracle.max, pixelOracleP99ChannelError: oracle.p99, decodePathCpuPixelCopies: frame.decodePathCpuPixelCopies,
      stagingCpuPixelReadbacks: frame.stagingCpuPixelReadbacks, nativeSurfaceCpuPixelReadbacks: frame.nativeSurfaceCpuPixelReadbacks,
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences,
    };
  } finally {
    lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return runSelfTest();
  const observed = await run(); const report = { schema: "editkin.gpu-effect-sdk-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); assertGreen(report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
