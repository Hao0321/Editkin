import { join, resolve } from "node:path";
import { boundedFrameQueueV1 } from "./boundedFrameQueueV1";
import { createBoundedPngFrameSinkV1, assertOwnedStreamWorkspaceV1 } from "./boundedPngFrameSinkV1";
import { startContinuousEncoderV1 } from "./continuousEncoderV1";
import { prepareGlobalAudioPassV1, writeGlobalAudioPassV1 } from "./globalAudioPassV1";
import { renderResidentSceneLinearVideoSequence } from "./residentSceneLinearVideoSequence";
import { residentStreamPlanV3 } from "./residentStreamPlanV3";
import { createRenderWorkDirectory, removeRenderWorkDirectory, runWithRenderWorkRootV1 } from "./renderWorkspace";
import { reportRenderStage } from "./renderProgress";
import { renderStageTimeout } from "./renderLifetime";
import { LongRenderRefusalV1, type LongResidentStreamProviderV1 } from "./longRenderContractsV1";

export interface ResidentStreamPipelineV3 {
  schema: "editkin.resident-png-stream/v3";
  consumedFrames: number; totalPngBytes: number; peakFrameBytes: number; retainedConsumedFrames: 0; maximumPendingDiskFrames: 1;
  frameQueueLimit: number; queueCapacity: number; peakQueuedFrames: number; maximumRetainedPngBytes: number;
  encoderWrites: number; encoderClosed: boolean; finalEncoderInstances: 1;
  audio: Awaited<ReturnType<typeof writeGlobalAudioPassV1>>;
}

/** Same native resident renderer and display PNGs as V2; one global PCM clock and one continuous final encoder. */
export const renderResidentSceneLinearVideoStreamV3: LongResidentStreamProviderV1 = async (
  project, preview, outputPath, plan, options, encoderName, timeoutMs, dependencies, run,
) => {
  if (!options.gpuCompositorPath || resolve(outputPath) !== resolve(run.partPath) || encoderName !== run.identity.encoder) {
    throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "resident V3 needs the parent's owned part and native renderer identity");
  }
  const schedule = residentStreamPlanV3(project, plan, run.identity, run.policy), rate = preview.graph.timebase;
  if (rate.denominator !== run.identity.frameRate.numerator || rate.numerator !== run.identity.frameRate.denominator) {
    throw new LongRenderRefusalV1("LONG_RENDER_CLOCK_RANGE", "native resident and encoder clocks differ");
  }
  return runWithRenderWorkRootV1(run.runDirectory, async () => {
    const workspace = await createRenderWorkDirectory("editkin-resident-aces2-video-");
    let encoder: ReturnType<typeof startContinuousEncoderV1> | undefined;
    const queue = schedule.frameQueueLimit > 1 ? boundedFrameQueueV1<Uint8Array>(schedule.queueCapacity) : undefined;
    try {
      await assertOwnedStreamWorkspaceV1(workspace); await run.guard.check("before-resident-v3");
      const ffmpegPath = options.ffmpegPath ?? "ffmpeg", ffprobePath = options.ffprobePath ?? "ffprobe";
      reportRenderStage("audio", plan.duration);
      const audio = await prepareGlobalAudioPassV1(project, plan, ffprobePath, timeoutMs);
      const version = await dependencies.runProcess(ffmpegPath, ["-version"], renderStageTimeout(timeoutMs));
      reportRenderStage("encode", plan.duration);
      encoder = startContinuousEncoderV1({ ffmpegPath, outputPath, identity: run.identity, frameBytes: schedule.maximumPngFrameBytes,
        videoInput: "png", outputTransform: "rec709_sdr", audio, signal: run.signal, timeoutMs, guard: run.guard });
      const codec = encoder, sequencePath = join(workspace, "display-sequence");
      let producedPngBytes = 0;
      const sink = createBoundedPngFrameSinkV1({ workspace, directory: sequencePath, width: project.width, height: project.height,
        startFrame: 0, frameCount: schedule.frameCount, maximumFrameBytes: schedule.maximumPngFrameBytes, signal: codec.signal,
        async write(bytes) {
          producedPngBytes += bytes.byteLength; run.guard.observeWrittenBytes("resident-v3-png", producedPngBytes);
          if (queue) await queue.push(bytes); else await codec.writeVideo(bytes);
        } });
      const abortQueue = () => queue?.fail(codec.signal.reason);
      codec.signal.addEventListener("abort", abortQueue, { once: true }); if (codec.signal.aborted) abortQueue();
      const videoProducer = (async () => {
        const receipt = await renderResidentSceneLinearVideoSequence({ executable: options.gpuCompositorPath!, graph: preview.graph,
          assetBindings: preview.assetBindings, selectedNativeVideoRuntime: options.selectedNativeVideoRuntime, startFrame: 0,
          frameCount: schedule.frameCount, outputDirectory: sequencePath, timeoutMs: renderStageTimeout(timeoutMs),
          fontRoot: options.fontRoot, pluginRoots: options.pluginRoots, signal: codec.signal, frameSink: sink.consume });
        sink.assertComplete(); if (queue) queue.end(); else codec.endVideo(); return receipt;
      })();
      const videoWriter = queue ? (async () => {
        for (;;) { const frame = await queue.shift(); if (frame === undefined) break; await codec.writeVideo(frame); }
        codec.endVideo();
      })() : Promise.resolve();
      const audioProducer = (async () => {
        const receipt = await writeGlobalAudioPassV1(audio, { samples: run.identity.audio.expectedSamples, ffmpegPath, timeoutMs,
          signal: codec.signal, write: bytes => codec.writeAudio(bytes) });
        codec.endAudio(); return receipt;
      })();
      try {
        const [native, , audioReceipt] = await Promise.all([videoProducer, videoWriter, audioProducer]);
        const encoded = await codec.finish(); await run.guard.check("after-resident-v3");
        if (native.frameCount !== schedule.frameCount || native.startFrame !== 0 || encoded.writes !== schedule.frameCount) {
          throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "resident V3 frame totals differ from the parent clock");
        }
        const receipt: ResidentStreamPipelineV3 = { schema: "editkin.resident-png-stream/v3", ...sink.receipt, retainedConsumedFrames: 0,
          maximumPendingDiskFrames: 1, frameQueueLimit: schedule.frameQueueLimit, queueCapacity: schedule.queueCapacity,
          peakQueuedFrames: queue?.receipt.peakQueuedFrames ?? 0, maximumRetainedPngBytes: schedule.maximumRetainedPngBytes,
          encoderWrites: encoded.writes, encoderClosed: encoded.closed, finalEncoderInstances: 1, audio: audioReceipt };
        return { outputPath, duration: plan.duration, encoder: encoderName, ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown",
          planner: "editkin-resident-video-scene-linear-aces2-formal-stream/v3", residentVideoPipeline: native, residentStreamV3Pipeline: receipt };
      } catch (error) {
        // Every producer settles before the workspace goes, even when stopping the encoder itself fails.
        queue?.fail(error); try { await codec.stop(error); } finally { await Promise.allSettled([videoProducer, videoWriter, audioProducer]); } throw error;
      } finally { codec.signal.removeEventListener("abort", abortQueue); }
    } finally {
      try { if (encoder && !encoder.receipt.closed) await encoder.stop(Error("RESIDENT_V3_PRODUCER_ENDED")); }
      finally { await removeRenderWorkDirectory(workspace); }
    }
  });
};
