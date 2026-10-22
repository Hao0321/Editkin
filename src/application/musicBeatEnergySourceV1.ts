import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { analyzeMusicBeatsV1, musicBeatFileShaV1, type MusicBeatsRuntimeV1 } from "./musicBeats";
import { musicBeatsRequestSchemaV1 } from "./musicBeatsTypesV1";
import { createMusicBeatEnergyAccumulatorV1, planMusicBeatEnergyV1 } from "./musicBeatEnergyV1";
import { runAnalysisProcess } from "./analysisProcess";
import { canonicalJson } from "../shared/canonicalJson";

export const musicBeatEnergyRequestSchemaV1 = musicBeatsRequestSchemaV1.extend({
  durationSeconds: z.number().finite().min(.25).max(60), expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Same integer-second preroll/sample trim as native audio_beats_codec.rs; direct fractional seeking changes resampling phase. */
export function musicBeatEnergyDecoderArgsV1(value: unknown) {
  const request = musicBeatsRequestSchemaV1.parse(value), count = Math.round(request.durationSeconds * 16000);
  const anchor = Math.max(0, Math.floor(request.sourceStartSeconds) - 1), trim = Math.round((request.sourceStartSeconds - anchor) * 16000);
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "mov,matroska,webm,wav,flac,mp3,ogg,aac", ...(anchor > 0 ? ["-ss", String(anchor)] : []),
    "-i", request.sourcePath, "-map", "0:a:0", "-vn", "-sn", "-dn", "-filter_threads", "1", "-af",
    `aresample=16000,aformat=sample_fmts=flt:channel_layouts=mono,atrim=start_sample=${trim}:end_sample=${trim + count},asetpts=PTS-STARTPTS`,
    "-t", (count / 16000).toFixed(9), "-c:a", "pcm_f32le", "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"];
}

/** Strict native analysis/cache plus one original-source RMS decode. The returned small evidence may be reused by style planners. */
export async function analyzeMusicBeatEnergySourceV1(value: unknown, runtime: MusicBeatsRuntimeV1) {
  const { expectedSourceSha256, ...request } = musicBeatEnergyRequestSchemaV1.parse(value), upstream = runtime.signal;
  const timeoutMs = runtime.timeoutMs ?? 60000, started = Date.now();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error("MUSIC_BEAT_ENERGY_TIMEOUT_INVALID");
  const owner = new AbortController(), abort = () => owner.abort(upstream?.reason), signal = owner.signal;
  upstream?.throwIfAborted(); upstream?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => owner.abort(Error("MUSIC_BEAT_ENERGY_TOTAL_TIMEOUT")), timeoutMs);
  const tools = { ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, nativeCorePath: runtime.nativeCorePath, cacheRoot: runtime.cacheRoot };
  try {
    const sourceBefore = await musicBeatFileShaV1(request.sourcePath, signal);
    if (sourceBefore.sha256 !== expectedSourceSha256) throw Error("MUSIC_BEAT_ENERGY_SOURCE_SHA_MISMATCH");
    const analysis = await analyzeMusicBeatsV1(request, { ...tools, signal, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)) });
    signal.throwIfAborted();
    if (analysis.binding.source.sha256 !== expectedSourceSha256 || canonicalJson(analysis.binding.source) !== canonicalJson(sourceBefore)) throw Error("MUSIC_BEAT_ENERGY_SOURCE_CHANGED");
    const layout = planMusicBeatEnergyV1(analysis.receipt, request), accumulator = createMusicBeatEnergyAccumulatorV1(layout), pcmHash = createHash("sha256");
    const decoded = await runAnalysisProcess(tools.ffmpegPath, musicBeatEnergyDecoderArgsV1(request),
      { signal, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), label: "music-beat-energy-source", maximumStdout: layout.decodedBytes,
        maximumStderr: 16384, captureStdout: false, onStdout: chunk => {
          signal.throwIfAborted(); pcmHash.update(chunk);
          for (let offset = 0; offset < chunk.length; offset += 65536) accumulator.push(chunk.subarray(offset, offset + 65536));
        } });
    if (decoded.stdout.length !== 0) throw Error("MUSIC_BEAT_ENERGY_PCM_CAPTURE_FORBIDDEN");
    const energy = accumulator.finish(), pcmSha256 = pcmHash.digest("hex");
    if (pcmSha256 !== analysis.receipt.pcmSha256) throw Error("MUSIC_BEAT_ENERGY_NATIVE_PCM_MISMATCH");
    const identities = [analysis.binding.source, analysis.binding.ffmpeg, analysis.binding.ffprobe, analysis.binding.core];
    const paths = [request.sourcePath, tools.ffmpegPath, tools.ffprobePath, tools.nativeCorePath];
    for (let i = 0; i < paths.length; i++) {
      signal.throwIfAborted();
      if (canonicalJson(await musicBeatFileShaV1(paths[i], signal)) !== canonicalJson(identities[i])) throw Error("MUSIC_BEAT_ENERGY_SOURCE_OR_TOOL_CHANGED_AFTER_DECODE");
    }
    signal.throwIfAborted();
    const binding = { schema: "editkin.music-beat-energy-binding/v1", request, source: analysis.binding.source,
      ffmpeg: analysis.binding.ffmpeg, ffprobe: analysis.binding.ffprobe, core: analysis.binding.core,
      nativeAnalysisKey: analysis.key, nativeReceiptSha256: analysis.receiptSha256, sampleBoundaryPolicy: layout.sampleBoundaryPolicy,
      normalization: energy.normalization, pcmSha256, nativePcmExact: true, sourceFilesRecheckedAfterDecode: true };
    const { inputChunks: _chunks, maximumChunkBytes: _chunkBytes, maximumIncompleteBytes: _carry, ...measure } = energy;
    const evidenceSha256 = createHash("sha256").update(canonicalJson({ binding, layout, energy: measure })).digest("hex");
    return { schema: "editkin.music-beat-energy-source/v1" as const, binding, layout, energy, evidenceSha256,
      nativeAnalysis: analysis, nativeCacheHit: analysis.cacheHit, rmsDecodeCalls: 1, pcmCapturedOrStagedBytes: 0,
      elapsedMs: Date.now() - started, projectEdits: 0, defaultEnabled: false as const, humanMusicalEnergyCertified: false as const };
  } finally { clearTimeout(timer); upstream?.removeEventListener("abort", abort); }
}
