import * as z from "zod/v4";
import { musicRhythmSchemaV2, validateMusicRhythmV2 } from "./musicRhythmV2";

export const MUSIC_BEATS_RESULT_BYTES_V1 = 64 * 1024 ** 2;
export const musicBeatsRequestSchemaV1 = z.strictObject({
  sourcePath: z.string().min(1).max(4096), sourceStartSeconds: z.number().finite().min(0).max(604_800),
  durationSeconds: z.number().finite().positive().max(86_400), priorBpm: z.number().finite().min(30).max(300).optional(),
  rhythmRefinementV2: z.literal(true).optional(),
});
export type MusicBeatsRequestV1 = z.infer<typeof musicBeatsRequestSchemaV1>;
const clock = z.number().finite().min(0).max(691_200), unit = z.number().finite().min(0).max(1), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const musicBeatsReceiptSchemaV1 = z.strictObject({
  schema: z.literal("editkin.music-beats-receipt/v1"), sourceSha256: sha, sourceBytes: z.number().int().positive().max(64 * 1024 ** 3),
  ffmpegSha256: sha, pcmSha256: sha, decodedBytes: z.number().int().positive().max(5_529_600_000),
  pcmStagedBytes: z.literal(0), maximumPcmQueueBytes: z.literal(131_072), elapsedMs: z.number().finite().nonnegative(),
  analysis: z.strictObject({
    schema: z.literal("editkin.music-beats-analysis/v1"), executor: z.literal("hao-core-spectral-flux-autocorrelation-dp/v1"),
    sampleRate: z.literal(16_000), decodedSamples: z.number().int().positive().max(1_382_400_000), durationSeconds: z.number().finite().positive().max(86_400),
    sourceStartSeconds: clock, fftSize: z.literal(1024), hopSamples: z.literal(160), peakFeatureFrames: z.number().int().min(0).max(6400), maximumFeatureFrames: z.literal(6400),
    tempoBpm: z.number().finite().min(30).max(300).nullable(), tempoConfidence: unit,
    meterHypothesis: z.literal("four-beat-accent-hypothesis; not a learned meter classifier"),
    onsets: z.array(z.strictObject({ timeSeconds: clock, strength: unit })).max(1_000_000),
    beats: z.array(z.strictObject({ timeSeconds: clock, confidence: unit, downbeat: z.boolean(), downbeatConfidence: unit })).max(400_000),
    tempoWindows: z.array(z.strictObject({ startSeconds: clock, endSeconds: clock, bpm: z.number().finite().min(30).max(300), confidence: unit })).max(2000),
    sections: z.array(z.strictObject({ timeSeconds: clock, novelty: z.number().finite().nonnegative(), energyBefore: z.number().finite().nonnegative(), energyAfter: z.number().finite().nonnegative() })).max(30_000),
    qualityState: z.literal("analysis_candidate_real_music_quality_unmeasured"),
    rhythmV2: musicRhythmSchemaV2.optional(),
  }),
  decoderAudit: z.array(z.object({ sourceId: z.literal("music-beats-source"), pid: z.number().int().positive(), reason: z.literal("finished"),
    exitBeforeCleanup: z.literal(0), exitCode: z.literal(0), treeClosed: z.literal(true), pipeThreadsClosed: z.literal(true),
    decodedBytes: z.number().int().positive(), expectedBytes: z.number().int().positive(), maxQueuedChunks: z.literal(2), chunkBytes: z.literal(32_768),
    elapsedMs: z.number().finite().nonnegative(), stderr: z.string().max(8192), cleanupError: z.null() })).length(1),
});
export type MusicBeatsReceiptV1 = z.infer<typeof musicBeatsReceiptSchemaV1>;

export function validateMusicBeatsReceiptV1(value: unknown, request: MusicBeatsRequestV1,
  identity: { sourceSha256: string; sourceBytes: number; ffmpegSha256: string }): MusicBeatsReceiptV1 {
  const parsed = musicBeatsReceiptSchemaV1.parse(value), analysis = parsed.analysis, count = Math.round(request.durationSeconds * 16_000);
  if (parsed.sourceSha256 !== identity.sourceSha256 || parsed.sourceBytes !== identity.sourceBytes || parsed.ffmpegSha256 !== identity.ffmpegSha256
    || parsed.decodedBytes !== count * 4 || analysis.decodedSamples !== count || Math.abs(analysis.durationSeconds - count / 16_000) > 1e-8
    || analysis.sourceStartSeconds !== request.sourceStartSeconds || parsed.decoderAudit[0].decodedBytes !== count * 4
    || parsed.decoderAudit[0].expectedBytes !== count * 4) throw Error("MUSIC_BEATS_RECEIPT_IDENTITY_MISMATCH");
  for (const events of [analysis.onsets, analysis.beats, analysis.sections]) {
    let previous = -Infinity;
    for (const event of events) {
      if (event.timeSeconds < request.sourceStartSeconds || event.timeSeconds >= request.sourceStartSeconds + analysis.durationSeconds
        || event.timeSeconds <= previous) throw Error("MUSIC_BEATS_EVENT_CLOCK_INVALID");
      previous = event.timeSeconds;
    }
  }
  if (analysis.tempoBpm === null && (analysis.beats.length || analysis.tempoWindows.length || analysis.tempoConfidence !== 0)) throw Error("MUSIC_BEATS_TEMPO_INVALID");
  if (request.rhythmRefinementV2) validateMusicRhythmV2(analysis.rhythmV2, analysis, request.priorBpm);
  else if (analysis.rhythmV2 !== undefined) throw Error("MUSIC_RHYTHM_EXPLICIT_REQUEST_REQUIRED");
  return parsed;
}
