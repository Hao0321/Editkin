import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--"))
  ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-professional-alpha");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const ffmpeg = join(root, "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe");
const modes = ["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"];
const threshold = { oracleMaxChannelError: 3, encodingPairMaxChannelError: 3, gpuCpuMaxChannelError: 2, p99ChannelError: 1, meanChannelError: .12 };
const width = 96;
const height = 54;

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function blend(backdrop, source, mode) {
  if (mode === "normal") return source;
  if (mode === "add") return Math.min(1, backdrop + source);
  if (mode === "screen") return 1 - (1 - backdrop) * (1 - source);
  if (mode === "multiply") return backdrop * source;
  if (mode === "overlay") return backdrop <= .5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "soft_light") return (1 - 2 * source) * backdrop * backdrop + 2 * source * backdrop;
  if (mode === "hard_light") return source <= .5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "difference") return Math.abs(backdrop - source);
  if (mode === "darken") return Math.min(backdrop, source);
  if (mode === "lighten") return Math.max(backdrop, source);
  if (mode === "color_dodge") return Math.min(1, backdrop / Math.max(.000001, 1 - source));
  if (mode === "color_burn") return 1 - Math.min(1, (1 - backdrop) / Math.max(.000001, source));
  throw new Error(`unknown blend ${mode}`);
}

function fixture() {
  const base = new PNG({ width, height });
  const straight = new PNG({ width, height });
  const premultiplied = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = x < 4 || y < 4 || x >= width - 4 || y >= height - 4
        ? 0 : Math.round(255 * clamp((Math.min(x, width - 1 - x, y, height - 1 - y) - 3) / 15));
      const rgb = [
        Math.round(35 + 210 * x / (width - 1)),
        Math.round(230 - 180 * y / (height - 1)),
        Math.round(55 + 180 * ((x * 7 + y * 11) % 31) / 30),
      ];
      const backdrop = [
        Math.round(20 + 160 * y / (height - 1)),
        Math.round(40 + 140 * x / (width - 1)),
        Math.round(210 - 120 * y / (height - 1)),
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        base.data[offset + channel] = backdrop[channel];
        straight.data[offset + channel] = rgb[channel];
        premultiplied.data[offset + channel] = Math.round(rgb[channel] * alpha / 255);
      }
      base.data[offset + 3] = 255;
      straight.data[offset + 3] = alpha;
      premultiplied.data[offset + 3] = alpha;
      if (alpha === 0) {
        straight.data[offset] = 255;
        straight.data[offset + 1] = 80;
        straight.data[offset + 2] = 200;
        premultiplied.data[offset] = 190;
        premultiplied.data[offset + 1] = 120;
        premultiplied.data[offset + 2] = 70;
      }
    }
  }
  return { base, straight, premultiplied };
}

function graph(mode, alphaMode) {
  const identity = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
  const source = (id, assetId, selectedAlphaMode) => [
    { id: `${id}-source`, inputs: [], enabled: true, kind: "source", assetId, mediaKind: "image", inputColorSpace: "rec709", alphaMode: selectedAlphaMode, timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 1 } },
    { id: `${id}-transform`, inputs: [`${id}-source`], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: `${id}-color`, inputs: [`${id}-transform`], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: identity },
  ];
  return {
    schema: "editkin.engine-graph/v1", graphId: `alpha-${mode}-${alphaMode}`, width, height,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [
      ...source("base", "base", "opaque"), ...source("upper", "upper", alphaMode),
      { id: "composite", inputs: ["base-color", "upper-color"], enabled: true, kind: "composite", blendMode: mode, opacity: 1 },
      { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" },
    ], outputNode: "output",
  };
}

function oracle(base, straight, mode) {
  const output = new PNG({ width, height });
  for (let offset = 0; offset < output.data.length; offset += 4) {
    const alpha = straight.data[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const backdrop = base.data[offset + channel] / 255;
      const source = straight.data[offset + channel] / 255;
      output.data[offset + channel] = Math.round(255 * clamp(backdrop * (1 - alpha) + blend(backdrop, source, mode) * alpha));
    }
    output.data[offset + 3] = 255;
  }
  return output;
}

function compare(left, right) {
  if (left.length !== right.length) throw new Error("pixel cardinality mismatch");
  let max = 0;
  let total = 0;
  const errors = [];
  for (let index = 0; index < left.length; index += 1) {
    const error = Math.abs(left[index] - right[index]);
    max = Math.max(max, error);
    total += error;
    errors.push(error);
  }
  errors.sort((a, b) => a - b);
  return { maxChannelError: max, p99ChannelError: errors[Math.floor((errors.length - 1) * .99)], meanChannelError: total / left.length };
}

async function render(graphPath, bindingsPath, outputPath, backend) {
  const { stdout } = await runFile(executable, ["engine-render", graphPath, bindingsPath, "0", outputPath, backend], { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

async function rejectsInvalidAlpha(graphPath, bindingsPath) {
  const invalid = JSON.parse(await readFile(graphPath, "utf8"));
  invalid.nodes.find((node) => node.id === "upper-source").alphaMode = "associated_guess";
  const invalidPath = join(evidenceRoot, "invalid-alpha.json");
  await writeFile(invalidPath, `${JSON.stringify(invalid, null, 2)}\n`);
  try {
    await runFile(executable, ["engine-render", invalidPath, bindingsPath, "0", join(evidenceRoot, "invalid.png"), "gpu"], { cwd: root, timeout: 30_000, windowsHide: true });
    return false;
  } catch (error) {
    return /alpha|unknown variant|associated_guess/i.test(`${error.stderr ?? ""}${error.message ?? ""}`);
  }
}

async function verifyFfmpegExportParity(paths) {
  const straightOutput = join(evidenceRoot, "ffmpeg-straight-composite.png");
  const premultipliedOutput = join(evidenceRoot, "ffmpeg-premultiplied-composite.png");
  const commonArgs = ["-y", "-hide_banner", "-loglevel", "error", "-i", paths.base];
  await runFile(ffmpeg, [
    ...commonArgs, "-i", paths.straight,
    "-filter_complex", "[0:v]format=rgba[b];[1:v]format=rgba[s];[b][s]overlay=format=auto[o]",
    "-map", "[o]", "-frames:v", "1", straightOutput,
  ], { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  await runFile(ffmpeg, [
    ...commonArgs, "-i", paths.premultiplied,
    "-filter_complex", "[0:v]format=rgba[b];[1:v]format=rgba,unpremultiply=inplace=1[p];[b][p]overlay=format=auto[o]",
    "-map", "[o]", "-frames:v", "1", premultipliedOutput,
  ], { cwd: root, timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
  const [straightBytes, premultipliedBytes, ffmpegBytes] = await Promise.all([
    readFile(straightOutput), readFile(premultipliedOutput), readFile(ffmpeg),
  ]);
  const comparison = compare(PNG.sync.read(straightBytes).data, PNG.sync.read(premultipliedBytes).data);
  return {
    ...comparison,
    executable: ffmpeg,
    executableSha256: sha256(ffmpegBytes),
    outputSha256: { straight: sha256(straightBytes), premultiplied: sha256(premultipliedBytes) },
  };
}

function selfTestGate() {
  const pixels = Buffer.from([10, 20, 30, 255, 50, 60, 70, 128]);
  const same = compare(pixels, Buffer.from(pixels));
  if (same.maxChannelError !== 0 || Math.abs(blend(.2, .8, "multiply") - .16) > 1e-12) throw new Error("alpha gate self-test failed");
  process.stdout.write("professional alpha gate self-test passed\n");
}

if (selfTest) {
  selfTestGate();
} else {
  await mkdir(evidenceRoot, { recursive: true });
  const images = fixture();
  const paths = { base: join(evidenceRoot, "base.png"), straight: join(evidenceRoot, "straight.png"), premultiplied: join(evidenceRoot, "premultiplied.png") };
  await Promise.all(Object.entries(paths).map(([key, path]) => writeFile(path, PNG.sync.write(images[key]))));
  const modeResults = [];
  for (const mode of modes) {
    const expected = oracle(images.base, images.straight, mode);
    const outputs = {};
    const receipts = {};
    for (const encoding of ["straight", "premultiplied"]) {
      const graphPath = join(evidenceRoot, `${mode}-${encoding}.json`);
      const bindingPath = join(evidenceRoot, `${mode}-${encoding}-bindings.json`);
      await writeFile(graphPath, `${JSON.stringify(graph(mode, encoding), null, 2)}\n`);
      await writeFile(bindingPath, `${JSON.stringify({ base: paths.base, upper: paths[encoding] }, null, 2)}\n`);
      for (const backend of ["gpu", "cpu"]) {
        const outputPath = join(evidenceRoot, `${mode}-${encoding}-${backend}.png`);
        receipts[`${encoding}-${backend}`] = await render(graphPath, bindingPath, outputPath, backend);
        outputs[`${encoding}-${backend}`] = PNG.sync.read(await readFile(outputPath)).data;
      }
    }
    modeResults.push({
      mode,
      straightOracle: compare(outputs["straight-gpu"], expected.data),
      premultipliedOracle: compare(outputs["premultiplied-gpu"], expected.data),
      encodingPair: compare(outputs["straight-gpu"], outputs["premultiplied-gpu"]),
      straightGpuCpu: compare(outputs["straight-gpu"], outputs["straight-cpu"]),
      premultipliedGpuCpu: compare(outputs["premultiplied-gpu"], outputs["premultiplied-cpu"]),
      straightReceiptAlphaModes: receipts["straight-gpu"].sourceAlphaModes,
      premultipliedReceiptAlphaModes: receipts["premultiplied-gpu"].sourceAlphaModes,
      directExecution: receipts["straight-gpu"].directExecution === true && receipts["premultiplied-gpu"].directExecution === true,
    });
  }
  const sampleGraph = join(evidenceRoot, "normal-straight.json");
  const sampleBindings = join(evidenceRoot, "normal-straight-bindings.json");
  const invalidAlphaRejected = await rejectsInvalidAlpha(sampleGraph, sampleBindings);
  const ffmpegExportParity = await verifyFfmpegExportParity(paths);
  const green = modeResults.every((result) => result.directExecution
    && result.straightOracle.maxChannelError <= threshold.oracleMaxChannelError
    && result.premultipliedOracle.maxChannelError <= threshold.oracleMaxChannelError
    && result.encodingPair.maxChannelError <= threshold.encodingPairMaxChannelError
    && result.straightGpuCpu.maxChannelError <= threshold.gpuCpuMaxChannelError
    && result.premultipliedGpuCpu.maxChannelError <= threshold.gpuCpuMaxChannelError
    && [result.straightOracle, result.premultipliedOracle, result.encodingPair, result.straightGpuCpu, result.premultipliedGpuCpu].every((comparison) => comparison.p99ChannelError <= threshold.p99ChannelError && comparison.meanChannelError <= threshold.meanChannelError)
    && (!result.straightReceiptAlphaModes || JSON.stringify(result.straightReceiptAlphaModes) === JSON.stringify(["opaque", "straight"]))
    && (!result.premultipliedReceiptAlphaModes || JSON.stringify(result.premultipliedReceiptAlphaModes) === JSON.stringify(["opaque", "premultiplied"])))
    && invalidAlphaRejected
    && ffmpegExportParity.maxChannelError <= 1
    && ffmpegExportParity.p99ChannelError <= 1
    && ffmpegExportParity.meanChannelError <= threshold.meanChannelError;
  const executableBytes = await readFile(executable);
  const report = {
    schema: "editkin.professional-alpha-gate/v1", status: green ? "GREEN" : "BLOCK", baseline,
    contract: "Explicit opaque/straight/premultiplied source boundaries normalize to one straight-alpha working contract before effects, masks and 12-mode source-over",
    dimensions: { width, height }, modes, threshold, modeResults, invalidAlphaRejected, ffmpegExportParity,
    transparentHiddenRgbFixture: true, verificationReadback: true, productPathCpuPixelCopiesClaimed: false,
    executable, executableSha256: sha256(executableBytes),
    fixtureSha256: Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, sha256(await readFile(path))]))),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, baseline, invalidAlphaRejected, ffmpegExportParity, executableSha256: report.executableSha256, worstEncodingPair: Math.max(...modeResults.map((result) => result.encodingPair.maxChannelError)), worstOracle: Math.max(...modeResults.flatMap((result) => [result.straightOracle.maxChannelError, result.premultipliedOracle.maxChannelError])), evidence: reportPath }, null, 2)}\n`);
  if (baseline ? green : !green) process.exitCode = 1;
}
