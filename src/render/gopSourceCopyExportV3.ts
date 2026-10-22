import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, mkdtemp, realpath, link, rm, rmdir, readdir, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { readBoundedFile } from "../shared/boundedFile";
import { runProcess, resolveMediaPath, FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { withRenderLifetime, assertRenderActive, fullDecodeTimeoutMs, renderLifetimeAbort } from "./renderLifetime";
import { sourcePreservingVolumeWatchV1, type SourcePreservingVolumeProbeV1 } from "./sourcePreservingVolumeV1";
import { packetByteSourceV1, witnessAvcPacketV1 } from "./sourcePacketV1";
import { readGopPacketsV2, type GopPacketReaderReceiptV2 } from "./gopPacketReaderV2";
import { gopPacketWindowV3, verifyGopPacketCopyV3 } from "./gopPacketWitnessV3";
import { readDecodedFrameClocksV1, type DecodedFrameReaderReceiptV1 } from "./decodedFrameClockReaderV1";
import { decodedPresentationWindowV1, verifyDecodedPresentationIdentityV1 } from "./decodedPresentationClockV1";
import { GOP_SOURCE_COPY_POLICY_V2, admitGopSourceCopyProjectV2, admitGopSourceCopyMediaV2 } from "./gopSourceCopyAdmissionV2";
import { mp4EditFileHandleV1, planMp4PresentationEditV1, applyMp4PresentationEditV1 } from "./mp4PresentationEditV1";
export const GOP_SOURCE_COPY_POLICY_V3 = "copy_exact_gop_postroll_original_streams_v3" as const;

import { readAacPacketsV1, type AacPacketReaderReceiptV1 } from "./aacPacketReaderV1";
import { aacOutputPacketWitnessV1, aacSourcePacketWindowV1, aacPacketPayloadSha256V1, verifyCopiedAacPacketWindowV1 } from "./aacPacketWitnessV1";
import { decodePcmWitnessV1 } from "./pcmDecodeWitnessV1";
import { verifyAacCutDecodedIdentityV1 } from "./aacPacketClockV1";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function fileSha(handle: FileHandle, size: number) {
  const buffer = Buffer.allocUnsafe(1024 ** 2), digest = createHash("sha256"); let offset = 0;
  while (offset < size) { assertRenderActive(); const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!read.bytesRead) throw Error("PACKET_COPY_FILE_ENDED_EARLY"); digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead; }
  return digest.digest("hex");
}
export interface GopSourceCopyRuntimeV3 {
  assetBase: string; ffmpegPath: string; ffprobePath: string; expectedSourceSha256: string; policy: typeof GOP_SOURCE_COPY_POLICY_V3;
  signal?: AbortSignal; timeoutMs?: number; maxAudioPrerollSeconds?: number; maxVideoPrerollSeconds?: number; maxVideoPostrollSeconds?: number; withPublicationGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
}
export interface GopSourceCopyDependenciesV3 { run: typeof runProcess; readPackets: typeof readGopPacketsV2; readFrames?: typeof readDecodedFrameClocksV1; decodePcm?: typeof decodePcmWitnessV1; readAudioPackets?: typeof readAacPacketsV1; volumeProbe?: SourcePreservingVolumeProbeV1 }
/** LV03 bounded postroll candidate: raw prefix, owned duration edit, decoded presentation and original audio identity are mandatory. */
export async function renderGopSourceCopyProjectV3(project: EditProject, outputPath: string, runtime: GopSourceCopyRuntimeV3,
  dependencies: GopSourceCopyDependenciesV3 = { run: runProcess, readPackets: readGopPacketsV2 }) {
  assertProofStillRouteV1(project, "gop-source-copy-v3");
  if (runtime.policy !== GOP_SOURCE_COPY_POLICY_V3) throw Error("GOP_COPY_EXPLICIT_POLICY_REQUIRED");
  const started = performance.now(), projectSha256 = hash(project), admission = admitGopSourceCopyProjectV2(project, GOP_SOURCE_COPY_POLICY_V2);
  const maxVideoPostrollSeconds = runtime.maxVideoPostrollSeconds ?? 2;
  if (!Number.isInteger(maxVideoPostrollSeconds) || maxVideoPostrollSeconds < 0 || maxVideoPostrollSeconds > 10) throw Error("GOP_COPY_VIDEO_POSTROLL_BUDGET_INVALID");
  const maxPrerollSeconds = runtime.maxAudioPrerollSeconds ?? 2, maxVideoPrerollSeconds = runtime.maxVideoPrerollSeconds ?? 2;
  if (!Number.isInteger(maxVideoPrerollSeconds) || maxVideoPrerollSeconds < 1 || maxVideoPrerollSeconds > 10) throw Error("GOP_COPY_VIDEO_PREROLL_BUDGET_INVALID");
  if (!Number.isInteger(maxPrerollSeconds) || maxPrerollSeconds < 1 || maxPrerollSeconds > 10) throw Error("AAC_PACKET_PREROLL_BUDGET_INVALID");
  if (!/^[a-f0-9]{64}$/.test(runtime.expectedSourceSha256)) throw Error("PACKET_COPY_SOURCE_SHA_REQUIRED");
  const sourcePath = resolveMediaPath(admission.sourceUri, runtime.assetBase), output = resolve(outputPath), parent = dirname(output);
  for (const path of [sourcePath, output, runtime.ffmpegPath, runtime.ffprobePath]) { assertLocalMediaPath(path); if (!isAbsolute(path)) throw Error("PACKET_COPY_ABSOLUTE_PATH_REQUIRED"); }
  if (extname(sourcePath).toLowerCase() !== ".mp4" || extname(output).toLowerCase() !== ".mp4" || sourcePath.toLowerCase() === output.toLowerCase()) throw Error("PACKET_COPY_CONTAINER_OR_ALIAS_INVALID");
  return withRenderLifetime({ signal: runtime.signal, timeoutMs: runtime.timeoutMs, workSeconds: admission.expectedDuration + admission.requestedDuration }, async () => {
    await mkdir(parent, { recursive: true }); if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw Error("PACKET_COPY_OUTPUT_PARENT_LINK");
    try { await lstat(output); throw Error("PACKET_COPY_OUTPUT_EXISTS"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const source = await open(sourcePath, "r"), token = randomUUID(), owner = JSON.stringify({ schema: "editkin.packet-copy-work/v1", pid: process.pid, token });
    let work: string | undefined, workIdentity: { dev: number; ino: number } | undefined, temporary: string | undefined, candidate: FileHandle | undefined;
    let candidateIdentity: { dev: number; ino: number } | undefined, monitor: ReturnType<typeof sourcePreservingVolumeWatchV1> | undefined;
    const packetReaders: GopPacketReaderReceiptV2[] = [], audioPacketReaders: AacPacketReaderReceiptV1[] = [], frameReaders: DecodedFrameReaderReceiptV1[] = [];
    try {
      const before = await source.stat({ bigint: true }); if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("PACKET_COPY_SOURCE_INVALID");
      const size = Number(before.size), stable = async () => {
        const current = await source.stat({ bigint: true }), path = await lstat(sourcePath, { bigint: true });
        if (path.isSymbolicLink() || path.dev !== before.dev || path.ino !== before.ino || current.size !== before.size
          || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) throw Error("PACKET_COPY_SOURCE_CHANGED");
      };
      work = await mkdtemp(join(parent, ".editkin-packet-copy-work-")); const wi = await lstat(work);
      if (wi.isSymbolicLink() || !wi.isDirectory()) throw Error("PACKET_COPY_WORK_OWNER_CHANGED"); workIdentity = { dev: wi.dev, ino: wi.ino };
      await writeFile(join(work, "owner.json"), owner, { flag: "wx" });
      monitor = sourcePreservingVolumeWatchV1({ workRoot: work, stagingLimitBytes: 1024 ** 2, probe: dependencies.volumeProbe,
        requirements: [{ path: parent, initialBytes: size + 65_536, reserveBytes: 1024 ** 3 }, { path: process.env.SystemRoot ?? parent, initialBytes: 0, reserveBytes: 2 * 1024 ** 3 }], onFailure: renderLifetimeAbort()! });
      await monitor.check(); monitor.start();
      if (await fileSha(source, size) !== runtime.expectedSourceSha256) throw Error("PACKET_COPY_SOURCE_SHA_MISMATCH"); await stable();
      const probe = async (path: string) => JSON.parse((await dependencies.run(runtime.ffprobePath, ["-v", "error", "-threads", "1", "-show_streams", "-show_format", "-show_data", "-of", "json", path], 30_000, { completeStdoutMaxChars: 65_536 })).stdout);
      const sourceMedia = admitGopSourceCopyMediaV2(await probe(sourcePath), admission);
      const limits = (tb: typeof sourceMedia.timebase) => ({ maxPrerollTicks: Math.floor(maxVideoPrerollSeconds * tb.denominator / tb.numerator),
        maxPostrollTicks: Math.floor(maxVideoPostrollSeconds * tb.denominator / tb.numerator), maxReorderTicks: Math.max(1, Math.floor(2 * tb.denominator / tb.numerator)), maxPendingPackets: 64, maxGopPackets: 8192 });
      const sourceWindow = gopPacketWindowV3(sourceMedia.startTicks, sourceMedia.endTicks, sourceMedia.timebase, "source", limits(sourceMedia.timebase)), bytes = packetByteSourceV1(source, size);
      await dependencies.readPackets(runtime.ffprobePath, sourcePath, async packet => sourceWindow.accept(packet, await witnessAvcPacketV1(packet, bytes)),
        { timeoutMs: fullDecodeTimeoutMs(admission.expectedDuration), onTerminal: r => packetReaders.push(r) });
      const retained = sourceWindow.finish(sourceMedia.videoDurationTicks);
      const sourceFrameWindow = decodedPresentationWindowV1(sourceMedia.startTicks, sourceMedia.endTicks, sourceMedia.timebase, "source");
      await (dependencies.readFrames ?? readDecodedFrameClocksV1)(runtime.ffprobePath, sourcePath, async frame => sourceFrameWindow.accept(frame),
        { timeoutMs: fullDecodeTimeoutMs(admission.expectedDuration), onTerminal: r => frameReaders.push(r) });
      const sourcePresentation = sourceFrameWindow.finish(); await stable(); await monitor.check();
      temporary = join(parent, `.${basename(output)}.${token}.packet-copy.part.mp4`);
      candidate = await open(temporary, "wx+"); const ci = await candidate.stat(); candidateIdentity = { dev: ci.dev, ino: ci.ino };
      const startSeconds = sourceMedia.startTicks * sourceMedia.timebase.numerator / sourceMedia.timebase.denominator;
      const durationSeconds = (sourceMedia.endTicks - sourceMedia.startTicks) * sourceMedia.timebase.numerator / sourceMedia.timebase.denominator;
      const args = ["-hide_banner", "-v", "error", "-nostdin", "-y", "-threads", "1", "-ss", String(startSeconds), "-i", sourcePath];
      if (sourceMedia.audio) {
        const a = sourceMedia.audio;
        if (a.clock.startSample === 0) args.push("-threads", "1", "-i", sourcePath);
        else args.push("-threads", "1", "-itsoffset", String(-1024 / a.config.sampleRate), "-ss", String((a.clock.startSample - 1024) / a.config.sampleRate), "-i", sourcePath);
        args.push("-t", String(durationSeconds), "-map", "0:v:0", "-map", "1:a:0", "-copypriorss:a", "1");
      } else args.push("-map", "0:v:0");
      args.push("-c", "copy", "-frames:v", String(retained.retainedPackets), "-avoid_negative_ts", "disabled", "-use_editlist", "1",
        "-video_track_timescale", String(sourceMedia.timebase.denominator), "-movie_timescale", String(sourceMedia.movieTimescale), ...FFMPEG_PROGRESS_ARGS, temporary);
      await dependencies.run(runtime.ffmpegPath, args, fullDecodeTimeoutMs(admission.requestedDuration), undefined, { ffmpegProgress: true, paths: [temporary] });
      await candidate.sync(); assertRenderActive();
      // Producer is closed; metadata edits target this owned handle only. No payload/sample-table mutation.
      let presentationHeaderPatch: Awaited<ReturnType<typeof applyMp4PresentationEditV1>> | null = null;
      if (retained.presentationHeaderPatchRequired) {
        const baseIo = mp4EditFileHandleV1(candidate);
        const io = {
          identity: async () => { assertRenderActive(); return baseIo.identity(); },
          read: async (at: number, length: number) => { assertRenderActive(); return baseIo.read(at, length); },
          write: async (at: number, data: Buffer) => { assertRenderActive(); return baseIo.write(at, data); },
          sync: async () => { assertRenderActive(); await baseIo.sync(); },
        };
        const plan = await planMp4PresentationEditV1(io, { ticks: sourceMedia.endTicks - sourceMedia.startTicks, timebase: sourceMedia.timebase }, sourceMedia.audio ? ["vide", "soun"] : ["vide"]);
        presentationHeaderPatch = await applyMp4PresentationEditV1(io, plan); assertRenderActive();
      }
      const outputSize = (await candidate.stat()).size;
      if (!outputSize || outputSize > size + 65_536) throw Error("PACKET_COPY_OUTPUT_SIZE_UNEXPECTED");
      const expectedOutput = { ...admission, expectedDuration: durationSeconds, requestedSourceStart: 0, requestedSourceEnd: durationSeconds, requestedDuration: durationSeconds };
      const outputMedia = admitGopSourceCopyMediaV2(await probe(temporary), expectedOutput, true);
      if (outputMedia.codecBindingCanonical !== sourceMedia.codecBindingCanonical) throw Error("PACKET_COPY_CODEC_CONFIG_CHANGED");
      const outputWindow = gopPacketWindowV3(outputMedia.startTicks, outputMedia.endTicks, outputMedia.timebase, "output", limits(outputMedia.timebase)), outputBytes = packetByteSourceV1(candidate, outputSize);
      await dependencies.readPackets(runtime.ffprobePath, temporary, async packet => outputWindow.accept(packet, await witnessAvcPacketV1(packet, outputBytes)),
        { timeoutMs: fullDecodeTimeoutMs(durationSeconds), onTerminal: r => packetReaders.push(r) });
      const copied = outputWindow.finish(outputMedia.videoDurationTicks), videoPacketProof = verifyGopPacketCopyV3(retained, copied);
      const outputFrameWindow = decodedPresentationWindowV1(outputMedia.startTicks, outputMedia.endTicks, outputMedia.timebase, "output");
      await (dependencies.readFrames ?? readDecodedFrameClocksV1)(runtime.ffprobePath, temporary!, async frame => outputFrameWindow.accept(frame),
        { timeoutMs: fullDecodeTimeoutMs(durationSeconds), onTerminal: r => frameReaders.push(r) });
      const outputPresentation = outputFrameWindow.finish(), presentationProof = verifyDecodedPresentationIdentityV1(sourcePresentation, outputPresentation);
      const decode = await dependencies.run(runtime.ffmpegPath, ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-i", temporary,
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", ...FFMPEG_PROGRESS_ARGS, "-"], fullDecodeTimeoutMs(durationSeconds), undefined, { ffmpegProgress: true });
      const frames = Number([...decode.stdout.matchAll(/^frame=[ \t]*(\d+)[ \t]*\r?$/gm)].at(-1)?.[1]);
      if (frames !== presentationProof.presentedFrames || !/^progress=end\r?$/m.test(decode.stdout)) throw Error("PACKET_COPY_DECODE_COUNT_MISMATCH");
      if (!!sourceMedia.audio !== !!outputMedia.audio) throw Error("GOP_COPY_ORIGINAL_AUDIO_STREAM_CHANGED");
      let audioEvidence: null | { identity: ReturnType<typeof verifyAacCutDecodedIdentityV1>; rawProof: ReturnType<typeof verifyCopiedAacPacketWindowV1>;
        reference: Awaited<ReturnType<typeof decodePcmWitnessV1>>; output: Awaited<ReturnType<typeof decodePcmWitnessV1>>;
        sourceRaw: ReturnType<ReturnType<typeof aacSourcePacketWindowV1>["finish"]>; outputRaw: ReturnType<ReturnType<typeof aacOutputPacketWitnessV1>["finish"]>; maxPrerollSamples: number } = null;
      if (sourceMedia.audio) {
      if (sourceMedia.audio!.codecBinding !== outputMedia.audio!.codecBinding) throw Error("MUXED_COPY_AUDIO_CONFIG_CHANGED");
      const maxAudioPrerollSamples = sourceMedia.audio!.config.sampleRate * maxPrerollSeconds;
      const outputAudioWitness = aacOutputPacketWitnessV1(sourceMedia.audio!.clock.sampleCount, maxAudioPrerollSamples);
      await (dependencies.readAudioPackets ?? readAacPacketsV1)(runtime.ffprobePath, temporary!, async packet =>
        outputAudioWitness.accept(packet, await aacPacketPayloadSha256V1(packet, outputBytes)),
        { timeoutMs: fullDecodeTimeoutMs(durationSeconds), onTerminal: r => audioPacketReaders.push(r) });
      const outputAudioRaw = outputAudioWitness.finish();
      const sourceAudioWitness = aacSourcePacketWindowV1(sourceMedia.audio!.clock.startSample + outputAudioRaw.rawStartSample, sourceMedia.audio!.clock.endSample);
      await (dependencies.readAudioPackets ?? readAacPacketsV1)(runtime.ffprobePath, sourcePath, async packet =>
        sourceAudioWitness.accept(packet, sourceAudioWitness.wantsPayload(packet) ? await aacPacketPayloadSha256V1(packet, bytes) : undefined),
        { timeoutMs: fullDecodeTimeoutMs(admission.expectedDuration), onTerminal: r => audioPacketReaders.push(r) });
      const sourceAudioRaw = sourceAudioWitness.finish();
      const audioPacketProof = verifyCopiedAacPacketWindowV1(sourceAudioRaw, outputAudioRaw, sourceMedia.audio!.clock.startSample);
      const audioRuntime = { executable: runtime.ffmpegPath, sampleRate: sourceMedia.audio!.config.sampleRate, channels: sourceMedia.audio!.config.channels,
        expectedSamples: sourceMedia.audio!.clock.sampleCount, timeoutMs: fullDecodeTimeoutMs(admission.expectedDuration) };
      const audioReference = await (dependencies.decodePcm ?? decodePcmWitnessV1)({ ...audioRuntime, source: sourcePath,
        referenceWindow: { startSample: sourceMedia.audio!.clock.startSample, endSample: sourceMedia.audio!.clock.endSample } });
      const audioOutput = await (dependencies.decodePcm ?? decodePcmWitnessV1)({ ...audioRuntime, source: temporary! });
      const audioIdentity = verifyAacCutDecodedIdentityV1(sourceMedia.audio!.clock, sourceMedia.audio!.config, audioReference, audioOutput, outputMedia.audio!.durationSamples);
      audioEvidence = { identity: audioIdentity, rawProof: audioPacketProof, reference: audioReference, output: audioOutput, sourceRaw: sourceAudioRaw, outputRaw: outputAudioRaw, maxPrerollSamples: maxAudioPrerollSamples };
      }
      const outputSha256 = await fileSha(candidate, outputSize);
      await stable(); if (await fileSha(source, size) !== runtime.expectedSourceSha256) throw Error("PACKET_COPY_SOURCE_CHANGED"); await monitor.check();
      const publish = async () => {
        assertRenderActive(); if (hash(project) !== projectSha256) throw Error("PACKET_COPY_PROJECT_CHANGED"); await stable();
        if ((await candidate!.stat()).size !== outputSize || await fileSha(candidate!, outputSize) !== outputSha256) throw Error("PACKET_COPY_CANDIDATE_CHANGED");
        const current = await lstat(temporary!); if (current.isSymbolicLink() || current.dev !== candidateIdentity!.dev || current.ino !== candidateIdentity!.ino) throw Error("PACKET_COPY_CANDIDATE_OWNER_CHANGED");
        await link(temporary!, output); const published = await lstat(output);
        if (published.isSymbolicLink() || published.dev !== candidateIdentity!.dev || published.ino !== candidateIdentity!.ino || published.size !== outputSize) throw Error("PACKET_COPY_PUBLICATION_OWNER_CHANGED");
      };
      if (runtime.withPublicationGuard) await runtime.withPublicationGuard(publish); else await publish();
      return { schema: "editkin.gop-source-copy-export/v3" as const, outputPath: output, outputSha256, sourceSha256: runtime.expectedSourceSha256,
        projectSha256, admission: { ...admission, policy: GOP_SOURCE_COPY_POLICY_V3 }, presentationHeaderPatch, sourceMedia, outputMedia, retained, copied, decodedVideoFrames: frames, duration: durationSeconds, bytes: outputSize,
        pixelOrAudioEncodingPasses: 0, audioStreams: sourceMedia.audio ? 1 : 0, audioIdentity: audioEvidence?.identity ?? null, audioEvidence, audioPacketReaders, videoPacketProof, sourcePresentation, outputPresentation, presentationProof, frameReaders, copiedVideoPacketsExact: true, requestedCutShiftTicks: 0, fullDecodeVerified: true,
        publicationIdentityVerified: true, packetReaders, packetReadCacheBytesEach: 1024 ** 2, mediaStagingBytes: 0, volumeWatch: monitor.receipt,
        elapsedMs: performance.now() - started, qualityCertified: false, certificationPerformed: false,
        scope: "single neutral AVC66/77/100 progressive8bit Rec709 fullGOP dependency prefix, boundedIDR preroll, exactdecodedpresentation andoptionaloriginalAAC-LC raw+floatPCMidentity; boundedpostroll withownededitlist andexactdecodedpresentation; hybrid/multi/othercodec/crossplayer/10h speed unqualified" };
    } finally {
      await monitor?.stop(); await candidate?.close(); await source.close();
      if (temporary && candidateIdentity) { const current = await lstat(temporary).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
        if (current) { if (current.isSymbolicLink() || current.dev !== candidateIdentity.dev || current.ino !== candidateIdentity.ino) throw Error("PACKET_COPY_CLEANUP_OWNER_CHANGED"); await rm(temporary); } }
      if (work) { const current = await lstat(work); if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase() || current.isSymbolicLink()
          || current.dev !== workIdentity?.dev || current.ino !== workIdentity?.ino || (await readBoundedFile(join(work, "owner.json"), 1024)).toString("utf8") !== owner
          || (await readdir(work)).join() !== "owner.json") throw Error("PACKET_COPY_WORK_OWNER_CHANGED"); await rm(join(work, "owner.json")); await rmdir(work); }
    }
  });
}
