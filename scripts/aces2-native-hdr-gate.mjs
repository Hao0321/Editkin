import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  return /[\\/]/.test(value) || value.startsWith(".") ? resolve(value) : value;
};
const candidate = argument("--candidate", join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe"));
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? resolve(process.argv[baselineIndex + 1]) : undefined;
const python = argument(
  "--python",
  process.env.EDITKIN_PYTHON
    ?? (process.platform === "win32"
      ? join(homedir(), "AppData/Local/Programs/Python/Python310/python.exe")
      : "python3"),
);
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-aces2-native-hdr");
const reportPath = join(evidenceRoot, "report.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const width = 48;
const height = 27;
const frameCount = 2;
const magic = Buffer.from([0x45, 0x4b, 0x46, 0x33, 0x32, 0x56, 0x31, 0]);
const configSha256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a";
const modes = {
  hlg: {
    processor: "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1",
    outputSpace: "rec2100_hlg_1000",
    displayTransform: "aces2_rec2100_hlg1000",
    lutSha256: "ab4a459ae1a284ceb34546ffe1bed664af6bdf6f43f4b7bc4ca562a4492a0eda",
    payloadSha256: "012d60627a4aa5e9880122c94cd540fa7d70bbda7918ef866a0a64cf4c9cadab",
  },
  pq: {
    processor: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
    outputSpace: "rec2100_pq_1000",
    displayTransform: "aces2_rec2100_pq1000",
    lutSha256: "0cad3aecbc3c5e12aec4f0c489bea6eb5a3a4c0e322aa28010468b856b6b121f",
    payloadSha256: "2c400e0cb185ba44ceecf19aae2ddbd5d90a976f39f43d324ff8bc118ef9f7e1",
  },
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    values[offset] = -.02 + x / (width - 1) * 16.02;
    values[offset + 1] = y / (height - 1) * 8;
    values[offset + 2] = ((x * 13 + y * 17) % 47) / 6;
    values[offset + 3] = ((x + y) % 11) / 10;
  }
  [[0, 0, 0, 0], [.18, .18, .18, 1], [1, 1, 1, 1], [4, 4, 4, .5], [16, 0, 0, 1], [0, 16, 0, .75], [0, 0, 16, .25]]
    .forEach((pixel, index) => values.set(pixel, index * 4));
  return values;
}

function encodeEkf32(values) {
  const bytes = Buffer.alloc(16 + values.length * 4);
  magic.copy(bytes);
  bytes.writeUInt32LE(width, 8);
  bytes.writeUInt32LE(height, 12);
  values.forEach((value, index) => bytes.writeFloatLE(value, 16 + index * 4));
  return bytes;
}

function graph(mode, { wrongOutput = false, duplicate = false, grade = false } = {}) {
  const spec = modes[mode];
  const identity = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: grade ? 1 : 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "plate", mediaKind: "image", inputColorSpace: "linear_rec709", alphaMode: "straight", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: frameCount } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "linear", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-linear-primary/v1", inputSpace: "linear_rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709" },
    { id: "display", inputs: ["linear"], enabled: true, kind: "color", processor: spec.processor, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: wrongOutput ? "rec709_sdr" : spec.outputSpace, grade: identity },
  ];
  let tail = "display";
  if (duplicate) {
    nodes.push({ id: "display-duplicate", inputs: [tail], enabled: true, kind: "color", processor: spec.processor, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: spec.outputSpace, grade: { ...identity, exposure: 0 } });
    tail = "display-duplicate";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba32_float" });
  return { schema: "editkin.engine-graph/v1", graphId: `aces2-native-${mode}-hdr`, width, height, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba32_float", cacheBudgetMb: 128, nodes, outputNode: "output" };
}

async function render(executable, graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render", graphPath, bindingsPath, "0", outputPath, backend], { cwd: root, timeout: 120_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function renderSequence(executable, graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render-display-sequence", graphPath, bindingsPath, "0", String(frameCount), outputPath, backend], { cwd: root, timeout: 120_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function decodePng16(path, output) {
  const bytes = await readFile(path);
  if (bytes.length < 26 || bytes.subarray(1, 4).toString("ascii") !== "PNG" || bytes[24] !== 16 || bytes[25] !== 6) throw new Error(`not a 16-bit RGBA PNG: ${path}`);
  await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba64le", output], { cwd: root, timeout: 30_000, windowsHide: true });
  const raw = await readFile(output);
  if (raw.length !== width * height * 8) throw new Error(`unexpected rgba64 payload: ${raw.length}`);
  return raw;
}

function codeMetrics(actual, expected) {
  const errors = [];
  let sum = 0;
  for (let offset = 0; offset < actual.length; offset += 2) {
    const error = Math.abs(actual.readUInt16LE(offset) - expected.readUInt16LE(offset));
    errors.push(error);
    sum += error;
  }
  errors.sort((left, right) => left - right);
  return { mean: sum / errors.length, p99: errors[Math.floor((errors.length - 1) * .99)], max: errors.at(-1) };
}

async function rejects(executable, name, candidateGraph, bindings, extension, marker) {
  const graphPath = join(evidenceRoot, `negative-${name}.json`);
  const bindingsPath = join(evidenceRoot, `negative-${name}-bindings.json`);
  await writeFile(graphPath, `${JSON.stringify(candidateGraph, null, 2)}\n`);
  await writeFile(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`);
  try {
    await render(executable, graphPath, bindingsPath, join(evidenceRoot, `negative-${name}.${extension}`), "gpu");
    return false;
  } catch (error) {
    return new RegExp(marker, "i").test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
}

if (selfTest) {
  if (encodeEkf32(fixture()).length !== 16 + width * height * 16 || Object.keys(modes).length !== 2) throw new Error("ACES 2 HDR gate self-test failed");
  console.log("ACES 2 HDR gate self-test passed");
} else {
  await mkdir(evidenceRoot, { recursive: true });
  const sourcePath = join(evidenceRoot, "source.ekf32");
  const bindingsPath = join(evidenceRoot, "bindings.json");
  await writeFile(sourcePath, encodeEkf32(fixture()));
  await writeFile(bindingsPath, `${JSON.stringify({ plate: sourcePath }, null, 2)}\n`);
  const fixtureSha256 = sha256(await readFile(sourcePath));
  const results = {};
  for (const mode of Object.keys(modes)) {
    const spec = modes[mode];
    const graphPath = join(evidenceRoot, `graph-${mode}.json`);
    const referencePath = join(evidenceRoot, `reference-${mode}.rgba64le`);
    await writeFile(graphPath, `${JSON.stringify(graph(mode), null, 2)}\n`);
    const referenceRun = await runFile(python, ["-X", "utf8", join(root, "scripts/aces2-native-hdr-reference.py"), sourcePath, referencePath, mode], { cwd: root, timeout: 90_000, windowsHide: true, maxBuffer: 2_000_000 });
    const reference = await readFile(referencePath);
    const pixels = {};
    const receipts = {};
    const sequences = {};
    const sequencePixels = {};
    for (const backend of ["gpu", "cpu"]) {
      const pngPath = join(evidenceRoot, `${mode}-${backend}.png`);
      receipts[backend] = await render(candidate, graphPath, bindingsPath, pngPath, backend);
      pixels[backend] = await decodePng16(pngPath, join(evidenceRoot, `${mode}-${backend}.rgba64le`));
      const directory = join(evidenceRoot, `${mode}-sequence-${backend}`);
      await rm(directory, { recursive: true, force: true });
      sequences[backend] = await renderSequence(candidate, graphPath, bindingsPath, directory, backend);
      sequencePixels[backend] = await decodePng16(join(directory, "frame-00000000.png"), join(evidenceRoot, `${mode}-sequence-${backend}.rgba64le`));
    }
    const metrics = {
      gpuVsPyOcio: codeMetrics(pixels.gpu, reference),
      cpuVsPyOcio: codeMetrics(pixels.cpu, reference),
      gpuVsCpu: codeMetrics(pixels.gpu, pixels.cpu),
      gpuSequenceVsSingle: codeMetrics(sequencePixels.gpu, pixels.gpu),
      cpuSequenceVsSingle: codeMetrics(sequencePixels.cpu, pixels.cpu),
      alphaMaxError: Math.max(...Array.from({ length: width * height }, (_, index) => Math.abs(pixels.gpu.readUInt16LE(index * 8 + 6) - reference.readUInt16LE(index * 8 + 6)))),
    };
    const receiptValid = Object.values(receipts).every((receipt) => receipt.displayTransform === spec.displayTransform && receipt.colorProcessor === spec.processor
      && receipt.ocioVersion === "2.5.2" && receipt.acesVersion === "2.0" && receipt.configSha256 === configSha256
      && receipt.lutSha256 === spec.lutSha256 && receipt.lutPayloadSha256 === spec.payloadSha256 && receipt.artifactFormat === "rgba16_unorm");
    const sequenceReceiptValid = Object.entries(sequences).every(([backend, execution]) => execution.receipt?.schema === "editkin.ocio-display-sequence/v1"
      && execution.receipt.status === "GREEN" && execution.receipt.displayColorSpace === spec.outputSpace && execution.receipt.colorProcessor === spec.processor
      && execution.receipt.lutSha256 === spec.lutSha256 && execution.receipt.lutPayloadSha256 === spec.payloadSha256
      && execution.receipt.artifactFormat === "rgba16_unorm" && execution.receipt.frameCount === frameCount
      && execution.receipt.deviceCreationCount === (backend === "gpu" ? 1 : 0));
    results[mode] = { spec, referenceReceipt: JSON.parse(referenceRun.stdout), metrics, receiptValid, sequenceReceiptValid, receipts, sequences };
  }
  let baselineRejected;
  let baselineEvidence;
  if (baseline) {
    baselineRejected = await rejects(baseline, "baseline-pq", graph("pq"), { plate: sourcePath }, "png", "unsupported color processor");
    baselineEvidence = { path: baseline, sha256: sha256(await readFile(baseline)) };
    await writeFile(baselineReportPath, `${JSON.stringify({ schema: "editkin.aces2-native-hdr-baseline/v1", status: baselineRejected ? "BLOCK" : "INVALID_BASELINE", baselineRejected, executable: baselineEvidence, fixtureSha256 }, null, 2)}\n`);
  } else {
    const frozen = JSON.parse(await readFile(baselineReportPath, "utf8"));
    baselineRejected = frozen.schema === "editkin.aces2-native-hdr-baseline/v1" && frozen.status === "BLOCK" && frozen.baselineRejected === true && frozen.fixtureSha256 === fixtureSha256;
    baselineEvidence = frozen.executable;
  }
  const negativeControls = {
    baselineRejected,
    wrongOutputRejected: await rejects(candidate, "wrong-output", graph("pq", { wrongOutput: true }), { plate: sourcePath }, "png", "invalid ACES 2"),
    gradeRejected: await rejects(candidate, "grade", graph("hlg", { grade: true }), { plate: sourcePath }, "png", "invalid ACES 2"),
    duplicateRejected: await rejects(candidate, "duplicate", graph("pq", { duplicate: true }), { plate: sourcePath }, "png", "exactly one"),
    floatArtifactRejected: await rejects(candidate, "float-artifact", graph("pq"), { plate: sourcePath }, "exr", "display-referred"),
  };
  try {
    const occupied = join(evidenceRoot, "pq-sequence-gpu");
    await renderSequence(candidate, join(evidenceRoot, "graph-pq.json"), bindingsPath, occupied, "gpu");
    negativeControls.occupiedSequenceRejected = false;
  } catch (error) {
    negativeControls.occupiedSequenceRejected = /already exists/i.test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
  negativeControls.partialDirectoriesAbsent = !(await readdir(evidenceRoot)).some((name) => name.includes(".editkin-partial-"));
  const thresholds = { referenceMeanCodeError: 64, referenceP99CodeError: 256, referenceMaxCodeError: 2048, gpuCpuMaxCodeError: 1, alphaMaxCodeError: 0 };
  const green = Object.values(negativeControls).every(Boolean) && Object.values(results).every((result) => result.receiptValid && result.sequenceReceiptValid
    && result.referenceReceipt.ocioVersion === "2.5.2" && result.referenceReceipt.configSha256 === configSha256
    && result.metrics.gpuVsPyOcio.mean <= thresholds.referenceMeanCodeError && result.metrics.gpuVsPyOcio.p99 <= thresholds.referenceP99CodeError && result.metrics.gpuVsPyOcio.max <= thresholds.referenceMaxCodeError
    && result.metrics.cpuVsPyOcio.mean <= thresholds.referenceMeanCodeError && result.metrics.cpuVsPyOcio.p99 <= thresholds.referenceP99CodeError && result.metrics.cpuVsPyOcio.max <= thresholds.referenceMaxCodeError
    && result.metrics.gpuVsCpu.max <= thresholds.gpuCpuMaxCodeError && result.metrics.gpuSequenceVsSingle.max === 0 && result.metrics.cpuSequenceVsSingle.max === 0
    && result.metrics.alphaMaxError <= thresholds.alphaMaxCodeError);
  const report = { schema: "editkin.aces2-native-hdr-gate/v1", status: green ? "GREEN" : "BLOCK", dimensions: { width, height }, frameCount, thresholds, results, negativeControls,
    candidate: { path: candidate, sha256: sha256(await readFile(candidate)) }, baseline: baselineEvidence, fixtureSha256, configSha256 };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, measurements: Object.fromEntries(Object.entries(results).map(([mode, result]) => [mode, result.metrics])), receiptValid: Object.fromEntries(Object.entries(results).map(([mode, result]) => [mode, result.receiptValid && result.sequenceReceiptValid])), negativeControls, candidateSha256: report.candidate.sha256, baselineSha256: report.baseline.sha256, evidence: reportPath }, null, 2));
  if (!green) process.exitCode = 1;
}
