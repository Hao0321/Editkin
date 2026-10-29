import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import { PNG } from "pngjs";
import { runAnalysisProcess } from "../../src/application/analysisProcess";
import { musicBeatFileShaV1 } from "../../src/application/musicBeats";
import { MUSIC_BEATS_RESULT_BYTES_V1, validateMusicBeatsReceiptV1 } from "../../src/application/musicBeatsTypesV1";
import { beatReviewRequestSchemaV1, planBeatReviewSheetV1, reduceBeatReviewPcmV1 } from "../../src/application/beatReviewSheetV1";
import { beatReviewHtmlV1, beatReviewSvgV1 } from "../../src/application/beatReviewSheetSvgV1";
import { readBoundedFile } from "../../src/shared/boundedFile";
import { assertLocalMediaPath } from "../../src/shared/localMediaPath";
import { canonicalJson } from "../../src/shared/canonicalJson";
import { probeVolumeSpace } from "../../src/render/renderDiskSpace";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.strictObject({ sha256: shaSchema, bytes: z.number().int().positive().max(64 * 1024 ** 3) });
const cacheSchema = z.strictObject({ schema: z.literal("editkin.music-beats-cache/v1"), key: shaSchema,
  receiptSha256: shaSchema, receipt: z.unknown(), binding: z.strictObject({
    schema: z.literal("editkin.music-beats-cache-key/v1"), source: identity, ffmpeg: identity, ffprobe: identity, core: identity,
    sourceStartSeconds: z.number().finite().min(0).max(604800), durationSeconds: z.number().finite().positive().max(86400),
    priorBpm: z.number().finite().min(30).max(300).nullable(), analysisRecipe: z.literal("spectral-flux-autocorrelation-dp-native/v1"),
    rhythmRefinementV2: z.literal(true).optional(),
  }),
});

/** Refuse links/aliases before local reads or creating the one new output directory. */
async function plainPath(path: string) {
  assertLocalMediaPath(path);
  if (!isAbsolute(path)) throw Error("BEAT_REVIEW_ABSOLUTE_LOCAL_PATH_REQUIRED");
  const absolute = resolve(path);
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    if ((await lstat(cursor)).isSymbolicLink()) throw Error("BEAT_REVIEW_LINK_PATH_REFUSED");
    if (dirname(cursor) === cursor) break;
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw Error("BEAT_REVIEW_PATH_ALIAS_REFUSED");
}

function auditionWav(pcm16: Uint8Array) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm16.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

export interface BeatReviewRuntimeV1 { ffmpegPath: string; timeoutMs?: number; signal?: AbortSignal }
/** Serial, bounded media readout only. No analysis, project edit, overwrite, model, network or automatic approval. */
export async function createBeatReviewContactSheetV1(value: unknown, outputDirectory: string, runtime: BeatReviewRuntimeV1) {
  const request = beatReviewRequestSchemaV1.parse(value), ffmpeg = runtime.ffmpegPath;
  const timeoutMs = runtime.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error("BEAT_REVIEW_TIMEOUT_INVALID");
  assertLocalMediaPath(outputDirectory);
  if (!isAbsolute(outputDirectory)) throw Error("BEAT_REVIEW_ABSOLUTE_LOCAL_PATH_REQUIRED");
  const upstream = runtime.signal, out = resolve(outputDirectory), owner = new AbortController(), externalAbort = () => owner.abort(upstream?.reason);
  upstream?.throwIfAborted(); upstream?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => owner.abort(Error("BEAT_REVIEW_TOTAL_TIMEOUT")), timeoutMs), started = Date.now();
  const signal = owner.signal, paths = [request.analysis.path, request.music.path, ffmpeg, ...(request.montage ? [request.montage.path] : [])];
  let ownedDirectory: { dev: number; ino: number; token: string } | undefined;
  const assertOwner = async () => {
    if (!ownedDirectory) throw Error("BEAT_REVIEW_OUTPUT_NOT_OWNED");
    await plainPath(out); const now = await lstat(out);
    if (!now.isDirectory() || now.dev !== ownedDirectory.dev || now.ino !== ownedDirectory.ino
      || (await readBoundedFile(join(out, ".owner.json"), 2048)).toString("utf8") !== ownedDirectory.token) throw Error("BEAT_REVIEW_OUTPUT_OWNER_CHANGED");
  };
  try {
    for (const path of paths) { signal.throwIfAborted(); await plainPath(path); }
    await plainPath(dirname(out));
    try { await lstat(out); throw Error("BEAT_REVIEW_OUTPUT_ALREADY_EXISTS"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const cacheBytes = await readBoundedFile(request.analysis.path, MUSIC_BEATS_RESULT_BYTES_V1);
    if (sha(cacheBytes) !== request.analysis.sha256) throw Error("BEAT_REVIEW_ANALYSIS_FILE_CHANGED");
    const cache = cacheSchema.parse(JSON.parse(cacheBytes.toString("utf8"))), binding = cache.binding;
    if (sha(canonicalJson(binding)) !== cache.key || sha(canonicalJson(cache.receipt)) !== cache.receiptSha256) throw Error("BEAT_REVIEW_CACHE_DIGEST_INVALID");
    const music = await musicBeatFileShaV1(request.music.path, signal), tool = await musicBeatFileShaV1(ffmpeg, signal);
    if (request.music.sha256 !== music.sha256 || canonicalJson(music) !== canonicalJson(binding.source)
      || canonicalJson(tool) !== canonicalJson(binding.ffmpeg)) throw Error("BEAT_REVIEW_SOURCE_OR_TOOL_MISMATCH");
    const nativeRequest = { sourcePath: request.music.path, sourceStartSeconds: binding.sourceStartSeconds,
      durationSeconds: binding.durationSeconds, ...(binding.priorBpm === null ? {} : { priorBpm: binding.priorBpm }),
      ...(binding.rhythmRefinementV2 ? { rhythmRefinementV2: true as const } : {}) };
    const receipt = validateMusicBeatsReceiptV1(cache.receipt, nativeRequest, { sourceSha256: music.sha256, sourceBytes: music.bytes, ffmpegSha256: tool.sha256 });
    const plan = planBeatReviewSheetV1(request, receipt, nativeRequest);
    const montage = request.montage ? await musicBeatFileShaV1(request.montage.path, signal) : undefined;
    if (montage && montage.sha256 !== request.montage!.sha256) throw Error("BEAT_REVIEW_MONTAGE_CHANGED");
    const volume = await probeVolumeSpace(dirname(out));
    if (!volume || volume.availableBytes < 96 * 1024 ** 2) throw Error("BEAT_REVIEW_OUTPUT_SPACE_SHORT_OR_UNKNOWN");
    signal.throwIfAborted(); await mkdir(out);
    const directory = await lstat(out), token = JSON.stringify({ schema: "editkin.beat-review-output-owner/v1", pid: process.pid, token: randomUUID() });
    await writeFile(join(out, ".owner.json"), token, { flag: "wx" }); ownedDirectory = { dev: directory.dev, ino: directory.ino, token };
    const run = (args: string[], maximumStdout: number) => runAnalysisProcess(ffmpeg, args, { signal,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), label: "beat-review-readout", maximumStdout, maximumStderr: 16384 });
    const prefix = ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1"];
    const decoded = await run([...prefix, "-ss", String(request.window.sourceStartSeconds), "-i", request.music.path,
      "-t", String(request.window.durationSeconds), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], plan.sampleCount * 4);
    const { pcm16, ...waveform } = reduceBeatReviewPcmV1(decoded.stdout, plan.sampleCount, request.waveformBins);
    const wav = auditionWav(pcm16), thumbnails = new Map<number, string>(), frames: { frame: number; bytes: number; sha256: string; requestedVideoSeconds: number }[] = [];
    if (request.montage) {
      const select = plan.frameIndices.map(n => `eq(n,${n})`).join("+");
      const filter = `setpts=PTS-STARTPTS,fps=${request.reviewFps}:start_time=0,select='${select}',scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1,format=rgba`;
      const rgba = await run([...prefix, "-ss", String(request.montage.sourceStartSeconds), "-i", request.montage.path,
        "-t", String(request.window.durationSeconds), "-an", "-vf", filter, "-frames:v", String(plan.frameIndices.length),
        "-fps_mode", "passthrough", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], plan.frameIndices.length * 320 * 180 * 4);
      const frameBytes = 320 * 180 * 4;
      if (rgba.stdout.length !== plan.frameIndices.length * frameBytes) throw Error("BEAT_REVIEW_FRAME_COUNT_MISMATCH");
      plan.frameIndices.forEach((frame, i) => {
        const png = PNG.sync.write({ width: 320, height: 180, data: rgba.stdout.subarray(i * frameBytes, (i + 1) * frameBytes) } as PNG);
        thumbnails.set(frame, `data:image/png;base64,${png.toString("base64")}`);
        frames.push({ frame, bytes: png.length, sha256: sha(png), requestedVideoSeconds: request.montage!.sourceStartSeconds + frame / request.reviewFps });
      });
    }
    const svg = Buffer.from(beatReviewSvgV1(plan, waveform, thumbnails)), html = Buffer.from(beatReviewHtmlV1(request.title, svg.toString("utf8"), wav.toString("base64")));
    if (svg.length > 8 * 1024 ** 2 || html.length > 12 * 1024 ** 2) throw Error("BEAT_REVIEW_DOCUMENT_BYTES_EXCEEDED");
    await assertOwner(); signal.throwIfAborted(); await writeFile(join(out, "review.svg"), svg, { flag: "wx" });
    const raster = await run([...prefix, "-i", join(out, "review.svg"), "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], 8 * 1024 ** 2);
    const png = PNG.sync.read(raster.stdout);
    if (png.width !== 1200 || png.height !== 470 + plan.groups.length * 230) throw Error("BEAT_REVIEW_RASTER_SIZE_MISMATCH");
    const proof = [{ path: request.analysis.path, sha256: request.analysis.sha256, bytes: cacheBytes.length },
      { path: request.music.path, ...music }, { path: ffmpeg, ...tool }, ...(montage ? [{ path: request.montage!.path, ...montage }] : [])];
    for (const expected of proof) {
      signal.throwIfAborted(); await plainPath(expected.path); const current = await musicBeatFileShaV1(expected.path, signal);
      if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256) throw Error("BEAT_REVIEW_INPUT_CHANGED_BEFORE_PUBLISH");
    }
    const data = new Map<string, Buffer>([["review.svg", svg], ["review.html", html], ["audition.wav", wav], ["review.png", raster.stdout],
      ["plan.json", Buffer.from(JSON.stringify({ plan, waveform, frames }, null, 2))]]);
    if ([...data.values()].reduce((n, b) => n + b.length, 0) > 32 * 1024 ** 2) throw Error("BEAT_REVIEW_ARTIFACT_BYTES_EXCEEDED");
    await assertOwner(); signal.throwIfAborted();
    for (const [name, bytes] of data) if (name !== "review.svg") await writeFile(join(out, name), bytes, { flag: "wx" });
    const files = [];
    for (const [name, bytes] of data) {
      if (sha(await readBoundedFile(join(out, name), 32 * 1024 ** 2)) !== sha(bytes)) throw Error("BEAT_REVIEW_OUTPUT_CHANGED");
      files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
    }
    const result = { schema: "editkin.beat-review-sheet/v1", status: "REVIEW_READY_NOT_APPROVED", quality: plan.quality,
      sourceProof: proof, analysisKey: cache.key, receiptSha256: cache.receiptSha256, analysisCalls: 0,
      sourceInputsRecheckedAfterMedia: true, waveformSamples: waveform.samples, waveformBins: waveform.bins.length,
      events: plan.events.length, inferredBars: plan.events.filter(e => e.kind === "bar" && e.inferred).length,
      frameGroups: plan.groups.length, decodedReviewFrames: frames.length, montageProvided: Boolean(request.montage),
      samplingConvention: plan.samplingConvention, alignmentAuthority: plan.alignmentAuthority,
      audition: { sampleRate: 16000, channels: 1, bitsPerSample: 16, clippedSamples: waveform.clippedSamples, sourceQualityEvidence: false },
      files, elapsedMs: Date.now() - started, projectEdits: 0, privateVAChanged: false, defaultEnabled: false };
    await assertOwner(); signal.throwIfAborted();
    await writeFile(join(out, "RESULT.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    return result;
  } catch (error) {
    if (ownedDirectory) {
      try { await assertOwner(); await writeFile(join(out, "FAILURE.json"), JSON.stringify({ status: "FAILED_NOT_REVIEW_READY", error: String(error), analysisCalls: 0 }), { flag: "wx" }); }
      catch { /* Never overwrite or take ownership of a changed output directory. */ }
    }
    throw error;
  } finally { clearTimeout(timer); upstream?.removeEventListener("abort", externalAbort); }
}
