import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B06_LOOP_CYCLES, B06_LOOP_SECONDS, ringSteps } from "./B06_halftoneRings";

const ID = "B06";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.9, 2.4, 4.1, 5.8] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "5d05ae2f854cf11cba927cb86afd10c22bf41fb9af9431954250a0ee7c5c40ed",
    "ba00336274a0adc3570e3ea1bcb7fcf33518fbf500dc5b4002ddf970a60ddc20",
    "9e991eeaa65fec453e519a773d1e9b8607d29b88ccead526496100be340ce4c9",
    "758a2841666ee163a287f8c09c604f48ba88d774125cf50408b754835803befd",
    "09efea1fd7beba2584d9599357598af025fed69a79038952525dbc965abdc8d8",
  ],
  landscape: [
    "b9e26cdf0252aa67647fd170e14b6845377bde37658b3a41e9957a8ba1baaac9",
    "292bcda635c3645fe0134ab3a5309b620eabb9157720337817820dc5cf4ec80a",
    "e575cc0c0f7d9bfb63d9d8854dbdf0969f86428ca01a1cca29ff91e74a36841c",
    "823fc44607d92337f451b59a960bb89ca4aaac6b8af2e59949415c27d2536f2e",
    "550e2915a7cceafe069a22036926d8364b7712aaa73a20363146df60d1ef5ec9",
  ],
};

const item = getMotionLibraryItem(ID) as BackgroundMotionItem;
const frame = (t: number, size: MotionFrameSize = PORTRAIT, input?: unknown) => generateMotionFrame(item, resolveMotionLibraryParams(item, input), t, size);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The seamless period at these params: the base loop, stretched by 1, 2 or 4 where the speed needs it (DESIGN §8). */
const period = (input?: unknown) => motionBackgroundLoopSeconds(item, resolveMotionLibraryParams(item, input));
/** The params a loop must survive (ART_DIRECTION §7: speed and density never break the loop). */
const LOOP_VARIANTS: readonly unknown[] = [undefined, { speed: 0.5 }, { speed: 2 }, { density: 0.5 }, { density: 2 }];
/** A frame's numbers (colours stripped), sorted: its geometry as a multiset, independent of drawing order. */
const numbers = (svg: string) => (svg.replace(/#[0-9A-Fa-f]{6}/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).sort((a, b) => a - b);
function maxDifference(a: readonly number[], b: readonly number[]): number {
  let worst = 0;
  for (let index = 0; index < a.length; index += 1) worst = Math.max(worst, Math.abs(a[index] - b[index]));
  return worst;
}
/** Every pixel painted: an opaque, full-frame base rect is the first thing drawn (after defs), so everything else lands on it. */
function paintsEveryPixel(svg: string, size: MotionFrameSize, base: string): boolean {
  const header = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
  if (!svg.startsWith(header) || !/^#[0-9A-F]{6}$/.test(base)) return false;
  let rest = svg.slice(header.length);
  if (rest.startsWith("<defs>")) rest = rest.slice(rest.indexOf("</defs>") + "</defs>".length);
  return rest.startsWith(`<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${base}"/>`);
}
/** Dot paths in drawing order: fill and the dots (centre and radius) of each. */
function dotPaths(svg: string): Array<{ fill: string; dots: Array<{ x: number; y: number; r: number }> }> {
  return [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)].map(([, d, fill]) => ({
    fill, dots: [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)a([\d.]+) /g)].map(([, x, y, r]) => ({ x: Number(x) + Number(r), y: Number(y), r: Number(r) })),
  }));
}

describe("B06 Halftone Rings", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B06_LOOP_SECONDS, B06_LOOP_CYCLES, B06_LOOP_SECONDS]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const start = frame(0, size, input), label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(frame(period(input), size, input), label).toBe(start);
        expect(frame(2 * period(input), size, input), label).toBe(start);
        expect(frame(period(input) / 3, size, input), label).not.toBe(start);
      }
    }
  });

  it("is continuous across the seam: just before the loop point every ring has turned a whole number of dot steps", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const before = numbers(frame(period(input) - 1e-4, size, input)), start = numbers(frame(0, size, input));
        expect(before.length).toBe(start.length);
        expect(maxDifference(before, start), JSON.stringify(input)).toBeLessThan(0.25);
      }
    }
  });

  it("paints every pixel: an opaque, full-frame accent card under everything (ART_DIRECTION §10, base A)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.accent)).toBe(true);
    }
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "tech_spec" } }), PORTRAIT, "#2ED3C0")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B06_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("turns neighbouring rings in opposite directions by whole dot steps, a little faster outward", () => {
    for (const direction of [1, -1] as const) {
      for (let ring = 1; ring <= 30; ring += 1) {
        const steps = ringSteps(ring, ring * 66, 1, 1, direction);
        expect(Number.isInteger(steps)).toBe(true);
        expect(Math.abs(steps)).toBeGreaterThanOrEqual(1);
        expect(Math.sign(steps)).toBe(ring % 2 === 1 ? direction : -direction);
        expect(Math.sign(ringSteps(ring + 1, (ring + 1) * 66, 1, 1, direction))).toBe(-Math.sign(steps));
      }
    }
    expect(Math.abs(ringSteps(25, 1650, 1, 1, 1))).toBeGreaterThan(Math.abs(ringSteps(1, 66, 1, 1, 1)));
    // Steps scale with the loop's whole cycles (backgroundLoop), so every ring keeps its relative rate at any speed.
    expect(ringSteps(25, 1650, 1, 2, 1)).toBe(2 * ringSteps(25, 1650, 1, 1, 1));
    expect(ringSteps(4, 264, 1, 3, -1)).toBe(3 * ringSteps(4, 264, 1, 1, -1));
  });

  it("alternates ink and cream rings on elliptical paths that follow the frame's shape, dots evenly spaced along each ring", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const [cream, ink] = dotPaths(frame(2.4, size));
      expect([cream.fill, ink.fill]).toEqual([palette.paper, palette.ink]);
      const aspect = (size.width / size.height) ** 0.6, ax = Math.sqrt(aspect), by = 1 / Math.sqrt(aspect);
      const cx = size.width / 2, cy = size.height / 2;
      // Each dot's elliptical "radius" is a whole number of ring spacings (66 px): odd rings ink, even rings cream.
      const ringOf = (dot: { x: number; y: number }) => Math.hypot((dot.x - cx) / ax, (dot.y - cy) / by) / 66;
      for (const dot of ink.dots) { expect(Math.abs(ringOf(dot) - Math.round(ringOf(dot)))).toBeLessThan(0.01); expect(Math.round(ringOf(dot)) % 2).toBe(1); }
      for (const dot of cream.dots) { expect(Math.abs(ringOf(dot) - Math.round(ringOf(dot)))).toBeLessThan(0.01); expect(Math.round(ringOf(dot)) % 2).toBe(0); }
      // Ring 3: taller than wide in portrait, wider than tall in landscape; consecutive dots about equally far apart.
      const ring3 = ink.dots.filter(dot => Math.round(ringOf(dot)) === 3);
      const spanX = Math.max(...ring3.map(dot => dot.x)) - Math.min(...ring3.map(dot => dot.x));
      const spanY = Math.max(...ring3.map(dot => dot.y)) - Math.min(...ring3.map(dot => dot.y));
      if (size.height > size.width) expect(spanY).toBeGreaterThan(spanX * 1.2);
      else expect(spanX).toBeGreaterThan(spanY * 1.2);
      const angleOf = (dot: { x: number; y: number }) => Math.atan2((dot.y - cy) / by, (dot.x - cx) / ax);
      const ordered = [...ring3].sort((a, b) => angleOf(a) - angleOf(b));
      const gaps = ordered.map((dot, index) => Math.hypot(dot.x - ordered[(index + 1) % ordered.length].x, dot.y - ordered[(index + 1) % ordered.length].y));
      expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.05);
      // Uniform dots, the same size on every ring.
      expect(new Set([...ink.dots, ...cream.dots].map(dot => dot.r)).size).toBe(1);
    }
  });

  it("density scales the ring spacing, speed the turn; deterministic per seed", () => {
    const count = (svg: string) => dotPaths(svg).reduce((sum, entry) => sum + entry.dots.length, 0);
    expect(count(frame(1, PORTRAIT, { density: 2 }))).toBeGreaterThan(count(frame(1)) * 3.5);
    expect(frame(1, PORTRAIT, { speed: 2 })).not.toBe(frame(1));
    expect(frame(2.4, LANDSCAPE, { seed: 7 })).toBe(frame(2.4, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 0.5 }]) {
      expect(frame(2.4, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(2.4, LANDSCAPE));
    }
  });
});
