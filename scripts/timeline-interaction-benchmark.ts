import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../src/domain/types";
import { resolveTimelineDrag } from "../src/ui/timelineInteraction";
import { buildTimelineIntervalIndex, queryTimelineIntervalIndex } from "../src/ui/timelineViewport";

const percentile = (samples: number[], ratio: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)];
const round = (value: number) => Number(value.toFixed(3));
const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

function fixture(trackCount = 50, clipsPerTrack = 1_000): EditProject {
  const project = createEmptyProject("50K interactive timeline", { id: "timeline-50k", width: 3840, height: 2160, fps: 30 });
  project.assets = [{ id: "synthetic", name: "Synthetic", kind: "video", uri: "synthetic.mp4", duration: 1 }];
  project.tracks = Array.from({ length: trackCount }, (_, trackIndex) => ({
    id: `video-${trackIndex}`,
    name: `Video ${trackIndex + 1}`,
    kind: "video" as const,
    locked: false,
    muted: false,
    clips: Array.from({ length: clipsPerTrack }, (_, clipIndex): TimelineClip => ({
      id: `clip-${trackIndex}-${clipIndex}`,
      assetId: "synthetic",
      trackId: `video-${trackIndex}`,
      timelineStart: clipIndex * 0.5,
      sourceStart: 0,
      duration: 0.5,
      volume: 1,
      transform: { ...DEFAULT_TRANSFORM },
      color: { ...DEFAULT_COLOR },
      keyframes: [],
    })),
  }));
  return project;
}

function measure(samples: number, warmups: number, action: (index: number) => unknown): number[] {
  for (let index = 0; index < warmups; index += 1) action(index);
  const output: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    action(index);
    output.push(performance.now() - started);
  }
  return output;
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const evidencePath = resolve(process.argv[2] ?? "../../.rd/benchmarks/editkin-timeline-interaction-windows-x64-20260822.json");
  const project = fixture();
  const indexes = project.tracks.map((track) => buildTimelineIntervalIndex(track.clips, (clip) => ({ start: clip.timelineStart, end: clip.timelineStart + clip.duration })));
  let maximumVisible = 0;
  const viewportSamples = measure(1_000, 100, (index) => {
    const visibleStart = (index * 7.13) % 480;
    let visible = 0;
    for (const intervalIndex of indexes) visible += queryTimelineIntervalIndex(intervalIndex, visibleStart, visibleStart + 18).length;
    maximumVisible = Math.max(maximumVisible, visible);
  });

  const target = "clip-49-500";
  const propertySamples = measure(500, 50, (index) => applyCommand(project, {
    type: "set_clip_color", clipId: target, patch: { exposure: (index % 80) / 10 - 4 },
  }));
  const volumeSamples = measure(500, 50, (index) => applyCommand(project, {
    type: "set_clip_volume", clipId: target, volume: (index % 200) / 100,
  }));
  const moveSamples = measure(300, 30, () => applyCommand(project, {
    type: "move_clip", clipId: target, timelineStart: 250,
  }));
  const trimSamples = measure(300, 30, () => applyCommand(project, {
    type: "trim_clip_end", clipId: target, seconds: 1 / 30,
  }));
  const pointerSamples = measure(2_000, 200, (index) => resolveTimelineDrag({
    originStart: 250,
    duration: 0.5,
    originClientX: 640,
    currentClientX: 640 + (index % 240),
    originScrollLeft: 1_000,
    currentScrollLeft: 1_000 + (index % 32),
    pixelsPerSecond: 120,
    fps: 30,
    snapCandidates: [240, 250, 260, 270],
  }));
  const edited = applyCommand(project, { type: "set_clip_color", clipId: target, patch: { exposure: 1.5 } });
  const originalTarget = project.tracks[49].clips[500];
  const editedTarget = edited.tracks[49].clips[500];
  const metrics = {
    viewportQuery: { samplesMs: viewportSamples.map(round), p50Ms: round(percentile(viewportSamples, 0.5)), p95Ms: round(percentile(viewportSamples, 0.95)), maximumVisible },
    colorEdit: { p50Ms: round(percentile(propertySamples, 0.5)), p95Ms: round(percentile(propertySamples, 0.95)) },
    volumeEdit: { p50Ms: round(percentile(volumeSamples, 0.5)), p95Ms: round(percentile(volumeSamples, 0.95)) },
    move: { p50Ms: round(percentile(moveSamples, 0.5)), p95Ms: round(percentile(moveSamples, 0.95)) },
    trim: { p50Ms: round(percentile(trimSamples, 0.5)), p95Ms: round(percentile(trimSamples, 0.95)) },
    pointerResolution: { p50Ms: round(percentile(pointerSamples, 0.5)), p95Ms: round(percentile(pointerSamples, 0.95)) },
  };
  const assertions = {
    viewportQueryP95Under2ms: metrics.viewportQuery.p95Ms <= 2,
    commonColorEditP95Under16Point7ms: metrics.colorEdit.p95Ms <= 16.7,
    commonVolumeEditP95Under16Point7ms: metrics.volumeEdit.p95Ms <= 16.7,
    moveP95Under16Point7ms: metrics.move.p95Ms <= 16.7,
    trimP95Under16Point7ms: metrics.trim.p95Ms <= 16.7,
    pointerResolutionP95Under0Point2ms: metrics.pointerResolution.p95Ms <= 0.2,
    onlyViewportItemsMaterialized: maximumVisible <= 1_850,
    inputIsImmutable: originalTarget.color.exposure === 0 && editedTarget.color.exposure === 1.5,
    untouchedBranchesShared: edited.assets === project.assets && edited.tracks[0] === project.tracks[0] && edited.tracks[48] === project.tracks[48],
  };
  const payload = {
    status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK",
    protocol: { id: "editkin-timeline-interaction-v2", dataset: "50 tracks × 1,000 clips", totalClips: 50_000, viewportSeconds: 18, warmups: { viewport: 100, property: 50, structural: 30, pointer: 200 }, scope: "domain command, viewport materialization and pointer-resolution math; delivered WebView input-to-visible evidence remains a separate journey" },
    evaluator: { path: "scripts/timeline-interaction-benchmark.ts", sha256: await sha256(resolve(import.meta.filename)) },
    environment: { hostname: hostname(), platform: platform(), release: release(), arch: process.arch, node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    metrics,
    assertions,
    uiDomRuntime: { status: "NOT_MEASURED_BY_THIS_EVALUATOR", reason: "The Tauri CDP smoke owns DOM-count and lazy-workspace checks against the packaged UI." },
    externalMatrix: { status: "NOT_MEASURED", reason: "macOS/Apple Silicon and lower-spec Windows hosts require their physical machines." },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (payload.status !== "GREEN") process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
