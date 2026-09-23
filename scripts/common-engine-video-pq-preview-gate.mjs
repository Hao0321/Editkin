import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const selfTest = process.argv.includes("--self-test");
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const candidate = resolve(valueAfter("--candidate") ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const reportPath = resolve(valueAfter("--report") ?? join(root, "..", "..", ".rd", "benchmarks", "editkin-common-video-pq-preview", "report.json"));
const sourcePath = resolve(root, "public/demo-source.mp4");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const runFile = promisify(execFile);
const pqProcessor = "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1";
const sdrProcessor = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const inputProcessor = "editkin-srgb-to-linear-rec709-primary/v1";
const configSha256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a";
const pqLutSha256 = "0cad3aecbc3c5e12aec4f0c489bea6eb5a3a4c0e322aa28010468b856b6b121f";
const pqPayloadSha256 = "2c400e0cb185ba44ceecf19aae2ddbd5d90a976f39f43d324ff8bc118ef9f7e1";
const identity = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clamp = (value) => Math.max(0, Math.min(1, value));

function graph(output = "pq", options = {}) {
  const display = output === "pq"
    ? { processor: pqProcessor, outputSpace: "rec2100_pq_1000" }
    : output === "hlg"
      ? { processor: "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1", outputSpace: "rec2100_hlg_1000" }
      : { processor: sdrProcessor, outputSpace: "rec709_sdr" };
  return {
    schema: "editkin.engine-graph/v1",
    graphId: options.graphId ?? `resident-scene-linear-${output}`,
    width: 960,
    height: 540,
    timebase: { numerator: 1, denominator: 30 },
    workingFormat: "rgba32_float",
    cacheBudgetMb: 64,
    nodes: [
      { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 180 } },
      { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: "linear", inputs: ["transform"], enabled: true, kind: "color", processor: inputProcessor, inputSpace: "rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709", grade: identity },
      { id: "display", inputs: ["linear"], enabled: true, kind: "color", processor: options.processor ?? display.processor, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: options.outputSpace ?? display.outputSpace, grade: identity },
      { id: "output", inputs: ["display"], enabled: true, kind: "output", format: "rgba32_float" },
    ],
    outputNode: "output",
  };
}

function formalImageGraph() {
  const value = graph("pq", { graphId: "formal-pq-image-control" });
  value.nodes[0] = { ...value.nodes[0], mediaKind: "image", inputColorSpace: "linear_rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 1 } };
  value.nodes[2] = { ...value.nodes[2], processor: "editkin-linear-primary/v1", inputSpace: "linear_rec709" };
  return value;
}

function encodeLinearEkf32(raw) {
  const magic = Buffer.from([0x45, 0x4b, 0x46, 0x33, 0x32, 0x56, 0x31, 0]);
  const bytes = Buffer.allocUnsafe(16 + raw.width * raw.height * 16);
  magic.copy(bytes);
  bytes.writeUInt32LE(raw.width, 8);
  bytes.writeUInt32LE(raw.height, 12);
  for (let offset = 0; offset < raw.data.length; offset += 4) {
    const target = 16 + offset * 4;
    bytes.writeFloatLE(srgbToLinear(raw.data[offset] / 255), target);
    bytes.writeFloatLE(srgbToLinear(raw.data[offset + 1] / 255), target + 4);
    bytes.writeFloatLE(srgbToLinear(raw.data[offset + 2] / 255), target + 8);
    bytes.writeFloatLE(raw.data[offset + 3] / 255, target + 12);
  }
  return bytes;
}

function linearRec709ToAcesCct(rgb) {
  const ap1 = [
    .61309740240118826 * rgb[0] + .33952314618410551 * rgb[1] + .047379451414707258 * rgb[2],
    .070193722469581596 * rgb[0] + .91635387905734134 * rgb[1] + .013452398473073862 * rgb[2],
    .020615592882227002 * rgb[0] + .10956977293813569 * rgb[1] + .86981463417963978 * rgb[2],
  ];
  return ap1.map((value) => value > .0078125
    ? .0823456049 * Math.log(Math.max(value, 1.17549435e-38)) + .5547945205479452
    : value * 10.5402374 + .0729055703);
}

function srgbToLinear(value) {
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
}

function samplePqLut(payload, rgb) {
  const size = 129;
  const scaled = rgb.map((value) => clamp(value) * 128);
  const low = scaled.map((value) => Math.min(127, Math.floor(value)));
  const [fr, fg, fb] = scaled.map((value, index) => value - low[index]);
  const [r, g, b] = low;
  const value = (rr, gg, bb, channel) => payload.readFloatLE((((rr + gg * size + bb * size * size) * 3) + channel) * 4);
  return [0, 1, 2].map((channel) => {
    const c000 = value(r, g, b, channel); const c100 = value(r + 1, g, b, channel);
    const c010 = value(r, g + 1, b, channel); const c001 = value(r, g, b + 1, channel);
    const c110 = value(r + 1, g + 1, b, channel); const c101 = value(r + 1, g, b + 1, channel);
    const c011 = value(r, g + 1, b + 1, channel); const c111 = value(r + 1, g + 1, b + 1, channel);
    if (fr >= fg) {
      if (fg >= fb) return c000 + fr * (c100 - c000) + fg * (c110 - c100) + fb * (c111 - c110);
      if (fr >= fb) return c000 + fr * (c100 - c000) + fb * (c101 - c100) + fg * (c111 - c101);
      return c000 + fb * (c001 - c000) + fr * (c101 - c001) + fg * (c111 - c101);
    }
    if (fb >= fg) return c000 + fb * (c001 - c000) + fg * (c011 - c001) + fr * (c111 - c011);
    if (fb >= fr) return c000 + fg * (c010 - c000) + fb * (c011 - c010) + fr * (c111 - c011);
    return c000 + fg * (c010 - c000) + fr * (c110 - c010) + fb * (c111 - c110);
  });
}

function measure(actual, raw, lut) {
  if (actual.width !== raw.width || actual.height !== raw.height) throw new Error("PQ verification and decoder oracle dimensions differ");
  const oracle = new PNG({ width: raw.width, height: raw.height });
  for (let offset = 0; offset < raw.data.length; offset += 4) {
    const linear = [0, 1, 2].map((channel) => srgbToLinear(raw.data[offset + channel] / 255));
    const encoded = samplePqLut(lut, linearRec709ToAcesCct(linear));
    for (let channel = 0; channel < 3; channel += 1) {
      const code10 = Math.round(clamp(encoded[channel]) * 1023);
      oracle.data[offset + channel] = Math.floor((code10 * 255 + 511) / 1023);
    }
    oracle.data[offset + 3] = raw.data[offset + 3];
  }
  const errors = [];
  let sum = 0;
  let swappedSum = 0;
  let gammaDecodedSum = 0;
  const actualChannelSum = [0, 0, 0];
  const expectedChannelSum = [0, 0, 0];
  let pixelSamples = 0;
  for (let offset = 0; offset < actual.data.length; offset += 16) {
    const pixel = offset / 4;
    const x = pixel % actual.width;
    const y = Math.floor(pixel / actual.width);
    if (x >= 600 || y < 40 || y >= 330) continue;
    const expected = [oracle.data[offset], oracle.data[offset + 1], oracle.data[offset + 2]];
    pixelSamples += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const expected8 = expected[channel];
      const error = Math.abs(actual.data[offset + channel] - expected8);
      errors.push(error);
      sum += error;
      swappedSum += Math.abs(actual.data[offset + (2 - channel)] - expected8);
      gammaDecodedSum += Math.abs(actual.data[offset + channel] - Math.round(srgbToLinear(expected8 / 255) * 255));
      actualChannelSum[channel] += actual.data[offset + channel];
      expectedChannelSum[channel] += expected8;
    }
  }
  errors.sort((a, b) => a - b);
  return { oracle, metrics: {
    samples: errors.length,
    meanCodeError: sum / errors.length,
    p99CodeError: errors[Math.floor((errors.length - 1) * .99)],
    maxCodeError: errors.at(-1),
    swappedMeanCodeError: swappedSum / errors.length,
    gammaDecodedMeanCodeError: gammaDecodedSum / errors.length,
    actualChannelMeans: actualChannelSum.map((value) => value / pixelSamples),
    expectedChannelMeans: expectedChannelSum.map((value) => value / pixelSamples),
  } };
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function measureFormalParity(actual, rgba64) {
  requireCondition(rgba64.length === actual.width * actual.height * 8, "formal PQ RGBA64 payload has the wrong dimensions");
  const errors = [];
  let sum = 0;
  for (let pixel = 0; pixel < actual.width * actual.height; pixel += 4) {
    const x = pixel % actual.width;
    const y = Math.floor(pixel / actual.width);
    if (x >= 600 || y < 40 || y >= 330) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const code16 = rgba64.readUInt16LE((pixel * 4 + channel) * 2);
      const code10 = Math.round(code16 * 1023 / 65535);
      const expected8 = Math.floor((code10 * 255 + 511) / 1023);
      const error = Math.abs(actual.data[pixel * 4 + channel] - expected8);
      errors.push(error);
      sum += error;
    }
  }
  errors.sort((a, b) => a - b);
  return {
    samples: errors.length,
    meanCodeError: sum / errors.length,
    p99CodeError: errors[Math.floor((errors.length - 1) * .99)],
    maxCodeError: errors.at(-1),
  };
}

function assertGreen(report) {
  requireCondition(report.schema === "editkin.common-video-pq-preview-gate/v1" && report.status === "GREEN", "PQ preview report is not GREEN");
  requireCondition(report.contractReceipt && report.surfaceReceipt && report.inactiveReceipt, "PQ preview contract receipt is incomplete");
  requireCondition(report.productPathCpuPixelCopies === 0 && report.presentedFrames >= 18 && report.presentP95Ms <= 45, "PQ preview missed its product-path performance gate");
  requireCondition(report.formalParity.samples >= 100_000 && report.formalParity.meanCodeError <= .25 && report.formalParity.p99CodeError <= 2 && report.formalParity.maxCodeError <= 96, "PQ preview diverged from the formal GPU display transform");
  requireCondition(report.measurements.samples >= 100_000 && report.measurements.meanCodeError <= .25 && report.measurements.p99CodeError <= 2 && report.measurements.maxCodeError <= 96, "PQ preview diverged from the independent 129-cube oracle");
  requireCondition(report.rejectedNegativeControls.length === 4 && report.releaseFences.pendingFenceCount === 0, "PQ preview negative controls or fence retirement are incomplete");
}

function syntheticSelfTest() {
  const valid = {
    schema: "editkin.common-video-pq-preview-gate/v1", status: "GREEN",
    contractReceipt: true, surfaceReceipt: true, inactiveReceipt: true,
    productPathCpuPixelCopies: 0, presentedFrames: 24, presentP95Ms: 20,
    measurements: { samples: 120_000, meanCodeError: .2, p99CodeError: 1, maxCodeError: 3 },
    formalParity: { samples: 120_000, meanCodeError: .1, p99CodeError: 1, maxCodeError: 2 },
    rejectedNegativeControls: ["sdr-surface", "pq-surface-sdr-graph", "hlg-surface", "processor-space-mismatch"],
    releaseFences: { pendingFenceCount: 0 },
  };
  assertGreen(valid);
  for (const broken of [
    { ...valid, surfaceReceipt: false },
    { ...valid, productPathCpuPixelCopies: 1 },
    { ...valid, measurements: { ...valid.measurements, p99CodeError: 3 } },
    { ...valid, rejectedNegativeControls: [] },
  ]) {
    let rejected = false;
    try { assertGreen(broken); } catch { rejected = true; }
    if (!rejected) throw new Error("PQ preview evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: 4 }));
}

async function withServer(run) {
  const child = spawn(candidate, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
    const id = `pq-preview-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000))]);
    return await run(request);
  } finally {
    try { await request("surface_release"); } catch {}
    try { await request("shutdown"); } catch {}
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

async function execute() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-pq-preview-"));
  try {
    const bindingsPath = join(temporary, "bindings.json");
    await writeFile(bindingsPath, JSON.stringify({ video: sourcePath }));
    const writeGraph = async (name, value) => {
      const path = join(temporary, `${name}.json`);
      await writeFile(path, JSON.stringify(value));
      return path;
    };
    return await withServer(async (request) => {
      const pqPath = await writeGraph("pq", graph("pq"));
      const loaded = await request("engine_video_load", { sessionId: "pq", graphPath: pqPath, bindingsPath, timelineFrame: 45 });
      requireCondition(loaded.ok && loaded.result.displayTransform === "aces2_rec2100_pq1000", `PQ graph load failed: ${JSON.stringify(loaded)}`);

      const rejectedNegativeControls = [];
      const sdrSurface = await request("surface_bind", { parentHwnd: "0", x: 32, y: 32, width: 96, height: 54, surfaceColorSpace: "srgb" });
      requireCondition(sdrSurface.ok, "SDR negative surface did not bind");
      const pqOnSdr = await request("engine_video_present_frame", { sessionId: "pq", timelineFrame: 45, toleranceSeconds: 1 / 30 });
      requireCondition(!pqOnSdr.ok && String(pqOnSdr.error).includes("Rgb10a2Unorm"), "PQ graph was not rejected on an SDR surface");
      rejectedNegativeControls.push("sdr-surface");
      await request("surface_release");

      const bound = await request("surface_bind", { parentHwnd: "0", x: 32, y: 32, width: 96, height: 54, surfaceColorSpace: "rec2100_pq_1000" });
      requireCondition(bound.ok, `PQ surface bind failed: ${JSON.stringify(bound)}`);
      const surfaceReceipt = bound.result.surfaceFormat === "Rgb10a2Unorm"
        && bound.result.surfaceColorSpace === "Bt2100Pq"
        && bound.result.pixelContract === "rec2020-pq-encoded-rgb/v1"
        && bound.result.hdrTransportConfigured === true
        && bound.result.legacyVideoPresentationAllowed === false
        && bound.result.physicalDisplayHdrVisibility === "advisory-unverified";

      const sdrPath = await writeGraph("sdr", graph("sdr"));
      const sdrLoaded = await request("engine_video_load", { sessionId: "sdr", graphPath: sdrPath, bindingsPath, timelineFrame: 45 });
      requireCondition(sdrLoaded.ok, "SDR negative graph did not load");
      const sdrOnPq = await request("engine_video_present_frame", { sessionId: "sdr", timelineFrame: 45, toleranceSeconds: 1 / 30 });
      requireCondition(!sdrOnPq.ok && String(sdrOnPq.error).includes("Bgra8UnormSrgb"), "SDR graph was not rejected on a PQ surface");
      rejectedNegativeControls.push("pq-surface-sdr-graph");
      await request("engine_video_release", { sessionId: "sdr" });

      const hlgPath = await writeGraph("hlg", graph("hlg"));
      const hlgLoaded = await request("engine_video_load", { sessionId: "hlg", graphPath: hlgPath, bindingsPath, timelineFrame: 45 });
      requireCondition(!hlgLoaded.ok && String(hlgLoaded.error).includes("formal-output"), "HLG resident preview did not fail closed at admission");
      rejectedNegativeControls.push("hlg-surface");

      const mismatchPath = await writeGraph("mismatch", graph("pq", { outputSpace: "rec709_sdr" }));
      const mismatch = await request("engine_video_load", { sessionId: "mismatch", graphPath: mismatchPath, bindingsPath, timelineFrame: 45 });
      requireCondition(!mismatch.ok, "processor/output-space mismatch was admitted");
      rejectedNegativeControls.push("processor-space-mismatch");

      const rawPath = join(temporary, "raw.png");
      const opened = await request("video_open", { sessionId: "raw", inputPath: sourcePath });
      const decoded = await request("video_decode_at", { sessionId: "raw", timeSeconds: 47 / 30, toleranceSeconds: 1 / 30, outputPath: rawPath });
      requireCondition(opened.ok && decoded.ok, "decoder oracle source failed");
      const outputPath = join(temporary, "pq.png");
      const verified = await request("engine_video_verify_frame", { sessionId: "pq", timelineFrame: 45, toleranceSeconds: 1 / 30, outputPath });
      requireCondition(verified.ok, `PQ verification failed: ${JSON.stringify(verified)}`);

      const raw = PNG.sync.read(await readFile(rawPath));
      const actual = PNG.sync.read(await readFile(outputPath));
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(join(dirname(reportPath), "raw-decoded.png"), PNG.sync.write(raw));
      await writeFile(join(dirname(reportPath), "pq-diagnostic.png"), PNG.sync.write(actual));
      const compressed = await readFile(resolve(root, "public/color/aces2/luts/output-acescct-to-rec2100_pq_1000.rgb-f32le.zlib"));
      const lut = inflateSync(compressed);
      requireCondition(sha256(lut) === pqPayloadSha256 && lut.length === 129 ** 3 * 3 * 4, "PQ LUT payload identity is invalid");
      const measured = measure(actual, raw, lut);
      const measurements = measured.metrics;
      await writeFile(join(dirname(reportPath), "pq-oracle.png"), PNG.sync.write(measured.oracle));
      const formalGraphPath = await writeGraph("formal-image", formalImageGraph());
      const formalBindingsPath = join(temporary, "formal-bindings.json");
      const formalSourcePath = join(temporary, "formal-linear.ekf32");
      const formalPngPath = join(temporary, "formal-pq.png");
      const formalRawPath = join(temporary, "formal-pq.rgba64le");
      await writeFile(formalSourcePath, encodeLinearEkf32(raw));
      await writeFile(formalBindingsPath, JSON.stringify({ video: formalSourcePath }));
      const formal = await runFile(candidate, ["engine-render", formalGraphPath, formalBindingsPath, "0", formalPngPath, "gpu"], {
        cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 2_000_000,
      });
      const formalReceipt = JSON.parse(formal.stdout);
      await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", formalPngPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba64le", formalRawPath], {
        cwd: root, windowsHide: true, timeout: 30_000,
      });
      const formalParity = measureFormalParity(actual, await readFile(formalRawPath));
      await writeFile(join(dirname(reportPath), "formal-pq.png"), await readFile(formalPngPath));

      const times = [];
      let last;
      for (let index = 0; index < 26; index += 1) {
        const started = performance.now();
        last = await request("engine_video_present_frame", { sessionId: "pq", timelineFrame: 46 + index, toleranceSeconds: 1 / 30 });
        requireCondition(last.ok, `PQ present failed: ${JSON.stringify(last)}`);
        if (index >= 6) times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const inactive = await request("engine_video_present_frame", { sessionId: "pq", timelineFrame: 240, toleranceSeconds: 1 / 30 });
      requireCondition(inactive.ok, `PQ inactive clear failed: ${JSON.stringify(inactive)}`);

      const contractReceipt = verified.result.displayTransform === pqProcessor
        && verified.result.outputSpace === "rec2100_pq_1000"
        && verified.result.lutSha256 === pqLutSha256
        && verified.result.lutPayloadSha256 === pqPayloadSha256
        && verified.result.inputTransform === inputProcessor
        && verified.result.ocioVersion === "2.5.2"
        && verified.result.acesVersion === "2.0"
        && verified.result.configSha256 === configSha256;
      const inactiveReceipt = inactive.result.active === false
        && inactive.result.nativeSurfaceCleared === true
        && inactive.result.surface.surfaceFormat === "Rgb10a2Unorm"
        && inactive.result.displayTransform === pqProcessor
        && inactive.result.outputSpace === "rec2100_pq_1000"
        && inactive.result.lutSha256 === pqLutSha256;
      const released = await request("engine_video_release", { sessionId: "pq" });
      await request("video_release", { sessionId: "raw" });
      return {
        loaded: loaded.result,
        bound: bound.result,
        verified: verified.result,
        contractReceipt,
        surfaceReceipt,
        inactiveReceipt,
        productPathCpuPixelCopies: last.result.productPathCpuPixelCopies,
        presentedFrames: times.length,
        presentP50Ms: times[Math.floor(times.length * .5)],
        presentP95Ms: times[Math.floor((times.length - 1) * .95)],
        measurements,
        formalParity,
        formalReceipt,
        rejectedNegativeControls,
        releaseFences: released.result.fences,
      };
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (selfTest) {
  syntheticSelfTest();
} else {
  const observed = await execute();
  const bytes = await readFile(candidate);
  const report = {
    schema: "editkin.common-video-pq-preview-gate/v1",
    status: "GREEN",
    measuredAt: new Date().toISOString(),
    executable: { path: candidate, bytes: bytes.length, sha256: sha256(bytes) },
    claimBoundary: "Windows DX12 resident ACES2 Rec.2100 PQ 1000-nit preview transport and code-value parity; physical display visibility remains advisory-unverified",
    ...observed,
  };
  assertGreen(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, reportPath, executable: report.executable, measurements: report.measurements, presentP95Ms: report.presentP95Ms, rejectedNegativeControls: report.rejectedNegativeControls }, null, 2));
}
