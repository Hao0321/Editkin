import { describe, expect, it } from "vitest";
import { buildSubjectSheenFiltersV1, createSubjectSheenKernelV1, subjectSheenStyleV1Schema } from "./subjectSheenV1";
const style = { schema: "editkin.subject-sheen-style/v1" as const, angleDegrees: 35, bandWidthRatio: .28, intensity: .7 };
describe("source-space sixteen-bit subject sheen kernel", () => {
  it("keeps endpoints transparent, never expands the matte, preserves the input and retains sub-u8 precision", () => {
    const kernel = createSubjectSheenKernelV1(64, 40, 9, style), input = Uint16Array.from({ length: 2560 }, (_, i) => [0, 1, 257, 12345, 32768, 65535][i % 6]), before = input.slice();
    expect(kernel.renderAlpha(input, 0).every(v => v === 0)).toBe(true); expect(kernel.renderAlpha(input, 8).every(v => v === 0)).toBe(true);
    const middle = kernel.renderAlpha(input, 4); expect(middle.some(v => v > 0 && v % 257 !== 0)).toBe(true);
    for (let i = 0; i < input.length; i++) { expect(middle[i]).toBeLessThanOrEqual(input[i]); if (!input[i]) expect(middle[i]).toBe(0); }
    expect(input).toEqual(before); expect(kernel.defaultEnabled).toBe(false); expect(kernel.qualityState).toBe("ART_PENDING_CLAUDE");
  });
  it("moves an actual bright band across the source instead of modulating the entire object", () => {
    const k = createSubjectSheenKernelV1(64, 40, 9, { ...style, angleDegrees: 0, intensity: 1 });
    const input = new Uint16Array(2560).fill(65535), left = k.renderAlpha(input, 2), right = k.renderAlpha(input, 6);
    const centre = (a: Uint16Array) => { let sum = 0, weight = 0; for (let i = 0; i < a.length; i++) { sum += (i % 64) * a[i]; weight += a[i]; } return sum / weight; };
    expect(centre(left)).toBeLessThan(32); expect(centre(right)).toBeGreaterThan(32); expect(centre(right) - centre(left)).toBeGreaterThan(20);
    expect(left.some(v => v === 0)).toBe(true); expect(right.some(v => v === 0)).toBe(true);
  });
  it("supports reverse diagonal direction and an explicit zero-strength no-op", () => {
    const input = new Uint16Array(2560).fill(32768), a = createSubjectSheenKernelV1(64, 40, 9, style).renderAlpha(input, 3);
    const b = createSubjectSheenKernelV1(64, 40, 9, { ...style, angleDegrees: -35 }).renderAlpha(input, 3);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) expect(a[y * 64 + x]).toBe(b[(39 - y) * 64 + x]);
    expect(createSubjectSheenKernelV1(64, 40, 9, { ...style, intensity: 0 }).renderAlpha(input, 4).every(v => v === 0)).toBe(true);
  });
  it("keeps one sixteen-bit graph for nonzero frame offsets and refuses unsafe labels", () => {
    const p = { alphaLabel: "matte", outputLabel: "glint", width: 64, height: 40, totalFrames: 9, frameOffset: 3, style }, graph = buildSubjectSheenFiltersV1(p);
    expect(graph.pixelFormat).toBe("gbrap16le"); expect(graph.frameOffset).toBe(3); expect(graph.rasterReserveBytes).toBe(64 * 40 * 40);
    expect(() => buildSubjectSheenFiltersV1({ ...p, alphaLabel: "matte];movie=http://bad" })).toThrow();
    expect(() => buildSubjectSheenFiltersV1({ ...p, alphaLabel: "glintHwhite" })).toThrow();
    expect(() => buildSubjectSheenFiltersV1({ ...p, frameOffset: 9 })).toThrow();
  });
  it.each([[0, 40, 9], [64, 15, 9], [8193, 16, 9], [1920, 1920, 9], [64, 40, 2], [64, 40, 241]])("rejects a raster/clock outside %j", (w, h, frames) => {
    expect(() => createSubjectSheenKernelV1(w, h, frames, style)).toThrow("BUDGET");
  });
  it("checks row cancellation, bad alpha sizes, out-of-range frames and unapproved style fields", () => {
    const k = createSubjectSheenKernelV1(64, 40, 9, style), reason = Error("stop-row"); let checks = 0;
    expect(() => k.renderAlpha(new Uint16Array(2560), 4, () => { if (++checks === 2) throw reason; })).toThrow(reason);
    expect(() => k.renderAlpha(new Uint16Array(12), 4)).toThrow("SIZE"); expect(() => k.frame(9)).toThrow("FRAME");
    expect(subjectSheenStyleV1Schema.safeParse({ ...style, certified: true }).success).toBe(false);
    expect(subjectSheenStyleV1Schema.safeParse({ ...style, intensity: NaN }).success).toBe(false);
  });
});
