import { describe, expect, it } from "vitest";
import { parseCubeFile, parseCubeLut, sampleCube1d, sampleCubeLut, sampleParsedCube, serializeCube3d } from "./cubeLut";

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

describe("strict .cube import parser", () => {
  it("accepts 3D with title, comments, domain and BOM", () => {
    const parsed = parseCubeFile(`﻿# made by hand\nTITLE "Warm test"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${IDENTITY_2}\n`);
    expect(parsed).toMatchObject({ kind: "3d", size: 2, title: "Warm test" });
    expect(sampleParsedCube(parsed, [0.3, 0.6, 0.9])[2]).toBeCloseTo(0.9, 6);
  });

  it("accepts 1D tables, including Resolve INPUT_RANGE, and interpolates per channel", () => {
    const parsed = parseCubeFile("LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0 2\n0 0 0\n0.5 0.25 1\n1 1 0\n");
    expect(parsed.kind).toBe("1d");
    if (parsed.kind !== "1d") throw new Error("expected 1d");
    expect(sampleCube1d(parsed, [1, 1, 1])).toEqual([0.5, 0.25, 1]);
    const half = sampleCube1d(parsed, [0.5, 0.5, 0.5]);
    expect(half[0]).toBeCloseTo(0.25, 6); expect(half[1]).toBeCloseTo(0.125, 6); expect(half[2]).toBeCloseTo(0.5, 6);
  });

  it.each([
    ["missing size", "0 0 0\n"],
    ["two sizes", "LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n"],
    ["incomplete rows", "LUT_1D_SIZE 3\n0 0 0\n1 1 1\n"],
    ["extra rows", "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n1 1 1\n"],
    ["non-finite", "LUT_1D_SIZE 2\n0 0 NaN\n1 1 1\n"],
    ["absurd magnitude", "LUT_1D_SIZE 2\n0 0 0\n1 1 99999\n"],
    ["inverted domain", "LUT_1D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n0 0 0\n1 1 1\n"],
    ["unknown keyword", "LUT_1D_SIZE 2\nLUT_SHAPER 1\n0 0 0\n1 1 1\n"],
    ["too large", "LUT_3D_SIZE 200\n"],
    ["header after data", "LUT_1D_SIZE 2\n0 0 0\nDOMAIN_MIN 0 0 0\n1 1 1\n"],
    ["four values", "LUT_1D_SIZE 2\n0 0 0 0\n1 1 1\n"],
  ])("rejects %s", (_label, source) => {
    expect(() => parseCubeFile(source)).toThrow();
  });

  it("serializes 3D tables in .cube order with six decimals", () => {
    const values = new Float32Array(parseCubeLut(IDENTITY_2).values);
    const text = serializeCube3d(values, 2, 'A "quoted"\ntitle');
    expect(text.split("\n").slice(0, 3)).toEqual(['TITLE "A quotedtitle"', "LUT_3D_SIZE 2", "0.000000 0.000000 0.000000"]);
    expect(parseCubeFile(text).values).toEqual(values);
    expect(() => serializeCube3d(values, 3, "x")).toThrow();
  });
});
