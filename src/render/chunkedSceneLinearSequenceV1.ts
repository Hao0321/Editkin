import { createHash } from "node:crypto";
import { rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAces2DisplayVideoRenderRequest } from "./aces2SdrVideo";
import { buildAssFilter, writeAssContent } from "./captionAss";
import { AssMotionBudget } from "./assMotionBudget";
import { resolveAssFontRoot } from "./fontRoot";
import { prepareMotionPhysicalLayouts } from "./motionPhysicalGlyphLayouts";
import { startContinuousEncoderV1 } from "./continuousEncoderV1";
import { prepareGlobalAudioPassV1, writeGlobalAudioPassV1 } from "./globalAudioPassV1";
import { assertSceneLinearChunkReceiptV1, sceneLinearChunkPlanV1, sceneLinearMetadataBytesV1, type SceneLinearChunkReceiptV1 } from "./sceneLinearChunkPlanV1";
import { inspectSceneLinearChunkFilesV1 } from "./sceneLinearChunkFilesV1";
import { createRenderWorkDirectory, removeRenderWorkDirectory, runWithRenderWorkRootV1 } from "./renderWorkspace";
import { withRenderLifetime } from "./renderLifetime";
import { reportRenderStage } from "./renderProgress";
import { runProcess } from "./ffmpegMedia";
import { LongRenderRefusalV1, type LongRouteDispatchV1 } from "./longRenderContractsV1";

export interface ChunkedSceneLinearSequenceReceiptV1 {
  schema: "editkin.chunked-scene-linear/v1"; chunks: number; frames: number; framesPerChunk: number;
  nativeDeviceCreations: number; nativeCallMilliseconds: number; nativeRenderMilliseconds: number; nativeOverheadMilliseconds: number;
  artifactFormat: "rgba8" | "rgba16_unorm"; peakBatchBytes: number; maximumBatchBytes: number; maximumRetainedPngBytes: number;
  metadataBytes: number; maximumMetadataBytes: number;
  consumedPngBytes: number; pngSequenceSha256: string; firstNativeReceipt: SceneLinearChunkReceiptV1; lastNativeReceipt: SceneLinearChunkReceiptV1;
  finalEncoderInstances: 1; videoIntermediateBytes: 0; encoderClosed: boolean; encoderFrames: number;
  audio: Awaited<ReturnType<typeof writeGlobalAudioPassV1>>;
}

/** C4: absolute native frame ranges, bounded PNG batches, one continuous final audio/video encode. */
export async function chunkedSceneLinearSequenceV1(input: LongRouteDispatchV1) {
  if (!input.options.gpuCompositorPath || resolve(input.outputPath) !== resolve(input.run.partPath)
    || input.encoder !== input.run.identity.encoder) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "scene-linear provider requires the parent output owner and native identity");
  const request = buildAces2DisplayVideoRenderRequest(input.project, { longTimeline: true }), hdr = request.outputTransform !== "rec709_sdr";
  if (hdr && (input.project.captions.length || input.project.motionGraphics.length)) {
    throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "HDR text has no calibrated203-nit reference white; keep the existing scene-linear overlay refusal");
  }
  const schedule = sceneLinearChunkPlanV1(input.project, input.plan.duration, request, input.run.identity, input.run.policy);
  return runWithRenderWorkRootV1(input.run.runDirectory, async () => {
    const workspace = await createRenderWorkDirectory("editkin-aces2-sdr-");
    let encoder: ReturnType<typeof startContinuousEncoderV1> | undefined;
    let encoderFinished = false;
    let audioProducer: Promise<Awaited<ReturnType<typeof writeGlobalAudioPassV1>>> | undefined;
    try {
      const graphPath = join(workspace, "graph.json"), bindingsPath = join(workspace, "bindings.json"), sequencePath = join(workspace, "display-sequence");
      const ffmpegPath = input.options.ffmpegPath ?? "ffmpeg", ffprobePath = input.options.ffprobePath ?? "ffprobe";
      const graphText = JSON.stringify(request.graph), bindingsText = JSON.stringify(request.assetBindings);
      let assFilter = "", assText: string | undefined;
      const assPath = join(workspace, "captions.ass");
      if (!hdr && (input.project.captions.length || input.project.motionGraphics.length)) {
        const fonts = await resolveAssFontRoot(input.options.fontRoot, input.project);
        const physicalLayouts = await prepareMotionPhysicalLayouts(input.project, input.options.fontRoot);
        // One global PTS domain: ASS is applied after all PNG ranges have joined the same encoder input.
        assText = writeAssContent(input.project, input.project.captionStyle,
          { ...fonts, physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget: new AssMotionBudget() });
        assFilter = `${buildAssFilter(assPath, fonts.fontRoot)},`;
      }
      // The native CLI commits its own JSON receipt alongside the PNGs. Reserve it in the metadata half of the cap.
      const maximumNativeReceiptBytes = Math.max(128 * 1024, 16 * 1024 + 4 * Buffer.byteLength(JSON.stringify({
        graphId: request.graph.graphId, executedNodeIds: request.graph.nodes.map(node => node.id) }), "utf8"));
      const metadataBytes = sceneLinearMetadataBytesV1([graphText, bindingsText, assText ?? ""], schedule.metadataBudgetBytes - maximumNativeReceiptBytes);
      await writeFile(graphPath, graphText, { flag: "wx" });
      await writeFile(bindingsPath, bindingsText, { flag: "wx" });
      if (assText !== undefined) await writeFile(assPath, assText, { flag: "wx" });
      const audio = await prepareGlobalAudioPassV1(input.project, input.plan, ffprobePath, input.timeoutMs);
      const version = await runProcess(ffmpegPath, ["-version"], input.timeoutMs);
      const pngDisplayFilter = hdr ? "format=gbrp16le,zscale=matrix=2020_ncl:range=limited,format=yuv420p10le" : `${assFilter}format=yuv420p`;
      let frames = 0, bytes = 0, peakBatch = 0, peakMetadata = metadataBytes, nativeCallMs = 0, nativeRenderMs = 0;
      let first: SceneLinearChunkReceiptV1 | undefined, last: SceneLinearChunkReceiptV1 | undefined;
      const digest = createHash("sha256");
      for (let index = 0; index < schedule.chunkCount; index++) {
        input.run.signal.throwIfAborted(); encoder?.signal.throwIfAborted(); await input.run.guard.check("before-scene-linear-chunk");
        const chunk = schedule.chunk(index);
        reportRenderStage("frames", input.plan.duration);
        const started = performance.now();
        const execute = () => runProcess(input.options.gpuCompositorPath!, ["engine-render-display-sequence", graphPath, bindingsPath,
          String(chunk.startFrame), String(chunk.frameCount), sequencePath, "gpu"], input.timeoutMs, undefined, { paths: [sequencePath] });
        const execution = encoder ? await withRenderLifetime({ signal: encoder.signal, timeoutMs: input.timeoutMs }, execute) : await execute();
        nativeCallMs += performance.now() - started;
        const receipt: unknown = JSON.parse(execution.stdout).receipt;
        assertSceneLinearChunkReceiptV1(receipt, request, chunk, schedule.artifactFormat, schedule.batchBudgetBytes);
        if (first && (receipt.configSha256 !== first.configSha256 || receipt.lutSha256 !== first.lutSha256)) {
          throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "native color processor inputs changed between frame batches");
        }
        first ??= receipt; last = receipt;
        nativeRenderMs += receipt.renderMilliseconds?.total ?? 0;
        const batch = await inspectSceneLinearChunkFilesV1({ directory: sequencePath, ...chunk, width: input.project.width, height: input.project.height,
          bitDepth: hdr ? 16 : 8, maximumFrameBytes: schedule.maximumPngFrameBytes, maximumBatchBytes: schedule.batchBudgetBytes, expectedBytes: receipt.totalBytes,
          nativeReceipt: { value: receipt, maximumBytes: maximumNativeReceiptBytes } });
        peakMetadata = Math.max(peakMetadata, metadataBytes + batch.manifestBytes);
        peakBatch = Math.max(peakBatch, batch.bytes); await input.run.guard.check("after-scene-linear-chunk");
        if (!encoder) {
          // Do not start the encoder's no-progress clock while the first native batch is still being created.
          encoder = startContinuousEncoderV1({ ffmpegPath, outputPath: input.outputPath, identity: input.run.identity,
            frameBytes: schedule.maximumPngFrameBytes, videoInput: "png", pngDisplayFilter, hdrMastering: hdr,
            outputTransform: request.outputTransform, audio, signal: input.run.signal, timeoutMs: input.timeoutMs,
            stallMs: input.options.stallTimeoutMs, guard: input.run.guard });
          const codec = encoder;
          audioProducer = (async () => {
            const result = await writeGlobalAudioPassV1(audio, { samples: input.run.identity.audio.expectedSamples, ffmpegPath,
              timeoutMs: input.timeoutMs, signal: codec.signal, write: bytes => codec.writeAudio(bytes) });
            codec.endAudio(); return result;
          })();
          void audioProducer.catch(error => codec.stop(error).catch(() => undefined));
        }
        const codec = encoder;
        for (let offset = 0; offset < chunk.frameCount; offset++) {
          codec.signal.throwIfAborted();
          bytes += await batch.consume(offset, async frame => { digest.update(frame); await codec.writeVideo(frame); frames++; });
          input.run.guard.observeWrittenBytes("scene-linear-png", bytes);
        }
        await batch.retireManifest(); await rmdir(sequencePath);
      }
      if (!encoder || !audioProducer || !first || !last || frames !== schedule.frameCount) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "scene-linear schedule did not complete its global frame range");
      encoder.endVideo(); const audioReceipt = await audioProducer, encoded = await encoder.finish();
      encoderFinished = true;
      await input.run.guard.check("after-scene-linear-encoder");
      const receipt: ChunkedSceneLinearSequenceReceiptV1 = { schema: "editkin.chunked-scene-linear/v1", chunks: schedule.chunkCount, frames,
        framesPerChunk: schedule.framesPerChunk, nativeDeviceCreations: schedule.chunkCount, nativeCallMilliseconds: nativeCallMs,
        nativeRenderMilliseconds: nativeRenderMs, nativeOverheadMilliseconds: Math.max(0, nativeCallMs - nativeRenderMs),
        artifactFormat: schedule.artifactFormat, peakBatchBytes: peakBatch, maximumBatchBytes: schedule.batchBudgetBytes,
        metadataBytes: peakMetadata, maximumMetadataBytes: schedule.metadataBudgetBytes,
        maximumRetainedPngBytes: schedule.maximumRetainedPngBytes, consumedPngBytes: bytes, pngSequenceSha256: digest.digest("hex"),
        firstNativeReceipt: first, lastNativeReceipt: last, finalEncoderInstances: 1, videoIntermediateBytes: 0,
        encoderClosed: encoded.closed, encoderFrames: encoded.writes, audio: audioReceipt };
      return { outputPath: input.outputPath, duration: input.plan.duration, encoder: input.encoder,
        planner: "editkin-chunked-scene-linear/v1", ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown", chunkedSceneLinearPipeline: receipt };
    } finally {
      try {
        if (encoder && !encoderFinished) await encoder.stop(Error("SCENE_LINEAR_PRODUCER_ENDED"));
      } finally {
        if (audioProducer) await Promise.allSettled([audioProducer]);
        await removeRenderWorkDirectory(workspace);
      }
    }
  });
}
