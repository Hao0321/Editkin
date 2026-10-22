import { createSourceClockTemporaryWorkV1 } from "./sourceClockTemporaryWorkV1";
import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, realpath, writeFile, readFile, readdir, link, unlink, rmdir, type FileHandle } from "node:fs/promises";
import { dirname, basename, join, resolve, extname } from "node:path";
import type { EditProject } from "../domain/types";
import { validateProject } from "../domain/projectValidation";
import { canonicalJson } from "../shared/canonicalJson";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { clipTimeRemapClockV1, clipTimeRemapAudioPlanV1 } from "../domain/clipTimeRemapV1";
import { admitSourcePreservingProjectV1, SOURCE_PRESERVING_POLICY_V1 } from "./sourcePreservingAdmissionV1";
import { runProcess, FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { withRenderLifetime, renderLifetimeSignal, renderLifetimeAbort, assertRenderActive, fullDecodeTimeoutMs } from "./renderLifetime";
import { createRenderVolumeWatchV1 } from "./renderVolumeWatchV1";
import type { DiskSpaceProbe } from "./renderDiskSpace";
import { buildDecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import { createTimeRemapFrameConsumerV2 } from "./timeRemapFrameConsumerV2";
import { startStreamEncoderV1 } from "./streamEncoderV1";
import { decodeRgbaOutputWitnessV1 } from "./rgbaOutputWitnessV1";
import { SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2, compilePitchPreservingAudioPlanV1 } from "./pitchPreservingAudioPlanV1";
import { readPitchAudioClockV1 } from "./audioFrameClockReaderV1";
import { witnessPitchPcmV1 } from "./pitchPcmWitnessV1";
import { decodePcmWitnessV1 } from "./pcmDecodeWitnessV1";
import { readPitchSourcePcmStatsV1, assertPitchSourceEligibilityV1, assertPitchOutputPeakV1 } from "./pitchSourcePcmStatsV1";
export { SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2 } from "./pitchPreservingAudioPlanV1";
import { pumpPhasePcmV1, SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 } from "./phasePcmPumpV1";
import { startDualStreamEncoderV1 } from "./dualStreamEncoderV1";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";
import { SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4, resolveTimeRemapFrameWindowV1, describeTimeRemapWindowColorV1, type TimeRemapFrameWindowV1 } from "./timeRemapFrameWindowV1";
import { borrowSourceClockIndexSessionV1, sourceClockIndexLifetimeSignalV1, type SourceClockIndexSessionV1 } from "./sourceClockIndexSessionV1";
import { admitTimeRemapCacheClipV1 } from "./timeRemapCacheContractV1";
export { SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 } from "./phasePcmPumpV1";

export const SOURCE_CLOCK_RENDER_POLICY_V1 = "diagnostic_lossless_source_clock_rgba8_v1" as const;
async function fileSha(handle: FileHandle) {
  const size = (await handle.stat()).size; if (!Number.isSafeInteger(size) || size < 1) throw Error("CURVE_RENDER_FILE_SIZE_INVALID");
  const b = Buffer.allocUnsafe(1024 ** 2), h = createHash("sha256"); let at = 0;
  while (at < size) { assertRenderActive(); const r = await handle.read(b, 0, Math.min(b.length, size - at), at); if (!r.bytesRead) throw Error("CURVE_RENDER_SOURCE_ENDED_EARLY"); h.update(b.subarray(0, r.bytesRead)); at += r.bytesRead; }
  return h.digest("hex");
}
/** Real single-neutral-clip source candidate. No ordinary renderer/default/VA promotion.
 * FFV1 diagnostic pixels are lossless in this encoded-RGBA8 blend contract; wider working-space/audio routes remain required. */
export async function renderTimeRemapSourceProjectV1(project: EditProject, outputPath: string, runtime: {
  ffmpegPath: string; ffprobePath: string; assetBase: string; expectedSourceSha256: string; policy: typeof SOURCE_CLOCK_RENDER_POLICY_V1 | typeof SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2 | typeof SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 | typeof SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4;
  outputFrameWindow?: TimeRemapFrameWindowV1; sourceIndexSession?: SourceClockIndexSessionV1;
  maximumOutputBytes: number; signal?: AbortSignal; timeoutMs?: number; maximumCacheBytes?: number; volumeProbe?: DiskSpaceProbe;
  onFrame?: (frame: { index: number; bytes: Uint8Array }) => Promise<void>;
  /** Optional owner journal observer. Called after exclusive creation, before a child writes. */
  onOwnedPath?: (path: string, kind: "file" | "dir") => Promise<void>;
  withPublicationGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  assertProofStillRouteV1(project, "time-remap-source-v1");
  const windowPolicy = runtime.policy === SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4;
  if (windowPolicy !== !!runtime.outputFrameWindow || windowPolicy !== !!runtime.sourceIndexSession) throw Error("CURVE_RENDER_WINDOW_POLICY_AND_LIVE_SESSION_REQUIRED");
  if (![SOURCE_CLOCK_RENDER_POLICY_V1, SOURCE_CLOCK_PCM_CONSTANT_POLICY_V2, SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3, SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4].includes(runtime.policy) || !/^[a-f0-9]{64}$/.test(runtime.expectedSourceSha256)
    || !Number.isSafeInteger(runtime.maximumOutputBytes) || runtime.maximumOutputBytes < 1024) throw Error("CURVE_RENDER_POLICY_OR_BUDGET_INVALID");
  validateProject(project); const rows = project.tracks.flatMap(t => t.clips); if (rows.length !== 1) throw Error("CURVE_RENDER_SINGLE_NEUTRAL_CLIP_REQUIRED");
  const clip = rows[0], asset = project.assets.find(a => a.id === clip.assetId)!; const clock = clipTimeRemapClockV1(project, clip, asset);
  if (windowPolicy) admitTimeRemapCacheClipV1(project, clip, asset);
  if (!clock || clip.timelineStart !== 0 || extname(outputPath).toLowerCase() !== ".mkv") throw Error("CURVE_RENDER_AUTHORED_CLOCK_AND_MKV_REQUIRED");
  if (Math.abs(clock.totalOutputFrames * clock.outputRate.denominator / clock.outputRate.numerator - clip.duration) > 1e-9) throw Error("CURVE_RENDER_DURATION_NOT_FRAME_ALIGNED");
  const frameWindow = resolveTimeRemapFrameWindowV1(clock, runtime.outputFrameWindow), renderFrames = frameWindow.frames;
  const renderDuration = windowPolicy ? frameWindow.encodedDuration : clip.duration;
  const neutral = structuredClone(project), nc = neutral.tracks.flatMap(t => t.clips)[0]; delete nc.speed; delete nc.timeRemap; nc.sourceStart = 0; nc.duration = asset.duration; nc.volume = 1;
  admitSourcePreservingProjectV1(neutral, SOURCE_PRESERVING_POLICY_V1);
  const sourcePath = resolve(runtime.assetBase, asset.uri), output = resolve(outputPath), parent = dirname(output), projectBefore = canonicalJson(project);
  for (const p of [sourcePath, output, runtime.ffmpegPath, runtime.ffprobePath]) assertLocalMediaPath(p);
  if (sourcePath.toLowerCase() === output.toLowerCase()) throw Error("CURVE_RENDER_SOURCE_OUTPUT_ALIAS");
  return withRenderLifetime({ signal: runtime.sourceIndexSession ? sourceClockIndexLifetimeSignalV1(runtime.sourceIndexSession, runtime.signal) : runtime.signal, timeoutMs: runtime.timeoutMs, workSeconds: asset.duration + renderDuration }, async () => {
    await mkdir(parent, { recursive: true }); if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw Error("CURVE_RENDER_PARENT_LINK");
    try { await lstat(output); throw Error("CURVE_RENDER_OUTPUT_EXISTS"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const source = await open(sourcePath, "r"), sourceIdentity = await source.stat({ bigint: true }), token = randomUUID(), owner = JSON.stringify({ schema: "editkin.curve-source-work/v1", token, pid: process.pid });
    const stable = async () => { const s = await source.stat({ bigint: true }), p = await lstat(sourcePath, { bigint: true }); if (p.isSymbolicLink() || p.dev !== sourceIdentity.dev || p.ino !== sourceIdentity.ino || s.size !== sourceIdentity.size || s.mtimeNs !== sourceIdentity.mtimeNs || s.ctimeNs !== sourceIdentity.ctimeNs) throw Error("CURVE_RENDER_SOURCE_CHANGED"); };
    let work: string | undefined, metadata: FileHandle | undefined, metadataIdentity: { dev: number; ino: number } | undefined, workIdentity: { dev: number; ino: number } | undefined;
    let candidate: FileHandle | undefined, candidateIdentity: { dev: number; ino: number } | undefined, temporary: string | undefined;
    let consumer: ReturnType<typeof createTimeRemapFrameConsumerV2> | undefined, encoder: ReturnType<typeof startStreamEncoderV1> | ReturnType<typeof startDualStreamEncoderV1> | undefined;
    let phaseTask: ReturnType<typeof pumpPhasePcmV1> | undefined;
    let monitor: ReturnType<typeof createRenderVolumeWatchV1> | undefined;
    let sourceIndexBorrow: Awaited<ReturnType<typeof borrowSourceClockIndexSessionV1>> | undefined;
    try {
      if (!sourceIdentity.isFile() || sourceIdentity.size < 1n || sourceIdentity.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("CURVE_RENDER_SOURCE_INVALID");
      await stable();
      if (runtime.sourceIndexSession) sourceIndexBorrow = await borrowSourceClockIndexSessionV1(runtime.sourceIndexSession, { sourcePath, sourceIdentity, expectedSourceSha256: runtime.expectedSourceSha256, ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, outputParent: parent });
      else if (await fileSha(source) !== runtime.expectedSourceSha256) throw Error("CURVE_RENDER_SOURCE_SHA_MISMATCH");
      const probe = JSON.parse((await runProcess(runtime.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-show_data", "-of", "json", sourcePath], 30000, { completeStdoutMaxChars: 65536 })).stdout);
      const streams = probe.streams as Record<string, any>[], video = streams.filter(s => s.codec_type === "video");
      if (video.length !== 1 || video[0].width !== project.width || video[0].height !== project.height || !["yuv420p", "rgba", "bgra", "rgb24", "bgr0"].includes(video[0].pix_fmt)
        || video[0].side_data_list?.length || !["1:1", "1/1"].includes(video[0].sample_aspect_ratio)) throw Error("CURVE_RENDER_SOURCE_GEOMETRY_OR_8BIT_LAYOUT_UNSUPPORTED");
      const windowColor = windowPolicy ? describeTimeRemapWindowColorV1(video[0]) : undefined;
      const audio = clipTimeRemapAudioPlanV1(clip), audioStreams = streams.filter(s => s.codec_type === "audio"), hasAudio = audioStreams.length > 0;
      const keepAudio = hasAudio && clip.volume !== 0 && audio.mode !== "mute";
      const phaseAudio = keepAudio && runtime.policy === SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3;
      if (keepAudio && (runtime.policy === SOURCE_CLOCK_RENDER_POLICY_V1 || windowPolicy)) throw Error("CURVE_RENDER_ORIGINAL_AUDIO_CONSUMER_REQUIRED");
      if (runtime.policy !== SOURCE_CLOCK_RENDER_POLICY_V1 && !windowPolicy && !hasAudio) throw Error("CURVE_RENDER_AUDIO_SOURCE_REQUIRED");
      if (keepAudio && audioStreams.length !== 1) throw Error("CURVE_RENDER_SINGLE_AUDIO_STREAM_REQUIRED");
      const constantAudio = keepAudio ? compilePitchPreservingAudioPlanV1({ sourceStartSeconds: clock.sourceStartSeconds, consumedSourceSeconds: clock.consumedSourceSeconds,
        timelineDurationSeconds: clip.duration, direction: clock.direction, mode: audio.mode, speed: clip.speed ?? 1, atempo: audio.atempo, volume: clip.volume, stream: audioStreams[0] }) : undefined;
      const audioClock = constantAudio ? await readPitchAudioClockV1({ ffprobePath: runtime.ffprobePath, sourcePath, plan: constantAudio, timeoutMs: fullDecodeTimeoutMs(asset.duration) }) : null;
      let audioSourceStats = constantAudio && !phaseAudio ? await readPitchSourcePcmStatsV1({ ffmpegPath: runtime.ffmpegPath, sourcePath, plan: constantAudio, timeoutMs: fullDecodeTimeoutMs(asset.duration) }) : null;
      if (constantAudio && audioSourceStats) assertPitchSourceEligibilityV1(constantAudio, audioSourceStats);
      let audioReference: Awaited<ReturnType<typeof witnessPitchPcmV1>> | Awaited<ReturnType<typeof pumpPhasePcmV1>> | null = constantAudio && !phaseAudio ? await witnessPitchPcmV1({ ffmpegPath: runtime.ffmpegPath, sourcePath, plan: constantAudio, timeoutMs: fullDecodeTimeoutMs(clip.duration) }) : null;
      if (constantAudio && audioSourceStats && audioReference) assertPitchOutputPeakV1(constantAudio, audioSourceStats, audioReference.channelPeaks);
      const timebase = String(video[0].time_base).split("/").map(Number); if (timebase.length !== 2 || !timebase.every(v => Number.isSafeInteger(v) && v > 0)) throw Error("CURVE_RENDER_SOURCE_TIMEBASE_UNKNOWN");
      work = await createSourceClockTemporaryWorkV1(parent); const wi = await lstat(work); workIdentity = { dev: wi.dev, ino: wi.ino }; await writeFile(join(work, "owner.json"), owner, { flag: "wx" });
      metadata = await open(join(work, "pts.bin"), "wx+"); const mi = await metadata.stat(); metadataIdentity = { dev: mi.dev, ino: mi.ino };
      await runtime.onOwnedPath?.(work, "dir");
      await runtime.onOwnedPath?.(join(work, "owner.json"), "file");
      await runtime.onOwnedPath?.(join(work, "pts.bin"), "file");
      monitor = createRenderVolumeWatchV1({ workRoot: work, stagingLimitBytes: 512 * 1024 ** 2 + 1024,
        requirements: [{ path: parent, initialBytes: runtime.maximumOutputBytes + 512 * 1024 ** 2, reserveBytes: 1024 ** 3 },
          { path: process.env.SystemRoot ?? parent, initialBytes: 0, reserveBytes: 2 * 1024 ** 3 }], probe: runtime.volumeProbe, onFailure: renderLifetimeAbort()! });
      await monitor.check(); monitor.start();
      const indexProfile = { timeBase: { numerator: timebase[0], denominator: timebase[1] }, h264FourByteNals: video[0].codec_name === "h264" && video[0].is_avc === "true" && video[0].nal_length_size === "4", timeoutMs: fullDecodeTimeoutMs(asset.duration) };
      const indexed = sourceIndexBorrow ? await sourceIndexBorrow.getIndex(indexProfile) : await buildDecodedPtsIndexV1({ ffprobePath: runtime.ffprobePath, sourcePath, source, sourceBytes: Number(sourceIdentity.size), metadata, ...indexProfile });
      await stable(); await monitor.check();
      consumer = createTimeRemapFrameConsumerV2({ clock, index: indexed.index, width: project.width, height: project.height, ffmpegPath: runtime.ffmpegPath, sourcePath,
        timeoutMs: fullDecodeTimeoutMs(asset.duration), signal: renderLifetimeSignal(), maximumCacheBytes: runtime.maximumCacheBytes, ...(windowPolicy ? { outputFrameWindow: runtime.outputFrameWindow } : {}) });
      temporary = join(parent, `.${basename(output)}.${token}.part.mkv`); candidate = await open(temporary, "wx+"); const ci = await candidate.stat(); candidateIdentity = { dev: ci.dev, ino: ci.ino };
      await runtime.onOwnedPath?.(temporary, "file");
      const encoderArgs = ["-hide_banner", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${project.width}x${project.height}`,
        "-framerate", `${clock.outputRate.numerator}/${clock.outputRate.denominator}`, "-i", "pipe:0",
        ...(phaseAudio && constantAudio ? ["-f", "f32le", "-ar", String(constantAudio.sampleRate), "-ac", String(constantAudio.channels), "-i", "pipe:3", "-map", "0:v:0", "-map", "1:a:0", "-c:a", "pcm_f32le"] : constantAudio ? ["-xerror", "-err_detect", "explode", "-threads", "1", "-t", String(constantAudio.inputReadSeconds), "-i", sourcePath, "-map", "0:v:0", "-map", "1:a:0", "-filter_threads", "1", "-af", constantAudio.muxFilter, "-c:a", "pcm_f32le"] : ["-an"]),
        "-threads", "1", "-c:v", "ffv1", "-level", "3", "-g", "1", "-pix_fmt", "bgra", ...(phaseAudio ? [] : ["-frames:v", String(renderFrames)]), ...FFMPEG_PROGRESS_ARGS, temporary];
      if (phaseAudio && constantAudio) {
        const dual = startDualStreamEncoderV1({ executable: runtime.ffmpegPath, args: encoderArgs, signal: renderLifetimeSignal()!, timeoutMs: fullDecodeTimeoutMs(clip.duration),
          maximumVideoWriteBytes: project.width * project.height * 4, maximumAudioWriteBytes: 2048, expectedVideoWrites: renderFrames, expectedAudioBytes: constantAudio.outputSamples * constantAudio.channels * 4 });
        encoder = dual;
        phaseTask = pumpPhasePcmV1({ ffmpegPath: runtime.ffmpegPath, sourcePath, plan: constantAudio, signal: renderLifetimeSignal(), timeoutMs: fullDecodeTimeoutMs(clip.duration),
          write: bytes => dual.writeAudio(bytes), end: () => dual.endAudio() }).catch(error => { renderLifetimeAbort()?.(error); throw error; });
        void phaseTask.catch(() => undefined);
      } else encoder = startStreamEncoderV1({ executable: runtime.ffmpegPath, args: encoderArgs,
        signal: renderLifetimeSignal()!, timeoutMs: fullDecodeTimeoutMs(renderDuration), stallMs: 30000, maximumWriteBytes: project.width * project.height * 4, expectedWrites: renderFrames });
      const sampledPixels = createHash("sha256");
      for (let n = frameWindow.firstFrame; n < frameWindow.endFrame; n++) {
        assertRenderActive(); const frame = await consumer.sample(n); sampledPixels.update(frame.bytes); await runtime.onFrame?.({ index: n, bytes: Buffer.from(frame.bytes) }); await encoder.write(frame.bytes);
        if ((await candidate.stat()).size > runtime.maximumOutputBytes) throw Error("CURVE_RENDER_OUTPUT_BUDGET");
      }
      await consumer.finish();
      if (phaseTask) { (encoder as ReturnType<typeof startDualStreamEncoderV1>).endVideo(); audioReference = await phaseTask; audioSourceStats = audioReference.sourceStats; }
      await encoder.finish(); await candidate.sync(); if ((await candidate.stat()).size > runtime.maximumOutputBytes) throw Error("CURVE_RENDER_OUTPUT_BUDGET");
      const sampledPixelSha256 = sampledPixels.digest("hex"), outputPixels = await decodeRgbaOutputWitnessV1({ executable: runtime.ffmpegPath, source: temporary,
        width: project.width, height: project.height, expectedFrames: renderFrames, timeoutMs: fullDecodeTimeoutMs(renderDuration) });
      if (outputPixels.sha256 !== sampledPixelSha256) throw Error("CURVE_RENDER_ENCODED_PIXEL_IDENTITY_MISMATCH");
      let outputAudio: Awaited<ReturnType<typeof decodePcmWitnessV1>> | null = null;
      if (constantAudio && audioReference) {
        const meta = JSON.parse((await runProcess(runtime.ffprobePath, ["-v", "error", "-select_streams", "a", "-show_streams", "-of", "json", temporary], 30000, { completeStdoutMaxChars: 65536 })).stdout);
        const rows = meta.streams as Record<string, any>[];
        if (rows.length !== 1 || rows[0].codec_name !== "pcm_f32le" || Number(rows[0].sample_rate) !== constantAudio.sampleRate || rows[0].channels !== constantAudio.channels || Number(rows[0].start_time) !== 0) throw Error("CURVE_RENDER_OUTPUT_PCM_SHAPE_CHANGED");
        outputAudio = await decodePcmWitnessV1({ executable: runtime.ffmpegPath, source: temporary, sampleRate: constantAudio.sampleRate, channels: constantAudio.channels, expectedSamples: constantAudio.outputSamples, timeoutMs: fullDecodeTimeoutMs(clip.duration) });
        if (outputAudio.sha256 !== audioReference.sha256 || outputAudio.samples !== audioReference.samples) throw Error("CURVE_RENDER_ENCODED_PCM_IDENTITY_MISMATCH");
      }
      const publication = async () => {
        assertRenderActive(); await indexed.index.assertIdentity(); await stable();
        if (sourceIndexBorrow) await sourceIndexBorrow.verify();
        else if (await fileSha(source) !== runtime.expectedSourceSha256) throw Error("CURVE_RENDER_SOURCE_OR_PROJECT_CHANGED");
        if (canonicalJson(project) !== projectBefore) throw Error("CURVE_RENDER_SOURCE_OR_PROJECT_CHANGED");
        await monitor!.check(); const outputSha256 = await fileSha(candidate!), size = (await candidate!.stat()).size;
        const path = await lstat(temporary!); if (path.isSymbolicLink() || path.dev !== candidateIdentity!.dev || path.ino !== candidateIdentity!.ino) throw Error("CURVE_RENDER_CANDIDATE_OWNER_CHANGED");
        assertRenderActive(); await link(temporary!, output); const published = await lstat(output);
        if (published.dev !== candidateIdentity!.dev || published.ino !== candidateIdentity!.ino || published.size !== size) throw Error("CURVE_RENDER_PUBLICATION_OWNER_CHANGED");
        await runtime.onOwnedPath?.(output, "file");
        return { outputSha256, size };
      };
      const { outputSha256, size } = await (runtime.withPublicationGuard ? runtime.withPublicationGuard(publication) : publication());
      return { schema: "editkin.source-clock-render/v1", outputPath: output, outputSha256, bytes: size, frames: renderFrames, duration: renderDuration,
        ...(windowPolicy ? { outputFrameWindow: frameWindow, globalClockSha256: createHash("sha256").update(canonicalJson(clock)).digest("hex"), sourceIndexSession: runtime.sourceIndexSession!.receipt, sourceColorMetadata: windowColor } : {}),
        sourceSha256: runtime.expectedSourceSha256, sampledPixelSha256, outputPixels, metadataBytes: indexed.index.metadataBytes, indexSha256: indexed.index.metadataSha256, frameConsumer: consumer.receipt,
        decoderReceipts: consumer.decoderReceipts, indexPacketReaders: indexed.packetReceipts, indexFrameReaders: indexed.frameReceipts, encoder: encoder.receipt,
        pixelEncoding: "lossless_ffv1_encoded_rgba8_candidate", originalAudio: phaseAudio ? "shared_phase_constant_pcm_f32_candidate" : constantAudio ? "pitch_preserving_constant_pcm_f32" : hasAudio ? "explicitly_muted" : "absent",
        audioPlan: phaseAudio && constantAudio ? { engine: "shared_bin_phase_vocoder_v1", speed: constantAudio.speed, sampleRate: constantAudio.sampleRate, channels: constantAudio.channels, sourceStartSample: constantAudio.sourceStartSample, sourceEndSample: constantAudio.sourceEndSample, outputSamples: constantAudio.outputSamples } : constantAudio ?? null, audioClock, audioSourceStats, audioReference, outputAudio, audioQualityCertified: false, wholePixelQualityCertified: false,
        rawMoviePixelsStaged: 0, installedActivationPerformed: false, ordinaryEditorPreviewReady: false, sceneLinearHdrReady: false };
    } finally {
      try {
      await monitor?.stop();
      if (encoder && !encoder.closed) await encoder.stop(Error("CURVE_RENDER_OWNER_ENDED")); await phaseTask?.catch(() => undefined); await consumer?.close(); await candidate?.close(); await source.close(); await metadata?.close();
      if (temporary && candidateIdentity) { const s = await lstat(temporary).catch(e => { if (e.code === "ENOENT") return undefined; throw e; }); if (s) { if (s.isSymbolicLink() || s.dev !== candidateIdentity.dev || s.ino !== candidateIdentity.ino) throw Error("CURVE_RENDER_TEMP_OWNER_CHANGED"); await unlink(temporary); } }
      if (work) {
        const s = await lstat(work); if (s.isSymbolicLink() || s.dev !== workIdentity?.dev || s.ino !== workIdentity?.ino || (await realpath(parent)).toLowerCase() !== parent.toLowerCase()
          || (await readdir(work)).sort().join() !== "owner.json,pts.bin") throw Error("CURVE_RENDER_WORK_OWNER_CHANGED");
        if ((await readFile(join(work, "owner.json"), "utf8")) !== owner) throw Error("CURVE_RENDER_WORK_TOKEN_CHANGED");
        const m = await lstat(join(work, "pts.bin")); if (m.isSymbolicLink() || m.dev !== metadataIdentity?.dev || m.ino !== metadataIdentity?.ino) throw Error("CURVE_RENDER_INDEX_OWNER_CHANGED");
        await unlink(join(work, "pts.bin")); await unlink(join(work, "owner.json")); await rmdir(work);
      }
      } finally { sourceIndexBorrow?.release(); }
    }
  });
}
