import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B34_LOOP_CYCLES, B34_LOOP_SECONDS, discScale, orbitPoint } from "./B34_minimalCircle";

const ID = "B34";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.9, 2.5, 4.4, 7.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "008995bceac560b9e84a09319eeaadd9fdfc03b2f6bd7bf6147024a901c37b06",
    "8bdeffdca83488bbfe7aebde38e76718cfde5b7fcabedd95c2e1c3b0ea031204",
    "52b6cbe672e432c2c366694dd798ca620e317e5973fe31963abf6f0272e250c1",
    "f04cd11349f1e8186517afe75fd3379b12a1683242a8af9dc8bfed4b89f1dda6",
    "3f55825a67244612308fa00e406e19d50a70eedc51a7502736a83527387635a7",
  ],
  landscape: [
    "048b6be8397255aa020530655e7c8874784776d28b88469e5b1d159d5a90777f",
    "69364f4b019c7d00805f63e67a8568db96836677b43076e6449decfb5018b7ca",
    "d537258b3e8739f4b38af87e5db1c0439191324bb086e1b2658eeb1d7e8bb3f5",
    "f237062c217c4988db782e4cff7281cbb11c85cf7bbf33c1c030d8787b7fa873",
    "46029918837d23cd516d2e2c6562cad40fe7c76e54e5f469513a7b852b15912b",
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

describe("B34 Minimal Circle", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B34_LOOP_SECONDS, B34_LOOP_CYCLES, B34_LOOP_SECONDS]);
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

  it("paints every pixel: an opaque, full-frame accent card (ART_DIRECTION §10, base A) under everything", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.accent)).toBe(true);
    }
    expect(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } })).not.toBe(frame(1));
  });

  it("is crisp and phone-safe: palette roles only, no transparency, no line thinner than 3 px at a 1080 short side", () => {
    const allowed = new Set<string>([palette.bg, palette.ink, palette.paper, palette.accent, palette.accent2]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of [undefined, { density: 2 }, { energy: "calm" }]) {
        for (let index = 0; index < 12; index += 1) {
          const svg = frame((index / 12) * B34_LOOP_SECONDS, size, input);
          for (const colour of svg.match(/#[0-9A-F]{6}/g) ?? []) expect(allowed.has(colour), colour).toBe(true);
          expect(svg).not.toMatch(/opacity/);
          for (const [, width] of svg.matchAll(/stroke-width="([\d.]+)"/g)) expect(Number(width)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B34_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.65, PORTRAIT, { speed: 2 })).toBe(frame(1.3));
    expect(frame(2.6, PORTRAIT, { speed: 0.5 })).toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { speed: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 2 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });

  /** The cream disc and the ink outline circle of a frame: centre and radius. */
  function circles(svg: string): { disc: { x: number; y: number; r: number }; ring: { x: number; y: number; r: number; width: number } } {
    const found = [...svg.matchAll(/<path d="M(-?[\d.]+) (-?[\d.]+)a([\d.]+) [^"]*" fill="([^"]+)"(?: stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)")?/g)];
    expect(found).toHaveLength(2);
    const [disc, ring] = found.map(([, x, y, r, , , width]) => ({ x: Number(x) + Number(r), y: Number(y), r: Number(r), width: Number(width ?? 0) }));
    expect(found[0][4]).toBe(palette.paper);
    expect([found[1][4], found[1][5]]).toEqual(["none", palette.ink]);
    return { disc, ring };
  }

  it("draws one big cream disc and an ink outline circle of the same size that trails it along the same orbit", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const distances: number[] = [];
      for (let index = 0; index < 24; index += 1) {
        const t = (index / 24) * B34_LOOP_SECONDS, { disc, ring } = circles(frame(t, size));
        expect(ring.r).toBe(disc.r);
        expect(disc.r).toBeCloseTo(0.36 * 1080, 0);
        expect(ring.width).toBeGreaterThan(15);
        distances.push(Math.hypot(ring.x - disc.x, ring.y - disc.y));
        // The outline sits where the disc was a moment earlier (it trails, it never leads).
        const earlier = circles(frame((t + B34_LOOP_SECONDS - 0.6) % B34_LOOP_SECONDS, size)).disc, later = circles(frame(t + 0.6, size)).disc;
        expect(Math.hypot(ring.x - earlier.x, ring.y - earlier.y)).toBeLessThan(Math.hypot(ring.x - later.x, ring.y - later.y));
      }
      expect(Math.min(...distances)).toBeGreaterThan(20);
    }
  });

  it("orbits along the long side and never pushes the disc off the frame, at any density", () => {
    [1.1, 1, 0.8].forEach((scale, index) => expect(discScale([0.5, 1, 2][index])).toBeCloseTo(scale, 12));
    const [lx, ly] = orbitPoint(LANDSCAPE, 0), [px, py] = orbitPoint(PORTRAIT, 0);
    expect([Math.round(lx - 960), Math.round(ly - 540), Math.round(px - 540), Math.round(py - 960)]).toEqual([422, 0, 0, 422]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const density of [0.5, 1, 2]) {
        for (let index = 0; index < 32; index += 1) {
          const { disc, ring } = circles(frame((index / 32) * B34_LOOP_SECONDS, size, { density }));
          for (const shape of [disc, ring]) {
            expect(shape.x - shape.r).toBeGreaterThan(0);
            expect(shape.x + shape.r).toBeLessThan(size.width);
            expect(shape.y - shape.r).toBeGreaterThan(0);
            expect(shape.y + shape.r).toBeLessThan(size.height);
          }
        }
      }
    }
  });
});
