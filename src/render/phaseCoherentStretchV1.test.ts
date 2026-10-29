import { describe, expect, it } from "vitest";
import { fftPlanV1, createPhaseCoherentStretchV1 } from "./phaseCoherentStretchV1";
describe("shared-bin phase audio core", () => {
  it("FFT matches independent direct complex DFT and inverse, rejects unsafe sizes", () => {
    const n = 16, a = Float64Array.from({ length: n }, (_, i) => Math.sin(i * .23) + i / 20), b = Float64Array.from({ length: n }, (_, i) => Math.cos(i * .41) / 3), originalA = a.slice(), originalB = b.slice(), fft = fftPlanV1(n);
    fft.transform(a, b);
    for (let k = 0; k < n; k++) { let real = 0, imag = 0; for (let t = 0; t < n; t++) { const angle = -2 * Math.PI * k * t / n; real += originalA[t] * Math.cos(angle) - originalB[t] * Math.sin(angle); imag += originalA[t] * Math.sin(angle) + originalB[t] * Math.cos(angle); }
      expect(Math.abs(a[k] - real)).toBeLessThan(1e-10); expect(Math.abs(b[k] - imag)).toBeLessThan(1e-10); }
    fft.transform(a, b, true); for (let k = 0; k < n; k++) { expect(Math.abs(a[k] - originalA[k])).toBeLessThan(1e-10); expect(Math.abs(b[k] - originalB[k])).toBeLessThan(1e-10); }
    for (const size of [0, 3, 16384, NaN]) expect(() => fftPlanV1(size)).toThrow("SIZE");
  });
  it.each([.5, 2, 4])("preserves equal and opposed stereo at %s with fixed windows and exact output count", async speed => {
    for (const polarity of [1, -1]) {
      const outputSamples = 2048, sourceSamples = Math.round(outputSamples * speed), scratch = [new Float64Array(512), new Float64Array(512)];
      let largest = 0, total = 0, maxResidual = 0;
      const consumer = createPhaseCoherentStretchV1({ sampleRate: 8000, channels: 2, sourceSamples, outputSamples, speed, fftSize: 512,
        readSourceWindow: async (start, length) => { largest = Math.max(largest, length); for (let i = 0; i < length; i++) { const sample = start + i, value = sample < 0 || sample >= sourceSamples ? 0 : .2 * Math.sin(2 * Math.PI * 440 * sample / 8000); scratch[0][i] = value; scratch[1][i] = value * polarity; } return scratch; } });
      while (true) { const block = await consumer.next(); if (!block) break; total += block.samples; for (let i = 0; i < block.samples; i++) maxResidual = Math.max(maxResidual, Math.abs(block.pcm[i * 2 + 1] - block.pcm[i * 2] * polarity)); }
      expect(total).toBe(outputSamples); expect(largest).toBe(512); expect(maxResidual).toBeLessThanOrEqual(1e-5); expect(consumer.receipt.sourceMovieArrayBytes).toBe(0); expect(consumer.receipt.maximumWorkingBytes).toBeLessThan(100000); consumer.close();
    }
  });
  it("invalid clock shape/nonfinite source and cancellation refuse without changing declared sample count", async () => {
    const base = { sampleRate: 8000, channels: 1 as const, sourceSamples: 1024, outputSamples: 2048, speed: .5, fftSize: 512, readSourceWindow: async () => [new Float64Array(512)] };
    expect(() => createPhaseCoherentStretchV1({ ...base, sourceSamples: 10 })).toThrow("REQUEST");
    const bad = createPhaseCoherentStretchV1({ ...base, readSourceWindow: async () => [new Float64Array(512).fill(NaN)] }); await expect(bad.next()).rejects.toThrow("NONFINITE"); expect(bad.receipt.outputSamples).toBe(0); bad.close();
    const signal = new AbortController(); signal.abort(Error("CONTROL_DSP_ABORT")); const aborted = createPhaseCoherentStretchV1({ ...base, signal: signal.signal }); await expect(aborted.next()).rejects.toThrow("CONTROL_DSP_ABORT"); aborted.close();
  });
  it("one next owns scratch; concurrent next/close refuse, and closed consumer cannot emit", async () => {
    let release: () => void = () => undefined; const gate = new Promise<void>(done => { release = done; });
    const consumer = createPhaseCoherentStretchV1({ sampleRate: 8000, channels: 1, sourceSamples: 1024, outputSamples: 2048, speed: .5, fftSize: 512,
      readSourceWindow: async () => { await gate; return [new Float64Array(512)]; } });
    const first = consumer.next(); await expect(consumer.next()).rejects.toThrow("STATE"); expect(() => consumer.close()).toThrow("BUSY"); release(); await first; consumer.close(); await expect(consumer.next()).rejects.toThrow("STATE");
  });
  it.each([.5, 2, 4])("keeps a chirp and an isolated attack within independent quality bounds at %s", async speed => {
    const rate = 48000, sourceSamples = Math.round(rate * speed), scratch = [new Float64Array(4096)];
    for (const shape of ["chirp", "attack"] as const) {
      const consumer = createPhaseCoherentStretchV1({ sampleRate: rate, channels: 1, speed, sourceSamples, outputSamples: rate,
        readSourceWindow: async (start, length) => { for (let i = 0; i < length; i++) { const at = start + i, t = at / rate;
          scratch[0][i] = at < 0 || at >= sourceSamples ? 0 : shape === "chirp" ? .2 * Math.sin(2 * Math.PI * (400 * t + 200 * t * t / speed)) : .2 * Math.exp(-.5 * ((t - .5 * speed) / .001) ** 2); }
          return scratch; } });
      const output = new Float32Array(rate); let offset = 0;
      try { while (true) { const block = await consumer.next(); if (!block) break; output.set(block.pcm, offset); offset += block.samples; } } finally { consumer.close(); }
      expect(offset).toBe(rate); let peak = 0, peakAt = 0;
      for (let i = 0; i < rate; i++) { expect(Number.isFinite(output[i])).toBe(true); if (Math.abs(output[i]) > peak) { peak = Math.abs(output[i]); peakAt = i; } }
      expect(peak).toBeLessThanOrEqual(.2 * 1.25 + .001);
      expect(consumer.receipt.maximumWorkingBytes).toBeLessThan(800000);
      if (shape === "attack") {
        expect(Math.abs(peakAt / rate - .5)).toBeLessThanOrEqual(.01); expect(peak).toBeGreaterThan(.04);
        let power = 0; for (let i = .4 * rate; i < .49 * rate; i++) power += output[i] ** 2;
        expect(Math.sqrt(power / (.09 * rate))).toBeLessThanOrEqual(.005); expect(consumer.receipt.detectedPulses).toBe(1);
      } else {
        let bestAmplitude = 0, bestOffset = 0, weightSum = 0;
        const lo = Math.round(.2 * rate), hi = Math.round(.8 * rate), weights = Float64Array.from({ length: hi - lo }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (hi - lo - 1)));
        for (const weight of weights) weightSum += weight;
        for (let hz = -8; hz <= 8; hz += .5) { let real = 0, imag = 0;
          for (let i = lo; i < hi; i++) { const t = i / rate, phase = 2 * Math.PI * ((400 + hz) * t + 200 * t * t), value = output[i] * weights[i - lo]; real += value * Math.cos(phase); imag -= value * Math.sin(phase); }
          const amplitude = 2 * Math.hypot(real, imag) / weightSum; if (amplitude > bestAmplitude) { bestAmplitude = amplitude; bestOffset = hz; } }
        expect(Math.abs(bestOffset)).toBeLessThanOrEqual(2); expect(bestAmplitude).toBeGreaterThan(.04);
      }
    }
  });
});
