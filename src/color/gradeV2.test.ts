import { describe, expect, it } from "vitest";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/types";
import {
  applyColorGradeV2Rgb, compileGradeNode, finishingThresholdInWorkingSpace, gradeWorkingSpace, resolveColorGradeV2, skinWeight, vignetteMaskValue,
} from "./gradeV2";
import {
  acescctToLinear, buildMonotoneCurve, buildPeriodicCurve, evaluateMonotoneCurve, evaluatePeriodicCurve, linearRec709ToOklab, linearToAcescct,
  oklabHueAnchors, oklabHueDegrees, oklabHueToWheel, oklabToWorking, wheelToOklabHue, workingToOklab, type Vec3,
} from "./gradeV2Color";
import { FILM_LOOKS_V2 } from "../creative/filmLooksV2";

const grade = (...nodes: ColorGradeNodeV2[]): ColorGradeV2 => ({ schema: "editkin.color-grade/v2", nodes });
const hueOf = (rgb: Vec3, space: "rec709_display" | "acescct" = "rec709_display") => { const lab = workingToOklab(rgb, space); return oklabHueDegrees(lab[1], lab[2]); };
const chromaOf = (rgb: Vec3, space: "rec709_display" | "acescct" = "rec709_display") => { const lab = workingToOklab(rgb, space); return Math.hypot(lab[1], lab[2]); };
const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index], digits));

describe("Color Grade v2 colour math", () => {
  it("round-trips working values through Oklab in both working spaces", () => {
    for (const space of ["rec709_display", "acescct"] as const) {
      for (const rgb of [[0, 0, 0], [1, 1, 1], [0.18, 0.4, 0.73], [0.5, 0.5, 0.5], [0.09, 0.55, 0.2]] as Vec3[]) {
        close(oklabToWorking(workingToOklab(rgb, space), space), rgb, 9);
      }
    }
    expect(acescctToLinear(linearToAcescct(0.18))).toBeCloseTo(0.18, 12);
    expect(linearToAcescct(0.0078125)).toBeCloseTo(0.155251141552511, 9);
  });

  it("maps ACES neutral to Oklab neutral and Rec.709 primaries onto the 0/60/…/300 hue wheel", () => {
    const grey = workingToOklab([0.4135, 0.4135, 0.4135], "acescct");
    expect(Math.hypot(grey[1], grey[2])).toBeLessThan(1e-9);
    const anchors = oklabHueAnchors();
    anchors.forEach((anchor, index) => expect(oklabHueToWheel(anchor)).toBeCloseTo(index * 60, 9));
    for (const wheel of [0, 17, 95, 180, 233.5, 359]) expect(oklabHueToWheel(wheelToOklabHue(wheel))).toBeCloseTo(wheel, 9);
  });

  it("interpolates monotone cubic curves without overshoot and wraps periodic curves", () => {
    const curve = buildMonotoneCurve([0, 0.3, 0.5, 1], [0, 0.5, 0.5, 1]);
    for (let x = 0; x <= 1; x += 0.01) {
      const y = evaluateMonotoneCurve(curve, x);
      expect(y).toBeGreaterThanOrEqual(-1e-12); expect(y).toBeLessThanOrEqual(1 + 1e-12);
      if (x > 0.3 && x < 0.5) expect(y).toBeCloseTo(0.5, 12);
    }
    const periodic = buildPeriodicCurve([30, 200, 300], [1, 1.3, 1]);
    expect(evaluatePeriodicCurve(periodic, 200)).toBeCloseTo(1.3, 12);
    expect(evaluatePeriodicCurve(periodic, 360 + 30)).toBeCloseTo(evaluatePeriodicCurve(periodic, 30), 12);
    expect(Math.abs(evaluatePeriodicCurve(periodic, 359.999) - evaluatePeriodicCurve(periodic, 0))).toBeLessThan(1e-4);
  });
});

describe("Color Grade v2 CPU reference", () => {
  it("is the exact identity without operations, and skips disabled, mixed-out and neutral nodes", () => {
    for (const value of [grade(), grade({ id: "n", enabled: false, contrast: 2 }), grade({ id: "n", mix: 0, gain: { master: 1 } }),
      grade({ id: "n", skinProtection: 1, curves: { y: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, hueVsSat: [{ hue: 0, value: 1 }, { hue: 180, value: 1 }] })]) {
      const resolved = resolveColorGradeV2(value, "rec709_display");
      expect(resolved.identity).toBe(true);
      close(applyColorGradeV2Rgb(value, "rec709_display", [0.2, 0.6, 0.9]), [0.2, 0.6, 0.9], 15);
    }
  });

  it("applies lift / gamma / gain / offset per channel with master + RGB wheels", () => {
    close(applyColorGradeV2Rgb(grade({ id: "n", lift: { master: 0.1 } }), "rec709_display", [0, 0.5, 1]), [0.1, 0.55, 1]);
    close(applyColorGradeV2Rgb(grade({ id: "n", gain: { master: 0.2, b: -0.2 } }), "rec709_display", [0.5, 0.5, 0.5]), [0.6, 0.6, 0.5]);
    close(applyColorGradeV2Rgb(grade({ id: "n", offset: { r: 0.05 } }), "rec709_display", [0.5, 0.5, 0.5]), [0.55, 0.5, 0.5]);
    const brighter = applyColorGradeV2Rgb(grade({ id: "n", gamma: { master: 0.5 } }), "rec709_display", [0.25, 0.25, 0.25]);
    expect(brighter[0]).toBeCloseTo(Math.pow(0.25, Math.pow(2, -0.5)), 12);
    expect(brighter[0]).toBeGreaterThan(0.25);
  });

  it("keeps the contrast pivot fixed and uses the space default pivot", () => {
    close(applyColorGradeV2Rgb(grade({ id: "n", contrast: 1.5, pivot: 0.4 }), "rec709_display", [0.4, 0.4, 0.4]), [0.4, 0.4, 0.4]);
    close(applyColorGradeV2Rgb(grade({ id: "n", contrast: 1.5 }), "acescct", [0.435, 0.435, 0.435]), [0.435, 0.435, 0.435]);
    expect(applyColorGradeV2Rgb(grade({ id: "n", contrast: 1.5 }), "rec709_display", [0.8, 0.8, 0.8])[0]).toBeCloseTo(0.45 + 0.35 * 1.5, 12);
  });

  it("tones shadows with log wheels far more than highlights", () => {
    const node: ColorGradeNodeV2 = { id: "n", log: { shadow: { b: 0.05 } } };
    const dark = applyColorGradeV2Rgb(grade(node), "rec709_display", [0.1, 0.1, 0.1]);
    const bright = applyColorGradeV2Rgb(grade(node), "rec709_display", [0.9, 0.9, 0.9]);
    const black = applyColorGradeV2Rgb(grade(node), "rec709_display", [0, 0, 0]);
    expect(dark[2] - 0.1).toBeGreaterThan(0.045);
    expect(bright[2] - 0.9).toBeLessThan(1e-9);
    close(black, [0, 0, 0], 12);
    close(applyColorGradeV2Rgb(grade(node), "acescct", [0.0729055341958355, 0.0729055341958355, 0.0729055341958355]), [0.0729055341958355, 0.0729055341958355, 0.0729055341958355], 12);
  });

  it("changes saturation in Oklab without moving lightness or hue, and never tints neutrals", () => {
    const rgb: Vec3 = [0.7, 0.45, 0.3];
    const before = workingToOklab(rgb, "rec709_display");
    const after = workingToOklab(applyColorGradeV2Rgb(grade({ id: "n", saturation: 0.6 }), "rec709_display", rgb), "rec709_display");
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(oklabHueDegrees(after[1], after[2])).toBeCloseTo(oklabHueDegrees(before[1], before[2]), 6);
    expect(Math.hypot(after[1], after[2])).toBeCloseTo(Math.hypot(before[1], before[2]) * 0.6, 9);
    const hueShift = grade({ id: "n", hueVsHue: [{ hue: 0, value: 30 }, { hue: 180, value: 30 }], saturation: 1.4, colorBoost: 0.5 });
    close(applyColorGradeV2Rgb(hueShift, "rec709_display", [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5], 9);
  });

  it("rotates hue on the hue wheel and boosts saturated colours less (chroma headroom)", () => {
    const sky: Vec3 = [0.35, 0.55, 0.85];
    const shifted = applyColorGradeV2Rgb(grade({ id: "n", hueVsHue: [{ hue: 120, value: 0 }, { hue: 240, value: -20 }, { hue: 330, value: 0 }] }), "rec709_display", sky);
    const wheelBefore = oklabHueToWheel(hueOf(sky)), wheelAfter = oklabHueToWheel(hueOf(shifted));
    expect(wheelAfter).toBeLessThan(wheelBefore);
    const boost = grade({ id: "n", saturation: 1.5 });
    const dull: Vec3 = [0.55, 0.5, 0.45], vivid: Vec3 = [0.95, 0.2, 0.1];
    const dullGain = chromaOf(applyColorGradeV2Rgb(boost, "rec709_display", dull)) / chromaOf(dull);
    const vividGain = chromaOf(applyColorGradeV2Rgb(boost, "rec709_display", vivid)) / chromaOf(vivid);
    expect(dullGain).toBeCloseTo(1.5, 6);
    expect(vividGain).toBeLessThan(1.25);
  });

  it("protects skin hue from creative hue rotation while other colours rotate", () => {
    const skin: Vec3 = [0.86, 0.66, 0.55];
    expect(skinWeight(workingToOklab(skin, "rec709_display"))).toBeGreaterThan(0.9);
    const rotate = (protect: number) => grade({ id: "n", hueVsHue: [{ hue: 0, value: 25 }, { hue: 120, value: 25 }, { hue: 240, value: 25 }], skinProtection: protect });
    const unprotected = Math.abs(hueOf(applyColorGradeV2Rgb(rotate(0), "rec709_display", skin)) - hueOf(skin));
    const protectedShift = Math.abs(hueOf(applyColorGradeV2Rgb(rotate(1), "rec709_display", skin)) - hueOf(skin));
    expect(unprotected).toBeGreaterThan(10);
    expect(protectedShift).toBeLessThan(1);
    const blue: Vec3 = [0.2, 0.3, 0.8];
    expect(Math.abs(hueOf(applyColorGradeV2Rgb(rotate(1), "rec709_display", blue)) - hueOf(blue))).toBeGreaterThan(10);
  });

  it("applies Y curves as luma offsets and RGB curves per channel", () => {
    const lifted = applyColorGradeV2Rgb(grade({ id: "n", curves: { y: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] } }), "rec709_display", [0, 0, 0]);
    close(lifted, [0.1, 0.1, 0.1]);
    const red = applyColorGradeV2Rgb(grade({ id: "n", curves: { r: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] } }), "rec709_display", [0.5, 0.5, 0.5]);
    close(red, [0.6, 0.5, 0.5]);
  });

  it("mixes nodes, chains them in order and applies a look at its strength", () => {
    const half = applyColorGradeV2Rgb(grade({ id: "n", offset: { master: 0.2 }, mix: 0.5 }), "rec709_display", [0.3, 0.3, 0.3]);
    close(half, [0.4, 0.4, 0.4]);
    const chained = applyColorGradeV2Rgb(grade({ id: "a", gain: { master: 1 } }, { id: "b", offset: { master: -0.1 } }), "rec709_display", [0.2, 0.2, 0.2]);
    close(chained, [0.3, 0.3, 0.3]);
    const look = FILM_LOOKS_V2[0].id;
    expect(resolveColorGradeV2({ schema: "editkin.color-grade/v2", look: { id: look, strength: 0 } }, "rec709_display").identity).toBe(true);
    const full = applyColorGradeV2Rgb({ schema: "editkin.color-grade/v2", look: { id: look } }, "rec709_display", [0.3, 0.5, 0.7]);
    const partial = applyColorGradeV2Rgb({ schema: "editkin.color-grade/v2", look: { id: look, strength: 0.5 } }, "rec709_display", [0.3, 0.5, 0.7]);
    close(partial, [0.3 + (full[0] - 0.3) / 2, 0.5 + (full[1] - 0.5) / 2, 0.7 + (full[2] - 0.7) / 2]);
    expect(() => resolveColorGradeV2({ schema: "editkin.color-grade/v2", look: { id: "hfl2_missing_look" } }, "rec709_display")).toThrow(/找不到/);
  });

  it("resolves looks per working space and scales look finishing by strength unless overridden", () => {
    const softFilm = FILM_LOOKS_V2.find(item => item.id === "hfl2_vlog_soft_film")!;
    expect(JSON.stringify(softFilm.grade("acescct"))).not.toBe(JSON.stringify(softFilm.grade("rec709_display")));
    const scaled = resolveColorGradeV2({ schema: "editkin.color-grade/v2", look: { id: softFilm.id, strength: 0.5 } }, "rec709_display");
    const fullGrain = softFilm.grade("rec709_display").finishing?.grain?.amount ?? 0;
    expect(fullGrain).toBeGreaterThan(0);
    expect(scaled.finishing?.grain?.amount).toBeCloseTo(fullGrain * 0.5, 9);
    const overridden = resolveColorGradeV2({ schema: "editkin.color-grade/v2", look: { id: softFilm.id }, finishing: { vignette: { amount: 0.2 } } }, "rec709_display");
    expect(overridden.finishing).toEqual({ vignette: { amount: 0.2 } });
    expect(resolveColorGradeV2({ schema: "editkin.color-grade/v2", look: { id: softFilm.id }, finishing: {} }, "rec709_display").finishing).toBeUndefined();
    expect(gradeWorkingSpace({ mode: "aces2" })).toBe("acescct");
    expect(gradeWorkingSpace(undefined)).toBe("rec709_display");
  });

  it("produces equal keys for equal grades and different keys for different spaces or parameters", () => {
    const a = resolveColorGradeV2(grade({ id: "n", contrast: 1.2, pivot: 0.4 }), "rec709_display");
    const b = resolveColorGradeV2(grade({ pivot: 0.4, contrast: 1.2, id: "n" } as ColorGradeNodeV2), "rec709_display");
    expect(a.key).toBe(b.key);
    expect(resolveColorGradeV2(grade({ id: "n", contrast: 1.2, pivot: 0.4 }), "acescct").key).not.toBe(a.key);
    expect(resolveColorGradeV2(grade({ id: "n", contrast: 1.21, pivot: 0.4 }), "rec709_display").key).not.toBe(a.key);
  });

  it("requires a resolver for LUT nodes and blends the LUT by strength", () => {
    const node: ColorGradeNodeV2 = { id: "n", lut: { id: "lut:0123456789abcdef", sha256: "0123456789abcdef".padEnd(64, "0"), strength: 0.5 } };
    expect(() => compileGradeNode(node, "rec709_display")).toThrow(/LUT/);
    const invert = { kind: "1d" as const, size: 2, domainMin: [0, 0, 0] as [number, number, number], domainMax: [1, 1, 1] as [number, number, number], values: new Float32Array([1, 1, 1, 0, 0, 0]) };
    close(applyColorGradeV2Rgb(grade(node), "rec709_display", [0.2, 0.2, 0.2], () => invert), [0.5, 0.5, 0.5], 6);
  });

  it("gamut limit keeps graded colours inside, holds ACES colours that came in outside and never pushes display colours past their input", () => {
    const boost: ColorGradeNodeV2 = { id: "n", saturation: 1.6, gamutLimit: true };
    const ap1 = (rgb: Vec3) => rgb.map(linearToAcescct) as Vec3;
    const maxLinear = (rgb: Vec3) => Math.max(...rgb.map(acescctToLinear));
    // Inside before the node, pushed out by it: lands on the AP1 ≤1.25 boundary instead of clipping.
    const inside = ap1([0.9, 0.32, 0.1]);
    const limited = applyColorGradeV2Rgb(grade(boost), "acescct", inside);
    expect(maxLinear(limited)).toBeLessThanOrEqual(1.25 + 1e-9);
    expect(chromaOf(limited, "acescct")).toBeGreaterThan(chromaOf(inside, "acescct"));
    // Bright HLG orange already above the ceiling (W1 ramen soup): held at its own chroma, not greyed.
    const hot = ap1([1.6, 0.45, 0.12]);
    const held = applyColorGradeV2Rgb(grade(boost), "acescct", hot);
    expect(chromaOf(held, "acescct")).toBeCloseTo(chromaOf(hot, "acescct"), 6);
    expect(maxLinear(held)).toBeLessThanOrEqual(1.6 + 1e-6);
    expect(Math.abs(hueOf(held, "acescct") - hueOf(hot, "acescct"))).toBeLessThan(1e-6);
    // A node that desaturates on its own keeps doing so for out-of-gamut input.
    const calmer = applyColorGradeV2Rgb(grade({ id: "n", saturation: 0.7, gamutLimit: true }), "acescct", hot);
    expect(chromaOf(calmer, "acescct")).toBeCloseTo(chromaOf(hot, "acescct") * 0.7, 6);
    // Display Rec.709 just above the 0.965 headroom: brightened and boosted, but no channel passes its input level.
    const nearClip: Vec3 = [0.99, 0.55, 0.25];
    const lifted = applyColorGradeV2Rgb(grade({ id: "n", gain: { master: 0.04 }, saturation: 1.3, gamutLimit: true }), "rec709_display", nearClip);
    expect(Math.max(...lifted)).toBeLessThanOrEqual(0.99 + 1e-9);
  });
});

describe("Color Grade v2 spatial reference", () => {
  it("matches vf_vignette's forward factor and maps glow thresholds into ACEScct", () => {
    expect(vignetteMaskValue(50, 50, 100, 100, 0.5)).toBe(1);
    const corner = vignetteMaskValue(0, 0, 100, 100, 0.5);
    expect(corner).toBeCloseTo(Math.trunc(255 * Math.cos(Math.PI / 4) ** 4) / 255, 12);
    expect(finishingThresholdInWorkingSpace(0.8, "rec709_display")).toBe(0.8);
    // ACEScct threshold = where the ACES 2.0 SDR output renders display 0.8 (not a γ2.4 scene model).
    const cct = finishingThresholdInWorkingSpace(0.8, "acescct");
    expect(cct).toBeCloseTo(0.6002, 4);
    expect(acescctToLinear(cct)).toBeGreaterThan(Math.pow(0.8, 2.4) * 2);
    expect(linearRec709ToOklab([1, 1, 1])[0]).toBeCloseTo(1, 6);
  });
});
