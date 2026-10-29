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
import { packetByteSourceV1, witnessAvcPacketV1, exactPacketWindowV1 } from "./sourcePacketV1";
import { readSourcePacketsV1, type PacketReaderReceiptV1 } from "./sourcePacketReaderV1";
import { EXACT_PACKET_COPY_POLICY_V1, admitPacketCopyProjectV1, admitPacketCopyMediaV1 } from "./packetCopyAdmissionV1";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function fileSha(handle: FileHandle, size: number) {
  const buffer = Buffer.allocUnsafe(1024 ** 2), digest = createHash("sha256"); let offset = 0;
  while (offset < size) { assertRenderActive(); const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!read.bytesRead) throw Error("PACKET_COPY_FILE_ENDED_EARLY"); digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead; }
  return digest.digest("hex");
}
export interface PacketCopyRuntimeV1 {
  assetBase: string; ffmpegPath: string; ffprobePath: string; expectedSourceSha256: string; policy: typeof EXACT_PACKET_COPY_POLICY_V1;
  signal?: AbortSignal; timeoutMs?: number; withPublicationGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
}
export interface PacketCopyDependenciesV1 { run: typeof runProcess; readPackets: typeof readSourcePacketsV1; volumeProbe?: SourcePreservingVolumeProbeV1 }
/** LV03 cut candidate: only measured exact IDR/no-reorder video; other requests refuse for normal rendering. */
export async function renderPacketCopyProjectV1(project: EditProject, outputPath: string, runtime: PacketCopyRuntimeV1,
  dependencies: PacketCopyDependenciesV1 = { run: runProcess, readPackets: readSourcePacketsV1 }) {
  assertProofStillRouteV1(project, "packet-copy-v1");
  const started = performance.now(), projectSha256 = hash(project), admission = admitPacketCopyProjectV1(project, runtime.policy);
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
    const packetReaders: PacketReaderReceiptV1[] = [];
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
      const sourceMedia = admitPacketCopyMediaV1(await probe(sourcePath), admission);
      const sourceWindow = exactPacketWindowV1(sourceMedia.startTicks, sourceMedia.endTicks, sourceMedia.timebase), bytes = packetByteSourceV1(source, size);
      await dependencies.readPackets(runtime.ffprobePath, sourcePath, async packet => sourceWindow.accept(packet, await witnessAvcPacketV1(packet, bytes)),
        { timeoutMs: fullDecodeTimeoutMs(admission.expectedDuration), onTerminal: r => packetReaders.push(r) });
      const retained = sourceWindow.finish(); await stable(); await monitor.check();
      temporary = join(parent, `.${basename(output)}.${token}.packet-copy.part.mp4`);
      candidate = await open(temporary, "wx+"); const ci = await candidate.stat(); candidateIdentity = { dev: ci.dev, ino: ci.ino };
      const startSeconds = sourceMedia.startTicks * sourceMedia.timebase.numerator / sourceMedia.timebase.denominator;
      const durationSeconds = (sourceMedia.endTicks - sourceMedia.startTicks) * sourceMedia.timebase.numerator / sourceMedia.timebase.denominator;
      // Input seek is permitted only after the source packet/IDR proof; output is independently verified below.
      await dependencies.run(runtime.ffmpegPath, ["-hide_banner", "-v", "error", "-nostdin", "-y", "-threads", "1", "-ss", String(startSeconds), "-i", sourcePath,
        "-t", String(durationSeconds), "-map", "0:v:0", "-an", "-c:v", "copy", "-copytb", "1", "-avoid_negative_ts", "make_zero", ...FFMPEG_PROGRESS_ARGS, temporary],
      fullDecodeTimeoutMs(admission.requestedDuration), undefined, { ffmpegProgress: true, paths: [temporary] });
      await candidate.sync(); assertRenderActive(); const outputSize = (await candidate.stat()).size;
      if (!outputSize || outputSize > size + 65_536) throw Error("PACKET_COPY_OUTPUT_SIZE_UNEXPECTED");
      const expectedOutput = { ...admission, expectedDuration: durationSeconds, requestedSourceStart: 0, requestedSourceEnd: durationSeconds, requestedDuration: durationSeconds };
      const outputMedia = admitPacketCopyMediaV1(await probe(temporary), expectedOutput);
      if (outputMedia.codecBindingCanonical !== sourceMedia.codecBindingCanonical) throw Error("PACKET_COPY_CODEC_CONFIG_CHANGED");
      const outputWindow = exactPacketWindowV1(outputMedia.startTicks, outputMedia.endTicks, outputMedia.timebase), outputBytes = packetByteSourceV1(candidate, outputSize);
      await dependencies.readPackets(runtime.ffprobePath, temporary, async packet => outputWindow.accept(packet, await witnessAvcPacketV1(packet, outputBytes)),
        { timeoutMs: fullDecodeTimeoutMs(durationSeconds), onTerminal: r => packetReaders.push(r) });
      const copied = outputWindow.finish();
      if (copied.retainedPackets !== retained.retainedPackets || copied.sourcePackets !== copied.retainedPackets
        || copied.payloadAndTimelineSha256 !== retained.payloadAndTimelineSha256) throw Error("PACKET_COPY_PAYLOAD_OR_TIMELINE_CHANGED");
      const decode = await dependencies.run(runtime.ffmpegPath, ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-i", temporary,
        "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", ...FFMPEG_PROGRESS_ARGS, "-"], fullDecodeTimeoutMs(durationSeconds), undefined, { ffmpegProgress: true });
      const frames = Number([...decode.stdout.matchAll(/^frame=[ \t]*(\d+)[ \t]*\r?$/gm)].at(-1)?.[1]);
      if (frames !== retained.retainedPackets || !/^progress=end\r?$/m.test(decode.stdout)) throw Error("PACKET_COPY_DECODE_COUNT_MISMATCH");
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
      return { schema: "editkin.exact-packet-copy-export/v1" as const, outputPath: output, outputSha256, sourceSha256: runtime.expectedSourceSha256,
        projectSha256, admission, sourceMedia, outputMedia, retained, copied, decodedVideoFrames: frames, duration: durationSeconds, bytes: outputSize,
        pixelOrAudioEncodingPasses: 0, audioStreams: 0, copiedVideoPacketsExact: true, requestedCutShiftTicks: 0, fullDecodeVerified: true,
        publicationIdentityVerified: true, packetReaders, packetReadCacheBytesEach: 1024 ** 2, mediaStagingBytes: 0, volumeWatch: monitor.receipt,
        elapsedMs: performance.now() - started, qualityCertified: false, certificationPerformed: false,
        scope: "single neutral H264 AVC no-reorder video-only exactIDR window; audio/B-frame/non-IDR/hybrid/multi-source and10h speed remain unqualified" };
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
