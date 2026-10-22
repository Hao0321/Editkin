import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, open, lstat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { automaticMusicPreferences, selectAutomaticMusicAsset } from "../creative/musicSelection";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import type { SmartCutKeepRange } from "../domain/smartCut";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject, projectDuration, validateProject } from "../domain/editGraph";
import { exportVideo } from "./exportVideo";
import { inspectMedia } from "./inspectMedia";
import { canvasResolutionForAsset } from "./sourceOrientation";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { analyzeSmartCut } from "./smartCut";
import { transcribeAutomaticCaptions } from "./automaticCaptions";
import { isNoSpeechTranscriptError } from "./automaticCaptionOutcome";
import { assessTranscriptSpeech } from "./transcriptSpeech";
import { analyzeSceneCuts } from "./sceneDetection";
import {
  NARRATION_SILENCE_DETECTION, VISUAL_ACTIVITY_DETECTION, audioKeepRangesFromSmartCut, planNarrationPauseTrim, planSemanticAutoEdit,
  planVisualQualityAutoEdit, visualHighlightTargetSeconds,
} from "./semanticAutoEdit";
import { creativeAssetIdFromUri, creativeAssetUri, listCreativeLibrary, resolveCreativeLibraryAsset } from "./creativeLibrary";
import { writeProjectFileAtomic } from "./projectFiles";
import { editorialProfile } from "./editorialProfiles";
import { withBatchExecutionOwnerV1 } from "./batchExecutionOwnerV1";
import { openBatchAutoEditResumeV1, commitBatchAutoEditProjectV1, renderBatchAutoEditResumeV1, type BatchResumeContextV1 } from "./batchAutoEditResumeV1";

export interface BatchAutoEditRequest {
  jobId: string;
  /** Native picker batch identity; optional for existing standalone callers with globally unique job IDs. */
  sessionId?: string;
  sourcePath: string;
  outputRoot: string;
  language?: string;
  /** Speech condensation for vertical/square (Shorts) sources only; horizontal long-form keeps every spoken cue. */
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
  /** Bundled whisper-cli. The shipped FFmpeg has no whisper filter, so captions need it (same as single-clip captions). */
  whisperCliPath?: string;
  /** Optional pinned model file override (EDITKIN_WHISPER_MODEL_PATH), as for single-clip captions. */
  modelPath?: string;
  creativePackRoot?: string;
  personalMusicRoot?: string;
  fontRoot?: string;
  colorRoot?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { stage: "prepare" | "analyze" | "apply" | "render" | "completed" | "failed"; completed: number; total: 1; jobId: string }) => void | Promise<void>;
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

export function batchArtifactPaths(request: Pick<BatchAutoEditRequest, "jobId" | "sessionId" | "sourcePath" | "outputRoot">): {
  directory: string;
  projectPath: string;
  outputPath: string;
  receiptPath: string;
} {
  if (!isAbsolute(request.sourcePath) || !isAbsolute(request.outputRoot)) throw new Error("批次素材與輸出資料夾必須是絕對路徑");
  const jobId = safeJobId(request.jobId);
  if (request.sessionId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(request.sessionId)) throw new Error("批次 session ID 不合法");
  const stem = safeStem(request.sourcePath);
  const directory = resolve(request.outputRoot, "Editkin 批量成片", `${stem}-${request.sessionId ? `${request.sessionId}-` : ""}${jobId}`);
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
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createBatchSourceProject(request: {
  sourcePath: string;
  jobId: string;
  sessionId?: string;
  duration: number;
  width?: number;
  height?: number;
  displayAspectRatio?: number;
  sourceSha256: string;
  now: Date;
  editorialProfile?: EditProject["editorialProfile"];
}): { project: EditProject; clip: TimelineClip } {
  const scopedJobId = request.sessionId ? `session-${sha256Json({ sessionId: request.sessionId, jobId: safeJobId(request.jobId) }).slice(0, 24)}` : safeJobId(request.jobId);
  const canvas = canvasResolutionForAsset({ kind: "video", width: request.width, height: request.height, displayAspectRatio: request.displayAspectRatio })
    ?? { width: 1920, height: 1080 };
  const project = createEmptyProject(safeStem(request.sourcePath), {
    id: `batch-project-${scopedJobId}`,
    width: canvas.width,
    height: canvas.height,
    fps: 30,
  });
  project.updatedAt = request.now.toISOString();
  project.editorialProfile = request.editorialProfile ?? "auto";
  project.aestheticSystem = resolveAestheticSystem(project.editorialProfile, canvas.width > canvas.height ? "longform" : "shorts");
  const asset: MediaAsset = {
    id: `batch-source-${scopedJobId}`,
    name: basename(request.sourcePath),
    kind: "video",
    uri: request.sourcePath,
    duration: request.duration,
    width: request.width,
    height: request.height,
    displayAspectRatio: request.displayAspectRatio,
    role: "primary-source",
    provenance: "user-selected-local-source",
    redistributable: false,
    derivatives: { sourceSha256: request.sourceSha256, generatedAt: request.now.toISOString() },
  };
  const clip: TimelineClip = {
    id: `batch-clip-${scopedJobId}`,
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
    const selected = selectAutomaticMusicAsset(library.assets, { projectName: project.name, duration: projectDuration(project), targetBpm: editorialProfile(project.editorialProfile).targetBpm, ...automaticMusicPreferences(project.editorialProfile) });
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

/**
 * Render copy with Creative Pack / Community Music URIs resolved to verified files, as the single-project export route
 * does before rendering. The saved project keeps its creative:// URIs; only the renderer's copy changes.
 */
async function materializeBatchCreativeAssets(project: EditProject, runtime: BatchAutoEditRuntime, dependencies: BatchDependencies): Promise<EditProject> {
  if (!project.assets.some((asset) => creativeAssetIdFromUri(asset.uri))) return project;
  if (!runtime.creativePackRoot) throw new Error("批次輸出需要素材庫 runtime 才能讀取社群配樂");
  const copy = structuredClone(project);
  for (const asset of copy.assets) {
    const creativeId = creativeAssetIdFromUri(asset.uri);
    if (creativeId) asset.uri = (await dependencies.resolveLibraryAsset(runtime.creativePackRoot, creativeId, runtime.personalMusicRoot)).absolutePath;
  }
  return copy;
}

/** Silence-detector keep ranges as independent narration evidence; unavailable evidence is undefined, not an error. */
async function batchAudioKeepRanges(
  request: BatchAutoEditRequest,
  duration: number,
  fps: number,
  sourceSha256: string | undefined,
  runtime: BatchAutoEditRuntime,
  dependencies: BatchDependencies,
): Promise<SmartCutKeepRange[] | undefined> {
  try {
    const cut = await dependencies.smartCut({ sourcePath: request.sourcePath, sourceStart: 0, duration, fps, sourceSha256, options: { ...NARRATION_SILENCE_DETECTION } },
      { ffmpegPath: runtime.ffmpegPath, nativeCorePath: runtime.nativeCorePath, cacheRoot: runtime.cacheRoot });
    return audioKeepRangesFromSmartCut(cut);
  } catch { return undefined; }
}

function receiptBase(request: BatchAutoEditRequest, paths: ReturnType<typeof batchArtifactPaths>, now: Date) {
  return {
    schemaVersion: 1,
    product: "Editkin",
    productVersion: "0.15.0",
    jobId: request.jobId,
    sessionId: request.sessionId,
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
  const execute = () => runBatchAutoEditItemOwned(request, runtime, overrides);
  return runtime.cacheRoot ? withBatchExecutionOwnerV1(runtime.cacheRoot, batchArtifactPaths(request).projectPath, execute) : execute();
}

async function runBatchAutoEditItemOwned(request: BatchAutoEditRequest, runtime: BatchAutoEditRuntime,
  overrides: Partial<BatchDependencies>): Promise<BatchAutoEditResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const paths = batchArtifactPaths(request);
  const warnings: string[] = [];
  const startedAt = dependencies.now();
  let sourceSha256: string | undefined;
  let resume: BatchResumeContextV1 | undefined;
  const report = (stage: Parameters<NonNullable<BatchAutoEditRuntime["onProgress"]>>[0]["stage"]) => {
    try { void Promise.resolve(runtime.onProgress?.({ stage, completed: stage === "completed" ? 1 : 0, total: 1, jobId: request.jobId })).catch(() => undefined); }
    catch { /* observer owns no project/journal state */ }
  };
  const verifySource = async () => {
    if (await dependencies.hashFile(request.sourcePath) !== sourceSha256) throw new Error("原始素材在批次處理期間發生變更，已拒絕完成收據");
  };
  const renderOptions = { ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, nativeCorePath: runtime.nativeCorePath,
    preferGpu: true, fontRoot: runtime.fontRoot, colorRoot: runtime.colorRoot, signal: runtime.signal };
  // The saved project keeps the music's creative:// URI; the renderer reads files, like the single-project export route.
  const render: typeof exportVideo = async (input) => dependencies.render({ ...input, project: await materializeBatchCreativeAssets(input.project, runtime, dependencies) });
  const completed = (project: EditProject): BatchAutoEditResult => ({ status: "completed", jobId: request.jobId, sourceName: basename(request.sourcePath),
    projectPath: paths.projectPath, outputPath: paths.outputPath, receiptPath: paths.receiptPath, sourceSha256,
    editorialFingerprint: resume!.execution.editorialFingerprint, warnings, project });
  await mkdir(paths.directory, { recursive: true });
  try {
    runtime.signal?.throwIfAborted(); report("prepare"); runtime.signal?.throwIfAborted();
    sourceSha256 = await dependencies.hashFile(request.sourcePath);
    runtime.signal?.throwIfAborted();
    resume = await openBatchAutoEditResumeV1(request, paths, sourceSha256, receiptBase(request, paths, startedAt), writeJsonAtomic);
    warnings.push(...resume.warnings); resume.warnings = warnings;
    if (resume.project) {
      report("render");
      await renderBatchAutoEditResumeV1(resume, render, renderOptions, verifySource);
      report("completed"); return completed(resume.project);
    }
    await resume.save("RUNNING"); report("analyze"); runtime.signal?.throwIfAborted();
    const probe = await dependencies.inspect(request.sourcePath, runtime.ffprobePath);
    runtime.signal?.throwIfAborted();
    if (!probe.hasVideo || probe.duration <= 0) throw new Error("批量自動剪輯只接受可解碼的影片檔");
    let { project, clip } = createBatchSourceProject({
      sourcePath: request.sourcePath,
      jobId: request.jobId,
      sessionId: request.sessionId,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      displayAspectRatio: probe.displayAspectRatio,
      sourceSha256,
      now: startedAt,
      editorialProfile: request.editorialProfile,
    });
    if (project.editorialProfile === "podcast_on_camera") {
      warnings.push("批次已套用露臉 Podcast 的節奏、字幕、調色與音樂；雙人自動導播仍需開啟成片後框選主持人與來賓，避免未確認身分就錯切人物。");
    }

    let transcript: Awaited<ReturnType<typeof transcribeAutomaticCaptions>> | undefined;
    let speechFilter: { dropped: number; usable: boolean } | undefined;
    // No audio, or recognition finished without usable speech: choose footage by picture steadiness.
    let noSpeech = !probe.hasAudio;
    if (probe.hasAudio && request.analysisMode !== "smart_cut") {
      try {
        const heard = await dependencies.transcribe({
          sourcePath: request.sourcePath,
          sourceStart: 0,
          duration: probe.duration,
          sourceSha256,
          language: request.language ?? "auto",
        }, {
          ffmpegPath: runtime.ffmpegPath,
          whisperCliPath: runtime.whisperCliPath,
          modelRoot: runtime.modelRoot,
          modelPath: runtime.modelPath,
          cacheRoot: runtime.cacheRoot,
        });
        // Ambient-only footage comes back as sound descriptions and outro boilerplate, not as nothing.
        const speech = assessTranscriptSpeech(heard.cues, probe.duration);
        speechFilter = { dropped: speech.discarded.length, usable: speech.usable };
        if (speech.usable) transcript = { ...heard, cues: speech.speechCues };
        else noSpeech = true;
      } catch (error) {
        runtime.signal?.throwIfAborted();
        if (isNoSpeechTranscriptError(error)) noSpeech = true;
        else warnings.push(`語意轉錄失敗，已改用去停頓保守模式：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (noSpeech) warnings.push(probe.hasAudio ? "沒有偵測到可用語音，改用畫面穩定度選段並略過字幕" : "來源沒有音軌，改用畫面穩定度選段並略過字幕");
    // The batch has no format choice: a horizontal source is long-form (keep every spoken word, cut only
    // pauses); vertical/square sources are Shorts (condense speech; no-speech Shorts target 8–30 s).
    const shortForm = project.width <= project.height;
    const scenesFor = async () => {
      runtime.signal?.throwIfAborted();
      const result = await dependencies.detectScenes({
      sourcePath: request.sourcePath,
      sourceStart: 0,
      duration: probe.duration,
      fps: project.fps,
      sourceSha256,
      }, { ffmpegPath: runtime.ffmpegPath, cacheRoot: runtime.cacheRoot });
      runtime.signal?.throwIfAborted(); return result;
    };

    if (transcript?.cues.some((cue) => cue.text.trim())) {
      const { buildNativeAutopilotCommand, planNativeAutopilotCreative } = await import("./nativeAutopilot");
      const scenes = await scenesFor();
      const plan = shortForm
        ? planSemanticAutoEdit({ duration: clip.duration, fps: project.fps, cues: transcript.cues, cuts: scenes.cuts, targetRatio: request.targetRatio ?? 0.65 })
        : planNarrationPauseTrim({ duration: clip.duration, fps: project.fps, cues: transcript.cues, audioKeepRanges: await batchAudioKeepRanges(request, probe.duration, project.fps, sourceSha256, runtime, dependencies) });
      const creative = planNativeAutopilotCreative({ duration: clip.duration, width: probe.width ?? project.width, height: probe.height ?? project.height, cues: transcript.cues, cuts: scenes.cuts, video: true, profile: project.editorialProfile });
      const built = buildNativeAutopilotCommand({ project, clip, transcript, semantic: plan, creative, speechFilter, idFactory: (kind, index) => `batch-${kind}-${request.jobId}-${index}` });
      project = applyCommand(project, built.command);
    } else if (noSpeech) {
      const { buildNativeAutopilotCommand, planNativeAutopilotCreative } = await import("./nativeAutopilot");
      const scenes = await scenesFor();
      const minSceneDuration = Math.min(VISUAL_ACTIVITY_DETECTION.minSceneDuration, probe.duration / 2);
      const activity = minSceneDuration < 1 / project.fps ? undefined : await dependencies.detectScenes({
        sourcePath: request.sourcePath, sourceStart: 0, duration: probe.duration, fps: project.fps, sourceSha256,
        threshold: VISUAL_ACTIVITY_DETECTION.threshold, minSceneDuration,
      }, { ffmpegPath: runtime.ffmpegPath, cacheRoot: runtime.cacheRoot }).then((result) => result.cuts.map(({ time, score }) => ({ time, score })), () => undefined);
      const plan = planVisualQualityAutoEdit({ duration: clip.duration, fps: project.fps, cuts: scenes.cuts, activity, targetDuration: visualHighlightTargetSeconds(clip.duration, shortForm) });
      const creative = planNativeAutopilotCreative({ duration: clip.duration, width: probe.width ?? project.width, height: probe.height ?? project.height, cues: [], cuts: scenes.cuts, video: true, profile: project.editorialProfile });
      const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues: [] }, semantic: plan, creative, speechFilter, idFactory: (kind, index) => `batch-${kind}-${request.jobId}-${index}` });
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
    runtime.signal?.throwIfAborted();
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
    resume.execution.editorialFingerprint = editorialFingerprint; resume.execution.musicId = selectedMusicId;
    report("apply"); runtime.signal?.throwIfAborted();
    // This is one non-abortable commit: the canonical writer and origin receipt finish together.
    const saved = await commitBatchAutoEditProjectV1(resume, project, dependencies.writeProject);
    report("render");
    await renderBatchAutoEditResumeV1(resume, render, renderOptions, verifySource);
    report("completed"); return completed(saved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resume && resume.execution.phase !== "completed") await resume.save(runtime.signal?.aborted ? "CANCELLED" : "FAILED", message);
    else if (!resume && !await lstat(paths.receiptPath).catch(inspectError => { if (inspectError.code === "ENOENT") return undefined; throw inspectError; })) await writeJsonAtomic(paths.receiptPath, {
      ...receiptBase(request, paths, startedAt),
      status: "FAILED",
      sourceSha256,
      warnings,
      error: message,
      failedAt: dependencies.now().toISOString(),
    });
    report("failed");
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
