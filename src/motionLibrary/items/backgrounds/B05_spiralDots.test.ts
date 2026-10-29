import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B05_LOOP_CYCLES, B05_LOOP_SECONDS, phyllotaxisTurn } from "./B05_spiralDots";

const ID = "B05";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1.1, 3.2, 5.6, 7.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "8399dfccc4b5527c5f5b9a1d581e2e671c72c2752f0a38a3cc1a2ab8dbb1c203",
    "7236dd3595dd223a1e2bb011022a93032727a72d16ae7a7fd0a4dfc8818a3954",
    "7f737d13507cbb86834ce8db8dec9aec7b7cdfae48d274fd1c9b146109683fde",
    "290cb4c701e83e21a0b6663d8d0a9c0afb8f21278fc39be6d81aa8dbc99f6b5c",
    "886c483a66230f6fbfb7ad383d2eb643ad725d1ff8aa47cd92f3721c70b25224",
  ],
  landscape: [
    "406e5ce4eac2fe23bb0b46e475b65678581d56f2b1c6593ab8833087c439c793",
    "bbca21b2ac00cbd1c2a6eaf9888851e3eb47aca91da895822ab15d8530e9d62c",
    "ad5b233cdb4d7d4013efe44a81d7d1c9f2e4e7d004642535df2c91db403c6b8f",
    "efe49a997af88c3db04be0b7495ef976d039c79e5364cecc988d6c48247cba4d",
    "8a27b6f530c64187f2753afc7bdb224c82965eccd9be45d3aafb1bc3028ef156",
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
const degrees = (radians: number) => (radians * 180) / Math.PI;

describe("B05 Spiral Dots", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B05_LOOP_SECONDS, B05_LOOP_CYCLES, B05_LOOP_SECONDS]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const start = frame(0, size, input), label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(frame(period(input), size, input), label).toBe(start);
        expect(frame(2 * period(input), size, input), label).toBe(start);
        expect(frame(period(input) / 3, size, input), label).not.toBe(start);
      }
    }
  });

  it("is continuous across the seam: just before the loop point every dot sits where a dot of the same colour sits at t = 0", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const before = frame(period(input) - 1e-4, size, input), start = frame(0, size, input);
        const a = numbers(before), b = numbers(start);
        expect(a.length).toBe(b.length);
        expect(maxDifference(a, b), JSON.stringify(input)).toBeLessThan(0.25);
        // Colour by colour as well: the even/odd dots keep their colour through the index shift.
        const [creamBefore, accentBefore] = dotPaths(before), [creamStart, accentStart] = dotPaths(start);
        expect(accentBefore.dots.length).toBe(accentStart.dots.length);
        expect(creamBefore.dots.length).toBe(creamStart.dots.length);
      }
    }
  });

  it("paints every pixel: an opaque, full-frame dark card under everything (ART_DIRECTION §10, base D)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.bg)).toBe(true);
    }
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } }), PORTRAIT, "#F4F4F0")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B05_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("turns by the golden-angle remainder of the index shift: 34 dots = −4.74°, 21 dots = +7.66°", () => {
    expect(degrees(phyllotaxisTurn(34))).toBeCloseTo(-4.736, 2);
    expect(degrees(phyllotaxisTurn(21))).toBeCloseTo(7.663, 2);
    expect(degrees(phyllotaxisTurn(34 * 4))).toBeCloseTo(-18.94, 1);
    expect(Math.abs(phyllotaxisTurn(0))).toBe(0);
  });

  it("is a disc spanning the short side, cream and accent, small in the eye and larger toward the rim, with open card around it", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const [cream, accent] = dotPaths(frame(2.5, size));
      expect([cream.fill, accent.fill]).toEqual([palette.paper, palette.accent]);
      const cx = size.width / 2, cy = size.height / 2, disc = 0.5 * Math.min(size.width, size.height);
      const all = [...cream.dots, ...accent.dots];
      expect(all.length).toBeGreaterThan(200);
      expect(all.length).toBeLessThan(400);
      for (const dot of all) expect(Math.hypot(dot.x - cx, dot.y - cy) + dot.r).toBeLessThan(disc + 1);
      expect(Math.abs(cream.dots.length - accent.dots.length)).toBeLessThan(accent.dots.length * 0.1);
      const distance = (dot: { x: number; y: number }) => Math.hypot(dot.x - cx, dot.y - cy);
      const mean = (dots: Array<{ r: number }>) => dots.reduce((sum, dot) => sum + dot.r, 0) / dots.length;
      const eye = accent.dots.filter(dot => distance(dot) < 0.2 * disc), outer = accent.dots.filter(dot => distance(dot) > 0.6 * disc && distance(dot) < 0.8 * disc);
      expect(mean(outer)).toBeGreaterThan(2 * mean(eye));
    }
  });

  it("density scales the dot count, speed the turn; deterministic per seed", () => {
    const count = (svg: string) => dotPaths(svg).reduce((sum, entry) => sum + entry.dots.length, 0);
    expect(count(frame(1, PORTRAIT, { density: 2 }))).toBeGreaterThan(count(frame(1)) * 1.8);
    expect(frame(1, PORTRAIT, { speed: 2 })).not.toBe(frame(1));
    expect(frame(3.2, LANDSCAPE, { seed: 7 })).toBe(frame(3.2, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 0.5 }]) {
      expect(frame(3.2, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(3.2, LANDSCAPE));
    }
  });
});
