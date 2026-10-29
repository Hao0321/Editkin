import { residentMuxFrameLimitArgsV3 } from "./residentStreamPlanV3";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import type { SelectedNativeVideoRuntimeIdentity } from "../application/selectedNativeVideoRuntime";
import type { RenderPlan } from "./planner";
import type { GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { renderResidentSceneLinearVideoSequence, type ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";
import { publishRenderOutput, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";
import { FFMPEG_PROGRESS_ARGS, type ProcessProgressWatch } from "./mediaProcess";
import { createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import { assertRenderDiskSpace, estimateAudioBedBytes, estimateEncodedOutputBytes, estimatePngSequenceBytes, exportDiskRequirements, planShape } from "./renderDiskSpace";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";
import { LongRenderRefusalV1, type LongRenderRunContextV1, type LongResidentStreamProviderV1 } from "./longRenderContractsV1";

export interface ResidentProjectOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  gpuCompositorPath?: string;
  selectedNativeVideoRuntime?: SelectedNativeVideoRuntimeIdentity;
  fontRoot?: string;
  pluginRoots?: string[];
  signal?: AbortSignal;
  /** SHORT/default callers retain the original PNG-sequence route; the LONG router selects 2, or 3 (WP-B provider). */
  residentStreamVersion?: 2 | 3;
  /** LONG only: the run context (guard V2, journal, identity plan) and the registered WP-B resident stream v3. */
  longRun?: LongRenderRunContextV1;
  residentStreamV3?: LongResidentStreamProviderV1;
}

interface ResidentProjectProbe {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorMatrix?: string;
}

export interface ResidentProjectDependencies<TEncoder extends string> {
  runProcess: (executable: string, args: string[], timeoutMs: number, capture?: { completeStdoutMaxChars: number }, watch?: ProcessProgressWatch) => Promise<{ stdout: string; stderr: string }>;
  renderAudioBed: (project: EditProject, plan: RenderPlan, outputPath: string, ffmpegPath: string, timeoutMs: number) => Promise<void>;
  probeMedia: (path: string, ffprobePath?: string) => Promise<ResidentProjectProbe>;
  encoderArgs: (encoder: TEncoder) => string[];
  finite: (value: number) => string;
}

export interface ResidentSceneLinearVideoProjectResult<TEncoder extends string> {
  residentStreamV3Pipeline?: import("./residentSceneLinearVideoStreamV3").ResidentStreamPipelineV3;
  outputPath: string;
  duration: number;
  encoder: TEncoder;
  planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1" | "editkin-resident-video-scene-linear-aces2-formal-stream/v2"
    | "editkin-resident-video-scene-linear-aces2-formal-stream/v3";
  residentStreamPipeline?: { schema: "editkin.resident-png-stream/v2"; consumedFrames: number; totalPngBytes: number; peakFrameBytes: number; maximumPendingFrames: number; retainedConsumedFrames: number; peakWorkBytes: number; stagingLimitBytes: number; intervalMs: number; writtenByteInterval: number; encoderWrites: number; encoderInputBytes: number; encoderClosed: boolean };
  ffmpegVersion: string;
  residentVideoPipeline: ResidentSceneLinearVideoSequenceReceipt;
}

export function residentVideoCoversFormalDuration(project: EditProject, frameCount: number): boolean {
  const ranges = project.tracks.filter((track) => track.kind === "video" && !track.hidden)
    .flatMap((track) => track.clips)
    .filter((clip) => (clip.layer?.enabled ?? true) && (clip.layer?.role ?? "content") === "content")
    .map((clip) => ({ start: Math.round(clip.timelineStart * project.fps), end: Math.round((clip.timelineStart + clip.duration) * project.fps) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let coveredUntil = 0;
  for (const range of ranges) {
    if (range.start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= frameCount) return true;
  }
  return false;
}

export async function renderResidentSceneLinearAces2VideoProject<TEncoder extends string>(
  project: EditProject,
  preview: GpuEngineVideoPreviewGraph,
  outputPath: string,
  plan: RenderPlan,
  options: ResidentProjectOptions,
  encoder: TEncoder,
  timeoutMs: number,
  dependencies: ResidentProjectDependencies<TEncoder>,
): Promise<ResidentSceneLinearVideoProjectResult<TEncoder>> {
  assertProofStillRouteV1(project, "resident-scene-linear-video");
  if (!options.gpuCompositorPath) throw new Error("Scene-linear resident video 正式輸出缺少原生 GPU compositor runtime。");
  const { runProcess, renderAudioBed, probeMedia, encoderArgs, finite } = dependencies;
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const frameCount = Math.round(plan.duration * project.fps);
  if (preview.graph.nodes.some(node => node.kind === "native_motion_paint")
    && (project.colorManagement?.mode !== "aces2" || project.colorManagement.outputTransform !== "rec709_sdr")) {
    throw new Error("Native paint resident 正式輸出必須保留專案明確 ACES2 rec709_sdr output contract。");
  }
  if (!residentVideoCoversFormalDuration(project, frameCount)) throw new Error("Scene-linear resident video 正式輸出目前不接受畫面空檔；請補齊底層影像或使用相容輸出路徑。");
  if (options.residentStreamVersion === 3) {
    if (!options.residentStreamV3 || !options.longRun) {
      throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "resident stream v3 (WP-B) is not available in this build", { route: "resident-stream-v3" });
    }
    return options.residentStreamV3(project, preview, outputPath, plan, options, encoder, timeoutMs, dependencies, options.longRun);
  }
  if (options.residentStreamVersion === 2) {
    const { renderResidentSceneLinearVideoStreamV2 } = await import("./residentSceneLinearVideoStreamV2");
    return renderResidentSceneLinearVideoStreamV2(project, preview, outputPath, plan, options, encoder, timeoutMs, dependencies);
  }
  const requested = resolve(outputPath);
  const shape = planShape(plan);
  await assertRenderDiskSpace(exportDiskRequirements(requested, estimateEncodedOutputBytes(shape, encoder),
    estimatePngSequenceBytes(shape, "rgba8") + estimateAudioBedBytes(plan.duration)));
  await mkdir(dirname(requested), { recursive: true });
  const workspace = await createRenderWorkDirectory("editkin-resident-aces2-video-");
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.resident-aces2-rendering.mp4`);
  try {
    const sequencePath = join(workspace, "display-sequence");
    const audioPath = join(workspace, "audio.m4a");
    const receipt = await renderResidentSceneLinearVideoSequence({
      executable: options.gpuCompositorPath, graph: preview.graph, assetBindings: preview.assetBindings,
      selectedNativeVideoRuntime: options.selectedNativeVideoRuntime,
      startFrame: 0, frameCount, outputDirectory: sequencePath, timeoutMs: renderStageTimeout(timeoutMs), fontRoot: options.fontRoot, pluginRoots: options.pluginRoots,
      signal: renderLifetimeSignal() ?? options.signal,
    });
    await renderAudioBed(project, plan, audioPath, ffmpegPath, timeoutMs);
    await runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", finite(project.fps), "-start_number", "0", "-i", join(sequencePath, "frame-%08d.png"),
      "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", ...residentMuxFrameLimitArgsV3(plan.duration, project.fps, frameCount),
      ...encoderArgs(encoder), "-pix_fmt", "yuv420p",
      "-color_primaries:v", "bt709", "-colorspace:v", "bt709", "-color_trc:v", "bt709",
      "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-c:a", "copy", "-t", finite(plan.duration), "-video_track_timescale", "90000", "-movflags", "+faststart", ...FFMPEG_PROGRESS_ARGS, temporaryOutput,
    ], timeoutMs, undefined, { ffmpegProgress: true, paths: [temporaryOutput] });
    const outputProbe = await probeMedia(temporaryOutput, ffprobePath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio || outputProbe.colorPrimaries !== "bt709"
      || outputProbe.colorTransfer !== "bt709" || outputProbe.colorMatrix !== "bt709"
      || Math.abs(outputProbe.duration - plan.duration) > Math.max(.15, 2 / project.fps)) {
      throw new Error(`Resident ACES2 正式輸出 QA 失敗：duration=${outputProbe.duration}, primaries=${outputProbe.colorPrimaries ?? "unknown"}, transfer=${outputProbe.colorTransfer ?? "unknown"}, matrix=${outputProbe.colorMatrix ?? "unknown"}`);
    }
    await publishRenderOutput(temporaryOutput, requested);
    const version = await runProcess(ffmpegPath, ["-version"], 10_000);
    return {
      outputPath: requested, duration: outputProbe.duration, encoder,
      planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
      ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown", residentVideoPipeline: receipt,
    };
  } finally {
    await rm(temporaryOutput, { force: true });
    await removeRenderWorkDirectory(workspace);
  }
}
