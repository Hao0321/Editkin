import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-openexr-sequence");
const reportPath = join(evidenceRoot, "report.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const width = 40;
const height = 24;
const startFrame = 7;
const frameCount = 3;
const magic = Buffer.from([0x45, 0x4b, 0x46, 0x33, 0x32, 0x56, 0x31, 0]);
const exrMagic = Buffer.from([0x76, 0x2f, 0x31, 0x01]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      values[offset] = -0.2 + x / (width - 1) * 5.4;
      values[offset + 1] = 0.004 + y / (height - 1) * 3.996;
      values[offset + 2] = ((x * 5 + y * 9) % 23) / 7;
      values[offset + 3] = 0.05 + ((x + y) % 20) / 20;
    }
  }
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

function graph(workingFormat = "rgba32_float", durationFrames = 20) {
  return {
    schema: "editkin.engine-graph/v1", graphId: `openexr-sequence-${workingFormat}`, width, height,
    timebase: { numerator: 1, denominator: 30 }, workingFormat, cacheBudgetMb: 64,
    nodes: [
      { id: "source", inputs: [], enabled: true, kind: "source", assetId: "plate", mediaKind: "image", inputColorSpace: "linear_rec709", alphaMode: "straight", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames } },
      { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-linear-primary/v1", inputSpace: "linear_rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709" },
      { id: "output", inputs: ["color"], enabled: true, kind: "output", format: workingFormat },
    ],
    outputNode: "output",
  };
}

async function sequence(executable, graphPath, bindingsPath, outputDirectory, backend = "gpu", frames = frameCount) {
  const { stdout } = await runFile(executable, ["engine-render-sequence", graphPath, bindingsPath, String(startFrame), String(frames), outputDirectory, backend], { cwd: root, timeout: 60_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function render(executable, graphPath, bindingsPath, timelineFrame, outputPath, backend = "gpu") {
  const { stdout } = await runFile(executable, ["engine-render", graphPath, bindingsPath, String(timelineFrame), outputPath, backend], { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function rejects(executable, args, marker) {
  try {
    await runFile(executable, args, { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
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
  if (decoded.length !== values.length || decoded[0] !== values[0] || exrMagic.length !== 4 || frameCount < 2) throw new Error("OpenEXR sequence gate self-test failed");
  console.log("OpenEXR sequence gate self-test passed");
} else {
  await mkdir(evidenceRoot, { recursive: true });
  const values = fixture();
  const fixturePath = join(evidenceRoot, "source.ekf32");
  const graphPath = join(evidenceRoot, "graph.json");
  const bindingsPath = join(evidenceRoot, "bindings.json");
  const gpuDirectory = join(evidenceRoot, "gpu-sequence");
  const cpuDirectory = join(evidenceRoot, "cpu-sequence");
  await Promise.all([rm(gpuDirectory, { recursive: true, force: true }), rm(cpuDirectory, { recursive: true, force: true })]);
  await writeFile(fixturePath, encodeEkf32(values));
  await writeFile(graphPath, `${JSON.stringify(graph(), null, 2)}\n`);
  await writeFile(bindingsPath, `${JSON.stringify({ plate: fixturePath }, null, 2)}\n`);

  const gpu = await sequence(candidate, graphPath, bindingsPath, gpuDirectory, "gpu");
  const cpu = await sequence(candidate, graphPath, bindingsPath, cpuDirectory, "cpu");
  const directories = { gpu: gpuDirectory, cpu: cpuDirectory };
  const receipts = { gpu: gpu.receipt, cpu: cpu.receipt };
  const imported = { gpu: [], cpu: [] };
  const frameHashes = { gpu: [], cpu: [] };
  let allExrMagic = true;
  for (const backend of ["gpu", "cpu"]) {
    for (let frame = startFrame; frame < startFrame + frameCount; frame += 1) {
      const exrPath = join(directories[backend], `frame-${String(frame).padStart(8, "0")}.exr`);
      const bytes = await readFile(exrPath);
      allExrMagic &&= bytes.subarray(0, 4).equals(exrMagic);
      frameHashes[backend].push(sha256(bytes));
      const importBindings = join(evidenceRoot, `${backend}-${frame}-import-bindings.json`);
      const output = join(evidenceRoot, `${backend}-${frame}-roundtrip.ekf32`);
      await writeFile(importBindings, `${JSON.stringify({ plate: exrPath }, null, 2)}\n`);
      await render(candidate, graphPath, importBindings, 0, output, backend);
      imported[backend].push(decodeEkf32(await readFile(output)));
    }
  }
  const manifestImportGraphPath = join(evidenceRoot, "manifest-import-graph.json");
  const manifestImportBindingsPath = join(evidenceRoot, "manifest-import-bindings.json");
  await writeFile(manifestImportGraphPath, `${JSON.stringify(graph("rgba32_float", frameCount), null, 2)}\n`);
  await writeFile(manifestImportBindingsPath, `${JSON.stringify({ plate: join(gpuDirectory, "editkin-openexr-sequence.json") }, null, 2)}\n`);
  const manifestImports = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const output = join(evidenceRoot, `manifest-import-${frame}.ekf32`);
    await render(candidate, manifestImportGraphPath, manifestImportBindingsPath, frame, output, "gpu");
    manifestImports.push(compare(decodeEkf32(await readFile(output)), values));
  }
  const measurements = [];
  for (let index = 0; index < frameCount; index += 1) {
    measurements.push({
      frame: startFrame + index,
      gpuOracle: compare(imported.gpu[index], values),
      cpuOracle: compare(imported.cpu[index], values),
      gpuCpu: compare(imported.gpu[index], imported.cpu[index]),
    });
  }
  const manifests = {
    gpu: JSON.parse(await readFile(join(gpuDirectory, "editkin-openexr-sequence.json"), "utf8")),
    cpu: JSON.parse(await readFile(join(cpuDirectory, "editkin-openexr-sequence.json"), "utf8")),
  };
  const directoryEntries = {
    gpu: await readdir(gpuDirectory),
    cpu: await readdir(cpuDirectory),
  };
  const fixtureSha256 = sha256(await readFile(fixturePath));
  let baselineRejected;
  let baselineEvidence;
  if (regressionOnly) {
    baselineRejected = undefined;
    baselineEvidence = undefined;
  } else if (baseline) {
    const baselineOutput = join(evidenceRoot, "baseline-sequence");
    await rm(baselineOutput, { recursive: true, force: true });
    baselineRejected = await rejects(baseline, ["engine-render-sequence", graphPath, bindingsPath, String(startFrame), String(frameCount), baselineOutput, "gpu"], "Usage|unknown|engine-render-sequence");
    baselineEvidence = { path: baseline, sha256: sha256(await readFile(baseline)) };
    await writeFile(baselineReportPath, `${JSON.stringify({ schema: "editkin.openexr-sequence-baseline/v1", status: baselineRejected ? "BLOCK" : "INVALID_BASELINE", baselineRejected, executable: baselineEvidence, fixtureSha256 }, null, 2)}\n`);
  } else {
    const frozen = JSON.parse(await readFile(baselineReportPath, "utf8"));
    baselineRejected = frozen.schema === "editkin.openexr-sequence-baseline/v1" && frozen.status === "BLOCK" && frozen.baselineRejected === true && frozen.fixtureSha256 === fixtureSha256;
    baselineEvidence = frozen.executable;
  }

  const zeroOutput = join(evidenceRoot, "negative-zero");
  const precisionOutput = join(evidenceRoot, "negative-precision");
  const occupiedOutput = join(evidenceRoot, "negative-occupied");
  await Promise.all([rm(zeroOutput, { recursive: true, force: true }), rm(precisionOutput, { recursive: true, force: true }), rm(occupiedOutput, { recursive: true, force: true })]);
  await mkdir(occupiedOutput);
  const rgba16Path = join(evidenceRoot, "negative-rgba16.json");
  await writeFile(rgba16Path, `${JSON.stringify(graph("rgba16_float"), null, 2)}\n`);
  const zeroRejected = await rejects(candidate, ["engine-render-sequence", graphPath, bindingsPath, String(startFrame), "0", zeroOutput, "gpu"], "1..=1000000");
  const wrongPrecisionRejected = await rejects(candidate, ["engine-render-sequence", rgba16Path, bindingsPath, String(startFrame), "1", precisionOutput, "gpu"], "rgba32_float");
  const occupiedRejected = await rejects(candidate, ["engine-render-sequence", graphPath, bindingsPath, String(startFrame), "1", occupiedOutput, "gpu"], "already exists");
  const wrongTimebaseGraph = graph("rgba32_float", frameCount);
  wrongTimebaseGraph.timebase = { numerator: 1, denominator: 24 };
  const wrongTimebasePath = join(evidenceRoot, "negative-timebase.json");
  await writeFile(wrongTimebasePath, `${JSON.stringify(wrongTimebaseGraph, null, 2)}\n`);
  const wrongTimebaseRejected = await rejects(candidate, ["engine-render", wrongTimebasePath, manifestImportBindingsPath, "0", join(evidenceRoot, "negative-timebase.ekf32"), "gpu"], "timebase.*does not match");
  const missingDirectory = join(evidenceRoot, "negative-missing-frame-sequence");
  await rm(missingDirectory, { recursive: true, force: true });
  await mkdir(missingDirectory);
  await Promise.all([
    copyFile(join(gpuDirectory, "editkin-openexr-sequence.json"), join(missingDirectory, "editkin-openexr-sequence.json")),
    copyFile(join(gpuDirectory, "preview.png"), join(missingDirectory, "preview.png")),
    copyFile(join(gpuDirectory, "frame-00000007.exr"), join(missingDirectory, "frame-00000007.exr")),
    copyFile(join(gpuDirectory, "frame-00000009.exr"), join(missingDirectory, "frame-00000009.exr")),
  ]);
  const missingBindingsPath = join(evidenceRoot, "negative-missing-frame-bindings.json");
  await writeFile(missingBindingsPath, `${JSON.stringify({ plate: join(missingDirectory, "editkin-openexr-sequence.json") }, null, 2)}\n`);
  const missingFrameRejected = await rejects(candidate, ["engine-render", manifestImportGraphPath, missingBindingsPath, "1", join(evidenceRoot, "negative-missing-frame.ekf32"), "gpu"], "frame is missing");
  const partialEntries = (await readdir(evidenceRoot)).filter((name) => name.includes("editkin-partial"));
  const threshold = { maxAbsoluteError: 0.0000015, meanAbsoluteError: 0.00000015 };
  const receiptValid = Object.entries(receipts).every(([backend, receipt]) => receipt.schema === "editkin.openexr-sequence/v1"
    && receipt.status === "GREEN" && receipt.frameCount === frameCount && receipt.startFrame === startFrame
    && receipt.lastFrame === startFrame + frameCount - 1 && receipt.artifactContainer === "openexr"
    && receipt.artifactFormat === "rgba32_float" && receipt.workingColorSpace === "linear_rec709"
    && receipt.alphaMode === "straight" && receipt.audioIncluded === false
    && receipt.timebase?.numerator === 1 && receipt.timebase?.denominator === 30
    && receipt.filePattern === "frame-%08d.exr" && receipt.deviceCreationCount === (backend === "gpu" ? 1 : 0)
    && receipt.previewFile === "preview.png"
    && /^[a-f0-9]{64}$/.test(receipt.sequenceSha256) && receipt.firstFrameSha256 === frameHashes[backend][0]
    && receipt.lastFrameSha256 === frameHashes[backend].at(-1)
    && JSON.stringify(receipt) === JSON.stringify(manifests[backend]));
  const baselineSatisfied = regressionOnly || baselineRejected === true;
  const green = allExrMagic && baselineSatisfied && zeroRejected && wrongPrecisionRejected && occupiedRejected && wrongTimebaseRejected && missingFrameRejected
    && partialEntries.length === 0 && receiptValid
    && Object.values(directoryEntries).every((entries) => entries.length === frameCount + 2)
    && manifestImports.every((item) => item.maxAbsoluteError <= threshold.maxAbsoluteError && item.meanAbsoluteError <= threshold.meanAbsoluteError)
    && measurements.every((measurement) => [measurement.gpuOracle, measurement.cpuOracle, measurement.gpuCpu]
      .every((item) => item.maxAbsoluteError <= threshold.maxAbsoluteError && item.meanAbsoluteError <= threshold.meanAbsoluteError));
  const report = {
    schema: "editkin.openexr-sequence-gate/v1", status: green ? "GREEN" : "BLOCK",
    evaluationMode: regressionOnly ? "candidate-regression" : "candidate-vs-historical-baseline",
    dimensions: { width, height }, startFrame, frameCount, threshold, measurements, manifestImports,
    receiptValid, receipts, frameHashes, directoryEntries,
    negativeControls: { baselineRequired: !regressionOnly, baselineRejected, zeroRejected, wrongPrecisionRejected, occupiedRejected, wrongTimebaseRejected, missingFrameRejected, partialDirectoriesAbsent: partialEntries.length === 0 },
    candidate: { path: candidate, sha256: sha256(await readFile(candidate)) }, baseline: baselineEvidence, fixtureSha256,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, receiptValid, worstAbsoluteError: Math.max(...measurements.flatMap((item) => [item.gpuOracle.maxAbsoluteError, item.cpuOracle.maxAbsoluteError, item.gpuCpu.maxAbsoluteError])), negativeControls: report.negativeControls, gpuP95Milliseconds: receipts.gpu.renderMilliseconds.p95, candidateSha256: report.candidate.sha256, baselineSha256: report.baseline?.sha256, evidence: reportPath }, null, 2));
  if (!green) process.exitCode = 1;
}
