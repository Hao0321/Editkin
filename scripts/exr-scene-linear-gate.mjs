import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return resolve(index >= 0 ? process.argv[index + 1] : fallback);
};
const candidate = argument("--candidate", join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe"));
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? resolve(process.argv[baselineIndex + 1]) : undefined;
const regressionOnly = process.argv.includes("--regression-only");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-exr-scene-linear");
const reportPath = join(evidenceRoot, "report.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const width = 48;
const height = 27;
const magic = Buffer.from([0x45, 0x4b, 0x46, 0x33, 0x32, 0x56, 0x31, 0]);
const exrMagic = Buffer.from([0x76, 0x2f, 0x31, 0x01]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      values[offset] = -0.25 + x / (width - 1) * 6.5;
      values[offset + 1] = 0.002 + y / (height - 1) * 4.998;
      values[offset + 2] = ((x * 13 + y * 17) % 31) / 10;
      values[offset + 3] = 0.1 + ((x + y) % 10) / 10;
    }
  }
  values.set([0.18, 0.18, 0.18, 1], 0);
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

function decodeEkf32(bytes) {
  if (!bytes.subarray(0, 8).equals(magic) || bytes.readUInt32LE(8) !== width || bytes.readUInt32LE(12) !== height) throw new Error("invalid EKF32 artifact");
  const values = new Float32Array(width * height * 4);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readFloatLE(16 + index * 4);
  return values;
}

function graph({ inputColorSpace = "linear_rec709", workingFormat = "rgba32_float", secondSource = false } = {}) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "plate", mediaKind: "image", inputColorSpace, alphaMode: "straight", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 1 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: inputColorSpace === "linear_rec709" ? "editkin-linear-primary/v1" : "editkin-rec709-primary/v1", inputSpace: inputColorSpace, workingSpace: inputColorSpace, outputSpace: inputColorSpace === "linear_rec709" ? "linear_rec709" : "rec709_sdr" },
  ];
  let tail = "color";
  if (secondSource) {
    nodes.push(
      { id: "sdr-source", inputs: [], enabled: true, kind: "source", assetId: "sdr", mediaKind: "image", inputColorSpace: "rec709", alphaMode: "straight", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 1 } },
      { id: "sdr-transform", inputs: ["sdr-source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: "sdr-color", inputs: ["sdr-transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "composite", inputs: ["color", "sdr-color"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
    );
    tail = "composite";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: workingFormat });
  return { schema: "editkin.engine-graph/v1", graphId: `exr-${inputColorSpace}-${workingFormat}-${secondSource}`, width, height, timebase: { numerator: 1, denominator: 30 }, workingFormat, cacheBudgetMb: 64, nodes, outputNode: "output" };
}

async function render(executable, graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render", graphPath, bindingsPath, "0", outputPath, backend], { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function rejects(executable, name, candidateGraph, bindings, marker) {
  const graphPath = join(evidenceRoot, `negative-${name}.json`);
  const bindingsPath = join(evidenceRoot, `negative-${name}-bindings.json`);
  await writeFile(graphPath, `${JSON.stringify(candidateGraph, null, 2)}\n`);
  await writeFile(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`);
  try {
    await render(executable, graphPath, bindingsPath, join(evidenceRoot, `negative-${name}.ekf32`), "gpu");
    return false;
  } catch (error) {
    return new RegExp(marker, "i").test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
}

function compare(left, right) {
  let maxAbsoluteError = 0;
  let meanAbsoluteError = 0;
  for (let index = 0; index < left.length; index += 1) {
    const error = Math.abs(left[index] - right[index]);
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
    meanAbsoluteError += error;
  }
  return { maxAbsoluteError, meanAbsoluteError: meanAbsoluteError / left.length };
}

if (selfTest) {
  const values = fixture();
  const decoded = decodeEkf32(encodeEkf32(values));
  if (decoded[0] !== values[0] || decoded.length !== values.length || exrMagic.length !== 4) throw new Error("EXR gate self-test failed");
  console.log("EXR scene-linear gate self-test passed");
} else {
  await mkdir(evidenceRoot, { recursive: true });
  const values = fixture();
  const ekf32Path = join(evidenceRoot, "source.ekf32");
  const graphPath = join(evidenceRoot, "graph.json");
  const ekf32BindingsPath = join(evidenceRoot, "bindings-ekf32.json");
  const exrBindingsPath = join(evidenceRoot, "bindings-exr.json");
  const exrPath = join(evidenceRoot, "candidate-output.exr");
  await writeFile(ekf32Path, encodeEkf32(values));
  await writeFile(graphPath, `${JSON.stringify(graph(), null, 2)}\n`);
  await writeFile(ekf32BindingsPath, `${JSON.stringify({ plate: ekf32Path }, null, 2)}\n`);
  const exportReceipt = await render(candidate, graphPath, ekf32BindingsPath, exrPath, "gpu");
  const exrBytes = await readFile(exrPath);
  await writeFile(exrBindingsPath, `${JSON.stringify({ plate: exrPath }, null, 2)}\n`);

  const roundtrip = {};
  const receipts = {};
  for (const backend of ["gpu", "cpu"]) {
    const output = join(evidenceRoot, `roundtrip-${backend}.ekf32`);
    receipts[backend] = await render(candidate, graphPath, exrBindingsPath, output, backend);
    roundtrip[backend] = decodeEkf32(await readFile(output));
  }
  const preview = {};
  for (const backend of ["gpu", "cpu"]) {
    const output = join(evidenceRoot, `preview-${backend}.png`);
    await render(candidate, graphPath, exrBindingsPath, output, backend);
    preview[backend] = PNG.sync.read(await readFile(output));
  }
  let pngMaxError = 0;
  for (let index = 0; index < preview.gpu.data.length; index += 1) pngMaxError = Math.max(pngMaxError, Math.abs(preview.gpu.data[index] - preview.cpu.data[index]));
  const expectedFirstPixel = Math.round((1.099 * 0.18 ** 0.45 - 0.099) * 255);
  const fixtureSha256 = sha256(await readFile(ekf32Path));
  let baselineRejected;
  let baselineEvidence;
  if (regressionOnly) {
    baselineRejected = undefined;
    baselineEvidence = undefined;
  } else if (baseline) {
    baselineRejected = await rejects(baseline, "baseline-openexr", graph(), { plate: exrPath }, "unsupported color processor.*editkin-linear-primary|requires an \\.ekf32|requires an \\.exr or \\.ekf32");
    baselineEvidence = { path: baseline, sha256: sha256(await readFile(baseline)) };
    await writeFile(baselineReportPath, `${JSON.stringify({ schema: "editkin.exr-scene-linear-baseline/v1", status: baselineRejected ? "BLOCK" : "INVALID_BASELINE", baselineRejected, executable: baselineEvidence, fixtureSha256 }, null, 2)}\n`);
  } else {
    const frozen = JSON.parse(await readFile(baselineReportPath, "utf8"));
    baselineRejected = frozen.schema === "editkin.exr-scene-linear-baseline/v1" && frozen.status === "BLOCK" && frozen.baselineRejected === true && frozen.fixtureSha256 === fixtureSha256;
    baselineEvidence = frozen.executable;
  }
  const wrongPrecisionRejected = await rejects(candidate, "rgba16", graph({ workingFormat: "rgba16_float" }), { plate: exrPath }, "rgba32_float");
  const wrongInterpretationRejected = await rejects(candidate, "encoded-exr", graph({ inputColorSpace: "rec709" }), { plate: exrPath }, "requires linear_rec709");
  const mixedSourceRejected = await rejects(candidate, "mixed-sdr", graph({ secondSource: true }), { plate: exrPath, sdr: exrPath }, "cannot mix");
  const truncatedPath = join(evidenceRoot, "truncated.exr");
  await writeFile(truncatedPath, exrBytes.subarray(0, 32));
  const malformedRejected = await rejects(candidate, "truncated", graph(), { plate: truncatedPath }, "decode OpenEXR|invalid|early|header|read");
  const measurements = {
    gpuOracle: compare(roundtrip.gpu, values), cpuOracle: compare(roundtrip.cpu, values), gpuCpu: compare(roundtrip.gpu, roundtrip.cpu),
    pngMaxError, previewFirstPixel: [...preview.gpu.data.subarray(0, 4)], expectedFirstPixel,
    extrema: { min: Math.min(...roundtrip.gpu), max: Math.max(...roundtrip.gpu) },
  };
  const threshold = { maxAbsoluteError: 0.000001, meanAbsoluteError: 0.0000001, pngMaxError: 1 };
  const baselineSatisfied = regressionOnly || baselineRejected === true;
  const green = exrBytes.subarray(0, 4).equals(exrMagic)
    && exportReceipt.artifactFormat === "rgba32_float" && exportReceipt.artifactContainer === "openexr"
    && Object.values(receipts).every((receipt) => receipt.artifactFormat === "rgba32_float")
    && [measurements.gpuOracle, measurements.cpuOracle, measurements.gpuCpu].every((item) => item.maxAbsoluteError <= threshold.maxAbsoluteError && item.meanAbsoluteError <= threshold.meanAbsoluteError)
    && measurements.pngMaxError <= threshold.pngMaxError && Math.abs(measurements.previewFirstPixel[0] - expectedFirstPixel) <= 1
    && measurements.extrema.min < 0 && measurements.extrema.max > 1
    && baselineSatisfied && wrongPrecisionRejected && wrongInterpretationRejected && mixedSourceRejected && malformedRejected;
  const report = {
    schema: "editkin.exr-scene-linear-gate/v1", status: green ? "GREEN" : "BLOCK", dimensions: { width, height }, threshold, measurements,
    standardContainer: { format: "OpenEXR", magic: exrBytes.subarray(0, 4).toString("hex"), bytes: exrBytes.length },
    evaluationMode: regressionOnly ? "candidate-regression" : "candidate-vs-historical-baseline",
    negativeControls: { baselineRequired: !regressionOnly, baselineRejected, wrongPrecisionRejected, wrongInterpretationRejected, mixedSourceRejected, malformedRejected },
    exportReceipt, importReceipts: receipts,
    candidate: { path: candidate, sha256: sha256(await readFile(candidate)) }, baseline: baselineEvidence,
    fixtureSha256, exrSha256: sha256(exrBytes),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, measurements, negativeControls: report.negativeControls, candidateSha256: report.candidate.sha256, baselineSha256: report.baseline?.sha256, evidence: reportPath }, null, 2));
  if (!green) process.exitCode = 1;
}
