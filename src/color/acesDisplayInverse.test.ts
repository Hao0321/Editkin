import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCubeLut, sampleCubeLut, type CubeLut } from "./cubeLut";
import { ACES_DISPLAY_INVERSE_SIZE, ACES_SDR_OUTPUT_LUT, acesDisplayInverseFor, buildAcesDisplayInverse, usesAcesDisplayReconstruction } from "./acesDisplayInverse";

/**
 * Regression for the washed-out ACES 2.0 SDR path (pro-w1-1). A Rec.709 test chart (ColorChecker-style
 * patches + 18 % grey, display code values) goes Rec.709 in → ACES → SDR Rec.709 out through the shipped
 * 65³ LUTs, including the 8-bit ACEScct surface FFmpeg composites on. Decoded as BT.1886 γ2.4 → CIELAB.
 *
 * Tolerances for a display-referred round trip: mid-grey |ΔL*| ≤ 1, mid contrast and chroma within ±3 %,
 * white ≥ 0.99, mean hue error ≤ 2°. The shipped Camera Rec.709 input misses every one of them
 * (white 0.706, ΔL* −8.0, contrast ×0.76, chroma ×0.78 — ACES_ROOT_CAUSE.json); the display inverse used
 * for Color Grade v2 clips passes.
 */
const app = fileURLToPath(new URL("../../", import.meta.url));
const lut = (name: string) => parseCubeLut(readFileSync(resolve(app, "public/color/aces2", name), "utf8"));

type Rgb = [number, number, number];
const CHECKER: Rgb[] = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170], [214, 126, 44], [80, 91, 166],
  [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46], [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31],
  [187, 86, 149], [8, 133, 161], [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
].map(rgb => rgb.map(value => value / 255) as Rgb);
const GREY18 = 0.18 ** (1 / 2.4);

function lab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(value => Math.max(0, Math.min(1, value)) ** 2.4);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047, y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function chartMetrics(transform: (rgb: Rgb) => Rgb) {
  const inLab = CHECKER.map(lab), outLab = CHECKER.map(rgb => lab(transform(rgb)));
  const chroma = (value: Rgb) => Math.hypot(value[1], value[2]);
  const hue = (value: Rgb) => Math.atan2(value[2], value[1]) * 180 / Math.PI;
  const chromatic = [...Array(18).keys()];
  const saturation = chromatic.reduce((sum, index) => sum + chroma(outLab[index]), 0) / chromatic.reduce((sum, index) => sum + chroma(inLab[index]), 0);
  const hueError = chromatic.reduce((sum, index) => sum + Math.abs(((hue(outLab[index]) - hue(inLab[index]) + 540) % 360) - 180), 0) / chromatic.length;
  return {
    midGreyDeltaL: lab(transform([GREY18, GREY18, GREY18]))[0] - lab([GREY18, GREY18, GREY18])[0],
    white: transform([1, 1, 1])[1],
    contrast: (outLab[19][0] - outLab[22][0]) / (inLab[19][0] - inLab[22][0]),
    saturation, hueError,
  };
}

const q8 = (rgb: Rgb): Rgb => rgb.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255) / 255) as Rgb;
let output: CubeLut;
let camera709: CubeLut;

beforeAll(() => {
  output = lut(ACES_SDR_OUTPUT_LUT);
  camera709 = lut("luts/input-rec709-to-acescct.cube");
});

describe("ACES 2.0 SDR display-referred input", () => {
  it("documents the shipped root cause: Camera Rec.709 in → ACES 2.0 SDR out washes a Rec.709 chart out", () => {
    const shipped = chartMetrics(rgb => sampleCubeLut(output, q8(sampleCubeLut(camera709, rgb))));
    expect(shipped.white).toBeLessThan(0.75);
    expect(shipped.midGreyDeltaL).toBeLessThan(-5);
    expect(shipped.contrast).toBeLessThan(0.85);
    expect(shipped.saturation).toBeLessThan(0.85);
  });

  it("round-trips the Rec.709 chart through the shipped SDR output LUT within the stated tolerances", () => {
    const inverse = acesDisplayInverseFor(output);
    expect(inverse.size).toBe(ACES_DISPLAY_INVERSE_SIZE);
    const trip = chartMetrics(rgb => sampleCubeLut(output, q8(sampleCubeLut(inverse, rgb))));
    expect(Math.abs(trip.midGreyDeltaL)).toBeLessThanOrEqual(1);
    expect(trip.white).toBeGreaterThanOrEqual(0.99);
    expect(Math.abs(trip.contrast - 1)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(trip.saturation - 1)).toBeLessThanOrEqual(0.03);
    expect(trip.hueError).toBeLessThanOrEqual(2);
    // Display white lands high in ACEScct (ACES 2.0 SDR reaches 100 nits near scene 128), black at scene black.
    expect(sampleCubeLut(inverse, [1, 1, 1])[1]).toBeGreaterThan(0.9);
    expect(Math.max(...sampleCubeLut(inverse, [0, 0, 0]))).toBeLessThan(0.08);
    // Every neutral display code and every chart patch is reachable; only extreme cube corners are not.
    for (let code = 0; code <= 255; code += 5) {
      const value = code / 255;
      const back = sampleCubeLut(output, sampleCubeLut(inverse, [value, value, value]));
      expect(Math.max(...back.map(channel => Math.abs(channel - value)))).toBeLessThan(1.5 / 255);
    }
    expect(inverse.unreachableNodes / inverse.size ** 3).toBeLessThan(0.03);
  });

  it("is deterministic, cached per parsed LUT and refuses a non-unit domain", () => {
    const small = buildAcesDisplayInverse(output, 9);
    expect(Array.from(buildAcesDisplayInverse(output, 9).values)).toEqual(Array.from(small.values));
    expect(acesDisplayInverseFor(output)).toBe(acesDisplayInverseFor(output));
    expect(() => buildAcesDisplayInverse({ ...output, domainMax: [2, 2, 2] }, 9)).toThrow(/定義域/);
  });

  it("only reconstructs display-referred sources of ACES 2.0 projects delivering Rec.709 SDR", () => {
    const sdr = { mode: "aces2", outputTransform: "rec709_sdr" } as const;
    for (const input of ["rec709", "srgb", "hlg", "pq"]) expect(usesAcesDisplayReconstruction(input, sdr)).toBe(true);
    for (const input of ["apple_log", "arri_logc4", "acescct", "linear_rec709", "blocked_log"]) expect(usesAcesDisplayReconstruction(input, sdr)).toBe(false);
    expect(usesAcesDisplayReconstruction("rec709", { mode: "rec709", outputTransform: "rec709_sdr" })).toBe(false);
    for (const outputTransform of ["p3d65_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"] as const) {
      expect(usesAcesDisplayReconstruction("hlg", { mode: "aces2", outputTransform })).toBe(false);
    }
    expect(usesAcesDisplayReconstruction("rec709", undefined)).toBe(false);
  });
});
