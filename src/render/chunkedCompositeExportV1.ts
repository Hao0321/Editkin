import { createHash } from "node:crypto";
import { boundedFrameQueueV1 } from "./boundedFrameQueueV1";
import { startContinuousEncoderV1 } from "./continuousEncoderV1";
import { prepareGlobalAudioPassV1, writeGlobalAudioPassV1 } from "./globalAudioPassV1";
import { planLongCompositeChunksV1 } from "./longChunkPlannerV1";
import { createLongSubProjectIndexV1 } from "./longSubProjectV1";
import { renderLongChunkRawV1 } from "./longCompositeChunkV2";
import { LongRenderRefusalV1, type LongRouteDispatchV1 } from "./longRenderContractsV1";
import { reportRenderStage } from "./renderProgress";
import { runProcess } from "./ffmpegMedia";
import type { RenderResult } from "./ffmpegTypes";

export interface ChunkedCompositeReceiptV1 {
  schema: "editkin.chunked-composite/v1";
  chunks: number; frames: number; frameBytes: number; frameQueueLimit: number; queueCapacity: number; peakQueuedFrames: number;
  rawVideoSha256: string; finalEncoderInstances: 1; videoIntermediateBytes: 0;
  audio: Awaited<ReturnType<typeof writeGlobalAudioPassV1>>;
  encoder: { pid: number | undefined; closed: boolean; videoFrames: number; audioBytes: number; maximumPendingVideoWrites: number; maximumPendingAudioWrites: number };
}

/** C5/C6/C7: only over-budget LONG composite dispatch; SHORT and under-budget graphs do not enter here. */
export async function chunkedCompositeExportV1(input: LongRouteDispatchV1): Promise<RenderResult> {
  if (input.run.identity.container !== "mp4" || input.run.identity.pixelFormat.startsWith("yuva") || input.run.policy.maxOwnedChildren < 3) {
    throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "bounded composite output needs a non-alpha MP4 route and three producer/encoder child slots");
  }
  const schedule = planLongCompositeChunksV1(input.project, input.run.policy), subProject = createLongSubProjectIndexV1(input.project);
  if (schedule.totalFrames !== input.run.identity.expectedFrames) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "chunk clock differs from the parent output identity");
  const ffmpegPath = input.options.ffmpegPath ?? "ffmpeg", ffprobePath = input.options.ffprobePath ?? "ffprobe";
  const audio = await prepareGlobalAudioPassV1(input.project, input.plan, ffprobePath, input.timeoutMs);
  const version = (await runProcess(ffmpegPath, ["-version"], input.timeoutMs, { completeStdoutMaxChars: 64 * 1024 })).stdout.split(/\r?\n/)[0];
  const outputTransform = input.project.colorManagement?.mode === "aces2" ? input.project.colorManagement.outputTransform : "rec709_sdr";
  const encoder = startContinuousEncoderV1({ ffmpegPath, outputPath: input.outputPath, identity: input.run.identity, frameBytes: schedule.frameBytes,
    outputTransform, audio, signal: input.run.signal, timeoutMs: input.timeoutMs, stallMs: input.options.stallTimeoutMs, guard: input.run.guard });
  // Reserve one raw assembler frame and one active encoder frame inside the declared frame queue limit.
  const queue = schedule.queueDepth > 1 ? boundedFrameQueueV1<Uint8Array>(schedule.queueDepth - 2) : undefined;
  const digest = createHash("sha256"); let frames = 0;
  const globalContext = { workingPrecision16: Boolean(input.plan.pairTransitions?.length),
    floatingBackdrop: input.plan.videoLayers.some(layer => layer.segments.some(segment => segment.kind === "clip" && Boolean(segment.clip.floatingFrame))) };
  reportRenderStage("frames", input.plan.duration);
  const videoProducer = (async () => {
    for (const chunk of schedule.chunks) {
      encoder.signal.throwIfAborted(); await input.run.guard.check("before-composite-chunk");
      const part = subProject(chunk);
      const result = await renderLongChunkRawV1({ ...part, options: { ...input.options, workRoot: input.run.runDirectory }, timeoutMs: input.timeoutMs,
        context: globalContext, sink: { signal: encoder.signal, async onFrame(frame) {
          encoder.signal.throwIfAborted(); digest.update(frame); frames++;
          if (queue) await queue.push(frame); else await encoder.writeVideo(frame);
        } } });
      if (result.frameCount !== chunk.frameCount) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "one composite chunk returned an incorrect frame count");
    }
    if (frames !== schedule.totalFrames) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "composite schedule ended before the expected final frame");
    if (queue) queue.end(); else encoder.endVideo();
  })();
  const videoWriter = queue ? (async () => {
    for (;;) { const frame = await queue.shift(); if (frame === undefined) break; await encoder.writeVideo(frame); }
    encoder.endVideo();
  })() : Promise.resolve();
  const audioProducer = (async () => {
    const receipt = await writeGlobalAudioPassV1(audio, { samples: input.run.identity.audio.expectedSamples, ffmpegPath, timeoutMs: input.timeoutMs,
      signal: encoder.signal, write: bytes => encoder.writeAudio(bytes) });
    encoder.endAudio(); return receipt;
  })();
  const abortQueue = () => queue?.fail(encoder.signal.reason);
  encoder.signal.addEventListener("abort", abortQueue, { once: true });
  if (encoder.signal.aborted) abortQueue();
  try {
    const [, , audioReceipt] = await Promise.all([videoProducer, videoWriter, audioProducer]);
    const encoded = await encoder.finish(); await input.run.guard.check("after-composite-encoder");
    const receipt: ChunkedCompositeReceiptV1 = { schema: "editkin.chunked-composite/v1", chunks: schedule.chunks.length, frames,
      frameBytes: schedule.frameBytes, frameQueueLimit: schedule.queueDepth, queueCapacity: queue?.receipt.capacity ?? 0,
      peakQueuedFrames: queue?.receipt.peakQueuedFrames ?? 0, rawVideoSha256: digest.digest("hex"),
      finalEncoderInstances: 1, videoIntermediateBytes: 0, audio: audioReceipt,
      encoder: { pid: encoded.pid, closed: encoded.closed, videoFrames: encoded.writes, audioBytes: encoded.audioBytes,
        maximumPendingVideoWrites: encoded.maximumPendingVideoWrites, maximumPendingAudioWrites: encoded.maximumPendingAudioWrites } };
    return { outputPath: input.outputPath, duration: input.plan.duration, encoder: input.encoder, planner: "editkin-bounded-composite/v1",
      ffmpegVersion: version, chunkedCompositePipeline: receipt };
  } catch (error) {
    queue?.fail(error);
    try { await encoder.stop(error); } finally { await Promise.allSettled([videoProducer, videoWriter, audioProducer]); }
    throw error;
  } finally { encoder.signal.removeEventListener("abort", abortQueue); }
}
