import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const baselineIndex = args.indexOf("--baseline");
const baseline = baselineIndex >= 0;
const corePath = resolve(baseline ? args[baselineIndex + 1] : join(root, "native/bin/win32-x64/hao-core.exe"));
const standardCargo = resolve(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const cargo = process.env.CARGO ?? (existsSync(standardCargo) ? standardCargo : "cargo");
const pluginRoot = join(root, "native/effect-test-plugin");
const libraryName = process.platform === "win32" ? "editkin_effect_test_plugin.dll" : process.platform === "darwin" ? "libeditkin_effect_test_plugin.dylib" : "libeditkin_effect_test_plugin.so";
const libraryPath = join(pluginRoot, "target/release", libraryName);
const evidence = resolve(root, "../../.rd/benchmarks/editkin-native-effect-sequence");
if (baseline) {
  await rm(evidence, { recursive: true, force: true });
}
await mkdir(evidence, { recursive: true });

const build = spawnSync(cargo, ["build", "--release"], { cwd: pluginRoot, encoding: "utf8", windowsHide: true });
if (build.status !== 0) throw new Error(build.stderr || "effect test plugin build failed");
const librarySha256 = createHash("sha256").update(await readFile(libraryPath)).digest("hex");
const manifestPath = join(evidence, "effect-plugin.json");
const manifest = { schema: "editkin.effect-plugin/v1", id: "editkin.diagnostic.gain-invert", version: "2.0.0", abiVersion: 2, librarySha256, entrySymbol: "editkin_effect_plugin_v2", supportedFormats: ["rgba32_float"], maxTemporalRadius: 0, timeoutMs: 100, deterministic: true };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const width = 4;
const height = 2;
const frameCount = 120;
const valuesPerFrame = width * height * 4;
const input = new Float32Array(valuesPerFrame * frameCount);
for (let frame = 0; frame < frameCount; frame += 1) {
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = frame * valuesPerFrame + pixel * 4;
    const alpha = pixel % 3 === 0 ? 0.5 : 1;
    input[offset] = Math.min(alpha, ((frame + pixel) % 29) / 28 * alpha);
    input[offset + 1] = Math.min(alpha, ((frame * 3 + pixel * 5) % 31) / 30 * alpha);
    input[offset + 2] = Math.min(alpha, ((frame * 7 + pixel * 2) % 37) / 36 * alpha);
    input[offset + 3] = alpha;
  }
}
const inputPath = join(evidence, "sequence-input.rgba32f");
const outputPath = join(evidence, "sequence-output.rgba32f");
await writeFile(inputPath, Buffer.from(input.buffer));
const requestPath = join(evidence, "sequence-request.json");
const request = {
  schema: "editkin.effect-plugin-sequence/v1", manifestPath, libraryPath, inputPath, outputPath,
  width, height, frameCount, startFrameIndex: 90, startTimeNumerator: 3, timeDenominator: 30,
  frameDurationNumerator: 1, frameDurationDenominator: 30, parameters: [0.8, 0.25, 0],
};
await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);

const execute = (path = requestPath, timeout = 30_000) => spawnSync(corePath, ["effect-plugin-sequence-run", path], { cwd: root, encoding: "utf8", windowsHide: true, timeout });
if (baseline) {
  const result = execute();
  if (result.status === 0) throw new Error("historical core unexpectedly accepted effect-plugin-sequence-run");
  const report = { schemaVersion: 1, status: "BLOCK", coreSha256: createHash("sha256").update(await readFile(corePath)).digest("hex"), observedError: String(result.stderr).trim().slice(-1_000) };
  await writeFile(join(evidence, "baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(0);
}

const positive = execute();
if (positive.status !== 0) throw new Error(positive.stderr || "effect sequence failed");
const supervisor = JSON.parse(positive.stdout);
const outputBytes = await readFile(outputPath);
const output = new Float32Array(
  outputBytes.buffer,
  outputBytes.byteOffset,
  outputBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
);
if (output.length !== input.length) throw new Error(`sequence output length ${output.length} != ${input.length}`);
let maxError = 0;
for (let index = 0; index < input.length; index += 4) {
  const alpha = input[index + 3];
  for (let channel = 0; channel < 3; channel += 1) {
    const base = Math.min(alpha, Math.max(0, input[index + channel]));
    const expected = (base + ((alpha - base) - base) * 0.25) * 0.8;
    maxError = Math.max(maxError, Math.abs(output[index + channel] - expected));
  }
  maxError = Math.max(maxError, Math.abs(output[index + 3] - alpha));
}
if (maxError > 1e-5) throw new Error(`sequence pixel oracle max error ${maxError}`);
const worker = supervisor.worker;
if (supervisor.isolated !== true || worker.frameCount !== frameCount || worker.libraryLoads !== 1 || worker.firstFrameIndex !== 90 || worker.lastFrameIndex !== 209) throw new Error("sequence receipt mismatch");

async function negative(name, patch, expected, inputBytes = Buffer.from(input.buffer)) {
  const caseInput = join(evidence, `${name}-input.rgba32f`);
  const caseOutput = join(evidence, `${name}-output.rgba32f`);
  const caseRequest = join(evidence, `${name}-request.json`);
  await writeFile(caseInput, inputBytes);
  await writeFile(caseRequest, `${JSON.stringify({ ...request, inputPath: caseInput, outputPath: caseOutput, ...patch }, null, 2)}\n`);
  const result = execute(caseRequest, 5_000);
  if (result.status === 0 || !String(result.stderr).includes(expected)) throw new Error(`${name} negative did not fail with ${expected}: ${result.stderr}`);
  return name;
}
const negativeControls = [];
negativeControls.push(await negative("truncated-input", {}, "input byte length", Buffer.from(input.buffer).subarray(0, input.byteLength - 4)));
negativeControls.push(await negative("invalid-rational-time", { frameDurationDenominator: 0 }, "invalid effect plugin sequence request"));
negativeControls.push(await negative("invalid-output", { frameCount: 1, parameters: [0.8, 0.25, 3] }, "invalid RGBA32F", Buffer.from(input.buffer).subarray(0, valuesPerFrame * 4)));
negativeControls.push(await negative("crash", { frameCount: 1, parameters: [0.8, 0.25, 2] }, "isolated effect sequence worker failed", Buffer.from(input.buffer).subarray(0, valuesPerFrame * 4)));
negativeControls.push(await negative("timeout", { frameCount: 1, parameters: [0.8, 0.25, 1] }, "timed out", Buffer.from(input.buffer).subarray(0, valuesPerFrame * 4)));

const repeatReceipts = [];
for (let index = 0; index < 8; index += 1) {
  const repeatedPath = join(evidence, `repeat-${index}.json`);
  await writeFile(repeatedPath, `${JSON.stringify({ ...request, outputPath: join(evidence, `repeat-${index}.rgba32f`) })}\n`);
  const result = execute(repeatedPath);
  if (result.status !== 0) throw new Error(`repeat ${index}: ${result.stderr}`);
  repeatReceipts.push(JSON.parse(result.stdout).worker);
}

const runAsync = (index) => new Promise((resolvePromise, reject) => {
  const path = join(evidence, `concurrent-${index}.json`);
  const output = join(evidence, `concurrent-${index}.rgba32f`);
  writeFile(path, `${JSON.stringify({ ...request, outputPath: output })}\n`).then(() => {
    const child = spawn(corePath, ["effect-plugin-sequence-run", path], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise(JSON.parse(stdout).worker) : reject(new Error(stderr)));
  }, reject);
});
const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => runAsync(index)));
const report = {
  schemaVersion: 1, status: "GREEN", contract: "editkin.effect-plugin-sequence/v1", isolated: supervisor.isolated,
  frameCount, pixelsPerFrame: width * height, libraryLoads: worker.libraryLoads, firstFrameIndex: worker.firstFrameIndex,
  lastFrameIndex: worker.lastFrameIndex, maxPixelError: maxError, outputSha256: worker.outputSha256,
  negativeControls, repeatRuns: repeatReceipts.length, concurrentWorkers: concurrent.length,
  coreSha256: createHash("sha256").update(await readFile(corePath)).digest("hex"), evidence: join(evidence, "report.json"),
};
await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
