import * as z from "zod/v4";
import { musicBeatsRequestSchemaV1, validateMusicBeatsReceiptV1, type MusicBeatsRequestV1, type MusicBeatsReceiptV1 } from "./musicBeatsTypesV1";
import { musicRhythmEventsInWindowV2, type MusicRhythmEventV2 } from "./musicRhythmV2";

const seconds = z.number().finite().min(0).max(604800);
const file = z.strictObject({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const beatReviewRequestSchemaV1 = z.strictObject({
  schema: z.literal("editkin.beat-review-request/v1"), title: z.string().trim().min(1).max(80),
  analysis: file, music: file,
  window: z.strictObject({ sourceStartSeconds: seconds, durationSeconds: z.number().finite().min(.25).max(60) }),
  montage: file.extend({ sourceStartSeconds: seconds }).optional(),
  reviewFps: z.number().finite().min(1).max(240).default(30),
  waveformBins: z.number().int().min(64).max(2048).default(1024),
  maximumFrameGroups: z.number().int().min(1).max(4).default(4),
}).superRefine((r, ctx) => {
  for (const time of [r.window.sourceStartSeconds, r.window.durationSeconds]) {
    if (Math.abs(time - Math.round(time * 16000) / 16000) > 1e-9)
      ctx.addIssue({ code: "custom", message: "Review audio window must use the 16000 Hz sample grid" });
  }
});
export type BeatReviewRequestV1 = z.infer<typeof beatReviewRequestSchemaV1>;
export interface BeatReviewEventV1 extends MusicRhythmEventV2 { kind: "pulse" | "bar"; offsetSeconds: number }

/** A diagnostic plan, never a marker command or musical ground truth. */
export function planBeatReviewSheetV1(value: unknown, receiptValue: MusicBeatsReceiptV1, nativeRequestValue: MusicBeatsRequestV1) {
  const request = beatReviewRequestSchemaV1.parse(value), nativeRequest = musicBeatsRequestSchemaV1.parse(nativeRequestValue);
  const receipt = validateMusicBeatsReceiptV1(receiptValue, nativeRequest, {
    sourceSha256: receiptValue.sourceSha256, sourceBytes: receiptValue.sourceBytes, ffmpegSha256: receiptValue.ffmpegSha256,
  });
  const analysis = receipt.analysis, start = request.window.sourceStartSeconds, end = start + request.window.durationSeconds;
  if (start < nativeRequest.sourceStartSeconds || end > nativeRequest.sourceStartSeconds + nativeRequest.durationSeconds
    || end > analysis.sourceStartSeconds + analysis.durationSeconds + 1e-9) throw Error("BEAT_REVIEW_WINDOW_NOT_COVERED");
  const events: BeatReviewEventV1[] = [];
  const append = (kind: "pulse" | "bar", event: MusicRhythmEventV2) => {
    if (event.timeSeconds < start || event.timeSeconds >= end) return;
    if (events.length === 4096) throw Error("BEAT_REVIEW_EVENT_LIMIT");
    events.push({ ...event, kind, offsetSeconds: event.timeSeconds - start });
  };
  if (nativeRequest.rhythmRefinementV2) {
    const refined = musicRhythmEventsInWindowV2(analysis, { sourceStartSeconds: start,
      sourceEndSeconds: Math.min(end, analysis.sourceStartSeconds + analysis.durationSeconds), priorBpm: nativeRequest.priorBpm });
    for (const e of refined.pulses) append("pulse", e);
    for (const e of refined.bars) append("bar", e);
  } else {
    analysis.beats.forEach((b, i) => {
      const source = { timeSeconds: b.timeSeconds, confidence: b.confidence, inferred: false, leftNativeIndex: i, rightNativeIndex: null };
      append("pulse", source);
      if (b.downbeat) append("bar", { ...source, confidence: b.downbeatConfidence });
    });
  }
  events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.kind.localeCompare(b.kind));
  const bars = events.filter(e => e.kind === "bar"), pool = bars.length ? bars : events.filter(e => e.kind === "pulse");
  const count = request.montage ? Math.min(request.maximumFrameGroups, pool.length || request.maximumFrameGroups) : 0;
  const lastFrame = Math.ceil(request.window.durationSeconds * request.reviewFps) - 1;
  const groups = Array.from({ length: count }, (_, i) => {
    const event = pool.length ? pool[count === 1 ? 0 : Math.round(i * (pool.length - 1) / (count - 1))] : null;
    const offset = event?.offsetSeconds ?? request.window.durationSeconds * (i + .5) / count;
    const center = Math.max(0, Math.min(lastFrame, Math.round(offset * request.reviewFps)));
    const frames = [...new Set([center - 1, center, center + 1].filter(n => n >= 0 && n <= lastFrame))];
    return { event, centerFrame: center, frames, sourceSeconds: start + offset };
  });
  return {
    schema: "editkin.beat-review-plan/v1" as const, request, events, groups,
    frameIndices: [...new Set(groups.flatMap(g => g.frames))].sort((a, b) => a - b),
    sampleCount: Math.round(request.window.durationSeconds * 16000),
    tempo: analysis.rhythmV2?.tempo ?? { rawBpm: analysis.tempoBpm, bpm: analysis.tempoBpm,
      priorBpm: nativeRequest.priorBpm ?? null, state: "legacy-observations", confidence: analysis.tempoConfidence },
    samplingConvention: "excerpt-relative-fps-grid-not-decoder-pts" as const,
    alignmentAuthority: "caller_asserted_constant_source_offset_only" as const,
    quality: { visualReview: "ART_PENDING_CLAUDE" as const, listeningReview: "PENDING_HAO" as const,
      fMeasure: "NOT_MEASURED" as const, humanQualityCertified: false as const, vaDefaultEligible: false as const },
  };
}
export type BeatReviewPlanV1 = ReturnType<typeof planBeatReviewSheetV1>;

/** Every decoded sample belongs to one bin. Audition is explicitly resampled mono, not source-quality evidence. */
export function reduceBeatReviewPcmV1(bytes: Uint8Array, sampleCount: number, binCount: number) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 4000 || sampleCount > 960000 || bytes.byteLength !== sampleCount * 4
    || !Number.isInteger(binCount) || binCount < 64 || binCount > 2048) throw Error("BEAT_REVIEW_PCM_SIZE_OR_BINS_INVALID");
  const bins = Array.from({ length: binCount }, () => ({ min: Infinity, max: -Infinity, samples: 0 }));
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pcm16 = new Uint8Array(sampleCount * 2);
  const output = new DataView(pcm16.buffer); let clippedSamples = 0, peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = input.getFloat32(i * 4, true);
    if (!Number.isFinite(sample)) throw Error("BEAT_REVIEW_PCM_NOT_FINITE");
    const bin = bins[Math.floor(i * binCount / sampleCount)];
    bin.min = Math.min(bin.min, sample); bin.max = Math.max(bin.max, sample); bin.samples++;
    peak = Math.max(peak, Math.abs(sample)); if (Math.abs(sample) > 1) clippedSamples++;
    output.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true);
  }
  return { bins, samples: sampleCount, sampleRate: 16000 as const, peak, clippedSamples, pcm16 };
}
