import { describe, expect, it } from "vitest";
import { analyzeShotColor, DEFAULT_SHOT_COLOR_THRESHOLDS, SHOT_COLOR_LIMITS, ShotColorAnalysisError, type ShotColorFrame } from "./shotColorAnalysis";

function frame(values: number[], extra: Partial<ShotColorFrame> = {}): ShotColorFrame {
  return { sampleId: "a", timeSeconds: 0, width: values.length / 3, height: 1, format: "rgb32f", primaries: "bt709", transfer: "linear", range: "full", pixels: new Float32Array(values), ...extra };
}
function measure(values: number[], extra: Partial<ShotColorFrame> = {}) { return analyzeShotColor([frame(values, extra)]).frames[0]; }

describe("bounded representative RGB measurements", () => {
  it("calibrates RGB coefficients, endpoints and nearest-rank quantiles independently", () => {
    const result = analyzeShotColor([frame([0,0,0, 1,1,1, 1,0,0, 0,1,0, 0,0,1])]);
    const value = result.frames[0];
    expect(value.linearRelativeY.mean).toBeCloseTo(.4, 12);
    expect(value.linearRelativeY.minimum).toBe(0);
    expect(value.linearRelativeY.maximum).toBe(1);
    expect(value.linearRelativeY.p50).toBe(Math.floor(.2126 * 4095) / 4095);
    expect(value.nearBlack).toEqual({ count: 1, fraction: .2 });
    expect(value.nearWhite).toEqual({ count: 1, fraction: .2 });
    expect(value.encodedEndpoints.low.map(x => x.count)).toEqual([3,3,3]);
    expect(value.encodedEndpoints.high.map(x => x.count)).toEqual([2,2,2]);
    expect(value.encodedEndpoints.anyLow.count).toBe(4);
    expect(value.encodedEndpoints.anyHigh.count).toBe(4);
    expect(value.relativeLinearChroma.mean).toBeCloseTo(.6, 12);
    expect(measure([1,0,0]).linearRelativeY.mean).toBeCloseTo(.2126, 12);
    expect(measure([0,1,0]).linearRelativeY.mean).toBeCloseTo(.7152, 12);
    expect(measure([0,0,1]).linearRelativeY.mean).toBeCloseTo(.0722, 12);
  });
  it("distinguishes linear, sRGB and inverse Rec709 OETF without guessing transfer", () => {
    expect(measure([.5,.5,.5]).linearRelativeY.mean).toBeCloseTo(.5, 7);
    expect(measure([.5,.5,.5], { transfer: "srgb" }).linearRelativeY.mean).toBeCloseTo(.21404114048223255, 7);
    expect(measure([.5,.5,.5], { transfer: "bt709-oetf" }).linearRelativeY.mean).toBeCloseTo(.25958940050628576, 7);
  });
  it("reports candidates, not trusted neutrals or an automatic grade", () => {
    const result = analyzeShotColor([frame([0,0,0, 1,1,1, .5,.5,.5, 1,0,0])]);
    expect(result.frames[0].neutralCandidates).toEqual({ count: 1, fraction: .25, meanLinearRgb: [.5,.5,.5], trustedWhitePoint: false });
    expect(result.advice.exposure.status).toBe("unmeasured");
    expect(result.advice.whiteBalance.status).toBe("unmeasured");
    expect(measure([1,0,0]).neutralCandidates.meanLinearRgb).toBeNull();
  });
  it("calibrates 100 ordered samples against a sorted nearest-rank oracle", () => {
    const values = Array.from({ length: 100 }, (_, i) => i / 99);
    const result = analyzeShotColor([frame(values.flatMap(v => [v,v,v]))]);
    for (const [key, rank] of [["p01",1],["p05",5],["p50",50],["p95",95],["p99",99]] as const) {
      expect(Math.abs(result.frames[0].linearRelativeY[key] - values[rank - 1])).toBeLessThanOrEqual(result.quantiles.maximumAbsoluteBinError + 1e-7);
    }
  });
  it("measures temporal changes, including signed decrease and identical controls", () => {
    const result = analyzeShotColor([frame([0,0,0]), frame([1,1,1], { sampleId: "b", timeSeconds: 2 }), frame([1,1,1], { sampleId: "c", timeSeconds: 3 }), frame([0,0,0], { sampleId: "d", timeSeconds: 4 })]);
    expect(result.changes[0]).toMatchObject({ elapsedSeconds: 2, meanAbsoluteLinearRgbDifference: 1, meanYDifference: 1, nearWhiteFractionDifference: 1 });
    expect(result.changes[1].meanAbsoluteLinearRgbDifference).toBe(0);
    expect(result.changes[2].meanYDifference).toBe(-1);
  });
  it("supports packed byte subviews without mutating input or aliasing thresholds", () => {
    const bytes = new Uint8Array([19, 128,128,128, 27]);
    const thresholds = { ...DEFAULT_SHOT_COLOR_THRESHOLDS };
    const before = [...bytes];
    const result = analyzeShotColor([frame([0,0,0], { format: "rgb8", pixels: bytes.subarray(1,4), transfer: "srgb" })], thresholds);
    expect(result.frames[0].linearRelativeY.mean).toBeCloseTo(.21586050011389926, 7);
    expect([...bytes]).toEqual(before);
    thresholds.nearBlackY = .005;
    expect(result.thresholds.nearBlackY).toBe(.01);
  });
  it.each([
    { width: 0 }, { width: -1 }, { width: .5 }, { width: Number.MAX_SAFE_INTEGER },
    { timeSeconds: NaN }, { timeSeconds: Infinity }, { timeSeconds: -1 }, { sampleId: " " },
    { primaries: "bt2020" }, { transfer: "hlg" }, { range: "limited" },
    { pixels: new Float32Array([0,0]) }, { pixels: new Float32Array([0,0,0,1]) },
    { pixels: new Uint8Array(3) }, { pixels: [0,0,0] },
    ...[NaN, Infinity, -.1, 1.1].map(v => ({ pixels: new Float32Array([v,0,0]) })),
  ])("rejects malformed or unsupported input %j", extra => {
    expect(() => analyzeShotColor([frame([0,0,0], extra as Partial<ShotColorFrame>)])).toThrow(ShotColorAnalysisError);
  });
  it("rejects empty, duplicates, chronology, mismatched geometry and batch budgets", () => {
    expect(() => analyzeShotColor([])).toThrow(ShotColorAnalysisError);
    expect(() => analyzeShotColor([frame([0,0,0]), frame([0,0,0], { timeSeconds: 1 })])).toThrow(/IDs/);
    expect(() => analyzeShotColor([frame([0,0,0]), frame([0,0,0], { sampleId: "b" })])).toThrow(/times/);
    expect(() => analyzeShotColor([frame([0,0,0]), frame([0,0,0,0,0,0], { sampleId: "b", timeSeconds: 1 })])).toThrow(/geometry/);
    expect(() => analyzeShotColor(Array.from({ length: 17 }, (_, i) => frame([0,0,0], { sampleId: String(i), timeSeconds: i })))).toThrow(/16/);
    const bytes = new Uint8Array(SHOT_COLOR_LIMITS.pixelsPerFrame * 3);
    expect(() => analyzeShotColor(Array.from({ length: 5 }, (_, i) => frame([], { sampleId: String(i), timeSeconds: i, width: 1024, height: 1024, format: "rgb8", pixels: bytes })))).toThrow(/budget/);
    expect(() => analyzeShotColor([frame([], { width: SHOT_COLOR_LIMITS.pixelsPerFrame + 1 })])).toThrow(/oversized/);
  });
  it("rejects concurrent buffers and invalid thresholds", () => {
    expect(() => analyzeShotColor([frame([0,0,0], { pixels: new Float32Array(new SharedArrayBuffer(12)) })])).toThrow(/shared/);
    for (const threshold of [{ ...DEFAULT_SHOT_COLOR_THRESHOLDS, nearBlackY: NaN }, { ...DEFAULT_SHOT_COLOR_THRESHOLDS, neutralMinimumY: 0 }, { ...DEFAULT_SHOT_COLOR_THRESHOLDS, neutralMaximumY: 1 }]) {
      expect(() => analyzeShotColor([frame([0,0,0])], threshold)).toThrow(ShotColorAnalysisError);
    }
  });
});
