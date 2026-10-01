import { describe, expect, it } from "vitest";
import { detectPcmSilences } from "./pcmSilence";

const options = { thresholdDb: -20, minSilence: 0.02 };

describe("PCM silence detection", () => {
  it("compares RMS power with the dB threshold, not peak amplitude", () => {
    const pcm = new Float32Array(40);
    pcm.fill(0.05, 0, 10);
    pcm[10] = 0.2; // RMS below 0.1 despite the peak.
    pcm.fill(0.2, 20);
    expect(detectPcmSilences([pcm], 1000, options)).toEqual([{ start: 0, end: 0.02 }]);
    expect(detectPcmSilences([pcm], 1000, { ...options, thresholdDb: -30 })).toEqual([]);
    expect(detectPcmSilences([new Float32Array(20).fill(1)], 1000, { ...options, thresholdDb: 0 })).toEqual([{ start: 0, end: 0.02 }]);
  });

  it("includes exactly the minimum duration and rejects shorter runs", () => {
    const pcm = new Float32Array(60).fill(1);
    pcm.fill(0, 0, 10);
    pcm.fill(0, 20, 40);
    expect(detectPcmSilences([pcm], 1000, options)).toEqual([{ start: 0.02, end: 0.04 }]);
    expect(detectPcmSilences([pcm], 1000, { ...options, minSilence: 0.0201 })).toEqual([]);
  });

  it("flushes leading, trailing and partial windows at the actual sample edge", () => {
    const pcm = new Float32Array(55).fill(1);
    pcm.fill(0, 0, 20);
    pcm.fill(0, 30);
    expect(detectPcmSilences([pcm], 1000, options)).toEqual([{ start: 0, end: 0.02 }, { start: 0.03, end: 0.055 }]);
    expect(detectPcmSilences([pcm], 1000, { ...options, minSilence: 0.026 })).toEqual([]);
  });

  it("handles empty PCM, continuous sound and entirely silent input", () => {
    expect(detectPcmSilences([new Float32Array()], 1000, options)).toEqual([]);
    expect(detectPcmSilences([new Float32Array(100).fill(1)], 1000, options)).toEqual([]);
    expect(detectPcmSilences([new Float32Array(100)], 1000, options)).toEqual([{ start: 0, end: 0.1 }]);
  });

  it("does not erase audio in one channel or opposite-phase stereo", () => {
    const sound = new Float32Array(30).fill(0.12);
    expect(detectPcmSilences([new Float32Array(30), sound], 1000, options)).toEqual([]);
    expect(detectPcmSilences([sound, sound.map(sample => -sample)], 1000, options)).toEqual([]);
    expect(detectPcmSilences([new Float32Array(30), new Float32Array(30)], 1000, options)).toEqual([{ start: 0, end: 0.03 }]);
  });

  it("rejects invalid PCM and detector parameters instead of cutting on invalid data", () => {
    const pcm = new Float32Array(30);
    for (const sampleRate of [0, -1, NaN, Infinity]) expect(() => detectPcmSilences([pcm], sampleRate, options)).toThrow();
    expect(() => detectPcmSilences([], 1000, options)).toThrow();
    expect(() => detectPcmSilences([pcm, new Float32Array(20)], 1000, options)).toThrow();
    expect(() => detectPcmSilences([new Float32Array([NaN])], 1000, options)).toThrow();
    for (const thresholdDb of [NaN, Infinity, 1]) expect(() => detectPcmSilences([pcm], 1000, { ...options, thresholdDb })).toThrow();
    for (const minSilence of [NaN, Infinity, -1]) expect(() => detectPcmSilences([pcm], 1000, { ...options, minSilence })).toThrow();
  });
});
