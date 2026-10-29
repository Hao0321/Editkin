import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B13_LOOP_CYCLES, B13_LOOP_SECONDS, cubeLift, cubeScale } from "./B13_isometricGrid";

const ID = "B13";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "6d4c706411ef9b1e4eaf12377cea98fd17703a819b802369fe2c90ccecd74d39",
    "3926b25a0920cd9c760d1b4bbb17418cfb3ec6b5b4c60dc1da92704dd4d470d6",
    "6f2f0e0af098cc6247c30f9b224328cf1e6a60fda74f890f5e7f00183c370bee",
    "c505cf832a4ec069c51fc31e430d86269667ed7d0bc0ab6e796757109359d067",
    "3f3d1eba8dfd9efaec1ce71cb1a0664912a8334be311b9421d5e566d60cfacff",
  ],
  landscape: [
    "a614b1f5390c1900b06dbcc34add30fb2b73a7d54f86dc1996c4aecdda8f503e",
    "8b85f9bef4a3bc256883e911c477aae4d09884237e9957de9a68a70d122c09a2",
    "d46e09edb3174880d8f03ce713296ccb9f473c1a41bb201587df03f10e672a5f",
    "2cefa450653f33f48693fad677ac7b0eed3b05584ab8b9bf7af66fd42f8dfa06",
    "ec97815039af54d2f8f454479b84408c5a95668fa42fbd2e894249684636418a",
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

describe("B13 Isometric Grid", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B13_LOOP_SECONDS, B13_LOOP_CYCLES, B13_LOOP_SECONDS]);
    expect(item.revision).toBe(1);
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
        const before = numbers(frame(period(input) - 1e-5, size, input)), start = numbers(frame(0, size, input));
        expect(before.length, JSON.stringify(input)).toBe(start.length);
        expect(maxDifference(before, start), JSON.stringify(input)).toBeLessThan(0.25);
      }
    }
  });

  it("paints every pixel: an opaque, full-frame dark card (ART_DIRECTION §10, base D) under everything", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.bg)).toBe(true);
    }
    expect(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } })).not.toBe(frame(1));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B13_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.2, PORTRAIT, { speed: 2 })).toBe(frame(0.4));
    expect(frame(0.8, PORTRAIT, { speed: 0.5 })).toBe(frame(0.4));
    expect(frame(0.4, PORTRAIT, { speed: 0.5 })).not.toBe(frame(0.4));
    expect(frame(1.3, PORTRAIT, { density: 2 })).not.toBe(frame(1.3));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });

  it("stands cubes up on a spring: flat at birth, overshooting, holding, then sunk and gone", () => {
    expect([cubeLift(0, 13), cubeScale(0)]).toEqual([0, 0]);
    const rise = Array.from({ length: 50 }, (_, index) => cubeLift(index / 100, 13));
    expect(Math.max(...rise)).toBeGreaterThan(1.05);
    expect(cubeLift(0.45, 13)).toBeCloseTo(1, 2);
    expect(cubeLift(0.62, 13)).toBe(0);
    expect(cubeScale(0.7)).toBe(0);
    expect(cubeLift(0.45, 30)).toBeCloseTo(1, 2);
    expect(Math.max(...Array.from({ length: 50 }, (_, index) => cubeLift(index / 100, 30)))).toBeLessThan(Math.max(...rise));
  });

  it("draws a cream ±60° lattice over deep-shade horizontals, and cubes with an accent top, cream left and shaded right face", () => {
    for (const t of [0.5, 1.3, 2.75]) {
      const svg = frame(t);
      expect(svg).toContain(`stroke="${palette.accent2}"`);
      expect(svg).toContain(`stroke="${palette.paper}"`);
      const tops = svg.match(new RegExp(`<path d="([^"]*)" fill="${palette.accent}"`))?.[1] ?? "";
      const cubes = (tops.match(/M/g) ?? []).length;
      expect(cubes, String(t)).toBeGreaterThanOrEqual(2);
      expect(cubes, String(t)).toBeLessThanOrEqual(14);
      expect(svg).toContain(`fill="${palette.paper}"`);
    }
  });
});
