import { musicBeatsRequestSchemaV1, validateMusicBeatsReceiptV1, type MusicBeatsReceiptV1, type MusicBeatsRequestV1 } from "./musicBeatsTypesV1";
import { musicRhythmEventsInWindowV2, type MusicRhythmEventV2 } from "./musicRhythmV2";

const layouts = new WeakSet<MusicBeatEnergyLayoutV1>();
/** Source sample intervals only. Neither onset confidence nor section novelty is relabelled as musical energy. */
export function planMusicBeatEnergyV1(receiptValue: MusicBeatsReceiptV1, requestValue: MusicBeatsRequestV1) {
  const request = musicBeatsRequestSchemaV1.parse(requestValue);
  if (request.durationSeconds < .25 || request.durationSeconds > 60) throw Error("MUSIC_BEAT_ENERGY_WINDOW_BUDGET");
  const receipt = validateMusicBeatsReceiptV1(receiptValue, request, { sourceSha256: receiptValue.sourceSha256,
    sourceBytes: receiptValue.sourceBytes, ffmpegSha256: receiptValue.ffmpegSha256 });
  const a = receipt.analysis;
  const pulses: MusicRhythmEventV2[] = request.rhythmRefinementV2
    ? musicRhythmEventsInWindowV2(a, { sourceStartSeconds: a.sourceStartSeconds, sourceEndSeconds: a.sourceStartSeconds + a.durationSeconds,
      priorBpm: request.priorBpm, maximumEvents: 129, include: "pulses" }).pulses
    : a.beats.map((b, i) => ({ timeSeconds: b.timeSeconds, confidence: b.confidence, inferred: false, leftNativeIndex: i, rightNativeIndex: null }));
  if (pulses.length < 2 || pulses.length > 129) throw Error("MUSIC_BEAT_ENERGY_PULSE_BUDGET");
  const boundaries = pulses.map(p => Math.round((p.timeSeconds - a.sourceStartSeconds) * 16000));
  if (boundaries.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n > a.decodedSamples || i > 0 && n <= boundaries[i - 1]))
    throw Error("MUSIC_BEAT_ENERGY_SAMPLE_CLOCK_INVALID");
  const intervals = boundaries.slice(0, -1).map((firstSample, i) => Object.freeze({ pulseIndex: i, firstSample, endSample: boundaries[i + 1] }));
  const result = Object.freeze({ schema: "editkin.music-beat-energy-layout/v1" as const, sampleRate: 16000 as const,
    sourceStartSeconds: a.sourceStartSeconds, decodedSamples: a.decodedSamples, decodedBytes: receipt.decodedBytes,
    pulses: Object.freeze(pulses.map(p => Object.freeze({ ...p }))), intervals: Object.freeze(intervals),
    sampleBoundaryPolicy: "nearest-source-sample" as const, terminalPulseHasNoMeasuredInterval: true as const });
  layouts.add(result); return result;
}
export type MusicBeatEnergyLayoutV1 = {
  readonly schema: "editkin.music-beat-energy-layout/v1"; readonly sampleRate: 16000; readonly sourceStartSeconds: number;
  readonly decodedSamples: number; readonly decodedBytes: number; readonly pulses: readonly Readonly<MusicRhythmEventV2>[];
  readonly intervals: readonly Readonly<{ pulseIndex: number; firstSample: number; endSample: number }>[];
  readonly sampleBoundaryPolicy: "nearest-source-sample"; readonly terminalPulseHasNoMeasuredInterval: true;
};

/** One pass over little-endian f32 chunks; at most3 incomplete bytes survive a push. Errors poison this accumulator. */
export function createMusicBeatEnergyAccumulatorV1(layout: MusicBeatEnergyLayoutV1) {
  if (!layouts.has(layout)) throw Error("MUSIC_BEAT_ENERGY_LIVE_LAYOUT_REQUIRED");
  const sums = new Float64Array(layout.intervals.length), counts = new Uint32Array(layout.intervals.length), carry = new Uint8Array(4);
  let state: "open" | "failed" | "finished" = "open", bytes = 0, sample = 0, interval = 0, incomplete = 0;
  let outsideSamples = 0, peak = 0, overUnitySamples = 0, chunks = 0, maximumChunkBytes = 0, maximumIncompleteBytes = 0;
  const active = () => { if (state !== "open") throw Error("MUSIC_BEAT_ENERGY_ACCUMULATOR_TERMINAL"); };
  const add = (value: number) => {
    if (!Number.isFinite(value)) throw Error("MUSIC_BEAT_ENERGY_PCM_NOT_FINITE");
    peak = Math.max(peak, Math.abs(value)); if (Math.abs(value) > 1) overUnitySamples++;
    while (interval < layout.intervals.length && sample >= layout.intervals[interval].endSample) interval++;
    if (interval < layout.intervals.length && sample >= layout.intervals[interval].firstSample) { sums[interval] += value * value; counts[interval]++; }
    else outsideSamples++;
    sample++;
  };
  return {
    push(chunk: Uint8Array) {
      active();
      try {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65536 || bytes + chunk.byteLength > layout.decodedBytes) throw Error("MUSIC_BEAT_ENERGY_PCM_BYTE_BUDGET");
        bytes += chunk.byteLength; chunks++; maximumChunkBytes = Math.max(maximumChunkBytes, chunk.byteLength);
        let offset = 0;
        if (incomplete) {
          while (incomplete < 4 && offset < chunk.byteLength) carry[incomplete++] = chunk[offset++];
          if (incomplete === 4) { add(new DataView(carry.buffer).getFloat32(0, true)); incomplete = 0; }
        }
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (; offset + 4 <= chunk.byteLength; offset += 4) add(view.getFloat32(offset, true));
        while (offset < chunk.byteLength) carry[incomplete++] = chunk[offset++];
        maximumIncompleteBytes = Math.max(maximumIncompleteBytes, incomplete);
      } catch (error) { state = "failed"; throw error; }
    },
    finish() {
      active();
      try {
        if (bytes !== layout.decodedBytes || incomplete || sample !== layout.decodedSamples) throw Error("MUSIC_BEAT_ENERGY_PCM_INCOMPLETE");
        const raw = layout.intervals.map((range, i) => {
          if (counts[i] !== range.endSample - range.firstSample) throw Error("MUSIC_BEAT_ENERGY_INTERVAL_SAMPLE_MISMATCH");
          return Math.sqrt(sums[i] / counts[i]);
        });
        const maximumIntervalRms = Math.max(...raw), measuredSamples = counts.reduce((n, count) => n + count, 0);
        if (measuredSamples + outsideSamples !== layout.decodedSamples) throw Error("MUSIC_BEAT_ENERGY_SAMPLE_ACCOUNTING_INVALID");
        const result = Object.freeze({ schema: "editkin.music-beat-energy/v1" as const, sampleRate: 16000 as const,
          intervals: Object.freeze(layout.intervals.map((range, i) => Object.freeze({ ...range, samples: counts[i], rms: raw[i],
            normalizedLevel: maximumIntervalRms === 0 ? 0 : raw[i] / maximumIntervalRms }))),
          normalization: "rms-divided-by-maximum-measured-interval-rms" as const, maximumIntervalRms,
          decodedSamples: sample, decodedBytes: bytes, measuredSamples, outsideSamples, peak, overUnitySamples,
          inputChunks: chunks, maximumChunkBytes, maximumIncompleteBytes, pcmStagedBytes: 0 as const,
          terminalPulseHasNoMeasuredInterval: true as const, humanMusicalEnergyCertified: false as const,
          defaultEnabled: false as const, qualityState: "measured_pcm_level_not_musical_energy" as const });
        state = "finished"; return result;
      } catch (error) { state = "failed"; throw error; }
    },
  };
}
