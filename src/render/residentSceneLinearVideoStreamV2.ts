import { residentMuxFrameLimitArgsV3 } from "./residentStreamPlanV3";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import type { GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import type { ResidentProjectDependencies, ResidentProjectOptions, ResidentSceneLinearVideoProjectResult } from "./residentSceneLinearVideoProject";
import { renderResidentSceneLinearVideoSequence } from "./residentSceneLinearVideoSequence";
import { startStreamEncoderV1 } from "./streamEncoderV1";
import { assertOwnedStreamWorkspaceV1, createBoundedPngFrameSinkV1 } from "./boundedPngFrameSinkV1";
import { createRenderVolumeWatchV1, LONG_RENDER_STAGING_LIMIT_V1 } from "./renderVolumeWatchV1";
import { currentRenderWorkRoot, createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import { estimateEncodedOutputBytes, planShape } from "./renderDiskSpace";
import { publishRenderOutput, renderLifetimeAbort, renderLifetimeSignal, renderLifetimeStallMs, renderStageTimeout, withRenderLifetime } from "./renderLifetime";
import { reportRenderStage, renderProgressTimeReporter } from "./renderProgress";
import { FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { buildStreamAudioMixV1 } from "./streamAudioMixV1";

/** Experimental version2: same resident SDR pixels and encoder policy, one transient PNG at a time.
 * This bounds intermediate frames; direct GPU encode/HDR/copy and 12h performance remain separate work. */
export async function renderResidentSceneLinearVideoStreamV2<TEncoder extends string>(project: EditProject,
  preview: GpuEngineVideoPreviewGraph, outputPath: string, plan: RenderPlan, options: ResidentProjectOptions,
  encoder: TEncoder, timeoutMs: number, dependencies: ResidentProjectDependencies<TEncoder>): Promise<ResidentSceneLinearVideoProjectResult<TEncoder>> {
  return withRenderLifetime({ signal: options.signal, timeoutMs }, async () => {
    const requested = resolve(outputPath), frameCount = Math.round(plan.duration * project.fps);
    if (!options.gpuCompositorPath || !Number.isSafeInteger(frameCount) || frameCount < 1) throw Error("RESIDENT_STREAM_REQUEST_INVALID");
    const root = currentRenderWorkRoot(); if (!root || resolve(root) === resolve(tmpdir())) throw Error("RESIDENT_STREAM_DEDICATED_WORK_ROOT_REQUIRED");
    const rate = preview.graph.timebase;
    if (!Number.isSafeInteger(rate.numerator) || !Number.isSafeInteger(rate.denominator) || rate.numerator <= 0 || rate.denominator <= 0) throw Error("RESIDENT_STREAM_RATE_INVALID");
    const maxFrameBytes = 256 * 1024 ** 2, maxAudioGraphBytes = 16 * 1024 ** 2;
    await mkdir(dirname(requested), { recursive: true });
    const workspace = await createRenderWorkDirectory("editkin-resident-aces2-video-");
    const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${randomUUID()}.resident-stream.mp4`);
    let encoderProcess: ReturnType<typeof startStreamEncoderV1> | undefined;
    const abort = renderLifetimeAbort()!, signal = renderLifetimeSignal()!;
    const monitor = createRenderVolumeWatchV1({ workRoot: workspace, stagingLimitBytes: LONG_RENDER_STAGING_LIMIT_V1,
      requirements: [{ path: requested, reserveBytes: 1024 ** 3, initialBytes: estimateEncodedOutputBytes(planShape(plan), encoder) },
        { path: workspace, reserveBytes: 1024 ** 3, initialBytes: maxAudioGraphBytes + maxFrameBytes },
        { path: process.env.SystemRoot ?? tmpdir(), reserveBytes: 2 * 1024 ** 3, initialBytes: 0 }],
      onFailure: abort });
    try {
      await assertOwnedStreamWorkspaceV1(workspace); await monitor.check(); monitor.start();
      const audioGraphPath = join(workspace, "audio-filter.txt"), sequencePath = join(workspace, "display-sequence");
      const ffmpegPath = options.ffmpegPath ?? "ffmpeg", ffprobePath = options.ffprobePath ?? "ffprobe";
      reportRenderStage("audio", plan.duration);
      const audio = await buildStreamAudioMixV1(project, plan, { inputOffset: 1, ffprobePath, signal });
      await writeFile(audioGraphPath, audio.filterComplex, { flag: "wx" });
      await monitor.check();
      try { await lstat(temporaryOutput); throw Error("RESIDENT_STREAM_OUTPUT_ALREADY_EXISTS"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      reportRenderStage("encode", plan.duration); const progress = renderProgressTimeReporter();
      encoderProcess = startStreamEncoderV1({ executable: ffmpegPath, signal, timeoutMs,
        stallMs: renderLifetimeStallMs() ?? 10 * 60_000, maximumWriteBytes: maxFrameBytes, expectedWrites: frameCount,
        activityPaths: [temporaryOutput],
        args: ["-n", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-thread_queue_size", "1", "-probesize", "32",
          "-analyzeduration", "1", "-fpsprobesize", "0", "-threads:v", "1", "-framerate", `${rate.denominator}/${rate.numerator}`,
          "-c:v", "png", "-i", "pipe:0", ...audio.inputArgs, "-filter_complex_script", audioGraphPath,
          "-map", "0:v:0", "-map", audio.outputLabel, ...residentMuxFrameLimitArgsV3(plan.duration, project.fps, frameCount),
          ...dependencies.encoderArgs(encoder), "-pix_fmt", "yuv420p", "-color_primaries:v", "bt709", "-colorspace:v", "bt709", "-color_trc:v", "bt709",
          "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1", ...audio.codecArgs, "-t", dependencies.finite(plan.duration),
          "-video_track_timescale", "90000", "-movflags", "+faststart", ...FFMPEG_PROGRESS_ARGS, temporaryOutput],
        onProgress: (seconds, bytes) => { if (seconds >= 0) progress?.(seconds); if (bytes >= 0) monitor.observeOutputBytes(bytes); } });
      void encoderProcess.completion.catch(abort);
      const sink = createBoundedPngFrameSinkV1({ workspace, directory: sequencePath, width: project.width, height: project.height,
        startFrame: 0, frameCount, maximumFrameBytes: maxFrameBytes, signal, write: bytes => encoderProcess!.write(bytes) });
      const receipt = await renderResidentSceneLinearVideoSequence({ executable: options.gpuCompositorPath, graph: preview.graph,
        assetBindings: preview.assetBindings, selectedNativeVideoRuntime: options.selectedNativeVideoRuntime, startFrame: 0, frameCount,
        outputDirectory: sequencePath, timeoutMs: renderStageTimeout(timeoutMs), fontRoot: options.fontRoot, pluginRoots: options.pluginRoots,
        signal, frameSink: async (path, frame) => { await monitor.check(); await sink.consume(path, frame); } });
      sink.assertComplete(); await encoderProcess.finish(); await monitor.check();
      reportRenderStage("verify"); const probe = await dependencies.probeMedia(temporaryOutput, ffprobePath);
      if (!probe.hasVideo || !probe.hasAudio || probe.colorPrimaries !== "bt709" || probe.colorTransfer !== "bt709"
        || probe.colorMatrix !== "bt709" || Math.abs(probe.duration - plan.duration) > Math.max(.15, 2 / project.fps)) throw Error("RESIDENT_STREAM_OUTPUT_QA_FAILED");
      await publishRenderOutput(temporaryOutput, requested);
      const version = await dependencies.runProcess(ffmpegPath, ["-version"], 10_000);
      return { outputPath: requested, duration: probe.duration, encoder, planner: "editkin-resident-video-scene-linear-aces2-formal-stream/v2",
        ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown", residentVideoPipeline: receipt,
        residentStreamPipeline: { schema: "editkin.resident-png-stream/v2", ...sink.receipt, ...monitor.receipt,
          encoderWrites: encoderProcess.receipt.writes, encoderInputBytes: encoderProcess.receipt.inputBytes, encoderClosed: encoderProcess.closed } };
    } finally {
      await monitor.stop();
      if (encoderProcess && !encoderProcess.closed) await encoderProcess.stop(Error("RESIDENT_STREAM_PRODUCER_ENDED"));
      await rm(temporaryOutput, { force: true }); await removeRenderWorkDirectory(workspace);
    }
  });
}
