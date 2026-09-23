import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type NativeEffectInstance } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-resident-scene-linear-video-project-render");
const reportPath = join(evidenceRoot, "report.json");
const baselineReportPath = join(evidenceRoot, "baseline-report.json");
const executable = join(root, "spikes/gpu-compositor/target/release/editkin-gpu-compositor.exe");
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const source = join(root, "public/demo-source.mp4");
const audioPath = join(evidenceRoot, "tone.wav");
const frameCount = 6;
const fps = 30;
const selfTest = process.argv.includes("--self-test");
const baseline = process.argv.includes("--baseline");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface GateReport {
  schema: "editkin.resident-scene-linear-video-project-render-gate/v2";
  measuredAt?: string;
  status: "GREEN" | "BLOCK";
  baselineProductRouteRejected: boolean;
  planner: string;
  frameCount: number;
  productPathCpuPixelCopies: number;
  verificationReadback: boolean;
  gpuEffectProgramCount: number;
  gpuEffectOperationCount: number;
  matteExecutionMode: string;
  mattePassCount: number;
  decodedChangedPixelRatio: number;
  oracleMeanCodeError: number;
  oracleP99CodeError: number;
  oracleMaxCodeError: number;
  audioRetained: boolean;
  bt709Tagged: boolean;
  rejectedNegativeControls: string[];
  executableSha256: string;
  outputSha256: string;
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.resident-scene-linear-video-project-render-gate/v2" || report.status !== "GREEN") throw new Error("scene-linear effect/matte product report is not GREEN");
  if (!report.baselineProductRouteRejected || report.planner !== "editkin-resident-video-scene-linear-aces2-formal-sequence/v1") throw new Error("formal product route or baseline delta is incomplete");
  if (report.frameCount !== frameCount || report.productPathCpuPixelCopies !== 0 || report.verificationReadback !== true) throw new Error("formal sequence boundary receipt is incomplete");
  if (report.gpuEffectProgramCount !== 1 || report.gpuEffectOperationCount !== 4) throw new Error("third-party GPU effect receipt is incomplete");
  if (report.matteExecutionMode !== "sampled-track-matte-scene-linear/v1" || report.mattePassCount !== 1) throw new Error("scene-linear matte receipt is incomplete");
  if (report.decodedChangedPixelRatio < .05 || !report.audioRetained || !report.bt709Tagged) throw new Error("decoded product artifact did not preserve the promised audiovisual delta");
  // The formal deliverable is H.264 yuv420p, so the decoded RGB oracle includes bounded
  // chroma-subsampling error while still rejecting effect-order and transfer-function drift.
  if (report.oracleMeanCodeError > 8 || report.oracleP99CodeError > 30 || report.oracleMaxCodeError > 96) {
    throw new Error(`decoded product artifact diverged from the independent scene-linear oracle: ${JSON.stringify({ mean: report.oracleMeanCodeError, p99: report.oracleP99CodeError, max: report.oracleMaxCodeError })}`);
  }
  if (report.rejectedNegativeControls.length !== 7) throw new Error("formal product negative controls are incomplete");
  for (const value of [report.executableSha256, report.outputSha256]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("formal product identity is incomplete");
}

function syntheticSelfTest(): void {
  const valid: GateReport = {
    schema: "editkin.resident-scene-linear-video-project-render-gate/v2", status: "GREEN", baselineProductRouteRejected: true,
    planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", frameCount, productPathCpuPixelCopies: 0,
    verificationReadback: true, gpuEffectProgramCount: 1, gpuEffectOperationCount: 4,
    matteExecutionMode: "sampled-track-matte-scene-linear/v1", mattePassCount: 1, decodedChangedPixelRatio: .4,
    oracleMeanCodeError: 1.2, oracleP99CodeError: 5, oracleMaxCodeError: 30,
    audioRetained: true, bt709Tagged: true, rejectedNegativeControls: Array.from({ length: 7 }, (_, index) => `negative-${index}`),
    executableSha256: "a".repeat(64), outputSha256: "b".repeat(64),
  };
  assertGreen(valid);
  const negatives: GateReport[] = [
    { ...valid, gpuEffectProgramCount: 0 }, { ...valid, mattePassCount: 0 },
    { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, decodedChangedPixelRatio: 0 },
    { ...valid, oracleMeanCodeError: 9 },
    { ...valid, rejectedNegativeControls: [] },
  ];
  for (const candidate of negatives) {
    let rejected = false;
    try { assertGreen(candidate); } catch { rejected = true; }
    if (!rejected) throw new Error("scene-linear effect/matte evaluator accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length })}\n`);
}

async function createPlugin(pluginRoot: string): Promise<{ manifest: Record<string, any>; manifestSha256: string }> {
  const directory = join(pluginRoot, "scene-linear-look");
  await mkdir(directory, { recursive: true });
  const manifest = {
    schema: "editkin.plugin/v1", id: "editkin.gate.scene-linear", name: "Scene-linear Gate", version: "1.0.0", minimumHostVersion: "0.15.0",
    publisher: { name: "Editkin Gate" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
    capabilities: [{
      id: "filmic", name: "Filmic", description: "Bounded scene-linear GPU fixture", kind: "effect", automation: "manual", semanticRoles: [], formats: ["any"], requires: [], avoidWhen: [],
      parameters: [
        { id: "gain", name: "Gain", type: "number", default: .82, min: 0, max: 2 },
        { id: "invert", name: "Invert", type: "number", default: .18, min: 0, max: 1 },
        { id: "gray", name: "Gray", type: "number", default: .28, min: 0, max: 1 },
        { id: "contrast", name: "Contrast", type: "number", default: 1.18, min: 0, max: 2 },
        { id: "pivot", name: "Pivot", type: "number", default: .45, min: 0, max: 1 },
      ],
      runtime: { type: "gpu_effect_graph", abiVersion: 1, supportedFormats: ["rgba16_float"], maxTemporalRadius: 0, operations: [
        { op: "gain", args: ["$parameter.gain"] }, { op: "invert", args: ["$parameter.invert"] },
        { op: "grayscale", args: ["$parameter.gray"] }, { op: "contrast", args: ["$parameter.contrast", "$parameter.pivot"] },
      ] },
    }],
  };
  const text = JSON.stringify(manifest);
  await writeFile(join(directory, "editkin-plugin.json"), text, "utf8");
  return { manifest, manifestSha256: sha256(text) };
}

function project(instance: NativeEffectInstance, mode: "candidate" | "control" = "candidate"): EditProject {
  const value = createEmptyProject("Resident scene-linear effect/matte export", { width: 960, height: 540, fps });
  value.assets.push(
    { id: "matte-video", name: "Matte source", kind: "video", uri: source, duration: 4, width: 960, height: 540, color: { interpretation: "rec709" } },
    { id: "target-video", name: "Target source", kind: "video", uri: source, duration: 4, width: 960, height: 540, color: { interpretation: "rec709" } },
    { id: "tone", name: "tone.wav", kind: "audio", uri: audioPath, duration: frameCount / fps },
  );
  value.tracks[0].clips.push({
    id: "matte-clip", assetId: "matte-video", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0,
    duration: frameCount / fps, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    creative: { effectPresetIds: mode === "candidate" ? ["mono_halftone"] : [] },
    layer: { enabled: true, blendMode: "normal", role: "content" },
  });
  value.tracks.push({ id: "target-track", name: "Target", kind: "video", locked: false, muted: false, clips: [{
    id: "target-clip", assetId: "target-video", trackId: "target-track", timelineStart: 0, sourceStart: 1,
    duration: frameCount / fps, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: .18 }, keyframes: [],
    creative: { effectPresetIds: [], nativeEffectInstances: mode === "candidate" ? [instance] : [] },
    layer: { enabled: true, blendMode: "normal", role: "content",
      ...(mode === "candidate" ? { trackMatte: { sourceClipId: "matte-clip", mode: "luma" as const } } : {}) },
  }] });
  const audioTrack = value.tracks.find((track) => track.kind === "audio")!;
  audioTrack.clips.push({
    id: "tone-clip", assetId: "tone", trackId: audioTrack.id, timelineStart: 0, sourceStart: 0,
    duration: frameCount / fps, volume: .5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

function targetClip(value: EditProject) {
  const clip = value.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === "target-clip");
  if (!clip) throw new Error("target clip fixture is missing");
  return clip;
}

async function decodeFrame(inputPath: string, outputPath: string, seek: number): Promise<PNG> {
  await runFile(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(seek), "-i", inputPath, "-frames:v", "1", outputPath], { windowsHide: true, timeout: 30_000 });
  return PNG.sync.read(await readFile(outputPath));
}

async function decodedComparison(leftPath: string, rightPath: string, temporary: string): Promise<{ ratio: number; candidate: PNG }> {
  const leftFrame = join(temporary, "candidate.png");
  const rightFrame = join(temporary, "control.png");
  const [left, right] = await Promise.all([decodeFrame(leftPath, leftFrame, .1), decodeFrame(rightPath, rightFrame, .1)]);
  if (left.width !== right.width || left.height !== right.height) throw new Error("candidate/control decoded dimensions differ");
  let changed = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    if (Math.max(Math.abs(left.data[offset] - right.data[offset]), Math.abs(left.data[offset + 1] - right.data[offset + 1]), Math.abs(left.data[offset + 2] - right.data[offset + 2])) >= 4) changed += 1;
  }
  return { ratio: changed / (left.width * left.height), candidate: left };
}

const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

function parseCube(sourceText: string): { size: number; values: number[] } {
  let size = 0; const values: number[] = [];
  for (const raw of sourceText.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith("TITLE")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === "LUT_3D_SIZE") { size = Number(fields[1]); continue; }
    if (fields.length >= 3 && fields.slice(0, 3).every((field) => Number.isFinite(Number(field)))) values.push(...fields.slice(0, 3).map(Number));
  }
  if (size !== 65 || values.length !== size ** 3 * 3) throw new Error("calibrated ACES2 LUT is incomplete");
  return { size, values };
}

function sampleCube(lut: { size: number; values: number[] }, rgb: number[]): number[] {
  const scaled = rgb.map((value) => clamp(value) * (lut.size - 1));
  const low = scaled.map((value) => Math.min(lut.size - 2, Math.floor(value)));
  const [fr, fg, fb] = scaled.map((value, index) => value - low[index]);
  const [r, g, b] = low;
  const at = (rr: number, gg: number, bb: number, channel: number) => lut.values[((rr + gg * lut.size + bb * lut.size * lut.size) * 3) + channel];
  return [0, 1, 2].map((channel) => {
    const c000 = at(r, g, b, channel); const c100 = at(r + 1, g, b, channel); const c010 = at(r, g + 1, b, channel); const c001 = at(r, g, b + 1, channel);
    const c110 = at(r + 1, g + 1, b, channel); const c101 = at(r + 1, g, b + 1, channel); const c011 = at(r, g + 1, b + 1, channel); const c111 = at(r + 1, g + 1, b + 1, channel);
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

function srgbToLinear(value: number): number { return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }
function acesCct(rgb: number[]): number[] {
  const ap1 = [
    .61309740240118826 * rgb[0] + .33952314618410551 * rgb[1] + .047379451414707258 * rgb[2],
    .070193722469581596 * rgb[0] + .91635387905734134 * rgb[1] + .013452398473073862 * rgb[2],
    .020615592882227002 * rgb[0] + .10956977293813569 * rgb[1] + .86981463417963978 * rgb[2],
  ];
  return ap1.map((value) => value > .0078125 ? .0823456049 * Math.log(Math.max(value, 1.17549435e-38)) + .5547945205479452 : value * 10.5402374 + .0729055703);
}

function primary(rgb: number[], exposure: number): number[] {
  return rgb.map((value) => clamp(value * 2 ** clamp(exposure, -3, 3)));
}

function oracleMetrics(actual: PNG, matte: PNG, target: PNG, lut: { size: number; values: number[] }): { mean: number; p99: number; max: number; expectedPng: Buffer } {
  if (actual.width !== matte.width || actual.height !== matte.height || actual.width !== target.width || actual.height !== target.height) throw new Error("oracle source dimensions differ");
  const expectedPixels = new Uint8Array(actual.data.length);
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    let matteRgb = [0, 1, 2].map((channel) => srgbToLinear(matte.data[offset + channel] / 255));
    const matteLuma = matteRgb[0] * .2126 + matteRgb[1] * .7152 + matteRgb[2] * .0722;
    matteRgb = [0, 0, 0].map(() => Math.floor(matteLuma * 8 + .5) / 8);
    let targetRgb = primary([0, 1, 2].map((channel) => srgbToLinear(target.data[offset + channel] / 255)), .18);
    targetRgb = targetRgb.map((value) => value * .82);
    targetRgb = targetRgb.map((value) => value * .82 + (1 - value) * .18);
    const targetLuma = targetRgb[0] * .2126 + targetRgb[1] * .7152 + targetRgb[2] * .0722;
    targetRgb = targetRgb.map((value) => value * .72 + targetLuma * .28);
    targetRgb = targetRgb.map((value) => clamp((value - .45) * 1.18 + .45));
    const factor = clamp(matteRgb[0]);
    const composited = matteRgb.map((value, channel) => value * (1 - factor) + targetRgb[channel] * factor);
    const displayed = sampleCube(lut, acesCct(composited));
    for (let channel = 0; channel < 3; channel += 1) expectedPixels[offset + channel] = Math.round(clamp(displayed[channel]) * 255);
    expectedPixels[offset + 3] = 255;
  }
  const errors: number[] = []; let sum = 0;
  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      const actualOffset = (y * actual.width + x) * 4;
      let best = [255, 255, 255]; let bestTotal = Number.POSITIVE_INFINITY;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const sampleX = x + dx; const sampleY = y + dy;
        if (sampleX < 0 || sampleY < 0 || sampleX >= actual.width || sampleY >= actual.height) continue;
        const expectedOffset = (sampleY * actual.width + sampleX) * 4;
        const candidate = [0, 1, 2].map((channel) => Math.abs(expectedPixels[expectedOffset + channel] - actual.data[actualOffset + channel]));
        const total = candidate[0] + candidate[1] + candidate[2];
        if (total < bestTotal) { best = candidate; bestTotal = total; }
      }
      for (const error of best) { errors.push(error); sum += error; }
    }
  }
  errors.sort((left, right) => left - right);
  const expectedPng = PNG.sync.write({ width: actual.width, height: actual.height, data: Buffer.from(expectedPixels) } as PNG);
  return { mean: sum / errors.length, p99: errors[Math.floor((errors.length - 1) * .99)], max: errors.at(-1) ?? 0, expectedPng };
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  await mkdir(evidenceRoot, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "editkin-scene-linear-product-gate-"));
  try {
    const pluginRoot = join(temporary, "plugins");
    const plugin = await createPlugin(pluginRoot);
    const instance: NativeEffectInstance = {
      id: "scene-linear-gpu", pluginId: String(plugin.manifest.id), capabilityId: "filmic", pluginVersion: String(plugin.manifest.version),
      manifestSha256: plugin.manifestSha256, runtimeType: "gpu_effect_graph", enabled: true,
      parameters: { gain: .82, invert: .18, gray: .28, contrast: 1.18, pivot: .45 },
    };
    const candidateProject = project(instance);
    const productRouteRejected = buildGpuEngineVideoPreviewGraph(candidateProject, 0) === undefined;
    if (baseline) {
      if (!productRouteRejected) throw new Error("baseline unexpectedly admitted the scene-linear effect/matte product route");
      const report = { schema: "editkin.resident-scene-linear-video-project-render-baseline/v2", measuredAt: new Date().toISOString(), status: "BLOCK", productRouteRejected, executableSha256: sha256(await readFile(executable)) };
      await writeFile(baselineReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const frozen = JSON.parse(await readFile(baselineReportPath, "utf8")) as { status?: string; productRouteRejected?: boolean };
    if (productRouteRejected) throw new Error("candidate product route still rejects scene-linear effect/matte projects");
    await runFile(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      `sine=frequency=440:sample_rate=48000:duration=${frameCount / fps}`,
      "-c:a", "pcm_s16le", audioPath,
    ], { windowsHide: true, timeout: 30_000 });
    const output = join(evidenceRoot, "resident-scene-linear-effect-matte-product.mp4");
    const controlOutput = join(evidenceRoot, "resident-scene-linear-control.mp4");
    await rm(output, { force: true }); await rm(controlOutput, { force: true });
    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: executable, preferGpu: false, fontRoot: join(root, "public/fonts"), pluginRoots: [pluginRoot], timeoutMs: 120_000 };
    const rendered = await renderProject(candidateProject, output, options);
    const control = await renderProject(project(instance, "control"), controlOutput, options);
    const probe = await probeMedia(output, ffprobe);
    const pipeline = rendered.residentVideoPipeline as (NonNullable<typeof rendered.residentVideoPipeline> & {
      gpuEffectPrograms: Array<{ shaderOpCount: number }>;
      matteExecutionMode: string;
      mattePassCount: number;
    }) | undefined;
    if (!pipeline) throw new Error("formal scene-linear effect/matte render omitted resident pipeline receipt");
    const rejectedNegativeControls: string[] = [];
    const rejectRoute = (name: string, candidate: EditProject) => {
      if (buildGpuEngineVideoPreviewGraph(candidate, 0) !== undefined) throw new Error(`${name} negative was admitted`);
      rejectedNegativeControls.push(name);
    };
    const rejectRender = async (name: string, candidate: EditProject, pluginRoots: string[]) => {
      const negativePath = join(temporary, `${name}.mp4`);
      await renderProject(candidate, negativePath, { ...options, pluginRoots }).then(
        () => { throw new Error(`${name} negative was rendered`); },
        () => { rejectedNegativeControls.push(name); },
      );
    };
    await rejectRender("missing-plugin-root", candidateProject, []);
    await rejectRender("stale-plugin-identity", project({ ...instance, manifestSha256: "0".repeat(64) }), [pluginRoot]);
    const mixedRuntime = project(instance);
    targetClip(mixedRuntime).creative!.nativeEffectInstances!.push({ ...instance, id: "cpu-effect", runtimeType: "native_effect" });
    rejectRoute("cpu-gpu-mixed-runtime", mixedRuntime);
    const selfMatte = project(instance); targetClip(selfMatte).layer!.trackMatte!.sourceClipId = "target-clip"; rejectRoute("self-track-matte", selfMatte);
    const wrongConfig = project(instance); (wrongConfig.colorManagement as { configId: string }).configId = "stale-config"; rejectRoute("stale-ocio-config", wrongConfig);
    const hdrOutput = project(instance); hdrOutput.colorManagement!.outputTransform = "rec2100_pq_1000"; rejectRoute("unsupported-hdr-output", hdrOutput);
    const nonLocalSource = project(instance); nonLocalSource.assets.find((asset) => asset.id === "target-video")!.uri = "https://invalid.example/video.mp4"; rejectRoute("non-local-video-source", nonLocalSource);
    const comparison = await decodedComparison(output, control.outputPath, temporary);
    const [matteFrame, targetFrame] = await Promise.all([
      decodeFrame(source, join(temporary, "matte-source.png"), .1),
      decodeFrame(source, join(temporary, "target-source.png"), 1.1),
    ]);
    const oracle = oracleMetrics(comparison.candidate, matteFrame, targetFrame, parseCube(await readFile(join(root, "public/color/aces2/luts/output-acescct-to-rec709_sdr.cube"), "utf8")));
    await writeFile(join(evidenceRoot, "oracle-expected.png"), oracle.expectedPng);
    const report: GateReport = {
      schema: "editkin.resident-scene-linear-video-project-render-gate/v2", measuredAt: new Date().toISOString(), status: "GREEN",
      baselineProductRouteRejected: frozen.status === "BLOCK" && frozen.productRouteRejected === true,
      planner: rendered.planner, frameCount: pipeline.frameCount, productPathCpuPixelCopies: pipeline.productPathCpuPixelCopies,
      verificationReadback: pipeline.verificationReadback, gpuEffectProgramCount: pipeline.gpuEffectPrograms.length,
      gpuEffectOperationCount: pipeline.gpuEffectPrograms.reduce((sum, program) => sum + program.shaderOpCount, 0),
      matteExecutionMode: pipeline.matteExecutionMode, mattePassCount: pipeline.mattePassCount,
      decodedChangedPixelRatio: comparison.ratio,
      oracleMeanCodeError: oracle.mean, oracleP99CodeError: oracle.p99, oracleMaxCodeError: oracle.max,
      audioRetained: probe.hasAudio, bt709Tagged: probe.colorPrimaries === "bt709" && probe.colorTransfer === "bt709" && probe.colorMatrix === "bt709",
      rejectedNegativeControls, executableSha256: sha256(await readFile(executable)), outputSha256: sha256(await readFile(output)),
    };
    assertGreen(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
