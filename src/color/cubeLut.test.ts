import { describe, expect, it } from "vitest";
import { parseCubeLut, sampleCubeLut } from "./cubeLut";

const IDENTITY_2 = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1`;

describe("3D cube LUT", () => {
  it("parses Resolve cube order and tetrahedrally interpolates identity", () => {
    const lut = parseCubeLut(IDENTITY_2);
    expect(lut.size).toBe(2);
    expect(sampleCubeLut(lut, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(sampleCubeLut(lut, [1, 1, 1])).toEqual([1, 1, 1]);
    const sample = sampleCubeLut(lut, [0.2, 0.7, 0.4]);
    expect(sample[0]).toBeCloseTo(0.2, 6);
    expect(sample[1]).toBeCloseTo(0.7, 6);
    expect(sample[2]).toBeCloseTo(0.4, 6);
  });

  it("rejects incomplete LUTs", () => {
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0")).toThrow(/不完整/);
  });
});
