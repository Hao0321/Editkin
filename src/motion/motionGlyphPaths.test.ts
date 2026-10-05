import { describe, expect, it } from "vitest";
import type { PreparedGlyph, PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";
import { MOTION_GLYPH_COORDINATE_LIMIT, MOTION_GLYPH_MAX_COMMANDS, motionGlyphPath } from "./motionGlyphPaths";

// Original abstract outlines. These controls do not parse a font or prove pixels.
const rectangle: PreparedGlyphPathCommand[] = [
  { type: "M", x: -100, y: -800 }, { type: "L", x: 600, y: -800 },
  { type: "L", x: 600, y: 200 }, { type: "L", x: -100, y: 200 }, { type: "Z" },
];
function glyph(pathCommands: readonly PreparedGlyphPathCommand[] = rectangle): PreparedGlyph {
  return { kind: "glyph", text: "F", codePoint: 70, sourceUtf16Offset: 0, sourceUtf16Length: 1, glyphId: 7,
    advanceEm: .65, kerningAfterEm: -.04, inkEm: { xMin: -.1, yMin: -.8, xMax: .6, yMax: .2 }, pathCommands };
}
const numbers = (path: string) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const quadratic = (a: number, q: number, b: number, t: number) => (1 - t) ** 2 * a + 2 * (1 - t) * t * q + t ** 2 * b;
const cubic = (a: number, c1: number, c2: number, b: number, t: number) => (1 - t) ** 3 * a
  + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * b;

describe("shared prepared motion glyph paths", () => {
  it("scales font units once at the authored y-down baseline and preserves negative bearing/descender", () => {
    const paths = motionGlyphPath(glyph(), 1000, 100, 40, 90);
    expect(paths.svg).toBe("M 30 10 L 100 10 L 100 110 L 30 110 Z");
    expect(paths.ass).toBe("m 30 10 l 100 10 l 100 110 l 30 110 l 30 10");
    expect(paths.commands).toEqual([{ type: "M", x: 30, y: 10 }, { type: "L", x: 100, y: 10 },
      { type: "L", x: 100, y: 110 }, { type: "L", x: 30, y: 110 }, { type: "Z" }]);
    expect(paths.ink).toEqual({ xMin: 30, yMin: 10, xMax: 100, yMax: 110 });
    expect(paths.ass).not.toMatch(/[{}\\]/);
  });

  it("elevates Q to the same exact cubic in SVG and ASS without an endpoint or baseline shift", () => {
    const prepared = { ...glyph([{ type: "M", x: 0, y: 0 }, { type: "Q", x1: 300, y1: -600, x: 900, y: 0 }, { type: "Z" }]),
      inkEm: { xMin: 0, yMin: -.3, xMax: .9, yMax: 0 } };
    const paths = motionGlyphPath(prepared, 1000, 100, 1, 2);
    expect(paths.svg).toBe("M 1 2 C 21 -38 51 -38 91 2 Z");
    expect(paths.ass).toBe("m 1 2 b 21 -38 51 -38 91 2 l 1 2");
    expect(paths.commands).toEqual([{ type: "M", x: 1, y: 2 },
      { type: "C", x1: 21, y1: -38, x2: 51, y2: -38, x: 91, y: 2 }, { type: "Z" }]);
    expect(paths.ink).toEqual({ xMin: 1, yMin: -28, xMax: 91, yMax: 2 });
    const [x0, y0, x1, y1, x2, y2, x3, y3] = numbers(paths.svg);
    for (const t of [0, .125, .25, .5, .75, .9, 1]) {
      expect(cubic(x0, x1, x2, x3, t)).toBeCloseTo(quadratic(1, 31, 91, t), 10);
      expect(cubic(y0, y1, y2, y3, t)).toBeCloseTo(quadratic(2, -58, 2, t), 10);
    }
  });

  it("retains authored cubic controls and endpoints without flattening", () => {
    const paths = motionGlyphPath(glyph([{ type: "M", x: 0, y: -700 },
      { type: "C", x1: -50, y1: -500, x2: 750, y2: 100, x: 500, y: 200 }, { type: "Z" }]), 1000, 80, 12, 70);
    expect(paths.svg).toBe("M 12 14 C 8 30 72 78 52 86 Z");
    expect(paths.ass).toBe("m 12 14 b 8 30 72 78 52 86 l 12 14");
  });

  it("preserves opposite contour winding and explicit closure for a nonzero counter", () => {
    const prepared = glyph([{ type: "M", x: 0, y: 0 }, { type: "L", x: 100, y: 0 },
      { type: "L", x: 100, y: 100 }, { type: "L", x: 0, y: 100 }, { type: "Z" },
      { type: "M", x: 25, y: 25 }, { type: "L", x: 25, y: 75 },
      { type: "L", x: 75, y: 75 }, { type: "L", x: 75, y: 25 }, { type: "Z" }]);
    const paths = motionGlyphPath(prepared, 100, 100);
    expect(paths.svg).toBe("M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z");
    expect(paths.ass).toBe("m 0 0 l 100 0 l 100 100 l 0 100 l 0 0 m 25 25 l 25 75 l 75 75 l 75 25 l 25 25");
    const signedArea = (points: number[][]) => points.reduce((sum, [x, y], index) => {
      const next = points[(index + 1) % points.length]; return sum + x * next[1] - next[0] * y;
    }, 0) / 2;
    const numericContours: number[][][] = [];
    let contour: number[][] = [];
    for (const command of paths.commands) {
      if (command.type === "Z") { numericContours.push(contour); contour = []; }
      else contour.push([command.x, command.y]);
    }
    expect(contour).toEqual([]);
    expect(numericContours.map(signedArea)).toEqual([10000, -2500]);
    for (const contours of [paths.svg.split(/\bM /).filter(Boolean), paths.ass.split(/\bm /).filter(Boolean)]) {
      const areas = contours.map(contour => {
        const values = numbers(contour);
        return signedArea(Array.from({ length: values.length / 2 }, (_, index) => values.slice(index * 2, index * 2 + 2)));
      });
      expect(areas).toEqual([10000, -2500]);
    }
  });

  it("reuses identical trimmed decimal coordinates for both serializers including fractional Q controls", () => {
    const paths = motionGlyphPath(glyph([{ type: "M", x: -0, y: -0 },
      { type: "Q", x1: 1, y1: 1, x: 3, y: 0 }, { type: "Z" }]), 3000, 1000);
    expect(paths.svg).toBe("M 0 0 C 0.222222 0.222222 0.555556 0.222222 1 0 Z");
    expect(paths.commands).toEqual([{ type: "M", x: 0, y: 0 },
      { type: "C", x1: .222222, y1: .222222, x2: .555556, y2: .222222, x: 1, y: 0 }, { type: "Z" }]);
    expect(Object.is(paths.commands[0].type === "M" && paths.commands[0].x, -0)).toBe(false);
    expect(numbers(paths.ass).slice(0, -2)).toEqual(numbers(paths.svg));
    expect(paths.svg + paths.ass).not.toMatch(/-0(?:\s|$)|[eE][+-]?\d|NaN|Infinity/);
  });

  it.each(["space", "newline"] as const)("returns no ink/drawing for prepared %s without shaping text", kind => {
    const prepared = { ...glyph([]), kind, text: kind === "space" ? " " : "\n", inkEm: null };
    expect(motionGlyphPath(prepared, 1000, 64)).toEqual({ svg: "", ass: "", ink: null, commands: [] });
  });

  it("does not add advance/kerning or parse source text into new glyphs", () => {
    const prepared = glyph(), expected = motionGlyphPath(prepared, 1000, 64);
    expect(motionGlyphPath({ ...prepared, text: "another string {\\p1}", advanceEm: 100, kerningAfterEm: -100 }, 1000, 64)).toEqual(expected);
    const ink = motionGlyphPath(prepared, 1000, 64, 25, -17).ink!;
    expect(ink.xMin).toBeCloseTo(18.6, 10); expect(ink.yMin).toBeCloseTo(-68.2, 10);
    expect(ink.xMax).toBeCloseTo(63.4, 10); expect(ink.yMax).toBeCloseTo(-4.2, 10);
  });

  it("is stateless and leaves frozen prepared contour/ink bytes unchanged", () => {
    const prepared = glyph(Object.freeze(rectangle.map(command => Object.freeze({ ...command }))));
    Object.freeze(prepared.inkEm); Object.freeze(prepared);
    const before = JSON.stringify(prepared), expected = motionGlyphPath(prepared, 1000, 48, 5, 80);
    motionGlyphPath(prepared, 1000, 200, 70, -20);
    expect(motionGlyphPath(prepared, 1000, 48, 5, 80)).toEqual(expected);
    expect(JSON.stringify(prepared)).toBe(before);
    expect(Object.isFrozen(expected.commands)).toBe(true);
    expect(expected.commands.every(Object.isFrozen)).toBe(true);
  });

  it("rejects non-finite or out-of-bound raw and transformed coordinates", () => {
    for (const x of [NaN, Infinity, -Infinity, MOTION_GLYPH_COORDINATE_LIMIT + 1]) {
      expect(() => motionGlyphPath(glyph([{ type: "M", x, y: 0 }]), 1000, 100)).toThrow(/coordinate/);
    }
    expect(() => motionGlyphPath(glyph([{ type: "M", x: 5000, y: 0 }, { type: "Z" }]), 16, 4096)).toThrow(/coordinate/);
    expect(() => motionGlyphPath(glyph(), 1000, 100, MOTION_GLYPH_COORDINATE_LIMIT, 0)).toThrow(/coordinate/);
    expect(() => motionGlyphPath(glyph(), 1000, 100, 0, NaN)).toThrow(/coordinate/);
  });

  it("rejects invalid scales and malformed outline/ink states", () => {
    for (const unitsPerEm of [0, 15, -1, NaN, Infinity, 1000.5, 16385]) expect(() => motionGlyphPath(glyph(), unitsPerEm, 64)).toThrow(/unitsPerEm/);
    for (const fontSize of [0, -1, NaN, Infinity, 4097]) expect(() => motionGlyphPath(glyph(), 1000, fontSize)).toThrow(/fontSize/);
    expect(() => motionGlyphPath({ ...glyph(), inkEm: { xMin: 1, yMin: 0, xMax: 0, yMax: 1 } }, 1000, 64)).toThrow(/ink box/);
    expect(() => motionGlyphPath({ ...glyph(), inkEm: null }, 1000, 64)).toThrow(/presence/);
    expect(() => motionGlyphPath(glyph([]), 1000, 64)).toThrow(/presence/);
    expect(() => motionGlyphPath({ ...glyph(), kind: "space" }, 1000, 64)).toThrow(/whitespace/);
  });

  it("rejects commands without a contour start and unsupported path opcodes", () => {
    expect(() => motionGlyphPath(glyph([{ type: "L", x: 0, y: 0 }]), 1000, 64)).toThrow(/begin with M/);
    expect(() => motionGlyphPath(glyph([{ type: "Q", x1: 1, y1: 1, x: 0, y: 0 }]), 1000, 64)).toThrow(/begin with M/);
    expect(() => motionGlyphPath(glyph([{ type: "Z" }]), 1000, 64)).toThrow(/contour start/);
    expect(() => motionGlyphPath(glyph([{ type: "M", x: 0, y: 0 }]), 1000, 64)).toThrow(/must close/);
    expect(() => motionGlyphPath(glyph([{ type: "M", x: 0, y: 0 }, { type: "M", x: 1, y: 1 }, { type: "Z" }]), 1000, 64)).toThrow(/must close/);
    expect(() => motionGlyphPath(glyph([{ type: "A" } as unknown as PreparedGlyphPathCommand]), 1000, 64)).toThrow(/Unsupported/);
  });

  it("enforces the prepared per-glyph command cap without dropping a contour", () => {
    const commands: PreparedGlyphPathCommand[] = Array.from({ length: MOTION_GLYPH_MAX_COMMANDS }, (_, index) =>
      index === 0 ? { type: "M", x: 0, y: 0 } : index === MOTION_GLYPH_MAX_COMMANDS - 1 ? { type: "Z" } : { type: "L", x: index % 100, y: index % 100 });
    const paths = motionGlyphPath(glyph(commands), 1000, 64);
    expect((paths.svg.match(/[MLZ]/g) ?? []).length).toBe(MOTION_GLYPH_MAX_COMMANDS);
    expect(paths.commands).toHaveLength(MOTION_GLYPH_MAX_COMMANDS);
    expect(paths.commands.at(-1)).toEqual({ type: "Z" });
    expect(() => motionGlyphPath(glyph([...commands, { type: "Z" }]), 1000, 64)).toThrow(/command bound/);
  });
});
