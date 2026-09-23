import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";

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
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-aces2-native-output");
const reportPath = join(evidenceRoot, "report.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const width = 64;
const height = 36;
const magic = Buffer.from([0x45, 0x4b, 0x46, 0x33, 0x32, 0x56, 0x31, 0]);
const processor = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const lutSha256 = "0808837eb979b6f59e79db411f6bd861469456a89bf399ffe652a99bf0c454b3";
const configSha256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const ramp = x / (width - 1);
      const row = y / (height - 1);
      values[offset] = -0.02 + ramp * 16.02;
      values[offset + 1] = Math.max(-0.01, row * row * 8 + ((x * 7 + y * 3) % 11) / 20);
      values[offset + 2] = ((x * 13 + y * 17) % 43) / 7;
      values[offset + 3] = ((x + y) % 11) / 10;
    }
  }
  const patches = [
    [0, 0, 0, 0], [0.18, 0.18, 0.18, 1], [1, 1, 1, 1], [4, 4, 4, .5],
    [16, 0, 0, 1], [0, 16, 0, .75], [0, 0, 16, .25], [-.02, .01, .5, 1],
  ];
  patches.forEach((value, index) => values.set(value, index * 4));
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

function graph({ wrongSpace = false, grade = undefined, duplicate = false, omitFloat = false, unknown = false } = {}) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "plate", mediaKind: "image", inputColorSpace: omitFloat ? "rec709" : "linear_rec709", alphaMode: "straight", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 3 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "linear", inputs: ["transform"], enabled: true, kind: "color", processor: omitFloat ? "editkin-rec709-primary/v1" : "editkin-linear-primary/v1", inputSpace: omitFloat ? "rec709" : "linear_rec709", workingSpace: omitFloat ? "rec709" : "linear_rec709", outputSpace: omitFloat ? "rec709_sdr" : "linear_rec709" },
    { id: "display", inputs: ["linear"], enabled: true, kind: "color", processor: unknown ? "editkin.unknown" : processor, inputSpace: wrongSpace ? "ACEScg" : "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709_sdr", ...(grade ? { grade } : {}) },
  ];
  let tail = "display";
  if (duplicate) {
    nodes.push({ id: "display-duplicate", inputs: [tail], enabled: true, kind: "color", processor, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709_sdr" });
    tail = "display-duplicate";
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba32_float" });
  return { schema: "editkin.engine-graph/v1", graphId: "aces2-native-rec709-sdr", width, height, timebase: { numerator: 1, denominator: 30 }, workingFormat: omitFloat ? "rgba16_float" : "rgba32_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}

async function render(executable, graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render", graphPath, bindingsPath, "0", outputPath, backend], { cwd: root, timeout: 45_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function renderSequence(executable, graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render-display-sequence", graphPath, bindingsPath, "0", "3", outputPath, backend], { cwd: root, timeout: 45_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function rejects(executable, name, candidateGraph, bindings, outputExtension, marker) {
  const graphPath = join(evidenceRoot, `negative-${name}.json`);
  const bindingsPath = join(evidenceRoot, `negative-${name}-bindings.json`);
  await writeFile(graphPath, `${JSON.stringify(candidateGraph, null, 2)}\n`);
  await writeFile(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`);
  try {
    await render(executable, graphPath, bindingsPath, join(evidenceRoot, `negative-${name}.${outputExtension}`), "gpu");
    return false;
  } catch (error) {
    return new RegExp(marker, "i").test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
}

function codeMetrics(actual, expected) {
  const errors = [];
  let sum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const error = Math.abs(actual[index] - expected[index]);
    errors.push(error);
    sum += error;
  }
  errors.sort((left, right) => left - right);
  return { mean: sum / errors.length, p99: errors[Math.floor((errors.length - 1) * .99)], max: errors.at(-1) };
}

if (selfTest) {
  const bytes = encodeEkf32(fixture());
  if (!bytes.subarray(0, 8).equals(magic) || bytes.length !== 16 + width * height * 16 || processor.length < 10) throw new Error("ACES 2 native output gate self-test failed");
  console.log("ACES 2 native output gate self-test passed");
} else {
  await mkdir(evidenceRoot, { recursive: true });
  const sourcePath = join(evidenceRoot, "source.ekf32");
  const graphPath = join(evidenceRoot, "graph.json");
  const bindingsPath = join(evidenceRoot, "bindings.json");
  const referencePath = join(evidenceRoot, "pyocio-reference.rgba8");
  await writeFile(sourcePath, encodeEkf32(fixture()));
  await writeFile(graphPath, `${JSON.stringify(graph(), null, 2)}\n`);
  await writeFile(bindingsPath, `${JSON.stringify({ plate: sourcePath }, null, 2)}\n`);
  const referenceRun = await runFile(python, ["-X", "utf8", join(root, "scripts/aces2-native-output-reference.py"), sourcePath, referencePath], { cwd: root, timeout: 45_000, windowsHide: true, maxBuffer: 2_000_000 });
  const referenceReceipt = JSON.parse(referenceRun.stdout);
  const reference = await readFile(referencePath);
  const receipts = {};
  const pixels = {};
  for (const backend of ["gpu", "cpu"]) {
    const output = join(evidenceRoot, `output-${backend}.png`);
    receipts[backend] = await render(candidate, graphPath, bindingsPath, output, backend);
    pixels[backend] = PNG.sync.read(await readFile(output)).data;
  }
  const sequences = {};
  const sequencePixels = {};
  for (const backend of ["gpu", "cpu"]) {
    const output = join(evidenceRoot, `sequence-${backend}`);
    await rm(output, { recursive: true, force: true });
    sequences[backend] = await renderSequence(candidate, graphPath, bindingsPath, output, backend);
    sequencePixels[backend] = PNG.sync.read(await readFile(join(output, "frame-00000000.png"))).data;
  }
  let baselineRejected;
  let baselineEvidence;
  const fixtureSha256 = sha256(await readFile(sourcePath));
  if (baseline) {
    baselineRejected = await rejects(baseline, "baseline", graph(), { plate: sourcePath }, "png", "unsupported color processor");
    baselineEvidence = { path: baseline, sha256: sha256(await readFile(baseline)) };
    await writeFile(baselineReportPath, `${JSON.stringify({ schema: "editkin.aces2-native-output-baseline/v1", status: baselineRejected ? "BLOCK" : "INVALID_BASELINE", baselineRejected, executable: baselineEvidence, fixtureSha256 }, null, 2)}\n`);
  } else {
    const frozen = JSON.parse(await readFile(baselineReportPath, "utf8"));
    baselineRejected = frozen.schema === "editkin.aces2-native-output-baseline/v1" && frozen.status === "BLOCK" && frozen.baselineRejected === true && frozen.fixtureSha256 === fixtureSha256;
    baselineEvidence = frozen.executable;
  }
  const identityGrade = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
  const negativeControls = {
    baselineRejected,
    wrongSpaceRejected: await rejects(candidate, "wrong-space", graph({ wrongSpace: true }), { plate: sourcePath }, "png", "invalid ACES 2"),
    gradeRejected: await rejects(candidate, "grade", graph({ grade: { ...identityGrade, exposure: 1 } }), { plate: sourcePath }, "png", "invalid ACES 2"),
    duplicateRejected: await rejects(candidate, "duplicate", graph({ duplicate: true }), { plate: sourcePath }, "png", "exactly one"),
    floatArtifactRejected: await rejects(candidate, "float-artifact", graph(), { plate: sourcePath }, "exr", "display-referred"),
    encodedSourceRejected: await rejects(candidate, "encoded-source", graph({ omitFloat: true }), { plate: sourcePath }, "png", "requires rgba32_float scene-linear"),
    unknownProcessorRejected: await rejects(candidate, "unknown-processor", graph({ unknown: true }), { plate: sourcePath }, "png", "unsupported color processor"),
  };
  try {
    const baselineSequencePath = join(evidenceRoot, "negative-baseline-sequence");
    await rm(baselineSequencePath, { recursive: true, force: true });
    await renderSequence(baselineEvidence.path, graphPath, bindingsPath, baselineSequencePath, "gpu");
    negativeControls.baselineSequenceRejected = false;
  } catch (error) {
    negativeControls.baselineSequenceRejected = /Usage|engine-render-display-sequence/i.test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
  try {
    await renderSequence(candidate, graphPath, bindingsPath, join(evidenceRoot, "sequence-gpu"), "gpu");
    negativeControls.occupiedSequenceRejected = false;
  } catch (error) {
    negativeControls.occupiedSequenceRejected = /already exists/i.test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
  negativeControls.partialDirectoriesAbsent = !(await readdir(evidenceRoot)).some((name) => name.includes(".editkin-partial-"));
  const measurements = {
    gpuVsPyOcio: codeMetrics(pixels.gpu, reference),
    cpuVsPyOcio: codeMetrics(pixels.cpu, reference),
    gpuVsCpu: codeMetrics(pixels.gpu, pixels.cpu),
    gpuSequenceVsSingle: codeMetrics(sequencePixels.gpu, pixels.gpu),
    cpuSequenceVsSingle: codeMetrics(sequencePixels.cpu, pixels.cpu),
    alphaMaxError: Math.max(...Array.from({ length: width * height }, (_, index) => Math.abs(pixels.gpu[index * 4 + 3] - reference[index * 4 + 3]))),
  };
  const thresholds = { pyOcioMeanCodeError: .35, pyOcioP99CodeError: 2, pyOcioMaxCodeError: 8, gpuCpuMaxCodeError: 1, alphaMaxCodeError: 0 };
  const receiptValid = Object.values(receipts).every((receipt) => receipt.displayTransform === "aces2_rec709_sdr" && receipt.colorProcessor === processor && receipt.ocioVersion === "2.5.2" && receipt.acesVersion === "2.0" && receipt.configSha256 === configSha256 && receipt.lutSha256 === lutSha256 && receipt.artifactFormat === "rgba8" && receipt.artifactContainer === "png");
  const sequenceReceiptValid = Object.entries(sequences).every(([backend, execution]) => {
    const receipt = execution.receipt;
    return receipt?.schema === "editkin.ocio-display-sequence/v1" && receipt.status === "GREEN" && receipt.colorProcessor === processor
      && receipt.ocioVersion === "2.5.2" && receipt.acesVersion === "2.0" && receipt.configSha256 === configSha256 && receipt.lutSha256 === lutSha256
      && receipt.artifactContainer === "png-sequence" && receipt.filePattern === "frame-%08d.png" && receipt.frameCount === 3
      && receipt.sequenceSha256?.length === 64 && receipt.firstFrameSha256?.length === 64 && receipt.lastFrameSha256?.length === 64
      && receipt.deviceCreationCount === (backend === "gpu" ? 1 : 0) && receipt.audioIncluded === false;
  });
  const referenceBound = referenceReceipt.ocioVersion === "2.5.2" && referenceReceipt.acesVersion === "2.0" && referenceReceipt.configSha256 === configSha256;
  const green = receiptValid && sequenceReceiptValid && referenceBound && Object.values(negativeControls).every(Boolean)
    && measurements.gpuVsPyOcio.mean <= thresholds.pyOcioMeanCodeError && measurements.gpuVsPyOcio.p99 <= thresholds.pyOcioP99CodeError && measurements.gpuVsPyOcio.max <= thresholds.pyOcioMaxCodeError
    && measurements.cpuVsPyOcio.mean <= thresholds.pyOcioMeanCodeError && measurements.cpuVsPyOcio.p99 <= thresholds.pyOcioP99CodeError && measurements.cpuVsPyOcio.max <= thresholds.pyOcioMaxCodeError
    && measurements.gpuVsCpu.max <= thresholds.gpuCpuMaxCodeError && measurements.gpuSequenceVsSingle.max === 0 && measurements.cpuSequenceVsSingle.max === 0
    && measurements.alphaMaxError <= thresholds.alphaMaxCodeError;
  const report = {
    schema: "editkin.aces2-native-output-gate/v1", status: green ? "GREEN" : "BLOCK", dimensions: { width, height }, thresholds, measurements, receiptValid, sequenceReceiptValid, referenceBound, negativeControls,
    receipts, sequences, referenceReceipt,
    sourceRange: { rgbMin: -.02, rgbMax: 16, alphaMin: 0, alphaMax: 1 },
    candidate: { path: candidate, sha256: sha256(await readFile(candidate)) }, baseline: baselineEvidence,
    fixtureSha256, lutSha256, configSha256,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, measurements, receiptValid, sequenceReceiptValid, negativeControls, candidateSha256: report.candidate.sha256, baselineSha256: report.baseline.sha256, evidence: reportPath }, null, 2));
  if (!green) process.exitCode = 1;
}
