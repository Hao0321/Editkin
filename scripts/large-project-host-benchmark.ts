import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../src/domain/types";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import { buildRenderPlan } from "../src/render/planner";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const percentile = (samples: number[], ratio: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)];
const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

function largeFixture(clipCount: number): EditProject {
  const project = createEmptyProject("50K clip host benchmark", { id: "large-project-50k", width: 3840, height: 2160, fps: 30 });
  project.assets.push({ id: "synthetic", name: "Synthetic", kind: "video", uri: "synthetic.mp4", duration: 2 });
  project.tracks[0].clips = Array.from({ length: clipCount }, (_, index): TimelineClip => ({
    id: `clip-${index}`, assetId: "synthetic", trackId: "video-main", timelineStart: index / 30,
    sourceStart: 0, duration: 1 / 30, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  }));
  return project;
}

function fourKFixture(basePath: string, overlayPath: string): EditProject {
  const project = createEmptyProject("4K host render", { id: "render-4k-host", width: 3840, height: 2160, fps: 30 });
  project.assets.push(
    { id: "base", name: "Base", kind: "video", uri: basePath, duration: 4, width: 640, height: 360 },
    { id: "overlay", name: "Overlay", kind: "video", uri: overlayPath, duration: 2, width: 320, height: 180 },
  );
  project.tracks[0].clips.push({
    id: "base-clip", assetId: "base", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  project.tracks.splice(1, 0, { id: "video-overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [{
    id: "overlay-clip", assetId: "overlay", trackId: "video-overlay", timelineStart: 1, sourceStart: 0, duration: 2,
    volume: 0, transform: { ...DEFAULT_TRANSFORM, scale: 0.52, opacity: 0.88 }, color: { ...DEFAULT_COLOR },
    keyframes: [
      { id: "start", time: 0.1, transform: { ...DEFAULT_TRANSFORM, x: -520, scale: 0.42, opacity: 0.45 }, color: { ...DEFAULT_COLOR }, easing: "linear" },
      { id: "end", time: 1.9, transform: { ...DEFAULT_TRANSFORM, x: 520, scale: 0.66, rotation: 6 }, color: { ...DEFAULT_COLOR, saturation: 1.2 }, easing: "linear" },
    ],
  }] });
  project.captions.push({ id: "caption", text: "Editkin 4K host benchmark", start: 0.5, duration: 2.5 });
  return project;
}

function gpuEvidence(): unknown {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("nvidia-smi.exe", ["--query-gpu=name,memory.total,driver_version,pstate", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (result.status === 0) {
    const [name, memoryMiB, driverVersion, pstate] = result.stdout.trim().split(",").map((item) => item.trim());
    return { source: "nvidia-smi", name, memoryMiB: Number(memoryMiB), driverVersion, pstate };
  }
  return { source: "nvidia-smi", status: "unavailable", detail: String(result.stderr || result.error?.message || "unknown").slice(-500) };
}

async function measuredRender(project: EditProject, outputPath: string, options: Parameters<typeof renderProject>[2]) {
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const started = performance.now();
  try {
    const result = await renderProject(project, outputPath, options);
    return { elapsedMs: performance.now() - started, peakRss, result };
  }
  finally { clearInterval(sampler); }
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const evidencePath = resolve(process.argv[2] ?? "../../.rd/benchmarks/editkin-large-project-4k-host-20260822.json");
  const artifactRoot = resolve(root, "../../.rd/artifacts/performance");
  const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
  const ffprobe = process.env.HAO_FFPROBE_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
  const nativeCore = process.env.HAO_NATIVE_CORE_PATH ?? resolve(root, "native/bin/win32-x64/hao-core.exe");
  const basePath = resolve(root, "public/benchmarks/layer-base.mp4");
  const overlayPath = resolve(root, "public/benchmarks/layer-overlay.mp4");
  await mkdir(artifactRoot, { recursive: true });

  const large = largeFixture(50_000);
  for (let index = 0; index < 3; index += 1) buildRenderPlan(large, (uri) => uri);
  const plannerSamples: number[] = [];
  let plannerPeakRss = process.memoryUsage().rss;
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now();
    const plan = buildRenderPlan(large, (uri) => uri);
    plannerSamples.push(performance.now() - started);
    plannerPeakRss = Math.max(plannerPeakRss, process.memoryUsage().rss);
    if (plan.videoLayers[0]?.segments.length !== 50_000) throw new Error("50K planner output mismatch");
  }

  const render = fourKFixture(basePath, overlayPath);
  const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: true, timeoutMs: 240_000 };
  const warmup = resolve(artifactRoot, "editkin-4k-warmup.mp4");
  await measuredRender(render, warmup, options);
  await rm(warmup, { force: true });
  const renderSamples = [];
  for (let index = 0; index < 2; index += 1) {
    const outputPath = resolve(artifactRoot, `editkin-4k-host-run-${index + 1}.mp4`);
    const sample = await measuredRender(render, outputPath, options);
    const probe = await probeMedia(outputPath, ffprobe);
    const info = await stat(outputPath);
    renderSamples.push({ ...sample, probe, bytes: info.size, sha256: await sha256(outputPath) });
    if (index === 0) await rm(outputPath, { force: true });
  }
  const plannerP95 = percentile(plannerSamples, 0.95);
  const renderP95 = percentile(renderSamples.map((sample) => sample.elapsedMs), 0.95);
  const assertions = {
    planner50000P95Under2000ms: plannerP95 <= 2_000,
    coordinatorPeakRssUnder1500MiB: plannerPeakRss <= 1_500 * 1024 * 1024,
    render4kP95Under30s: renderP95 <= 30_000,
    render4kRealTimeFactorUnder7Point5: renderP95 / 4_000 <= 7.5,
    hardwareEncoderUsed: renderSamples.every((sample) => sample.result.encoder === (process.platform === "darwin" ? "h264_videotoolbox" : "h264_nvenc")),
    nativePlannerUsed: renderSamples.every((sample) => sample.result.planner.startsWith("hao-core-rust")),
    outputQa: renderSamples.every((sample) => sample.probe.width === 3840 && sample.probe.height === 2160 && sample.probe.hasVideo && sample.probe.hasAudio && Math.abs(sample.probe.duration - 4) < 0.15),
  };
  const payload = {
    status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK",
    protocol: { id: "editkin-large-project-host-v1", warmups: { planner: 3, render: 1 }, samples: { planner: 12, render: 2 }, scope: "this physical host only" },
    evaluator: { path: "scripts/large-project-host-benchmark.ts", sha256: await sha256(resolve(import.meta.filename)) },
    environment: { hostname: hostname(), platform: platform(), release: release(), arch: process.arch, node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), gpu: gpuEvidence() },
    dataset: { plannerClips: 50_000, render: { width: 3840, height: 2160, fps: 30, durationSeconds: 4, layers: 2 }, inputs: [{ path: "public/benchmarks/layer-base.mp4", sha256: await sha256(basePath) }, { path: "public/benchmarks/layer-overlay.mp4", sha256: await sha256(overlayPath) }] },
    planner: { samplesMs: plannerSamples.map((value) => round(value)), p50Ms: round(percentile(plannerSamples, 0.5)), p95Ms: round(plannerP95), throughputClipsPerSecondAtP95: Math.round(50_000 / (plannerP95 / 1_000)), peakCoordinatorRssBytes: plannerPeakRss },
    render: { p50Ms: round(percentile(renderSamples.map((sample) => sample.elapsedMs), 0.5)), p95Ms: round(renderP95), samples: renderSamples.map((sample) => ({ elapsedMs: round(sample.elapsedMs), realTimeFactor: round(sample.elapsedMs / 4_000), peakCoordinatorRssBytes: sample.peakRss, bytes: sample.bytes, sha256: sample.sha256, encoder: sample.result.encoder, planner: sample.result.planner, ffmpegVersion: sample.result.ffmpegVersion, probe: sample.probe })) },
    assertions,
    externalMatrix: { status: "NOT_MEASURED", reason: "8K, AMD/Intel GPU, Apple Silicon, laptop battery and thermal endurance require those physical hosts." },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (payload.status !== "GREEN") process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
