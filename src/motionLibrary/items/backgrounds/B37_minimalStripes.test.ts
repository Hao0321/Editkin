import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B37_LOOP_CYCLES, B37_LOOP_SECONDS, stripeSlide } from "./B37_minimalStripes";

const ID = "B37";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.9, 2.5, 4.4, 7.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "b3573cf213cb4c9fee1327a1ca869e73ee7a73a21482fb41c20510f19b39350a",
    "64d151cd1169e5b1c87f058f394a120efdfb6144e8a4ad1275db3668af4922b3",
    "575a86a3405ca4c46d79a39b17f34e05590039dda9e976e590d085e3c19259fd",
    "aecb33f3f3943edc321dbcafb08a400e0fca6bb03b10ec41330e11e4d8cf2d43",
    "89fb06f61fd7326de891672bf27d3aafe46d9c546b744f24361239e8e1e6f1f3",
  ],
  landscape: [
    "3b8c33e15ca8eeef7136932f536d20c5289500c0b45674926777f3a575a87115",
    "ac6e779b094b10e5f15bb9496b4a7215f70013d180bc5f4aee44dc600fbf852c",
    "7bc1af99a7ff278dd643b2165233ac487429b2775e5db9ae10d757a8c04cec95",
    "b1cf094f41cef72b67e03d7c459d9fb313c50a0ff6c4ef4d8fb7dacc875ac635",
    "dd72526920d70a8cf79fbccae0bb5a046e6d8d434b5992e1eaeb210467877069",
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

describe("B37 Minimal Stripes", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B37_LOOP_SECONDS, B37_LOOP_CYCLES, B37_LOOP_SECONDS]);
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

  it("is crisp and phone-safe: palette roles only, no transparency, no line thinner than 3 px at a 1080 short side", () => {
    const allowed = new Set<string>([palette.bg, palette.ink, palette.paper, palette.accent, palette.accent2]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of [undefined, { density: 2 }, { energy: "calm" }]) {
        for (let index = 0; index < 12; index += 1) {
          const svg = frame((index / 12) * B37_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B37_LOOP_SECONDS);
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

  /** The bars of each band: [x, top, width, height] per bar, by fill colour. */
  function bands(svg: string): Map<string, Array<[number, number, number, number]>> {
    const result = new Map<string, Array<[number, number, number, number]>>();
    for (const [, d, fill] of svg.matchAll(/<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/g)) {
      result.set(fill, [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)H(-?[\d.]+)V(-?[\d.]+)H/g)].map(([, x0, y0, x1, y1]) =>
        [Number(x0), Number(y0), Number(x1) - Number(x0), Number(y1) - Number(y0)] as [number, number, number, number]));
    }
    return result;
  }

  it("stacks three thick bands of long bars, accent, cream and the deep shade, as one group across the middle", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const rows = bands(frame(1.3, size));
      expect([...rows.keys()]).toEqual([palette.accent, palette.paper, palette.accent2]);
      const tops = [...rows.values()].map(bars => bars[0][1]), heights = [...rows.values()].map(bars => bars[0][3]);
      for (const bars of rows.values()) for (const bar of bars) expect(bar[2] / bar[3]).toBeGreaterThan(2.5);
      const groupTop = tops[0], groupBottom = tops[2] + heights[2];
      expect((groupTop + groupBottom) / 2).toBeCloseTo(size.height / 2, 0);
      expect(heights[0]).toBeGreaterThanOrEqual(128);
    }
  });

  it("slides the accent and deep rows one way and the cream row the other, by whole bar periods per cycle", () => {
    expect([stripeSlide(0, "standard"), stripeSlide(1, "standard"), stripeSlide(2, "punchy")]).toEqual([0, 1, 2]);
    expect(stripeSlide(0.25, "calm")).toBeCloseTo(0.25, 12);
    // Punchy slides then holds: almost no travel right after a whole period.
    expect(stripeSlide(0.02, "punchy")).toBeLessThan(0.002);
    const a = bands(frame(1.0, LANDSCAPE)), b = bands(frame(1.1, LANDSCAPE));
    // Follow one bar: the bar nearest the middle at the first time, and the bar nearest it a tenth of a second later.
    const near = (bars: ReadonlyArray<[number, number, number, number]>, x: number) => bars.reduce((best, bar) => (Math.abs(bar[0] - x) < Math.abs(best[0] - x) ? bar : best));
    const shift = (fill: string) => { const from = near(a.get(fill)!, 960)[0]; return near(b.get(fill)!, from)[0] - from; };
    expect(shift(palette.accent)).toBeLessThan(0);
    expect(shift(palette.accent2)).toBeLessThan(0);
    expect(shift(palette.paper)).toBeGreaterThan(0);
  });
});
