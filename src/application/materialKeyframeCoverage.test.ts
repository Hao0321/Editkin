import { describe, expect, it } from "vitest";
import { selectMaterialKeyframeTimes } from "./materialIntelligence";

describe("real long-take material coverage", () => {
  it("uses the requested eight samples across folder 29 instead of three distant frames", () => {
    const duration = 431.96666666666664;
    const times = selectMaterialKeyframeTimes(duration, [], 8);
    expect(times).toHaveLength(8);
    expect(times[0]).toBe(0.1);
    expect(times.at(-1)).toBeCloseTo(duration - 0.1, 3);
    expect(Math.max(...times.slice(1).map((time, index) => time - times[index]))).toBeLessThan(62);
    expect(new Set(times).size).toBe(times.length);
    expect(times.every((time, index) => time >= 0 && time < duration && (!index || time > times[index - 1]))).toBe(true);
  });

  it("does not multiply short-clip extraction costs or exceed the hard twelve-frame limit", () => {
    expect(selectMaterialKeyframeTimes(12, [], 8)).toHaveLength(3);
    expect(selectMaterialKeyframeTimes(720, [], 100)).toHaveLength(12);
    expect(selectMaterialKeyframeTimes(432, [], 1)).toHaveLength(1);
    expect(selectMaterialKeyframeTimes(432, [], 4)).toHaveLength(4);
    expect(selectMaterialKeyframeTimes(0, [], 8)).toEqual([]);
  });

  it("retains scene-aware sampling for edited footage", () => {
    expect(selectMaterialKeyframeTimes(12, [
      { time: 4, frame: 120, score: 10 }, { time: 8, frame: 240, score: 11 },
    ], 4)).toEqual([0.1, 2, 10, 11.9]);
  });
});
