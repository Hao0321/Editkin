import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--"))
  ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-scene-linear-alpha");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const width = 64;
const height = 36;
const numericalTolerance = { absolute: 0.00001, relative: 0.00001 };
const modes = [
  "normal", "add", "screen", "multiply", "overlay", "soft_light",
  "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn",
];
const magic = Buffer.from([0x45, 0x4b, 0x46, 0x33, 0x32, 0x56, 0x31, 0]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function writeFloatArtifact(values) {
  const bytes = Buffer.alloc(16 + values.length * 4);
  magic.copy(bytes, 0);
  bytes.writeUInt32LE(width, 8);
  bytes.writeUInt32LE(height, 12);
  values.forEach((value, index) => bytes.writeFloatLE(value, 16 + index * 4));
  return bytes;
}

function readFloatArtifact(bytes) {
  if (!bytes.subarray(0, 8).equals(magic) || bytes.readUInt32LE(8) !== width || bytes.readUInt32LE(12) !== height) throw new Error("invalid float artifact header");
  const values = new Float32Array(width * height * 4);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readFloatLE(16 + index * 4);
  return values;
}

function fixtures() {
  const base = new Float32Array(width * height * 4);
  const straight = new Float32Array(base.length);
  const premultiplied = new Float32Array(base.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const edge = Math.min(x, width - 1 - x, y, height - 1 - y);
      const alpha = edge < 2 ? 0 : Math.min(1, (edge - 1) / 9);
      const rgb = [
        -0.25 + 5.5 * x / (width - 1),
        0.001 + 7.999 * y / (height - 1),
        4.25 * ((x * 7 + y * 11) % 29) / 28,
      ];
      const backdrop = [
        -0.125 + 2.625 * y / (height - 1),
        0.005 + 3.995 * x / (width - 1),
        1.75 - 2.0 * y / (height - 1),
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        base[offset + channel] = backdrop[channel];
        straight[offset + channel] = rgb[channel];
        premultiplied[offset + channel] = rgb[channel] * alpha;
      }
      base[offset + 3] = 1;
      straight[offset + 3] = alpha;
      premultiplied[offset + 3] = alpha;
      if (alpha === 0) {
        straight[offset] = 48; straight[offset + 1] = -16; straight[offset + 2] = 24;
        premultiplied[offset] = -31; premultiplied[offset + 1] = 63; premultiplied[offset + 2] = 15;
      }
    }
  }
  return { base, straight, premultiplied };
}

function blend(backdrop, source, mode) {
  if (mode === "normal") return source;
  if (mode === "add") return backdrop + source;
  if (mode === "screen") return 1 - (1 - backdrop) * (1 - source);
  if (mode === "multiply") return backdrop * source;
  if (mode === "overlay") return backdrop <= 0.5
    ? 2 * backdrop * source
    : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "soft_light") return (1 - 2 * source) * backdrop * backdrop + 2 * source * backdrop;
  if (mode === "hard_light") return source <= 0.5
    ? 2 * backdrop * source
    : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "difference") return Math.abs(backdrop - source);
  if (mode === "darken") return Math.min(backdrop, source);
  if (mode === "lighten") return Math.max(backdrop, source);
  if (mode === "color_dodge") return source >= 1 ? 1 : backdrop / Math.max(0.000001, 1 - source);
  if (mode === "color_burn") return source <= 0 ? 0 : 1 - (1 - backdrop) / Math.max(0.000001, source);
  throw new Error(`unknown blend ${mode}`);
}

function oracle(base, source, mode) {
  const output = new Float64Array(base.length);
  for (let offset = 0; offset < base.length; offset += 4) {
    const alpha = source[offset + 3];
    for (let channel = 0; channel < 3; channel += 1) output[offset + channel] = base[offset + channel] * (1 - alpha) + blend(base[offset + channel], source[offset + channel], mode) * alpha;
    output[offset + 3] = 1;
  }
  return output;
}

function compare(left, right) {
  let maxAbsoluteError = 0;
  let maxRelativeError = 0;
  let maxNormalizedError = 0;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const absolute = Math.abs(left[index] - right[index]);
    const relative = absolute / Math.max(1e-6, Math.abs(right[index]));
    const normalized = absolute / (numericalTolerance.absolute + numericalTolerance.relative * Math.abs(right[index]));
    maxAbsoluteError = Math.max(maxAbsoluteError, absolute);
    maxRelativeError = Math.max(maxRelativeError, relative);
    maxNormalizedError = Math.max(maxNormalizedError, normalized);
    total += absolute;
  }
  return { maxAbsoluteError, maxRelativeError, maxNormalizedError, meanAbsoluteError: total / left.length };
}

function graph(mode, alphaMode, workingFormat = "rgba32_float") {
  const branch = (id, selectedAlphaMode) => [
    { id: `${id}-source`, inputs: [], enabled: true, kind: "source", assetId: id, mediaKind: "image", inputColorSpace: "linear_rec709", alphaMode: selectedAlphaMode, timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 1 } },
    { id: `${id}-transform`, inputs: [`${id}-source`], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: `${id}-color`, inputs: [`${id}-transform`], enabled: true, kind: "color", processor: "editkin-linear-primary/v1", inputSpace: "linear_rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709" },
  ];
  return {
    schema: "editkin.engine-graph/v1", graphId: `scene-linear-${mode}-${alphaMode}`, width, height,
    timebase: { numerator: 1, denominator: 30 }, workingFormat, cacheBudgetMb: 64,
    nodes: [...branch("base", "opaque"), ...branch("upper", alphaMode),
      { id: "composite", inputs: ["base-color", "upper-color"], enabled: true, kind: "composite", blendMode: mode, opacity: 1 },
      { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: workingFormat }],
    outputNode: "output",
  };
}

async function render(graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render", graphPath, bindingsPath, "0", outputPath, backend], { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function negativeRejected(name, candidate, bindingsPath, marker) {
  const path = join(evidenceRoot, `negative-${name}.json`);
  await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`);
  try {
    await render(path, bindingsPath, join(evidenceRoot, `negative-${name}.ekf32`), "gpu");
    return false;
  } catch (error) {
    return new RegExp(marker, "i").test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
}

if (selfTest) {
  const values = fixtures().base;
  const roundtrip = readFloatArtifact(writeFloatArtifact(values));
  const formulaChecks = [
    blend(2, 3, "add") === 5,
    blend(2, 3, "multiply") === 6,
    blend(0.25, 0.75, "overlay") === 0.375,
    blend(0.25, 0.75, "hard_light") === 0.625,
    blend(-0.25, 2, "darken") === -0.25,
    blend(-0.25, 2, "lighten") === 2,
    blend(2, 0.5, "color_dodge") === 4,
    blend(2, 0.5, "color_burn") === 3,
  ];
  if (roundtrip.length !== values.length || roundtrip[0] !== values[0] || formulaChecks.some((result) => !result)) throw new Error("scene-linear gate self-test failed");
  console.log("scene-linear alpha gate self-test passed");
} else {
  await mkdir(evidenceRoot, { recursive: true });
  const fixture = fixtures();
  const paths = { base: join(evidenceRoot, "base.ekf32"), straight: join(evidenceRoot, "straight.ekf32"), premultiplied: join(evidenceRoot, "premultiplied.ekf32") };
  await Promise.all(Object.entries(paths).map(([key, path]) => writeFile(path, writeFloatArtifact(fixture[key]))));
  const bindings = { base: paths.base, upper: paths.straight };
  const bindingsPath = join(evidenceRoot, "bindings.json");
  await writeFile(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`);
  const modeResults = [];
  let observedBlock;
  try {
    for (const mode of modes) {
      const outputs = {};
      const receipts = {};
      for (const encoding of ["straight", "premultiplied"]) {
        const graphPath = join(evidenceRoot, `${mode}-${encoding}.json`);
        const selectedBindingsPath = join(evidenceRoot, `${mode}-${encoding}-bindings.json`);
        await writeFile(graphPath, `${JSON.stringify(graph(mode, encoding), null, 2)}\n`);
        await writeFile(selectedBindingsPath, `${JSON.stringify({ base: paths.base, upper: paths[encoding] }, null, 2)}\n`);
        for (const backend of ["gpu", "cpu"]) {
          const outputPath = join(evidenceRoot, `${mode}-${encoding}-${backend}.ekf32`);
          receipts[`${encoding}-${backend}`] = await render(graphPath, selectedBindingsPath, outputPath, backend);
          outputs[`${encoding}-${backend}`] = readFloatArtifact(await readFile(outputPath));
        }
      }
      const expected = oracle(fixture.base, fixture.straight, mode);
      modeResults.push({
        mode,
        straightOracle: compare(outputs["straight-gpu"], expected),
        premultipliedOracle: compare(outputs["premultiplied-gpu"], expected),
        encodingPair: compare(outputs["straight-gpu"], outputs["premultiplied-gpu"]),
        straightGpuCpu: compare(outputs["straight-gpu"], outputs["straight-cpu"]),
        premultipliedGpuCpu: compare(outputs["premultiplied-gpu"], outputs["premultiplied-cpu"]),
        artifactFormats: Object.values(receipts).map((receipt) => receipt.artifactFormat),
        extrema: { min: Math.min(...outputs["straight-gpu"]), max: Math.max(...outputs["straight-gpu"]) },
      });
    }
  } catch (error) {
    observedBlock = `${error.stderr ?? ""}${error.message ?? ""}`.slice(-2_000);
  }
  if (baseline) {
    const report = { schema: "editkin.scene-linear-alpha-gate/v1", status: observedBlock ? "BLOCK" : "INVALID_BASELINE", baseline: true, observedBlock, executable, executableSha256: sha256(await readFile(executable)) };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (!observedBlock) process.exitCode = 1;
  } else {
    if (observedBlock) throw new Error(`scene-linear execution blocked: ${observedBlock}`);
    const invalidPrecisionRejected = await negativeRejected("rgba16", graph("normal", "straight", "rgba16_float"), bindingsPath, "rgba32_float");
    const malformed = Buffer.from(await readFile(paths.straight)); malformed.writeFloatLE(Number.NaN, 16); const malformedPath = join(evidenceRoot, "malformed-nan.ekf32"); await writeFile(malformedPath, malformed);
    const malformedBindingsPath = join(evidenceRoot, "malformed-bindings.json"); await writeFile(malformedBindingsPath, `${JSON.stringify({ base: paths.base, upper: malformedPath }, null, 2)}\n`);
    const malformedRejected = await negativeRejected("non-finite", graph("normal", "straight"), malformedBindingsPath, "non-finite");
    const threshold = { maxAbsoluteError: 0.00025, maxNormalizedError: 1, meanAbsoluteError: 0.000002, numericalTolerance };
    const green = invalidPrecisionRejected && malformedRejected && modeResults.every((result) =>
      result.artifactFormats.every((format) => format === "rgba32_float")
      && result.extrema.min < 0 && result.extrema.max > 1
      && [result.straightOracle, result.premultipliedOracle, result.encodingPair, result.straightGpuCpu, result.premultipliedGpuCpu].every((measurement) => measurement.maxAbsoluteError <= threshold.maxAbsoluteError && measurement.maxNormalizedError <= threshold.maxNormalizedError && measurement.meanAbsoluteError <= threshold.meanAbsoluteError));
    const report = { schema: "editkin.scene-linear-alpha-gate/v1", status: green ? "GREEN" : "BLOCK", baseline: false, dimensions: { width, height }, modes, threshold, modeResults, invalidPrecisionRejected, malformedRejected, preservesNegativeAndHdr: true, extendedRangeBlendContract: "editkin.scene-linear-blend/v1", executable, executableSha256: sha256(await readFile(executable)), fixtureSha256: Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, sha256(await readFile(path))]))) };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, invalidPrecisionRejected, malformedRejected, worstAbsoluteError: Math.max(...modeResults.flatMap((result) => [result.straightOracle.maxAbsoluteError, result.premultipliedOracle.maxAbsoluteError, result.encodingPair.maxAbsoluteError, result.straightGpuCpu.maxAbsoluteError, result.premultipliedGpuCpu.maxAbsoluteError])), extrema: modeResults[0].extrema, executableSha256: report.executableSha256, evidence: reportPath }, null, 2));
    if (!green) process.exitCode = 1;
  }
}
