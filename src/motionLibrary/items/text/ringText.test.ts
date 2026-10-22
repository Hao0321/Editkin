import { describe, expect, it } from "vitest";
import { parseAbsolutePathD } from "../../svg/pathOps";
import { layoutRingText, ringGlyphsPathD } from "./ringText";

const near = (a: number, b: number, tolerance: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance);
const points = (d: string) => parseAbsolutePathD(d).flatMap(segment => segment.type === "Z" ? []
  : segment.type === "C" ? [[segment.x1, segment.y1], [segment.x2, segment.y2], [segment.x, segment.y]]
    : segment.type === "Q" ? [[segment.x1, segment.y1], [segment.x, segment.y]] : [[segment.x, segment.y]]);
const polar = (x: number, y: number, cx: number, cy: number) => (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
const step = (a: number, b: number) => ((b - a) % 360 + 360) % 360;

describe("layoutRingText", () => {
  const ring = layoutRingText({ text: "出發時刻", font: "display", weight: 700, size: 60, radius: 300, cx: 540, cy: 960 });
  it("repeats text + 「・」 as often as it fits and spreads the rest evenly, with no seam", () => {
    expect(ring.unit).toBe("出發時刻・");
    // C = 1884.96; a unit needs 5 × (60 + 0.1 · 60) = 330 px → 5 repeats; 25 full-width glyphs leave 15.4 px gaps.
    expect(ring.repeats).toBe(5);
    expect(ring.glyphs).toHaveLength(25);
    near(ring.gap, (2 * Math.PI * 300 - 25 * 60) / 25, 1e-9);
    const angles = ring.glyphs.map(glyph => polar(glyph.x, glyph.y, 540, 960));
    angles.forEach((angle, index) => near(step(angle, angles[(index + 1) % angles.length]), 360 / 25, 1e-6));
    for (const glyph of ring.glyphs) near(Math.hypot(glyph.x - 540, glyph.y - 960), 300, 1e-9);
    expect(ring.glyphs.map(glyph => glyph.char).join("")).toBe("出發時刻・".repeat(5));
    expect(ring.glyphs.filter(glyph => glyph.isSeparator).map(glyph => glyph.index)).toEqual([4, 9, 14, 19, 24]);
    expect([ring.glyphs[7].unitIndex, ring.glyphs[7].repeat]).toEqual([2, 1]);
    expect(Object.isFrozen(ring) && Object.isFrozen(ring.glyphs) && Object.isFrozen(ring.glyphs[0])).toBe(true);
  });
  it("stands glyphs upright on the circle: the first at the top, tops outward when clockwise", () => {
    const first = ring.glyphs[0];
    near(first.x, 540, 1e-9); near(first.y, 660, 1e-9); near(first.angle, 0, 1e-9);
    expect(first.transform).toBe("translate(540 660) rotate(0)");
    // Local outline: centred on the advance centre and the em-box middle.
    const local = points(first.pathD);
    for (const [x, y] of local) { expect(Math.abs(x)).toBeLessThanOrEqual(31); expect(Math.abs(y)).toBeLessThanOrEqual(31); }
    // The glyph a quarter of the way round sits at the right, rotated 90° (its top points away from the centre).
    const quarter = layoutRingText({ text: "出", font: "display", size: 60, radius: 300, cx: 0, cy: 0, separator: "", minGap: 0, rotationDegrees: 90 });
    near(quarter.glyphs[0].x, 300, 1e-9); near(quarter.glyphs[0].y, 0, 1e-9); near(quarter.glyphs[0].angle, 90, 1e-9);
    const ccw = layoutRingText({ text: "出發", font: "display", size: 60, radius: 300, cx: 0, cy: 0, clockwise: false });
    near(Math.abs(ccw.glyphs[0].angle), 180, 1e-9); // tops face the centre
    near(polar(ccw.glyphs[1].x, ccw.glyphs[1].y, 0, 0), -90 - (360 / ccw.glyphs.length), 1e-6);
  });
  it("merges every glyph into one path inside the ring band", () => {
    const merged = ringGlyphsPathD(ring.glyphs);
    expect(merged.match(/M/g)!.length).toBeGreaterThan(25);
    for (const [x, y] of points(merged)) {
      const r = Math.hypot(x - 540, y - 960);
      expect(r).toBeGreaterThan(300 - 31);
      expect(r).toBeLessThan(Math.hypot(300 + 31, 31));
    }
    expect(ringGlyphsPathD(ring.glyphs.filter(glyph => !glyph.isSeparator))).not.toBe(merged);
  });
  it("handles separators, overlong units and caching", () => {
    const own = layoutRingText({ text: "爆發・", font: "display", size: 50, radius: 200, cx: 0, cy: 0 });
    expect(own.unit).toBe("爆發・");
    const none = layoutRingText({ text: "爆發", font: "display", size: 50, radius: 200, cx: 0, cy: 0, separator: "" });
    expect(none.unit).toBe("爆發");
    expect(none.glyphs.some(glyph => glyph.isSeparator)).toBe(false);
    const wide = layoutRingText({ text: "爆發", font: "display", size: 50, radius: 200, cx: 0, cy: 0, separator: " ・ " });
    expect(wide.glyphs.slice(0, 5).map(glyph => [glyph.char, glyph.isSeparator, glyph.pathD === ""]))
      .toEqual([["爆", false, false], ["發", false, false], [" ", true, true], ["・", true, false], [" ", true, true]]);
    const tight = layoutRingText({ text: "一二三四五六七八九十", font: "display", size: 100, radius: 50, cx: 0, cy: 0 });
    expect(tight.repeats).toBe(1);
    expect(tight.gap).toBeLessThan(0); // the unit does not fit: glyphs overlap rather than being dropped
    expect(layoutRingText({ text: "出發時刻", font: "display", weight: 700, size: 60, radius: 300, cx: 540, cy: 960 })).toBe(ring);
    expect(() => layoutRingText({ text: "", font: "display", size: 50, radius: 200, cx: 0, cy: 0 })).toThrow(/text/);
    expect(() => layoutRingText({ text: "爆", font: "display", size: 50, radius: 0, cx: 0, cy: 0 })).toThrow(/radius/);
  });
});
