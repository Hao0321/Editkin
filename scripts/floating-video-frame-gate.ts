import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { applyCommand } from "../src/domain/commands";
import { createEmptyProject, migrateProject, validateProject } from "../src/domain/editGraph";
import { projectSchema } from "../src/domain/schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../src/domain/types";
import { floatingVideoFramePreset } from "../src/motion/floatingVideoFrame";
import { floatingFrameSceneCommands } from "../src/motion/floatingFrameScenes";
import { motionClipPresetCommands } from "../src/motion/motionClipPresets";
import { buildEngineRenderGraph } from "../src/render/engineGraph";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const evidence = resolve(root, ".rd/benchmarks/floating-video-frame-20260928");
const ffmpegPath = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const source = join(root, "public/demo-source.mp4");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(): EditProject {
  let project = createEmptyProject("浮空影片框功能驗收", { id: "floating-frame-gate", width: 960, height: 540, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: {
    id: "own-video", name: "可替換的使用者影片", kind: "video", uri: source, duration: 12,
    width: 960, height: 540, color: { interpretation: "rec709" },
  } });
  const clip = (id: string, trackId: string, sourceStart: number, volume: number): TimelineClip => ({
    id, assetId: "own-video", trackId, timelineStart: 0, sourceStart, duration: 1, volume,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { enabled: true, blendMode: "normal", role: "content" },
  });
  project = applyCommand(project, { type: "add_clip", clip: clip("floating", "video-main", 1, .5) });
  project = applyCommand(project, { type: "set_clip_floating_frame", clipId: "floating", frame: floatingVideoFramePreset("prism") });
  const front = project.tracks.find(track => track.id === "video-main")!.clips[0];
  return applyCommand(project, { type: "batch", commands: motionClipPresetCommands(front, project.fps, "float_in") });
}

async function sample(path: string, output: string): Promise<PNG> {
  await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.55", "-i", path, "-frames:v", "1", output], { timeout: 30_000 });
  return PNG.sync.read(await readFile(output));
}

await mkdir(evidence, { recursive: true });
const authored = fixture();
const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(authored)))));
if (reopened.tracks.find(track => track.id === "video-main")?.clips[0].floatingFrame?.style !== "prism") throw new Error("浮空框在儲存／恢復後遺失");
let nativeRejected = false;
try { buildEngineRenderGraph(reopened); } catch (error) { nativeRejected = /浮空影片框/.test(String(error)); }
if (!nativeRejected) throw new Error("原生 graph 不能靜默忽略浮空框");
const candidate = join(evidence, "candidate.mp4");
const control = join(evidence, "control.mp4");
const options = { ffmpegPath, ffprobePath, preferGpu: false, timeoutMs: 120_000 };
const result = await renderProject(reopened, candidate, options);
const flat = structuredClone(reopened);
flat.tracks.find(track => track.id === "video-main")!.clips[0].floatingFrame = undefined;
await renderProject(flat, control, options);
const candidateProbe = await probeMedia(candidate, ffprobePath);
const candidateImage = await sample(candidate, join(evidence, "candidate-0.55s.png"));
const controlImage = await sample(control, join(evidence, "control-0.55s.png"));
if (candidateImage.width !== controlImage.width || candidateImage.height !== controlImage.height) throw new Error("控制影格尺寸不符");
let changedPixels = 0;
for (let i = 0; i < candidateImage.data.length; i += 4) {
  if (Math.abs(candidateImage.data[i] - controlImage.data[i])
    + Math.abs(candidateImage.data[i + 1] - controlImage.data[i + 1])
    + Math.abs(candidateImage.data[i + 2] - controlImage.data[i + 2]) > 54) changedPixels += 1;
}
if (!candidateProbe.hasVideo || !candidateProbe.hasAudio || changedPixels < 2_000
  || result.planner !== "editkin-floating-video-frame-ffmpeg/v1") throw new Error(`浮空框輸出未通過：${JSON.stringify({ candidateProbe, changedPixels, planner: result.planner })}`);
const report = { schema: "editkin.floating-video-frame-product-gate/v1", status: "GREEN", candidate, planner: result.planner,
  candidateSha256: sha(await readFile(candidate)), sourceSha256: sha(await readFile(source)),
  width: candidateImage.width, height: candidateImage.height, changedPixelsAgainstFlatControl: changedPixels,
  projectRevision: reopened.revision, nativeGraphRejected: nativeRejected, reviewState: "REVIEW_REQUIRED" };
await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const portraitSource = join(evidence, "portrait-source.mp4");
await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", source, "-t", "2",
  "-vf", "scale=360:640:force_original_aspect_ratio=increase,crop=360:640", "-c:v", "libx264", "-crf", "20",
  "-c:a", "aac", portraitSource], { timeout: 60_000 });
let portrait = createEmptyProject("雙直式浮空框功能驗收", { id: "portrait-duo-gate", width: 360, height: 640, fps: 30 });
portrait = applyCommand(portrait, { type: "import_asset", asset: {
  id: "portrait-video", name: "使用者直式影片", kind: "video", uri: portraitSource,
  duration: 2, width: 360, height: 640, color: { interpretation: "rec709" },
} });
portrait = applyCommand(portrait, { type: "add_clip", clip: {
  id: "portrait-base", assetId: "portrait-video", trackId: "video-main", timelineStart: 0, sourceStart: 0,
  duration: 1, volume: .5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  layer: { enabled: true, blendMode: "normal", role: "content" },
} });
const sceneCommands = floatingFrameSceneCommands(portrait, "portrait-base", "portrait_duo");
if (sceneCommands.length !== 5) throw new Error("雙直式場景指令數量錯誤");
portrait = applyCommand(portrait, { type: "batch", commands: sceneCommands });
const portraitReopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(portrait)))));
const portraitFrames = portraitReopened.tracks.flatMap(track => track.clips).filter(clip => clip.floatingFrame);
if (portraitFrames.length !== 3 || portraitFrames.filter(clip => clip.floatingFrame?.orbit).length !== 1) throw new Error("雙直式場景在儲存／恢復後遺失");
const portraitCandidate = join(evidence, "portrait-duo.mp4");
const portraitResult = await renderProject(portraitReopened, portraitCandidate, options);
const portraitProbe = await probeMedia(portraitCandidate, ffprobePath);
const portraitImage = await sample(portraitCandidate, join(evidence, "portrait-duo-0.55s.png"));
const visiblePixels = (fromX: number, toX: number) => {
  let count = 0;
  for (let y = 160; y < 500; y += 1) for (let x = fromX; x < toX; x += 1) {
    const index = (y * portraitImage.width + x) * 4;
    if (Math.max(portraitImage.data[index], portraitImage.data[index + 1], portraitImage.data[index + 2]) > 45) count += 1;
  }
  return count;
};
const visibleRegionPixels = { rearLeft: visiblePixels(0, 55), foreground: visiblePixels(120, 240), rearRight: visiblePixels(305, 360) };
if (portraitImage.width !== 360 || portraitImage.height !== 640 || !portraitProbe.hasVideo || !portraitProbe.hasAudio
  || portraitResult.planner !== "editkin-floating-video-frame-ffmpeg/v1"
  || Object.values(visibleRegionPixels).some(count => count < 2_000)) throw new Error(`雙直式正式輸出未通過：${JSON.stringify(visibleRegionPixels)}`);
const portraitReport = { schema: "editkin.floating-video-frame-scene-gate/v1", status: "GREEN", candidate: portraitCandidate,
  candidateSha256: sha(await readFile(portraitCandidate)), width: portraitImage.width, height: portraitImage.height,
  editableVideoLayers: portraitFrames.length, animatedPerspectiveLayers: 1, audioStreams: portraitProbe.hasAudio,
  visibleRegionPixels, planner: portraitResult.planner, reviewState: "REVIEW_REQUIRED" };
await writeFile(join(evidence, "portrait-report.json"), `${JSON.stringify(portraitReport, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ single: report, portrait: portraitReport })}\n`);
