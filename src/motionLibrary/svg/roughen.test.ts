import { describe, expect, it } from "vitest";
import { layoutLine } from "./glyphs";
import { roughenPathD } from "./roughen";

function points(d: string): Array<[number, number]> {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
}

describe("roughenPathD", () => {
  const square = "M0 0L100 0L100 100L0 100Z";
  it("is deterministic and seed dependent", () => {
    const options = { amplitude: 2, wavelength: 20, seed: 4 };
    expect(roughenPathD(square, options)).toBe(roughenPathD(square, options));
    expect(roughenPathD(square, { ...options, seed: 5 })).not.toBe(roughenPathD(square, options));
    expect(roughenPathD(square, options)).toMatch(/^M[^MZ]+Z$/);
  });
  it("moves points by at most amplitude × (1 + grain)", () => {
    const rough = points(roughenPathD(square, { amplitude: 3, wavelength: 25, seed: 1, grain: 0.3, step: 2 }));
    expect(rough.length).toBeGreaterThan(150);
    for (const [x, y] of rough) {
      const distance = Math.min(Math.abs(x), Math.abs(x - 100), Math.abs(y), Math.abs(y - 100));
      expect(distance).toBeLessThanOrEqual(3 * 1.3 + 0.01);
    }
  });
  it("amplitude 0 returns the flattened outline and keeps glyph contours", () => {
    expect(roughenPathD(square, { amplitude: 0, wavelength: 10, seed: 1 })).toBe("M0 0L100 0L100 100L0 100Z");
    const glyph = layoutLine("回", { font: "display", size: 200 });
    const contours = glyph.pathD.split("Z").filter(Boolean).length;
    expect(roughenPathD(glyph.pathD, { amplitude: 1, wavelength: 12, seed: 2 }).split("Z").filter(Boolean)).toHaveLength(contours);
  });
  it("refuses relative or arc path data", () => {
    expect(() => roughenPathD("m0 0l10 0l0 10z", { amplitude: 1, wavelength: 5, seed: 1 })).toThrow(/absolute/);
    expect(() => roughenPathD("M0 0A5 5 0 0 1 10 0Z", { amplitude: 1, wavelength: 5, seed: 1 })).toThrow(/absolute/);
    expect(() => roughenPathD(square, { amplitude: -1, wavelength: 5, seed: 1 })).toThrow();
  });
});
