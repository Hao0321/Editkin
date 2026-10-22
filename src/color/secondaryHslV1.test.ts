import { describe, expect, it, vi } from "vitest";
import { compileSecondaryHslKeyV1, secondaryHslKeyWeightV1, workingRgbToHslV1 } from "./secondaryHslV1";
import { applyColorGradeV2Rgb, resolveColorGradeV2 } from "./gradeV2";
import { bakeResolvedGradeLut, sampleBakedGradeLut } from "./gradeLutBake";
import { parseCubeFile } from "./cubeLut";
import type { Vec3 } from "./gradeV2Color";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/visualTypes";
import type { SecondaryHslV1 } from "../domain/secondaryHslV1Types";

const selectRed: SecondaryHslV1 = { schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code", qualifier: { hue: { centerDegrees: 0, halfWidthDegrees: 20 } } };
const grade = (...nodes: ColorGradeNodeV2[]): ColorGradeV2 => ({ schema: "editkin.color-grade/v2", nodes });
describe("secondary HSL input selection and paired grade", () => {
  it.each([
    [[1, 0, 0], 0], [[1, 1, 0], 60], [[0, 1, 0], 120],
    [[0, 1, 1], 180], [[0, 0, 1], 240], [[1, 0, 1], 300],
  ] as [Vec3, number][])("computes hand-checkable RGB %j hue %s", (rgb, hue) => {
    expect(workingRgbToHslV1(rgb)).toEqual({ hue, saturation: 1, lightness: .5 });
  });
  it("does not treat grey, black or white as red; a lightness-only key can select them", () => {
    const red = compileSecondaryHslKeyV1(selectRed.qualifier), middle = compileSecondaryHslKeyV1({ lightness: { minimum: .4, maximum: .6 } });
    for (const level of [0, .5, 1]) {
      expect(workingRgbToHslV1([level, level, level]).hue).toBeUndefined();
      expect(secondaryHslKeyWeightV1([level, level, level], red)).toBe(0);
    }
    expect(secondaryHslKeyWeightV1([.5, .5, .5], middle)).toBe(1);
  });
  it("softens circular hue symmetrically through the red seam", () => {
    const key = compileSecondaryHslKeyV1({ hue: { centerDegrees: 0, halfWidthDegrees: 15, softnessDegrees: 30 } });
    expect(secondaryHslKeyWeightV1([1, .5, 0], key)).toBe(.5);
    expect(secondaryHslKeyWeightV1([1, 0, .5], key)).toBe(.5);
    expect(secondaryHslKeyWeightV1([1, 0, 0], key)).toBe(1);
    expect(secondaryHslKeyWeightV1([1, 1, 0], key)).toBe(0);
  });
  it("multiplies bounded S/L transitions, then cleans black/white and inverts", () => {
    const qualifier = { lightness: { minimum: .4, maximum: .6, softness: .2 } };
    const plain = compileSecondaryHslKeyV1(qualifier), cleaned = compileSecondaryHslKeyV1(qualifier, { blackPoint: .25, whitePoint: .75 });
    const inverted = compileSecondaryHslKeyV1(qualifier, { blackPoint: .25, whitePoint: .75 }, true);
    expect(secondaryHslKeyWeightV1([.3, .3, .3], plain)).toBeCloseTo(.5, 12);
    expect(secondaryHslKeyWeightV1([.25, .25, .25], cleaned)).toBe(0);
    expect(secondaryHslKeyWeightV1([.4, .4, .4], cleaned)).toBe(1);
    expect(secondaryHslKeyWeightV1([.25, .25, .25], inverted)).toBe(1);
    const combined = compileSecondaryHslKeyV1({ saturation: { minimum: .75, maximum: 1, softness: .5 }, lightness: { minimum: .6, maximum: 1, softness: .2 } });
    expect(secondaryHslKeyWeightV1([.75, .25, .25], combined)).toBeCloseTo(.25, 12);
  });
  it("validates keys before use and refuses nonfinite pixel components", () => {
    expect(() => compileSecondaryHslKeyV1({})).toThrow();
    expect(() => compileSecondaryHslKeyV1({ lightness: { minimum: 1, maximum: 0 } })).toThrow();
    expect(() => compileSecondaryHslKeyV1(selectRed.qualifier, { blackPoint: .6, whitePoint: .4 })).toThrow();
    expect(() => secondaryHslKeyWeightV1([NaN, 0, 0], compileSecondaryHslKeyV1(selectRed.qualifier))).toThrow(/finite/);
  });
  it("grades selected and unselected colours independently without source mutation", () => {
    const value = grade({ id: "select", offset: { r: .1 }, secondaryHslV1: { ...selectRed, outside: { offset: { g: .2 } } } });
    const before = structuredClone(value), red: Vec3 = [.8, .1, .1], green: Vec3 = [.1, .6, .1];
    expect(applyColorGradeV2Rgb(value, "rec709_display", red)).toEqual([.9, .1, .1]);
    expect(applyColorGradeV2Rgb(value, "rec709_display", green)).toEqual([.1, .8, .1]);
    expect(value).toEqual(before);
    expect(red).toEqual([.8, .1, .1]);
  });
  it("blends both grades from the same input, then applies whole-node mix once", () => {
    const value = grade({ id: "select", offset: { r: .2 }, mix: .5, secondaryHslV1: { ...selectRed,
      qualifier: { lightness: { minimum: .6, maximum: 1, softness: .2 } }, outside: { gain: { r: 1 } } } });
    const result = applyColorGradeV2Rgb(value, "rec709_display", [.5, .5, .5]);
    expect(result[0]).toBeCloseTo(.675, 12);
    expect(result.slice(1)).toEqual([.5, .5]);
  });
  it("retains an active outside-only node and removes a wholly neutral selector", () => {
    const value = grade({ id: "outside", secondaryHslV1: { ...selectRed, outside: { offset: { b: .1 } } } });
    expect(resolveColorGradeV2(value, "rec709_display").identity).toBe(false);
    expect(applyColorGradeV2Rgb(value, "rec709_display", [0, .5, 0])).toEqual([0, .5, .1]);
    expect(applyColorGradeV2Rgb(value, "rec709_display", [.5, 0, 0])).toEqual([.5, 0, 0]);
    expect(resolveColorGradeV2(grade({ id: "neutral", secondaryHslV1: selectRed }), "rec709_display").identity).toBe(true);
  });
  it("selects after preceding serial nodes, before its own inside/outside grade", () => {
    const value = grade({ id: "first", offset: { master: .25 } }, { id: "second", gain: { master: .2 }, secondaryHslV1: { ...selectRed, qualifier: { lightness: { minimum: .5, maximum: .6 } } } });
    expect(applyColorGradeV2Rgb(value, "rec709_display", [.3, .3, .3])[0]).toBeCloseTo(.66, 12);
  });
  it("preserves unclamped RGB while selecting clamped working codes, also in ACEScct", () => {
    const value = grade({ id: "select", offset: { r: .1 }, secondaryHslV1: selectRed });
    expect(applyColorGradeV2Rgb(value, "rec709_display", [1.2, -.1, -.1])).toEqual([1.3, -.1, -.1]);
    const grey = grade({ id: "grey", offset: { master: .01 }, secondaryHslV1: { ...selectRed, qualifier: { lightness: { minimum: .43, maximum: .44 } } } });
    expect(applyColorGradeV2Rgb(grey, "acescct", [.435, .435, .435])).toEqual([.445, .445, .445]);
  });
  it("disabled selectors use exactly the original CPU, key and table; disabled/zero nodes load no outside LUT", () => {
    const base = { id: "same", offset: { r: .05 }, mix: .7 };
    const original = resolveColorGradeV2(grade(base), "rec709_display");
    const disabled = resolveColorGradeV2(grade({ ...base, secondaryHslV1: { ...selectRed, enabled: false, outside: { gain: { b: 1 } } } }), "rec709_display");
    expect(disabled).toEqual(original);
    expect(bakeResolvedGradeLut(disabled, 9).values).toEqual(bakeResolvedGradeLut(original, 9).values);
    const hash = "1".repeat(64), lut = { id: `lut:${hash.slice(0, 16)}`, sha256: hash, strength: 1 };
    const resolver = vi.fn();
    for (const fields of [{ enabled: false }, { mix: 0 }]) {
      expect(resolveColorGradeV2(grade({ id: "ignored", ...fields, secondaryHslV1: { ...selectRed, outside: { lut } } }), "rec709_display", resolver).identity).toBe(true);
    }
    expect(resolver).not.toHaveBeenCalled();
  });
  it("binds outside LUT content and preserves selected inside pixels in the shared bake", () => {
    const cube = parseCubeFile("LUT_3D_SIZE 2\n" + Array(8).fill("0.2 0.4 0.6").join("\n") + "\n");
    const hash = "2".repeat(64), lut = { id: `lut:${hash.slice(0, 16)}`, sha256: hash, strength: 1 };
    const value = grade({ id: "lut", secondaryHslV1: { ...selectRed, outside: { lut } } });
    const resolver = vi.fn(() => cube), resolved = resolveColorGradeV2(value, "rec709_display", resolver);
    expect(resolver).toHaveBeenCalledWith(lut);
    expect(resolved.lutRefs).toEqual([lut]);
    const baked = bakeResolvedGradeLut(resolved, 9);
    expect(sampleBakedGradeLut(baked, [1, 0, 0])).toEqual([1, 0, 0]);
    sampleBakedGradeLut(baked, [0, 1, 0]).forEach((component, index) => expect(component).toBeCloseTo([.2, .4, .6][index], 6));
    expect(resolved.key).toContain(hash);
  });
});
