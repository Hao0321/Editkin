import { describe, expect, it } from "vitest";
import { fixtureReceiptV1 } from "./musicBeats.fixture";
import { musicBeatsReceiptSchemaV1 } from "./musicBeatsTypesV1";
import { createMusicBeatEnergyAccumulatorV1, planMusicBeatEnergyV1 } from "./musicBeatEnergyV1";

function fixture(start = 0) {
  const raw = fixtureReceiptV1(2, start);
  raw.analysis.beats = [.25, .75, 1.25, 1.75].map(t => ({ timeSeconds: start + t, confidence: .8, downbeat: false, downbeatConfidence: 0 }));
  const receipt = musicBeatsReceiptSchemaV1.parse(raw), request = { sourcePath: "D:/music.wav", sourceStartSeconds: start, durationSeconds: 2 };
  return { receipt, request, layout: planMusicBeatEnergyV1(receipt, request) };
}
function pcm(value: (i: number) => number = i => i < 12000 ? .25 : i < 20000 ? -.5 : 1) {
  const array = new Float32Array(32000);
  for (let i = 0; i < array.length; i++) array[i] = value(i);
  return new Uint8Array(array.buffer);
}
function independent(bytes: Uint8Array, first: number, end: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let sum = 0;
  for (let i = first; i < end; i++) { const value = view.getFloat32(i * 4, true); sum += value ** 2; }
  return Math.sqrt(sum / (end - first));
}
function feed(bytes: Uint8Array, size = 65536, start = 0) {
  const { layout } = fixture(start), acc = createMusicBeatEnergyAccumulatorV1(layout);
  for (let n = 0; n < bytes.length; n += size) acc.push(bytes.subarray(n, n + size));
  return { result: acc.finish(), layout, acc };
}

describe("source-sample beat RMS streaming", () => {
  it.each([1, 2, 3, 7, 4093, 65536])("matches an independent whole-buffer reference across %s-byte chunks", chunk => {
    const bytes = pcm(), { result, layout } = feed(bytes, chunk);
    result.intervals.forEach((r, i) => expect(r.rms).toBe(independent(bytes, layout.intervals[i].firstSample, layout.intervals[i].endSample)));
    expect(result.intervals.map(r => r.rms)).toEqual([.25, .5, 1]);
    expect(result.intervals.map(r => r.normalizedLevel)).toEqual([.25, .5, 1]);
    expect(result.measuredSamples).toBe(24000); expect(result.outsideSamples).toBe(8000);
    expect(result.maximumIncompleteBytes).toBeLessThanOrEqual(3); expect(result.maximumChunkBytes).toBeLessThanOrEqual(65536);
    expect(result.pcmStagedBytes).toBe(0); expect(result.terminalPulseHasNoMeasuredInterval).toBe(true);
  });
  it("preserves source-clock provenance at a10hour coordinate without allocating a long stream", () => {
    const { result, layout } = feed(pcm(), 21, 36001.125);
    expect(layout.pulses[0].timeSeconds).toBe(36001.375); expect(layout.intervals[0].firstSample).toBe(4000);
    expect(result.decodedSamples).toBe(32000); expect(result.intervals.map(r => r.rms)).toEqual([.25, .5, 1]);
  });
  it("does not substitute confidence for PCM levels or claim musical-energy approval", () => {
    const { result } = feed(pcm(i => i % 2 ? -.1 : .1));
    expect(result.intervals.every(r => Math.abs(r.rms - .1) < 1e-7)).toBe(true);
    expect(result.humanMusicalEnergyCertified).toBe(false); expect(result.defaultEnabled).toBe(false);
    expect(result.normalization).toContain("maximum-measured-interval");
  });
  it("keeps silence zero and counts over-unity source samples without clipping", () => {
    expect(feed(pcm(() => 0)).result.intervals.every(r => r.normalizedLevel === 0 && r.rms === 0)).toBe(true);
    const r = feed(pcm(() => -2)).result;
    expect(r.peak).toBe(2); expect(r.overUnitySamples).toBe(32000); expect(r.intervals.every(i => i.rms === 2)).toBe(true);
  });
  it("handles sliced views and zero-sized pushes without losing source bytes", () => {
    const source = pcm(), padded = new Uint8Array(source.length + 12); padded.set(source, 5);
    const acc = createMusicBeatEnergyAccumulatorV1(fixture().layout); acc.push(new Uint8Array(0));
    const view = padded.subarray(5, 5 + source.length); for (let n = 0; n < view.length; n += 65535) acc.push(view.subarray(n, n + 65535));
    expect(acc.finish().intervals.map(r => r.rms)).toEqual([.25, .5, 1]);
  });
  it.each([NaN, Infinity, -Infinity])("rejects %s even outside measured beat intervals and poisons the state", invalid => {
    const acc = createMusicBeatEnergyAccumulatorV1(fixture().layout), bytes = pcm(i => i === 0 ? invalid : .1);
    expect(() => acc.push(bytes.subarray(0, 100))).toThrow(/NOT_FINITE/);
    expect(() => acc.push(new Uint8Array(4))).toThrow(/TERMINAL/); expect(() => acc.finish()).toThrow(/TERMINAL/);
  });
  it("refuses truncated, oversized and excess PCM without permitting resume", () => {
    const acc = createMusicBeatEnergyAccumulatorV1(fixture().layout); acc.push(pcm().subarray(0, 65536));
    expect(() => acc.finish()).toThrow(/INCOMPLETE/); expect(() => acc.push(new Uint8Array(4))).toThrow(/TERMINAL/);
    const large = createMusicBeatEnergyAccumulatorV1(fixture().layout); expect(() => large.push(pcm())).toThrow(/BYTE_BUDGET/);
    const full = feed(pcm()).acc; expect(() => full.push(new Uint8Array(4))).toThrow(/TERMINAL/); expect(() => full.finish()).toThrow(/TERMINAL/);
    const extra = createMusicBeatEnergyAccumulatorV1(fixture().layout), b = pcm();
    extra.push(b.subarray(0, 64000)); extra.push(b.subarray(64000)); expect(() => extra.push(new Uint8Array(1))).toThrow(/BYTE_BUDGET/);
  });
  it("refuses serialized layouts and freezes live interval metadata", () => {
    const { layout } = fixture(); expect(Object.isFrozen(layout.pulses[0]) && Object.isFrozen(layout.intervals[0])).toBe(true);
    expect(() => createMusicBeatEnergyAccumulatorV1(JSON.parse(JSON.stringify(layout)))).toThrow(/LIVE_LAYOUT/);
  });
  it("refuses insufficient, excess or sample-collapsed pulse clocks", () => {
    const { receipt, request } = fixture(); receipt.analysis.beats = receipt.analysis.beats.slice(0, 1);
    expect(() => planMusicBeatEnergyV1(receipt, request)).toThrow(/PULSE_BUDGET/);
    receipt.analysis.beats = Array.from({ length: 130 }, (_, i) => ({ timeSeconds: i / 100, confidence: 1, downbeat: false, downbeatConfidence: 0 }));
    expect(() => planMusicBeatEnergyV1(receipt, request)).toThrow(/PULSE_BUDGET/);
    receipt.analysis.beats = [.5, .500001].map(timeSeconds => ({ timeSeconds, confidence: 1, downbeat: false, downbeatConfidence: 0 }));
    expect(() => planMusicBeatEnergyV1(receipt, request)).toThrow(/SAMPLE_CLOCK/);
  });
  it("requires the explicitly requested refinement extension and a short window", () => {
    const { receipt, request } = fixture(); expect(() => planMusicBeatEnergyV1(receipt, { ...request, rhythmRefinementV2: true })).toThrow();
    expect(() => planMusicBeatEnergyV1(receipt, { ...request, durationSeconds: 61 })).toThrow(/WINDOW_BUDGET/);
  });
  it("measures inferred subdivision intervals while keeping their native source indices", () => {
    const { receipt, request } = fixture(), a = receipt.analysis;
    a.tempoBpm = 60; a.beats = [.25, 1.25].map(timeSeconds => ({ timeSeconds, confidence: .8, downbeat: false, downbeatConfidence: 0 }));
    a.rhythmV2 = { schema: "editkin.music-rhythm-refinement/v2", policy: "prior-octave-four-beat-candidate/v2",
      tempo: { rawBpm: 60, bpm: 120, priorBpm: 120, octaveMultiplier: 2, state: "prior-octave-corrected", confidence: .5 },
      pulseRecipe: { mode: "insert-midpoints", phase: 0 }, bars: { mode: "unavailable", beatsPerBar: 4, anchorSourceSeconds: null,
        anchorNativeIndex: null, periodSeconds: 2, confidence: 0, inferred: false, reason: "insufficient-or-irregular-evidence" },
      nativeBeatCount: 2, nativeDownbeatCount: 0, regularIntervalFraction: 1, humanQualityCertified: false };
    const layout = planMusicBeatEnergyV1(receipt, { ...request, priorBpm: 120, rhythmRefinementV2: true });
    expect(layout.pulses[1]).toMatchObject({ timeSeconds: .75, inferred: true, leftNativeIndex: 0, rightNativeIndex: 1, confidence: .2 });
    const acc = createMusicBeatEnergyAccumulatorV1(layout), b = pcm(); acc.push(b.subarray(0, 65536)); acc.push(b.subarray(65536));
    expect(acc.finish().intervals.map(r => r.samples)).toEqual([8000, 8000]);
  });
});
