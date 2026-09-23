import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import { createClipMask } from "../src/domain/masks";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const ffmpeg = join(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = join(appRoot, "native/bin/win32-x64/hao-core.exe");
const productReportPath = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-product-path/report.json");
const sourcePath = join(repoRoot, ".rd/tmp/auto-roto-sam2/sam2/sav_dataset/example/sav_000001.mp4");
const reportRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-formal-parity");
const reportPath = join(reportRoot, "report.json");
const duration = 1.5;
const fps = 24;

type ProductReport = {
  status: string;
  artifacts: { matteManifest: { path: string; sha256: string }; alphaSequence: { path: string; bytes: number; sha256: string } };
};

type FrozenManifest = {
  schema: string;
  engine: string;
  width: number;
  height: number;
  analysisFps: number;
  frameCount: number;
  sequencePath: string;
  sequenceSha256?: string;
  sequenceBytes?: number;
  meanBoundaryChatter: number;
  correctionStrokesApplied?: number;
  correctedFrames?: number[];
  qualityState: string;
  sam2Model?: unknown;
  frames: Array<{ frame: number; alphaPath: string; previewSha256: string; alphaFrameSha256: string }>;
};

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });
}

async function decodeRgb(video: string, time: number, output: string, width: number, height: number): Promise<Buffer> {
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=lanczos,format=rgb24`, "-f", "rawvideo", output]);
  return readFile(output);
}

async function decodeGray(image: string, output: string, width: number, height: number): Promise<Buffer> {
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", image, "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=neighbor,format=gray`, "-f", "rawvideo", output]);
  return readFile(output);
}

function projectFor(source: string, matte?: FrozenManifest) {
  const project = createEmptyProject("Auto Roto formal parity", { id: matte ? "auto-roto-formal" : "auto-roto-control", width: matte?.width ?? 480, height: matte?.height ?? 848, fps });
  project.assets.push({ id: "source", name: "SA-V source", kind: "video", uri: source, duration, width: project.width, height: project.height });
  const clip: TimelineClip = {
    id: "subject", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
  if (matte) {
    const mask = createClipMask("auto-roto-production", "subject");
    (mask as unknown as { matteSequence: Record<string, unknown> }).matteSequence = {
      schema: matte.schema, engine: matte.engine, width: matte.width, height: matte.height, analysisFps: matte.analysisFps,
      frameCount: matte.frameCount, sequenceUri: matte.sequencePath, sequenceSha256: matte.sequenceSha256, sequenceBytes: matte.sequenceBytes,
      manifestUri: productReportPath.replace(/report\.json$/, "cache-placeholder"), framePreviewUris: matte.frames.map((frame) => frame.alphaPath),
      meanBoundaryChatter: matte.meanBoundaryChatter, correctionStrokesApplied: matte.correctionStrokesApplied, correctedFrames: matte.correctedFrames,
      sam2Model: matte.sam2Model, stale: false, frozen: true, qualityState: matte.qualityState,
    };
    clip.masks = [mask];
  }
  project.tracks[0].clips.push(clip);
  return project;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))] ?? Infinity;
}

function evaluate(metrics: { meanCompositeError: number; p95CompositeError: number; highAlphaRetention: number; lowAlphaSuppression: number; previewExact: boolean; tamperRejected: boolean }) {
  const checks = {
    meanCompositeError: metrics.meanCompositeError <= .035,
    p95CompositeError: metrics.p95CompositeError <= .12,
    highAlphaRetention: metrics.highAlphaRetention >= .88,
    lowAlphaSuppression: metrics.lowAlphaSuppression >= .92,
    previewExact: metrics.previewExact,
    tamperRejected: metrics.tamperRejected,
  };
  return { status: Object.values(checks).every(Boolean) ? "GREEN_FORMAL_PARITY" : "FAIL", checks };
}

function selfTest(): void {
  const valid = { meanCompositeError: .01, p95CompositeError: .04, highAlphaRetention: .96, lowAlphaSuppression: .98, previewExact: true, tamperRejected: true };
  if (evaluate(valid).status !== "GREEN_FORMAL_PARITY") throw new Error("formal parity evaluator rejected valid fixture");
  const mutations = [
    { ...valid, meanCompositeError: .1 }, { ...valid, p95CompositeError: .3 }, { ...valid, highAlphaRetention: .5 },
    { ...valid, lowAlphaSuppression: .5 }, { ...valid, previewExact: false }, { ...valid, tamperRejected: false },
  ];
  if (mutations.some((mutation) => evaluate(mutation).status !== "FAIL")) throw new Error("formal parity evaluator accepted a negative mutation");
  process.stdout.write("AUTO_ROTO_FORMAL_PARITY_SELF_TEST status=GREEN mutations=6\n");
}

async function main(): Promise<void> {
  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });
  const product = JSON.parse(await readFile(productReportPath, "utf8")) as ProductReport;
  if (product.status !== "GREEN_ISOLATED_RESEARCH_PATH") throw new Error("Auto Roto isolated research path gate 尚未通過");
  const matte = JSON.parse(await readFile(product.artifacts.matteManifest.path, "utf8")) as FrozenManifest;
  matte.sequencePath = product.artifacts.alphaSequence.path;
  matte.frameCount = matte.frames.length;
  const alpha = await readFile(matte.sequencePath);
  if (sha256(alpha) !== product.artifacts.alphaSequence.sha256 || alpha.length !== product.artifacts.alphaSequence.bytes) throw new Error("Research path alpha artifact 已漂移");
  const manifestPath = product.artifacts.matteManifest.path;
  const candidateProject = projectFor(sourcePath, matte);
  candidateProject.tracks[0].clips[0].masks![0].matteSequence!.manifestUri = manifestPath;
  const controlProject = projectFor(sourcePath);
  const candidateOutput = join(reportRoot, "masked.mp4");
  const controlOutput = join(reportRoot, "control.mp4");
  const [candidateRender, controlRender] = await Promise.all([
    renderProject(validateProject(candidateProject), candidateOutput, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 180_000 }),
    renderProject(validateProject(controlProject), controlOutput, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 180_000 }),
  ]);
  const sampleTimes = [.25, .75, 1.25];
  const errors: number[] = [];
  let highRetained = 0; let highTotal = 0; let lowSuppressed = 0; let lowTotal = 0;
  for (let sample = 0; sample < sampleTimes.length; sample += 1) {
    const time = sampleTimes[sample];
    const frameIndex = Math.min(matte.frameCount - 1, Math.max(0, Math.floor(time * matte.analysisFps)));
    const frameOffset = frameIndex * matte.width * matte.height;
    const expectedAlpha = alpha.subarray(frameOffset, frameOffset + matte.width * matte.height);
    const [candidate, control] = await Promise.all([
      decodeRgb(candidateOutput, time, join(reportRoot, `masked-${sample}.rgb24`), matte.width, matte.height),
      decodeRgb(controlOutput, time, join(reportRoot, `control-${sample}.rgb24`), matte.width, matte.height),
    ]);
    for (let pixel = 0; pixel < expectedAlpha.length; pixel += 1) {
      const a = expectedAlpha[pixel] / 255;
      const rgb = pixel * 3;
      const controlLuma = (control[rgb] + control[rgb + 1] + control[rgb + 2]) / 3;
      const candidateLuma = (candidate[rgb] + candidate[rgb + 1] + candidate[rgb + 2]) / 3;
      errors.push((Math.abs(candidate[rgb] - control[rgb] * a) + Math.abs(candidate[rgb + 1] - control[rgb + 1] * a) + Math.abs(candidate[rgb + 2] - control[rgb + 2] * a)) / (3 * 255));
      if (expectedAlpha[pixel] >= 64 && controlLuma >= 20) {
        highTotal += 1;
        highRetained += Math.min(1, candidateLuma / Math.max(1, controlLuma * a));
      }
      if (expectedAlpha[pixel] <= 20 && controlLuma >= 20) { lowTotal += 1; if (candidateLuma / controlLuma <= .08) lowSuppressed += 1; }
    }
  }
  let previewExact = true;
  for (const frameIndex of [0, Math.floor(matte.frameCount / 2), matte.frameCount - 1]) {
    const decoded = await decodeGray(matte.frames[frameIndex].alphaPath, join(reportRoot, `preview-${frameIndex}.gray8`), matte.width, matte.height);
    const expected = alpha.subarray(frameIndex * matte.width * matte.height, (frameIndex + 1) * matte.width * matte.height);
    previewExact = previewExact && decoded.equals(expected) && sha256(expected) === matte.frames[frameIndex].alphaFrameSha256;
  }
  const tamperedSequence = join(reportRoot, "tampered.alpha8");
  const tamperedManifest = join(reportRoot, "tampered-manifest.json");
  await Promise.all([copyFile(matte.sequencePath, tamperedSequence), copyFile(manifestPath, tamperedManifest)]);
  const tampered = await readFile(tamperedSequence); tampered[Math.floor(tampered.length / 2)] ^= 0xff; await writeFile(tamperedSequence, tampered);
  const tamperedProject = projectFor(sourcePath, matte);
  const tamperedMatte = tamperedProject.tracks[0].clips[0].masks![0].matteSequence!;
  tamperedMatte.sequenceUri = tamperedSequence; tamperedMatte.manifestUri = tamperedManifest;
  let tamperRejected = false;
  try { await renderProject(validateProject(tamperedProject), join(reportRoot, "must-not-render.mp4"), { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 60_000 }); }
  catch (error) { tamperRejected = /SHA-256/.test(error instanceof Error ? error.message : String(error)); }
  const metrics = {
    meanCompositeError: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    p95CompositeError: percentile(errors, .95), highAlphaRetention: highRetained / Math.max(1, highTotal),
    lowAlphaSuppression: lowSuppressed / Math.max(1, lowTotal), previewExact, tamperRejected,
  };
  const verdict = evaluate(metrics);
  const report = {
    schema: "editkin.auto-roto-sam21-formal-parity-gate/v1", ...verdict, metrics,
    inputs: { productReportPath, productReportSha256: sha256(await readFile(productReportPath)), sourcePath, sourceSha256: sha256(await readFile(sourcePath)) },
    artifacts: {
      candidate: { path: candidateOutput, bytes: (await stat(candidateOutput)).size, sha256: sha256(await readFile(candidateOutput)), render: candidateRender, probe: await probeMedia(candidateOutput, ffprobe) },
      control: { path: controlOutput, bytes: (await stat(controlOutput)).size, sha256: sha256(await readFile(controlOutput)), render: controlRender, probe: await probeMedia(controlOutput, ffprobe) },
    },
    claimBoundary: "Proves Editkin formal FFmpeg export consumes the exact hash-bound production matte represented in EditGraph and matches preview alpha within frozen thresholds; it does not establish Adobe parity or public distribution signing.",
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`AUTO_ROTO_FORMAL_PARITY status=${verdict.status} mean=${metrics.meanCompositeError.toFixed(5)} p95=${metrics.p95CompositeError.toFixed(5)} report=${reportPath}\n`);
  if (verdict.status === "FAIL") process.exitCode = 1;
}

if (process.argv.includes("--self-test")) selfTest(); else await main();
