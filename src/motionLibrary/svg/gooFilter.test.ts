import { describe, expect, it } from "vitest";
import { GOO_ALPHA_MATRIX, createSvgDocument, g, gooFilter, path } from "./document";

describe("gooFilter", () => {
  it("adds blur + alpha-threshold primitives over the box grown by 3σ", () => {
    const doc = createSvgDocument({ width: 1080, height: 1920 });
    const url = gooFilter(doc, 12.5, { x0: 200, y0: 700, x1: 880, y1: 1220 });
    expect(url).toBe("url(#mfx1)");
    const svg = doc.render(g({ filter: url }, path("M0 0H10V10Z", { fill: "#111316" })));
    expect(svg).toContain('<filter id="mfx1" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse"'
      + ' x="162.5" y="662.5" width="755" height="595">');
    expect(svg).toContain('<feGaussianBlur in="SourceGraphic" stdDeviation="12.5"/>');
    expect(svg).toContain('<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 18 -7"/>');
    expect(GOO_ALPHA_MATRIX).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 18, -7]);
  });
  it("clips the region to the frame grown by 3σ and skips negligible blurs", () => {
    const doc = createSvgDocument({ width: 400, height: 300 });
    gooFilter(doc, 10, { x0: -500, y0: -10, x1: 900, y1: 100 });
    expect(doc.render()).toContain('x="-30" y="-30" width="460" height="160"');
    const quiet = createSvgDocument({ width: 400, height: 300 });
    expect(gooFilter(quiet, 0.04, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBeUndefined();
    expect(quiet.render()).not.toContain("<filter");
  });
  it("refuses bad input", () => {
    const doc = createSvgDocument({ width: 400, height: 300 });
    expect(() => gooFilter(doc, -1, { x0: 0, y0: 0, x1: 10, y1: 10 })).toThrow(/σ/);
    expect(() => gooFilter(doc, 5, { x0: 10, y0: 0, x1: 10, y1: 10 })).toThrow(/box/);
    expect(() => gooFilter(doc, Number.NaN, { x0: 0, y0: 0, x1: 10, y1: 10 })).toThrow(/σ/);
  });
});
