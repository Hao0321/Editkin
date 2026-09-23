import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { analyzeSceneCuts } from "../src/application/sceneDetection";
import { buildSceneSplitCommand } from "../src/application/sceneSplitCommands";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject, findClip } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";

const root = resolve(import.meta.dirname, "..");
const ffmpegPath = process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const fixturePath = resolve(root, "../../.rd/fixtures/editkin-scene-ground-truth.mp4");
const cacheBase = resolve(root, "../../.rd/cache");
const evidencePath = resolve(root, "../../.rd/benchmarks/editkin-scene-detection-integration.json");
await access(ffmpegPath);
await mkdir(dirname(fixturePath), { recursive: true });
try { await access(fixturePath); } catch {
  await promisify(execFile)(ffmpegPath, [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2",
    "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=2",
    "-f", "lavfi", "-i", "color=c=green:s=640x360:r=30:d=2",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p",
    "-c:v", "libx264", fixturePath,
  ], { windowsHide: true, timeout: 60_000 });
}
await mkdir(cacheBase, { recursive: true });
const cacheRoot = await mkdtemp(join(cacheBase, "editkin-scene-integration-"));
try {
  const request = { sourcePath: fixturePath, sourceStart: 0, duration: 6, fps: 30, threshold: 10, minSceneDuration: 0.5 };
  const cold = await analyzeSceneCuts(request, { ffmpegPath, cacheRoot });
  const warm = await analyzeSceneCuts(request, { ffmpegPath, cacheRoot });
  if (cold.cacheHit || !warm.cacheHit || JSON.stringify(cold.cuts) !== JSON.stringify(warm.cuts)) throw new Error("場景偵測冷／暖快取契約失敗");
  if (cold.cuts.length !== 2 || Math.abs(cold.cuts[0].time - 2) > 1 / 30 || Math.abs(cold.cuts[1].time - 4) > 1 / 30) {
    throw new Error(`場景切點不符合已知 ground truth：${JSON.stringify(cold.cuts)}`);
  }
  let project = createEmptyProject("Scene Integration", { id: "scene-integration", width: 640, height: 360, fps: 30 });
  project = applyCommand(project, { type: "batch", commands: [
    { type: "import_asset", asset: { id: "scene-asset", name: "known scenes", kind: "video", uri: fixturePath, duration: 6, width: 640, height: 360 } },
    { type: "add_clip", clip: { id: "scene-clip", assetId: "scene-asset", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 6, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
  ] });
  const planned = buildSceneSplitCommand(project, findClip(project, "scene-clip"), cold.cuts, (() => { let id = 0; return () => `scene-${++id}`; })());
  project = applyCommand(project, planned.command);
  const clips = project.tracks[0].clips.map((clip) => ({ id: clip.id, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration }));
  if (clips.length !== 3 || clips.some((clip) => Math.abs(clip.duration - 2) > 1 / 30)) throw new Error("場景切點沒有正確寫回 EditGraph");
  const evidence = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), status: "GREEN",
    dataset: { id: "three-hard-cuts-colors-v1", duration: 6, fps: 30, expectedCuts: [2, 4] },
    cold: { cuts: cold.cuts, elapsedMs: cold.elapsedMs, cacheHit: cold.cacheHit },
    warm: { elapsedMs: warm.elapsedMs, cacheHit: warm.cacheHit },
    editGraph: { splitCount: planned.splitCount, clips },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally { await rm(cacheRoot, { recursive: true, force: true }); }
