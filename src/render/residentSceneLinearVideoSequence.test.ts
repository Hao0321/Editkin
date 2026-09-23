import { describe, expect, it } from "vitest";
import { halfFrameToleranceSeconds } from "./residentSceneLinearVideoSequence";

describe("halfFrameToleranceSeconds", () => {
  it("uses the complete rational timebase for integer and NTSC frame rates", () => {
    expect(halfFrameToleranceSeconds({ numerator: 1, denominator: 30 })).toBeCloseTo(1 / 60, 12);
    expect(halfFrameToleranceSeconds({ numerator: 1001, denominator: 30_000 })).toBeCloseTo(1001 / 60_000, 12);
    expect(halfFrameToleranceSeconds({ numerator: 1001, denominator: 60_000 })).toBeCloseTo(1001 / 120_000, 12);
  });

  it("rejects invalid rational timebases", () => {
    expect(() => halfFrameToleranceSeconds({ numerator: 0, denominator: 30 })).toThrow(/timebase/);
    expect(() => halfFrameToleranceSeconds({ numerator: 1, denominator: 0 })).toThrow(/timebase/);
  });
});
