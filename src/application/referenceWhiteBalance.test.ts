import { describe, expect, it } from "vitest";
import { measureReferenceWhiteBalanceFrame as measure, selectReferenceWhiteBalanceCandidate as select, type ReferenceWhiteBalanceFrame } from "./referenceWhiteBalance";
const base = { temperature: 0, tint: 0 };
function frame(rgb = [120, 110, 100], extra: Partial<ReferenceWhiteBalanceFrame> = {}): ReferenceWhiteBalanceFrame {
  return { sampleId: "a", timeSeconds: 0, width: 8, height: 8, roi: { x: 0, y: 0, width: 1, height: 1 },
    transfer: "bt709-oetf", reference: "caller-declared-neutral", pixels: new Uint8Array(Array.from({ length: 64 }, () => rgb).flat()), ...extra };
}
const candidate = (rgb: number[], temperature = 0, tint = 0) => ({ temperature, tint, frames: [measure(frame(rgb))] });
describe("caller declared reference WB proxy", () => {
  it("measures a neutral patch without asserting neutral provenance", () => {
    const f = measure(frame([128, 128, 128])); expect(f.pixelCount).toBe(64); expect(f.neutralErrorStops).toBe(0);
    expect(f.meanLinearRgb[0]).toBeCloseTo(((128 / 255 + .099) / 1.099) ** (1 / .45), 12);
    expect(f.varianceLinearRgb.every(v => v < 1e-12)).toBe(true);
    expect(select([candidate([128, 128, 128])], base)).toMatchObject({ status: "unchanged", referenceAuthority: "caller-declared-not-detected", whitePointVerification: "unmeasured" });
  });
  it("selects independently constructed improved decoded pixels, not gradeRgb", () => {
    const result = select([candidate([120, 110, 100]), candidate([111, 111, 111], -.25)], base);
    expect(result.status).toBe("candidate"); expect(result.selectedIndex).toBe(1);
  });
  it("rejects clipping, black/white and luminance drift", () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [255, 80, 80]]) expect(select([candidate(rgb)], base).status).toBe("reference_unusable");
    const result = select([candidate([120, 110, 100]), candidate([200, 200, 200], .25)], base);
    expect(result.candidates[1].accepted).toBe(false); expect(result.status).toBe("target_unreachable");
  });
  it("rejects mixed colours whose mean is exactly neutral", () => {
    const mixed = frame([128, 128, 128], { transfer: "linear", pixels: new Uint8Array(Array.from({ length: 64 }, (_, i) => i % 2 ? [50, 150, 100] : [150, 50, 100]).flat()) });
    const m = measure(mixed); expect(m.neutralErrorStops).toBeCloseTo(0, 12);
    expect(select([{ ...base, frames: [m] }], base).status).toBe("reference_unusable");
  });
  it("does not infer a neutral reference from a coloured object", () => {
    expect(() => measure(frame([100, 100, 100], { reference: undefined } as unknown as Partial<ReferenceWhiteBalanceFrame>))).toThrow();
    expect(select([candidate([140, 80, 80])], base).whitePointVerification).toBe("unmeasured");
  });
  it("rejects invalid geometry and nonfinite metadata", () => {
    for (const extra of [{ width: 257 }, { timeSeconds: NaN }, { roi: { x: -.1, y: 0, width: 1, height: 1 } }, { roi: { x: .8, y: 0, width: .3, height: 1 } }, { roi: { x: 0, y: 0, width: .1, height: .1 } }]) expect(() => measure(frame([128, 128, 128], extra))).toThrow();
  });
  it("rejects mismatched surfaces, duplicate baseline and excessive delta", () => {
    const a = candidate([120, 110, 100]);
    for (const mutate of [(b: typeof a) => { b.frames[0].sampleId = "other"; }, (b: typeof a) => { b.frames[0].transfer = "linear"; }, (b: typeof a) => { b.frames[0].timeSeconds = 1; }, (b: typeof a) => { b.temperature = 1.01; }, (b: typeof a) => { b.frames[0].endpointFraction = .9; }]) {
      const b = candidate([111, 111, 111], -.25); mutate(b); expect(() => select([a, b], base)).toThrow();
    }
    expect(() => select([a, a], base)).toThrow(); expect(() => select([candidate([111, 111, 111], .25)], base)).toThrow();
  });
});
