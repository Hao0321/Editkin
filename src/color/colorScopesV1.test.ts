import { describe, expect, it } from "vitest";
import { COLOR_SCOPE_LIMITS_V1, SKIN_HUE_RAY_V1, colorScopeBinsV1, scopeSampleSizeV1 } from "./colorScopesV1";
const sum = (values: Uint32Array) => values.reduce((a, b) => a + b, 0);
describe("bounded scopes of display-encoded pixels", () => {
  it("keeps portrait and landscape proportions within the readback budget", () => {
    expect(scopeSampleSizeV1(3840, 2160)).toEqual({ width: 320, height: 180 });
    expect(scopeSampleSizeV1(1080, 1920)).toEqual({ width: 101, height: 180 });
    expect(scopeSampleSizeV1(36, 64)).toEqual({ width: 36, height: 64 });
    expect(() => scopeSampleSizeV1(0, 1080)).toThrow();
  });
  it("calibrates channel levels, column positions and encoded luma with RGB primaries", () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const b = colorScopeBinsV1({ width: 3, height: 1, data });
    expect(b.samples).toBe(3);
    expect(b.histogram[255]).toBe(1); expect(b.histogram[256 + 255]).toBe(1); expect(b.histogram[512 + 255]).toBe(1);
    for (const level of [54, 182, 18]) expect(b.histogram[768 + level]).toBe(1);
    expect(b.waveform[127 * 256]).toBe(1);
    expect(b.waveform[(128 + 127) * 256 + 85]).toBe(1);
    expect(b.waveform[(256 + 127) * 256 + 170]).toBe(1);
    expect(sum(b.vectors)).toBe(3);
    expect(Array.from(b.vectors).filter(n => n > 0)).toHaveLength(3);
  });
  it("puts neutral gray at zero chroma and ignores fully transparent pixels", () => {
    const b = colorScopeBinsV1({ width: 2, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255, 255, 0, 0, 0]) });
    expect(b.samples).toBe(1); expect(b.vectors[64 * 128 + 64]).toBe(1);
    expect(b.histogram[128]).toBe(1); expect(b.histogram[255]).toBe(0);
  });
  it("detects a changed rendered channel without recomputing any grade", () => {
    const raw = { width: 1, height: 1, data: new Uint8ClampedArray([80, 100, 120, 255]) };
    const altered = { ...raw, data: new Uint8ClampedArray([160, 100, 120, 255]) };
    expect(colorScopeBinsV1(raw).histogram[80]).toBe(1);
    expect(colorScopeBinsV1(altered).histogram[160]).toBe(1);
    expect(colorScopeBinsV1(altered).histogram[80]).toBe(0);
    expect(raw.data[0]).toBe(80);
  });
  it("caps sampled pixels and has duration-independent storage", () => {
    const data = new Uint8ClampedArray(COLOR_SCOPE_LIMITS_V1.pixels * 4).fill(255);
    const b = colorScopeBinsV1({ width: 320, height: 180, data });
    expect(b.samples).toBeLessThanOrEqual(COLOR_SCOPE_LIMITS_V1.samples);
    for (let channel = 0; channel < 4; channel++) expect(sum(b.histogram.subarray(channel * 256, (channel + 1) * 256))).toBe(b.samples);
    expect(b.waveform.byteLength + b.histogram.byteLength + b.vectors.byteLength).toBeLessThan(512 * 1024);
  });
  it("refuses oversized, truncated or malformed inputs rather than silently measuring", () => {
    for (const image of [{ width: 321, height: 180, data: new Uint8ClampedArray(321 * 180 * 4) }, { width: 1, height: 1, data: new Uint8ClampedArray(3) }, { width: NaN, height: 1, data: new Uint8ClampedArray(4) }]) expect(() => colorScopeBinsV1(image)).toThrow();
  });
  it("uses an explicit upper-left chroma hue reference", () => {
    expect(Math.cos(SKIN_HUE_RAY_V1)).toBeLessThan(0); expect(Math.sin(SKIN_HUE_RAY_V1)).toBeGreaterThan(0);
  });
});
