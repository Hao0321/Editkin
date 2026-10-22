import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B02_LOOP_CYCLES, B02_LOOP_SECONDS } from "./B02_halftoneWave";

const ID = "B02";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "fcbe376dea9897be6712ddd62cb05296c7e0505be3a495e3db1cc3ba52cda0f2",
    "67f003b41bce6d1b602b578bf9c4a9e5fca1862567061858cb854d32028fbe94",
    "e0ec5e199e337b4734078ba637518369cd97d27025333aa6befcd34e5a0905fb",
    "d591e69ad78576a6b0e634358851ee5e1f5b59c473c866ca4703e37dac975b62",
    "0cf5fb37e97345889c3c055fad01765e1332e5b351f1ef8435eb72927126aa5c",
  ],
  landscape: [
    "ffd106157ad32d62d4ddcca1436391fbd4c8221dc11df16de040021280cc8500",
    "ff398b46671c0f86feb117a6f39739b354b9fc5a3fd962bbcbf4d828623c9865",
    "cb2699b63b9dc7812f8ae731e0d77c3ee62193d09feb41f5caca76d677db3689",
    "fc7446ca60961318ce80098cf92358908741b3b54d26a867ff093fcf1901e671",
    "145f6e1acfba5d5fac093074be8984efb1a9d22a38875d56b7fd8a1ee2f9c3a2",
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

describe("B02 Halftone Wave", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B02_LOOP_SECONDS, B02_LOOP_CYCLES, B02_LOOP_SECONDS]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const start = frame(0, size, input), label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(frame(period(input), size, input), label).toBe(start);
        expect(frame(2 * period(input), size, input), label).toBe(start);
        expect(frame(period(input) / 3, size, input), label).not.toBe(start);
      }
    }
  });

  it("is continuous across the seam: the instant before the loop point matches t = 0 to a fraction of a pixel", () => {
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
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } }), PORTRAIT, "#2457F5")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B02_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("draws a cream screen on the cell centres and an ink screen on the grid points, both crisp full-strength roles", () => {
    const [cream, ink] = dotPaths(frame(1.3));
    expect([cream.fill, ink.fill]).toEqual([palette.paper, palette.ink]);
    expect(cream.dots.length).toBe(ink.dots.length);
    // Square screens of pitch 44 px centred on the frame: ink on the grid, cream half a pitch off in both directions.
    const offGrid = (value: number, origin: number, shift: number) => Math.abs((((value - origin - shift) / 44) % 1 + 1.5) % 1 - 0.5) * 44;
    for (const dot of ink.dots) { expect(offGrid(dot.x, 540, 0)).toBeLessThan(0.11); expect(offGrid(dot.y, 960, 0)).toBeLessThan(0.11); }
    for (const dot of cream.dots) { expect(offGrid(dot.x, 540, 22)).toBeLessThan(0.11); expect(offGrid(dot.y, 960, 22)).toBeLessThan(0.11); }
    // Bold at the crest, never vanishing, and an ink dot never touches its cream neighbours (0.707 pitch apart).
    for (const t of [0, 1, 2, 3]) {
      const [c, k] = dotPaths(frame(t));
      const inkMax = Math.max(...k.dots.map(dot => dot.r)), creamMax = Math.max(...c.dots.map(dot => dot.r));
      expect(inkMax).toBeGreaterThan(0.33 * 44);
      expect(Math.min(...k.dots.map(dot => dot.r), ...c.dots.map(dot => dot.r))).toBeGreaterThan(0.06 * 44);
      expect(inkMax + creamMax).toBeLessThan(0.707 * 44);
    }
    expect(dotPaths(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } })).map(entry => entry.fill)).toEqual(["#FFFFFF", "#111316"]);
  });

  it("speed is a true rate: ×2 shows at t what ×1 shows at 2t, ×0.5 at 2t what ×1 shows at t; density adds dots", () => {
    const count = (svg: string) => dotPaths(svg).reduce((sum, entry) => sum + entry.dots.length, 0);
    expect(count(frame(1, PORTRAIT, { density: 2 }))).toBeGreaterThan(count(frame(1)) * 3.5);
    expect(frame(0.5, PORTRAIT, { speed: 2 })).toBe(frame(1));
    expect(frame(2, PORTRAIT, { speed: 0.5 })).toBe(frame(1));
    expect(frame(1, PORTRAIT, { speed: 0.5 })).not.toBe(frame(1));
  });

  it("is deterministic; seed and energy change the frame", () => {
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).not.toBe(frame(1.3, LANDSCAPE));
    expect(frame(1.3, LANDSCAPE, { energy: "hype" })).not.toBe(frame(1.3, LANDSCAPE));
  });
});
