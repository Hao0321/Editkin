import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { selectAutomaticMusicAsset } from "../creative/musicSelection";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject, projectDuration, validateProject } from "../domain/editGraph";
import { exportVideo } from "./exportVideo";
import { inspectMedia } from "./inspectMedia";
import { canvasResolutionForAsset } from "./sourceOrientation";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { analyzeSmartCut } from "./smartCut";
import { transcribeAutomaticCaptions } from "./automaticCaptions";
import { analyzeSceneCuts } from "./sceneDetection";
import { planSemanticAutoEdit } from "./semanticAutoEdit";
import { creativeAssetUri, listCreativeLibrary, resolveCreativeLibraryAsset } from "./creativeLibrary";
import { writeProjectFileAtomic } from "./projectFiles";
import { editorialProfile } from "./editorialProfiles";

export interface BatchAutoEditRequest {
  jobId: string;
  sourcePath: string;
  outputRoot: string;
  language?: string;
  targetRatio?: number;
  addMusic?: boolean;
  analysisMode?: "semantic" | "smart_cut";
  editorialProfile?: EditProject["editorialProfile"];
}

export interface BatchAutoEditRuntime {
  ffmpegPath: string;
  ffprobePath: string;
  nativeCorePath?: string;
  cacheRoot?: string;
  modelRoot: string;
  creativePackRoot?: string;
  personalMusicRoot?: string;
  fontRoot?: string;
  colorRoot?: string;
}

export interface BatchAutoEditResult {
  status: "completed" | "failed";
  jobId: string;
  sourceName: string;
  projectPath?: string;
  outputPath?: string;
  receiptPath: string;
  sourceSha256?: string;
  editorialFingerprint?: string;
  warnings: string[];
  error?: string;
  project?: EditProject;
}

interface BatchDependencies {
  hashFile: (path: string) => Promise<string>;
  inspect: typeof inspectMedia;
  transcribe: typeof transcribeAutomaticCaptions;
  detectScenes: typeof analyzeSceneCuts;
  smartCut: typeof analyzeSmartCut;
  writeProject: typeof writeProjectFileAtomic;
  render: typeof exportVideo;
  listLibrary: typeof listCreativeLibrary;
  resolveLibraryAsset: typeof resolveCreativeLibraryAsset;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: BatchDependencies = {
  hashFile: sha256File,
  inspect: inspectMedia,
  transcribe: transcribeAutomaticCaptions,
  detectScenes: analyzeSceneCuts,
  smartCut: analyzeSmartCut,
  writeProject: writeProjectFileAtomic,
  render: exportVideo,
  listLibrary: listCreativeLibrary,
  resolveLibraryAsset: resolveCreativeLibraryAsset,
  now: () => new Date(),
};

function safeStem(path: string): string {
  const extension = extname(path);
  const stem = basename(path, extension).trim() || "新影片";
  return stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 80) || "新影片";
}

function safeJobId(jobId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(jobId)) throw new Error("批次工作 ID 不合法");
  return jobId;
}

export function batchArtifactPaths(request: Pick<BatchAutoEditRequest, "jobId" | "sourcePath" | "outputRoot">): {
  directory: string;
  projectPath: string;
  outputPath: string;
  receiptPath: string;
} {
  if (!isAbsolute(request.sourcePath) || !isAbsolute(request.outputRoot)) throw new Error("批次素材與輸出資料夾必須是絕對路徑");
  const jobId = safeJobId(request.jobId);
  const stem = safeStem(request.sourcePath);
  const directory = resolve(request.outputRoot, "Editkin 批量成片", `${stem}-${jobId}`);
  return {
    directory,
    projectPath: join(directory, `${stem}.editkin.json`),
    outputPath: join(directory, `${stem}.mp4`),
    receiptPath: join(directory, "batch-receipt.json"),
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createBatchSourceProject(request: {
  sourcePath: string;
  jobId: string;
  duration: number;
  width?: number;
  height?: number;
  sourceSha256: string;
  now: Date;
  editorialProfile?: EditProject["editorialProfile"];
}): { project: EditProject; clip: TimelineClip } {
  const canvas = canvasResolutionForAsset({ kind: "video", width: request.width, height: request.height })
    ?? { width: 1920, height: 1080 };
  const project = createEmptyProject(safeStem(request.sourcePath), {
    id: `batch-project-${safeJobId(request.jobId)}`,
    width: canvas.width,
    height: canvas.height,
    fps: 30,
  });
  project.updatedAt = request.now.toISOString();
  project.editorialProfile = request.editorialProfile ?? "auto";
  project.aestheticSystem = resolveAestheticSystem(project.editorialProfile, canvas.width > canvas.height ? "longform" : "shorts");
  const asset: MediaAsset = {
    id: `batch-source-${request.jobId}`,
    name: basename(request.sourcePath),
    kind: "video",
    uri: request.sourcePath,
    duration: request.duration,
    width: request.width,
    height: request.height,
    role: "primary-source",
    provenance: "user-selected-local-source",
    redistributable: false,
    derivatives: { sourceSha256: request.sourceSha256, generatedAt: request.now.toISOString() },
  };
  const clip: TimelineClip = {
    id: `batch-clip-${request.jobId}`,
    assetId: asset.id,
    trackId: "video-main",
    timelineStart: 0,
    sourceStart: 0,
    duration: asset.duration,
    volume: 1,
    transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR },
    keyframes: [],
  };
  return {
    project: applyCommand(project, { type: "batch", commands: [
      { type: "import_asset", asset },
      { type: "add_clip", clip },
    ] }),
    clip,
  };
}

function musicCommands(project: EditProject, asset: MediaAsset): EditorCommand[] {
  const duration = projectDuration(project);
  const crossfade = Math.min(1.2, asset.duration / 5, duration / 5);
  const commands: EditorCommand[] = [
    { type: "import_asset", asset },
    { type: "add_track", track: { id: "audio-music-a", name: "配樂 A", kind: "audio", locked: false, muted: false, clips: [] } },
    { type: "add_track", track: { id: "audio-music-b", name: "配樂 B", kind: "audio", locked: false, muted: false, clips: [] } },
  ];
  let cursor = 0;
  let index = 0;
  while (cursor < duration - 0.5 / project.fps) {
    const clipDuration = Math.min(asset.duration, duration - cursor);
    commands.push({ type: "add_clip", clip: {
      id: `batch-music-${index}-${project.id}`,
      assetId: asset.id,
      trackId: index % 2 === 0 ? "audio-music-a" : "audio-music-b",
      timelineStart: cursor,
      sourceStart: 0,
      duration: clipDuration,
      volume: 0.24,
      transform: { ...DEFAULT_TRANSFORM },
      color: { ...DEFAULT_COLOR },
      keyframes: [],
    } });
    if (clipDuration >= duration - cursor) break;
    cursor += Math.max(1 / project.fps, clipDuration - crossfade);
    index += 1;
  }
  return commands;
}

async function addAutomaticMusic(
  project: EditProject,
  runtime: BatchAutoEditRuntime,
  dependencies: BatchDependencies,
): Promise<{ project: EditProject; musicId?: string; warning?: string }> {
  if (!runtime.creativePackRoot || !runtime.personalMusicRoot) return { project, warning: "素材庫 runtime 未就緒，未加入自動配樂" };
  try {
    const library = await dependencies.listLibrary(runtime.creativePackRoot, runtime.personalMusicRoot);
    const selected = selectAutomaticMusicAsset(library.assets, { projectName: project.name, duration: projectDuration(project), targetBpm: editorialProfile(project.editorialProfile).targetBpm });
    if (!selected) return { project, warning: "素材庫沒有符合的社群配樂" };
    const resolved = await dependencies.resolveLibraryAsset(runtime.creativePackRoot, selected.id, runtime.personalMusicRoot);
    const music: MediaAsset = {
      id: `batch-music-asset-${project.id}`,
      name: selected.name,
      kind: "audio",
      uri: creativeAssetUri(selected.id),
      duration: selected.duration ?? (await dependencies.inspect(resolved.absolutePath, runtime.ffprobePath)).duration,
      role: "background-music",
      bpm: selected.bpm,
      license: selected.license,
      provenance: selected.provenance,
      redistributable: selected.redistributable,
    };
    return { project: applyCommand(project, { type: "batch", commands: musicCommands(project, music) }), musicId: selected.id };
  } catch (error) {
    return { project, warning: `自動配樂略過：${error instanceof Error ? error.message : String(error)}` };
  }
}

function receiptBase(request: BatchAutoEditRequest, paths: ReturnType<typeof batchArtifactPaths>, now: Date) {
  return {
    schemaVersion: 1,
    product: "Editkin",
    productVersion: "0.15.0",
    jobId: request.jobId,
    sourceName: basename(request.sourcePath),
    projectPath: paths.projectPath,
    outputPath: paths.outputPath,
    reviewState: "REVIEW_REQUIRED",
    editorialProfile: request.editorialProfile ?? "auto",
    createdAt: now.toISOString(),
  };
}

export async function runBatchAutoEditItem(
  request: BatchAutoEditRequest,
  runtime: BatchAutoEditRuntime,
  overrides: Partial<BatchDependencies> = {},
): Promise<BatchAutoEditResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const paths = batchArtifactPaths(request);
  const warnings: string[] = [];
  const startedAt = dependencies.now();
  let sourceSha256: string | undefined;
  await mkdir(paths.directory, { recursive: true });
  try {
    sourceSha256 = await dependencies.hashFile(request.sourcePath);
    const probe = await dependencies.inspect(request.sourcePath, runtime.ffprobePath);
    if (!probe.hasVideo || probe.duration <= 0) throw new Error("批量自動剪輯只接受可解碼的影片檔");
    let { project, clip } = createBatchSourceProject({
      sourcePath: request.sourcePath,
      jobId: request.jobId,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      sourceSha256,
      now: startedAt,
      editorialProfile: request.editorialProfile,
    });
    if (project.editorialProfile === "podcast_on_camera") {
      warnings.push("批次已套用露臉 Podcast 的節奏、字幕、調色與音樂；雙人自動導播仍需開啟成片後框選主持人與來賓，避免未確認身分就錯切人物。");
    }

    let transcript: Awaited<ReturnType<typeof transcribeAutomaticCaptions>> | undefined;
    if (probe.hasAudio && request.analysisMode !== "smart_cut") {
      try {
        transcript = await dependencies.transcribe({
          sourcePath: request.sourcePath,
          sourceStart: 0,
          duration: probe.duration,
          sourceSha256,
          language: request.language ?? "auto",
        }, {
          ffmpegPath: runtime.ffmpegPath,
          modelRoot: runtime.modelRoot,
          cacheRoot: runtime.cacheRoot,
        });
      } catch (error) {
        warnings.push(`語意轉錄失敗，已改用去停頓保守模式：${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!probe.hasAudio) {
      warnings.push("來源沒有音軌，保留完整畫面並略過字幕");
    }

    if (transcript?.cues.some((cue) => cue.text.trim())) {
      const { buildNativeAutopilotCommand, planNativeAutopilotCreative } = await import("./nativeAutopilot");
      const scenes = await dependencies.detectScenes({
        sourcePath: request.sourcePath,
        sourceStart: 0,
        duration: probe.duration,
        fps: project.fps,
        sourceSha256,
      }, { ffmpegPath: runtime.ffmpegPath, cacheRoot: runtime.cacheRoot });
      const plan = planSemanticAutoEdit({
        duration: clip.duration,
        fps: project.fps,
        cues: transcript.cues,
        cuts: scenes.cuts,
        targetRatio: request.targetRatio ?? 0.65,
      });
      const creative = planNativeAutopilotCreative({ duration: clip.duration, width: probe.width ?? project.width, height: probe.height ?? project.height, cues: transcript.cues, cuts: scenes.cuts, video: true, profile: project.editorialProfile });
      const built = buildNativeAutopilotCommand({ project, clip, transcript, semantic: plan, creative, idFactory: (kind, index) => `batch-${kind}-${request.jobId}-${index}` });
      project = applyCommand(project, built.command);
    } else if (probe.hasAudio) {
      const cut = await dependencies.smartCut({
        sourcePath: request.sourcePath,
        sourceStart: 0,
        duration: probe.duration,
        fps: project.fps,
        sourceSha256,
      }, { ffmpegPath: runtime.ffmpegPath, nativeCorePath: runtime.nativeCorePath, cacheRoot: runtime.cacheRoot });
      if (cut.removedFrames > 0) {
        const ranges = cut.ranges.map((range) => ({ start: range.startFrame / cut.fps, end: range.endFrame / cut.fps }));
        project = applyCommand(project, {
          type: "smart_cut_clip",
          clipId: clip.id,
          keepRanges: ranges,
          segmentIds: ranges.map((_, index) => index === 0 ? clip.id : `batch-silence-${request.jobId}-${index}`),
        });
      }
    }

    let selectedMusicId: string | undefined;
    if (request.addMusic !== false) {
      const music = await addAutomaticMusic(project, runtime, dependencies);
      project = music.project;
      selectedMusicId = music.musicId;
      if (music.warning) warnings.push(music.warning);
    }
    validateProject(project);
    const editorialFingerprint = sha256Json({
      sourceSha256,
      clips: project.tracks.flatMap((track) => track.clips.map((item) => ({ trackId: track.id, sourceStart: item.sourceStart, timelineStart: item.timelineStart, duration: item.duration }))),
      captions: project.captions.map((caption) => ({ start: caption.start, duration: caption.duration, text: caption.text, translation: caption.translation })),
      selectedMusicId,
    });
    const saved = await dependencies.writeProject(paths.projectPath, project, null);
    const render = await dependencies.render({
      project: saved,
      outputPath: paths.outputPath,
      options: {
        ffmpegPath: runtime.ffmpegPath,
        ffprobePath: runtime.ffprobePath,
        nativeCorePath: runtime.nativeCorePath,
        preferGpu: true,
        fontRoot: runtime.fontRoot,
        colorRoot: runtime.colorRoot,
      },
    });
    const sourceAfterSha256 = await dependencies.hashFile(request.sourcePath);
    if (sourceAfterSha256 !== sourceSha256) throw new Error("原始素材在批次處理期間發生變更，已拒絕完成收據");
    await writeJsonAtomic(paths.receiptPath, {
      ...receiptBase(request, paths, startedAt),
      status: "COMPLETED",
      sourceSha256,
      sourcePreserved: true,
      editorialFingerprint,
      selectedMusicId,
      warnings,
      output: { duration: render.duration, encoder: render.encoder, planner: render.planner, ffmpegVersion: render.ffmpegVersion },
      completedAt: dependencies.now().toISOString(),
    });
    return {
      status: "completed",
      jobId: request.jobId,
      sourceName: basename(request.sourcePath),
      projectPath: paths.projectPath,
      outputPath: paths.outputPath,
      receiptPath: paths.receiptPath,
      sourceSha256,
      editorialFingerprint,
      warnings,
      project: saved,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(paths.receiptPath, {
      ...receiptBase(request, paths, startedAt),
      status: "FAILED",
      sourceSha256,
      warnings,
      error: message,
      failedAt: dependencies.now().toISOString(),
    });
    return {
      status: "failed",
      jobId: request.jobId,
      sourceName: basename(request.sourcePath),
      projectPath: paths.projectPath,
      receiptPath: paths.receiptPath,
      sourceSha256,
      warnings,
      error: message,
    };
  }
}
