import { describe, expect, it } from "vitest";
import { clipSamplePlacementV1, durationFrameCountV1, frameAlignedSampleWindowsV1, frameRateRationalV1, frameToSampleV1, frameToSecondsV1,
  frameToTicksV1, sampleToFrameV1, sampleWindowsV1, secondsToFrameV1, secondsToSamplesV1, ticksToFrameV1 } from "./longRenderClockV1";
import { isLongRenderRefusalV1 } from "./longRenderContractsV1";

const NTSC = { numerator: 30000, denominator: 1001 };
const roundDiv = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

describe("long-render rational clock", () => {
  it("maps project fps to the exact engine ratio", () => {
    expect(frameRateRationalV1(30)).toEqual({ numerator: 30, denominator: 1 });
    expect(frameRateRationalV1(25)).toEqual({ numerator: 25, denominator: 1 });
    expect(frameRateRationalV1(30000 / 1001)).toEqual(NTSC);
    expect(frameRateRationalV1(29.97)).toEqual(NTSC);
    expect(frameRateRationalV1(60000 / 1001)).toEqual({ numerator: 60000, denominator: 1001 });
    expect(frameRateRationalV1(24000 / 1001)).toEqual({ numerator: 24000, denominator: 1001 });
  });

  it("keeps 25 h at 48 kHz and 90 kHz exact beyond 2^32 (a 32-bit operation would corrupt it)", () => {
    const rate = { numerator: 30, denominator: 1 };
    const frames = durationFrameCountV1(90_000, rate);
    expect(frames).toBe(2_700_000);
    const samples = frameToSampleV1(frames, rate, 48_000);
    expect(samples).toBe(4_320_000_000);
    expect(samples).toBeGreaterThan(2 ** 32);
    expect(samples | 0).not.toBe(samples);
    expect(sampleToFrameV1(samples, rate, 48_000)).toBe(frames);
    const ticks = frameToTicksV1(frames, rate, 90_000);
    expect(ticks).toBe(8_100_000_000);
    expect(ticksToFrameV1(ticks, rate, 90_000)).toBe(frames);
    expect(frameToTicksV1(frames, rate, 15_360)).toBe(1_382_400_000);
  });

  it("matches an independent BigInt reference for NTSC rates at 24 h and 25 h", () => {
    for (const rate of [NTSC, { numerator: 60000, denominator: 1001 }, { numerator: 24000, denominator: 1001 }]) {
      for (const hours of [24, 25]) {
        const frames = durationFrameCountV1(hours * 3600, rate);
        expect(frames).toBe(Math.round(hours * 3600 * rate.numerator / rate.denominator));
        for (const sampleRate of [44_100, 48_000]) {
          const samples = frameToSampleV1(frames, rate, sampleRate);
          expect(BigInt(samples)).toBe(roundDiv(BigInt(frames) * BigInt(sampleRate) * BigInt(rate.denominator), BigInt(rate.numerator)));
          expect(sampleToFrameV1(samples, rate, sampleRate, "round")).toBe(frames);
        }
        const ticks = frameToTicksV1(frames, rate, 90_000);
        expect(BigInt(ticks)).toBe(roundDiv(BigInt(frames) * 90_000n * BigInt(rate.denominator), BigInt(rate.numerator)));
        expect(ticksToFrameV1(ticks, rate, 90_000, "round")).toBe(frames);
      }
    }
  });

  it("tiles 25 h of NTSC audio in frame-aligned windows without drift or re-rounding", () => {
    const total = durationFrameCountV1(25 * 3600, NTSC);
    const windows = frameAlignedSampleWindowsV1(total, 1800, NTSC, 48_000);
    let frame = 0, sample = 0;
    for (const window of windows) {
      expect(window.startFrame).toBe(frame); expect(window.startSample).toBe(sample);
      frame += window.frameCount; sample += window.sampleCount;
    }
    expect(frame).toBe(total);
    expect(sample).toBe(frameToSampleV1(total, NTSC, 48_000));
    const full = windows.slice(0, -1).map(window => window.sampleCount);
    expect(Math.max(...full) - Math.min(...full)).toBeLessThanOrEqual(1);
  });

  it("places adjacent frame-aligned clips over 24 h with no gap and no overlap", () => {
    let start = 0, previousEnd: number | undefined;
    for (let index = 0; index < 2000; index += 1) {
      const durationFrames = 1301 + (index % 7) * 97;
      const placement = clipSamplePlacementV1({ timelineStartSeconds: frameToSecondsV1(start, NTSC), durationSeconds: durationFrames * 1001 / 30000, sampleRate: 48_000, frameRate: NTSC });
      expect(placement.frameAligned).toBe(true);
      if (previousEnd !== undefined) expect(placement.startSample).toBe(previousEnd);
      previousEnd = placement.startSample + placement.sampleCount;
      start += durationFrames;
    }
    expect(previousEnd).toBe(frameToSampleV1(start, NTSC, 48_000));
    expect(start).toBeGreaterThan(24 * 3600 * 30);
  });

  it("splits sample ranges exactly and converts seconds near frame boundaries without float drift", () => {
    expect(sampleWindowsV1(10, 4)).toEqual([{ index: 0, startSample: 0, sampleCount: 4 }, { index: 1, startSample: 4, sampleCount: 4 }, { index: 2, startSample: 8, sampleCount: 2 }]);
    expect(sampleWindowsV1(0, 4)).toEqual([]);
    expect(secondsToFrameV1(frameToSecondsV1(2_589_411, NTSC), NTSC, "floor")).toBe(2_589_411);
    expect(secondsToFrameV1(10.5 / 30, { numerator: 30, denominator: 1 }, "floor")).toBe(10);
    expect(secondsToSamplesV1(43_200, 48_000)).toBe(2_073_600_000);
  });

  it("refuses invalid or out-of-range input with LONG_RENDER_CLOCK_RANGE", () => {
    const cases = [
      () => frameToSampleV1(-1, NTSC, 48_000), () => frameToSampleV1(1.5, NTSC, 48_000), () => frameToSampleV1(1, { numerator: 0, denominator: 1 }, 48_000),
      () => frameToSampleV1(1, NTSC, 0), () => secondsToFrameV1(Number.NaN, NTSC), () => secondsToFrameV1(-1, NTSC),
      () => frameToTicksV1(Number.MAX_SAFE_INTEGER, NTSC, 90_000), () => frameRateRationalV1(0), () => sampleWindowsV1(10, 0),
    ];
    for (const run of cases) { let error: unknown; try { run(); } catch (caught) { error = caught; } expect(isLongRenderRefusalV1(error, "LONG_RENDER_CLOCK_RANGE")).toBe(true); }
  });
});
