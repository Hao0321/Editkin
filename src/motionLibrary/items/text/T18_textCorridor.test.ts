import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import { flattenPathD } from "../../svg/pathOps";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { T18_CORE_DEPTH, T18_LOOP_SECONDS, corridorLayout, corridorWash, mapPathD } from "./T18_textCorridor";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T18";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.4, 0.9, 1.3, 1.75] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "deca0fe63c4be40a763ad059c2b04baf4331b4833364d13e97091865bb1e3043",
    "9ebdd0858bb013ad361141ef2175d84cbf576fda1885b781e9239db90c2d5053",
    "497b936d0c031647339e572f40b0f8836bef26f54aac0b9ab94f102328e49558",
    "54fdf866af64026fda421e809caf00b834447bcd24c66f7b6da7fb09facf3217",
    "99354e416b974b8243950acef0cdcadbc2c3b29fc2b5a1dc3a2fa2ed8b5817eb",
  ],
  landscape: [
    "9347141ffa7e8e7b97611b269f5d2968fe325e9fb461a48b2d3d78f745ec1811",
    "7f8c2f4818d4abfe7ae84f51baecbc9ffbcbfb6700c157d1d861f8c6645a60e5",
    "54cf39990d93768d86b455d052b63bf2b3c689037814aa958ab61a359ff8daca",
    "662bdab4daa359a729458291cfee67759817cc1182f5a595fad618d644ef4144",
    "d280e103762683a6651bea1bce48e9b13f741ab1cda95894ce938ce1d0fb102f",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const header = (size: MotionFrameSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

/** The path data of every <path> in a frame. */
const pathDs = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]);

/** Absolute points (end and control points) of compact relative m/l/q/c/z path data, as mapPathD writes it. */
function relativePoints(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  for (const [, command, body] of d.matchAll(/([mlqcz])([^mlqcz]*)/g)) {
    if (command === "z") { x = startX; y = startY; continue; }
    const values = (body.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    for (let index = 0; index + 1 < values.length; index += 2) points.push([x + values[index], y + values[index + 1]]);
    x += values[values.length - 2]; y += values[values.length - 1];
    if (command === "m") { startX = x; startY = y; }
  }
  return points;
}

describe("T18 Text Corridor", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T18_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "bg" }, { lines: ["加油・GO"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T18_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T18_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T18_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T18_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.9, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.9, PORTRAIT)).toBe(first);
  });

  it("tiles all four planes in lanes and streams whole text repeats per loop", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const layout = corridorLayout(params(), size);
      for (const plane of ["left", "right", "floor", "ceiling"]) expect(layout.lanes.filter(lane => lane.plane === plane).length, plane).toBeGreaterThanOrEqual(1);
      // 前進・: three cells, the separator flagged; one repeat per loop (two at punchy and hype).
      expect(layout.cells.map(cell => cell.char)).toEqual(["前", "進", "・"]);
      expect(layout.cells.map(cell => cell.separator)).toEqual([false, false, true]);
      expect(layout.tilesPerLoop % layout.cells.length).toBe(0);
      // The corridor follows the frame aspect, so its corner lines run into the frame corners.
      expect(layout.halfWidth).toBeCloseTo(size.width / size.height, 12);
    }
    expect(corridorLayout(params(), PORTRAIT).tilesPerLoop).toBe(3);
    expect(corridorLayout(params({ energy: "hype" }), PORTRAIT).tilesPerLoop).toBe(6);
    // A line without a separator gets one, so repeats never run together.
    expect(corridorLayout(params({ lines: ["前進"] }), PORTRAIT).cells.map(cell => cell.char)).toEqual(["前", "進", "・"]);
  });

  it("paints accent tiles with ink glyphs, deep-shade separator tiles and a bright paper core at the vanishing point", () => {
    const palette = item.defaultParams.palette;
    const svg = frameText(0.4, PORTRAIT);
    expect(svg).toContain(`fill="${palette.accent}"`);
    expect(svg).toContain(`fill="${palette.ink}"`);
    expect(svg).toContain(`fill="${palette.accent2}"`);
    // The core: the corridor's far cross-section, centred, in paper, painted first (behind every tile).
    const core = /<path d="([^"]+)" fill="#F5F1E6"\/>/.exec(svg)!;
    expect(svg.indexOf(core[0])).toBeLessThan(svg.indexOf(`fill="${palette.accent}"`));
    const [ring] = flattenPathD(core[1]);
    const xs = ring.map(point => point[0]), ys = ring.map(point => point[1]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(540, 0);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(960, 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1080 / T18_CORE_DEPTH, 0);
    // Tiles wash toward the core colour with depth (none near the camera, fully at the core).
    expect(corridorWash(1)).toBe(0);
    expect(corridorWash(T18_CORE_DEPTH)).toBe(1);
  });

  it("bleeds by definition, yet the near tiles carry big, readable glyphs (≥ 9% of the short side) and nothing is non-finite", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const svg = frameText(0.9, size);
      expect(svg).not.toMatch(/NaN|Infinity/);
      // Glyph paths are the projected (compact relative "m…") ones; tiles and dots are absolute. The near glyphs are big.
      const heights = [...svg.matchAll(/<path d="(m[^"]+)" fill="#[0-9A-F]{6}"\/>/g)].map(match => {
        const ys = relativePoints(match[1]).map(point => point[1]);
        return Math.max(...ys) - Math.min(...ys);
      });
      expect(heights.length).toBeGreaterThan(8);
      expect(Math.max(...heights)).toBeGreaterThan(0.09 * Math.min(size.width, size.height));
    }
  });

  it("mapPathD maps every point (control points too) and writes compact relative path data in tenths", () => {
    const d = "M10 10L20 10Q25 15 20 20C15 25 12 22 10 20Z";
    const shifted = mapPathD(d, (x, y) => [x + 100.04, y * 2]);
    const rings = flattenPathD(d.replace(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g, (_, x, y) => `${Number(x) + 100.04} ${Number(y) * 2}`));
    expect(shifted.startsWith("m110 20l10 0q")).toBe(true);
    // Rebuild absolute points from the relative output and compare with the mapped originals (within 0.05 px).
    const absolute = relativePoints(shifted);
    const expected: Array<[number, number]> = [[10, 10], [20, 10], [25, 15], [20, 20], [15, 25], [12, 22], [10, 20]].map(([px, py]) => [px + 100.04, py * 2]);
    expect(absolute).toHaveLength(expected.length);
    absolute.forEach(([px, py], index) => {
      expect(Math.abs(px - expected[index][0]), `x${index}`).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(py - expected[index][1]), `y${index}`).toBeLessThanOrEqual(0.05 + 1e-9);
    });
    expect(rings[0][0][0]).toBeCloseTo(110.04, 2);
    expect(() => mapPathD(d, () => [Number.NaN, 0])).toThrow(/out of range/);
  });

  it("draws palette roles only: two unrelated palettes share no colour", () => {
    for (const t of TIMES) {
      const a = colours(frameText(t, PORTRAIT, { palette: PALETTE_A, plate: "bg" }));
      const b = colours(frameText(t, PORTRAIT, { palette: PALETTE_B, plate: "bg" }));
      expect([...a].filter(colour => b.has(colour)), `t=${t}`).toEqual([]);
    }
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        // The corridor's own tiles are opaque palette colours, so every plate just paints under them.
        for (const plate of ["bg", "paper", "accent"] as const) {
          const plated = frameText(t, size, { plate });
          expect(plated.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(plated.replace(plateRect(size, palette[plate]), "")).toBe(none);
        }
      }
    }
    expect(pathDs(frameText(0, PORTRAIT)).length).toBeGreaterThan(40);
  });
});
