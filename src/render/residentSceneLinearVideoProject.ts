import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import type { GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { renderResidentSceneLinearVideoSequence, type ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";

interface ResidentProjectOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  gpuCompositorPath?: string;
  fontRoot?: string;
  pluginRoots?: string[];
}

interface ResidentProjectProbe {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorMatrix?: string;
}

interface ResidentProjectDependencies<TEncoder extends string> {
  runProcess: (executable: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
  renderAudioBed: (project: EditProject, plan: RenderPlan, outputPath: string, ffmpegPath: string, timeoutMs: number) => Promise<void>;
  probeMedia: (path: string, ffprobePath?: string) => Promise<ResidentProjectProbe>;
  encoderArgs: (encoder: TEncoder) => string[];
  finite: (value: number) => string;
}

export interface ResidentSceneLinearVideoProjectResult<TEncoder extends string> {
  outputPath: string;
  duration: number;
  encoder: TEncoder;
  planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1";
  ffmpegVersion: string;
  residentVideoPipeline: ResidentSceneLinearVideoSequenceReceipt;
}

export function residentVideoCoversFormalDuration(project: EditProject, frameCount: number): boolean {
  const ranges = project.tracks.filter((track) => track.kind === "video" && !track.muted)
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
  if (!options.gpuCompositorPath) throw new Error("Scene-linear resident video 正式輸出缺少原生 GPU compositor runtime。");
  const { runProcess, renderAudioBed, probeMedia, encoderArgs, finite } = dependencies;
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const frameCount = Math.round(plan.duration * project.fps);
  if (!residentVideoCoversFormalDuration(project, frameCount)) throw new Error("Scene-linear resident video 正式輸出目前不接受畫面空檔；請補齊底層影像或使用相容輸出路徑。");
  const workspace = await mkdtemp(join(tmpdir(), "editkin-resident-aces2-video-"));
  const requested = resolve(outputPath);
  await mkdir(dirname(requested), { recursive: true });
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.resident-aces2-rendering.mp4`);
  try {
    const sequencePath = join(workspace, "display-sequence");
    const audioPath = join(workspace, "audio.m4a");
    const receipt = await renderResidentSceneLinearVideoSequence({
      executable: options.gpuCompositorPath, graph: preview.graph, assetBindings: preview.assetBindings,
      startFrame: 0, frameCount, outputDirectory: sequencePath, timeoutMs, fontRoot: options.fontRoot, pluginRoots: options.pluginRoots,
    });
    await renderAudioBed(project, plan, audioPath, ffmpegPath, timeoutMs);
    await runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", finite(project.fps), "-start_number", "0", "-i", join(sequencePath, "frame-%08d.png"),
      "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-frames:v", String(frameCount),
      ...encoderArgs(encoder), "-pix_fmt", "yuv420p",
      "-color_primaries:v", "bt709", "-colorspace:v", "bt709", "-color_trc:v", "bt709",
      "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-c:a", "copy", "-t", finite(plan.duration), "-video_track_timescale", "90000", "-movflags", "+faststart", temporaryOutput,
    ], timeoutMs);
    const outputProbe = await probeMedia(temporaryOutput, ffprobePath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio || outputProbe.colorPrimaries !== "bt709"
      || outputProbe.colorTransfer !== "bt709" || outputProbe.colorMatrix !== "bt709"
      || Math.abs(outputProbe.duration - plan.duration) > Math.max(.15, 2 / project.fps)) {
      throw new Error(`Resident ACES2 正式輸出 QA 失敗：duration=${outputProbe.duration}, primaries=${outputProbe.colorPrimaries ?? "unknown"}, transfer=${outputProbe.colorTransfer ?? "unknown"}, matrix=${outputProbe.colorMatrix ?? "unknown"}`);
    }
    await rm(requested, { force: true });
    await rename(temporaryOutput, requested);
    const version = await runProcess(ffmpegPath, ["-version"], 10_000);
    return {
      outputPath: requested, duration: outputProbe.duration, encoder,
      planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1",
      ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown", residentVideoPipeline: receipt,
    };
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}
