import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B11_LOOP_CYCLES, B11_LOOP_SECONDS } from "./B11_gridWave";

const ID = "B11";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "c0dd6689a53a6ce9cf13206a7d0693d1a3ed795cac29a0ea0232dc4cdb48a6ee",
    "79d3fe1b37c3a1d479f6ac2b50c830384f5fe1b8a181881c8101b06e0b4ae5d4",
    "e5c0037e7f8d0b0ce9431f7bb6da6bf81ca757898214388b831b169a3f1bbf43",
    "39fbffd3a0dfddbb0d88d2f58c0851568bed524f078f2299cc3f317f6e50b4b0",
    "01bb6db7b574bad1eea1b48f1e9cd7c69c22ed36b62f0976539fe7673edd082f",
  ],
  landscape: [
    "c52e70e1a3afab47165e46712b5c8e710ffdaf1058f7847ca704a1827258fcda",
    "fe50d279345188d3f5486d767749697b6d57750593088515763621786a0bef29",
    "277642968d58e1e04f7f2bae4d4448c82a3f09ef680e463a7ecdde4b8d6045b5",
    "e25b99c90fa3afc966b1daa47299ca14a83e39f60570d69b26dc43875395544b",
    "c42ac319c69cded5083d2dc6c02078b487bc6a014e43410e98d69e11d470c611",
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
/** Every pixel painted: an opaque, full-frame bg rect is the first thing drawn (after defs), so everything else lands on it. */
function paintsEveryPixel(svg: string, size: MotionFrameSize, bg: string): boolean {
  const header = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
  if (!svg.startsWith(header) || !/^#[0-9A-F]{6}$/.test(bg)) return false;
  let rest = svg.slice(header.length);
  if (rest.startsWith("<defs>")) rest = rest.slice(rest.indexOf("</defs>") + "</defs>".length);
  return rest.startsWith(`<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${bg}"/>`);
}
/** Stroked paths: stroke colour, width and polylines (each "M… L… L…" run). */
function strokes(svg: string): Array<{ stroke: string; width: number; lines: Array<Array<[number, number]>> }> {
  return [...svg.matchAll(/<path d="([^"]*)" fill="none" stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)"/g)].map(([, d, stroke, width]) => ({
    stroke, width: Number(width),
    lines: d.split("M").filter(Boolean).map(run => run.split("L").map(pair => pair.split(" ").map(Number) as [number, number])),
  }));
}

describe("B11 Grid Wave", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B11_LOOP_SECONDS, B11_LOOP_CYCLES, B11_LOOP_SECONDS]);
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

  it("paints every pixel: an opaque, full-frame cream card under everything (ART_DIRECTION §10, base C)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.paper)).toBe(true);
    }
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } }), PORTRAIT, "#FFFFFF")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B11_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("draws the grid crisp on cream: deep-shade lines with every fourth line in ink, bent without folding", () => {
    for (const t of [0, 1.1, 2.6]) {
      const [minor, major] = strokes(frame(t));
      expect([minor.stroke, major.stroke]).toEqual([palette.accent2, palette.ink]);
      expect(frame(t)).not.toMatch(/opacity/);
      expect(major.width).toBeGreaterThan(minor.width);
      expect(minor.lines.length).toBeGreaterThan(2.5 * major.lines.length);
      // Vertical lines come first in each path; at the same sample index along them, x always increases across the grid
      // (the lines never cross), and they really are bent (not straight).
      const verticals = [...minor.lines, ...major.lines].filter(line => Math.abs(line[0][1] - line[1][1]) > Math.abs(line[0][0] - line[1][0]));
      const columns = [...verticals].sort((a, b) => a[Math.floor(a.length / 2)][0] - b[Math.floor(b.length / 2)][0]);
      for (let sample = 0; sample < columns[0].length; sample += 3) {
        for (let index = 1; index < columns.length; index += 1) expect(columns[index][sample][0]).toBeGreaterThan(columns[index - 1][sample][0]);
      }
      const bend = Math.max(...columns.map(line => Math.max(...line.map(point => point[0])) - Math.min(...line.map(point => point[0]))));
      expect(bend).toBeGreaterThan(25);
    }
  });

  it("density sets the cell size, speed the wave travel; deterministic per seed", () => {
    const count = (input?: unknown) => strokes(frame(1, PORTRAIT, input)).reduce((sum, entry) => sum + entry.lines.length, 0);
    expect(count({ density: 2 })).toBeGreaterThan(count() * 1.8);
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 2 }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });
});
