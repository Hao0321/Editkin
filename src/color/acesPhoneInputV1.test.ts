import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { parseCubeLut, sampleCubeLut } from "./cubeLut";
import { acesDisplayInverseFor, ACES_SDR_OUTPUT_LUT, usesAcesDisplayReconstruction } from "./acesDisplayInverse";
import { acesSdrOutputLutPathV1, ACES_PHONE_SDR_OUTPUT_LUT_V1, usesAcesClipDisplayInverseV1, withAcesPhonePolicyV1 } from "./acesPhoneInputV1";

const old = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" as const };
const fresh = withAcesPhonePolicyV1(old);
describe("approved ACES phone BT.1886 input", () => {
  it("preserves every historic input/grade/output routing decision", () => {
    for (const outputTransform of ["rec709_sdr", "p3d65_sdr", "rec2100_hlg_1000", "rec2100_pq_1000"] as const) {
      for (const input of ["rec709", "srgb", "hlg", "pq", "acescct", "apple_log", "linear_rec709", "blocked_log"] as const) {
        for (const gradeV2 of [undefined, { schema: "editkin.color-grade/v2" as const }]) {
          for (const rec709DisplayPolicy of [undefined, "legacy-grade-v2"] as const) {
            const management = { ...old, outputTransform, rec709DisplayPolicy };
            expect(usesAcesClipDisplayInverseV1(input, management, { gradeV2 })).toBe(Boolean(gradeV2) && usesAcesDisplayReconstruction(input, management));
          }
        }
      }
    }
  });
  it("reconstructs ungraded and graded fresh display video but keeps scene inputs scene-referred", () => {
    for (const input of ["rec709", "srgb", "hlg", "pq"] as const) expect(usesAcesClipDisplayInverseV1(input, fresh, {})).toBe(true);
    for (const input of ["acescct", "apple_log", "linear_rec709", "blocked_log"] as const) expect(usesAcesClipDisplayInverseV1(input, fresh, {})).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", fresh, { rec709Input: "camera", gradeV2: { schema: "editkin.color-grade/v2" } })).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", fresh, { rec709Input: "display" })).toBe(true);
  });
  it("does not enable reconstruction in quick Rec.709, other displays, or the refused linear-white-balance route", () => {
    expect(usesAcesClipDisplayInverseV1("rec709", withAcesPhonePolicyV1(DEFAULT_COLOR_MANAGEMENT), {})).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", { ...fresh, outputTransform: "p3d65_sdr" }, {})).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", fresh, {}, true)).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", old, { gradeV2: { schema: "editkin.color-grade/v2" } }, true)).toBe(false);
  });
  it("uses a separate BT.1886 output only for the new SDR recipe", () => {
    expect(acesSdrOutputLutPathV1(old)).toBe(ACES_SDR_OUTPUT_LUT);
    expect(acesSdrOutputLutPathV1(fresh)).toBe(ACES_PHONE_SDR_OUTPUT_LUT_V1);
    expect(acesSdrOutputLutPathV1({ ...fresh, outputTransform: "p3d65_sdr" })).toBe(ACES_SDR_OUTPUT_LUT);
  });
  it("uses the pinned OCIO Rec.1886 EOTF rather than the old sRGB display encoding", () => {
    const oldLut = parseCubeLut(readFileSync(`public/color/aces2/${ACES_SDR_OUTPUT_LUT}`, "utf8"));
    const newLut = parseCubeLut(readFileSync(`public/color/aces2/${ACES_PHONE_SDR_OUTPUT_LUT_V1}`, "utf8"));
    const eotf = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    expect(newLut.size).toBe(65);
    for (const v of [.25, .375, .5, .625]) {
      const a = sampleCubeLut(oldLut, [v, v, v]), b = sampleCubeLut(newLut, [v, v, v]);
      b.forEach((code, i) => expect(Math.abs(code - eotf(a[i]) ** (1 / 2.4))).toBeLessThan(.00001));
    }
  });
  it("round-trips neutral endpoints and representative display colors through the actual65 inverse and output", () => {
    const output = parseCubeLut(readFileSync(`public/color/aces2/${ACES_PHONE_SDR_OUTPUT_LUT_V1}`, "utf8"));
    const inverse = acesDisplayInverseFor(output);
    expect(inverse.size).toBe(65);
    for (const rgb of [[0, 0, 0], [.02, .02, .02], [.18, .18, .18], [.5, .5, .5], [.95, .95, .95], [1, 1, 1], [.72, .47, .36], [.24, .52, .75], [.26, .58, .34]] as [number, number, number][]) {
      const actual = sampleCubeLut(output, sampleCubeLut(inverse, rgb));
      expect(Math.max(...actual.map((v, i) => Math.abs(v - rgb[i])))).toBeLessThan(.012);
    }
  }, 60_000);
});
