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

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const percentile = (samples: number[], value: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)];
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function plannerFixture(clipCount: number): EditProject {
  const project = createEmptyProject("planner-5000", { id: "planner-5000", width: 1920, height: 1080, fps: 30 });
  project.assets.push({ id: "asset", name: "Synthetic", kind: "video", uri: "synthetic.mp4", duration: 1 });
  project.tracks[0].clips = Array.from({ length: clipCount }, (_, index): TimelineClip => ({
    id: `clip-${index}`, assetId: "asset", trackId: "video-main", timelineStart: index * 0.1,
    sourceStart: 0, duration: 0.1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  }));
  return project;
}

function renderFixture(basePath: string, overlayPath: string): EditProject {
  const project = createEmptyProject("1080p GPU benchmark", { id: "render-1080p", width: 1920, height: 1080, fps: 30 });
  project.assets.push(
    { id: "base", name: "Base", kind: "video", uri: basePath, duration: 4, width: 640, height: 360 },
    { id: "overlay", name: "Overlay", kind: "video", uri: overlayPath, duration: 2, width: 320, height: 180 },
  );
  project.tracks[0].clips.push({
    id: "base-clip", assetId: "base", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  project.tracks.splice(1, 0, {
    id: "video-overlay", name: "Overlay", kind: "video", locked: false, muted: false,
    clips: [{
      id: "overlay-clip", assetId: "overlay", trackId: "video-overlay", timelineStart: 1, sourceStart: 0, duration: 2,
      volume: 0, transform: { ...DEFAULT_TRANSFORM, scale: 0.55, opacity: 0.85 }, color: { ...DEFAULT_COLOR },
      keyframes: [
        { id: "start", time: 0.1, transform: { ...DEFAULT_TRANSFORM, x: -300, scale: 0.45, opacity: 0.4 }, color: { ...DEFAULT_COLOR }, easing: "linear" },
        { id: "end", time: 1.9, transform: { ...DEFAULT_TRANSFORM, x: 300, scale: 0.7, rotation: 8 }, color: { ...DEFAULT_COLOR, hue: 60, saturation: 1.25 }, easing: "linear" },
      ],
    }],
  });
  project.captions.push({ id: "caption", text: "Editkin benchmark", start: 0.5, duration: 2.5 });
  return project;
}

function windowsGpu() {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try { return JSON.parse(result.stdout); } catch { return result.stdout.trim(); }
}

async function measuredRender(project: EditProject, output: string, options: Parameters<typeof renderProject>[2]) {
  let peakCoordinatorRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakCoordinatorRss = Math.max(peakCoordinatorRss, process.memoryUsage().rss); }, 10);
  const started = performance.now();
  try {
    const result = await renderProject(project, output, options);
    return { elapsedMs: performance.now() - started, peakCoordinatorRss, result };
  } finally { clearInterval(sampler); }
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const evidencePath = resolve(process.argv[2] ?? "../../.rd/benchmarks/editkin-performance-windows-x64-20260821.json");
  const artifactRoot = resolve(root, "../../.rd/artifacts/performance");
  const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
  const ffprobe = process.env.HAO_FFPROBE_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
  const nativeCore = process.env.HAO_NATIVE_CORE_PATH ?? resolve(root, "native/bin/win32-x64/hao-core.exe");
  const basePath = resolve(root, "public/benchmarks/layer-base.mp4");
  const overlayPath = resolve(root, "public/benchmarks/layer-overlay.mp4");
  await mkdir(artifactRoot, { recursive: true });

  const plannerProject = plannerFixture(5_000);
  for (let index = 0; index < 5; index += 1) buildRenderPlan(plannerProject, (uri) => uri);
  const plannerSamples: number[] = [];
  let plannerPeakRss = process.memoryUsage().rss;
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    const plan = buildRenderPlan(plannerProject, (uri) => uri);
    plannerSamples.push(performance.now() - started);
    plannerPeakRss = Math.max(plannerPeakRss, process.memoryUsage().rss);
    if (plan.videoLayers[0]?.segments.length !== 5_000) throw new Error("planner fixture output mismatch");
  }

  const renderProjectFixture = renderFixture(basePath, overlayPath);
  const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: true, timeoutMs: 180_000 };
  const warmupPath = resolve(artifactRoot, "editkin-1080p-warmup.mp4");
  await measuredRender(renderProjectFixture, warmupPath, options);
  await rm(warmupPath, { force: true });
  const renderSamples = [];
  for (let index = 0; index < 3; index += 1) {
    const output = resolve(artifactRoot, `editkin-1080p-run-${index + 1}.mp4`);
    const sample = await measuredRender(renderProjectFixture, output, options);
    const probe = await probeMedia(output, ffprobe);
    const file = await stat(output);
    renderSamples.push({ ...sample, probe, bytes: file.size, sha256: await sha256(output) });
    if (index < 2) await rm(output, { force: true });
  }
  const elapsedSamples = renderSamples.map((sample) => sample.elapsedMs);
  const plannerP95 = percentile(plannerSamples, 0.95);
  const renderP95 = percentile(elapsedSamples, 0.95);
  const assertions = {
    planner5000P95Under200ms: plannerP95 <= 200,
    render1080pP95Under20s: renderP95 <= 20_000,
    renderRealTimeFactorP95Under5: renderP95 / 4_000 <= 5,
    hardwareEncoderUsed: renderSamples.every((sample) => sample.result.encoder === (process.platform === "darwin" ? "h264_videotoolbox" : "h264_nvenc")),
    nativePlannerUsed: renderSamples.every((sample) => sample.result.planner.startsWith("hao-core-rust")),
    qaStreamsAndDimensions: renderSamples.every((sample) => sample.probe.hasVideo && sample.probe.hasAudio && sample.probe.width === 1920 && sample.probe.height === 1080 && Math.abs(sample.probe.duration - 4) < 0.15),
  };
  const evaluatorPath = resolve(import.meta.filename);
  const payload = {
    status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK",
    protocol: { id: "editkin-performance-v1", warmups: { planner: 5, render: 1 }, samples: { planner: 30, render: 3 }, percentiles: ["p50", "p95"], coordinatorMemoryOnly: true },
    evaluator: { path: "scripts/performance-benchmark.ts", sha256: await sha256(evaluatorPath) },
    environment: { hostname: hostname(), platform: platform(), release: release(), node: process.version, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), gpu: windowsGpu() },
    dataset: { plannerClips: 5_000, render: { width: 1920, height: 1080, fps: 30, durationSeconds: 4, layers: 2 }, inputs: [{ path: "public/benchmarks/layer-base.mp4", sha256: await sha256(basePath) }, { path: "public/benchmarks/layer-overlay.mp4", sha256: await sha256(overlayPath) }] },
    planner: { samplesMs: plannerSamples.map((value) => round(value)), p50Ms: round(percentile(plannerSamples, 0.5)), p95Ms: round(plannerP95), throughputClipsPerSecondAtP95: Math.round(5_000 / (plannerP95 / 1_000)), peakCoordinatorRssBytes: plannerPeakRss },
    render: { samples: renderSamples.map((sample) => ({ elapsedMs: round(sample.elapsedMs), realTimeFactor: round(sample.elapsedMs / 4_000), peakCoordinatorRssBytes: sample.peakCoordinatorRss, bytes: sample.bytes, sha256: sample.sha256, encoder: sample.result.encoder, planner: sample.result.planner, ffmpegVersion: sample.result.ffmpegVersion, probe: sample.probe })), p50Ms: round(percentile(elapsedSamples, 0.5)), p95Ms: round(renderP95) },
    assertions,
    externalMatrix: { status: "NOT_MEASURED", reason: "4K/8K, Intel/AMD GPU, Apple Silicon and battery/thermal testing require matching physical hosts." },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (payload.status !== "GREEN") process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
