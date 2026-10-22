import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B03_LOOP_CYCLES, B03_LOOP_SECONDS } from "./B03_comicDots";

const ID = "B03";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.7, 2.1, 3.6, 5.5] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "1752704ea7bb3789af8d71444632249c4ced8621bd237db1fe78d5d321a2050f",
    "5aef8010ea561d88a3109a7d704a8fde00f1fc8fa18a0a0cb836d83735c7155a",
    "09a520c2ece464c33bdad29287ed83f752fad88d51d42319e9cbdcecb6a0028a",
    "65166099b2776f68e47d97a028650c807b2cf65e4f84a7eb28dd2176d2d9df9d",
    "2c93b055de04642cef5bf26361c627825cccd4f476c636e3e8bec77b020f7a3f",
  ],
  landscape: [
    "d74733c6263af06c4131ea79874eaf0558a3d136451960e389b6cce1c66bc1df",
    "f0ad68e4b39218ae4b89bb23dea590e218b2ec90b6c0bd0811634f3cc9f23797",
    "a2f8504f2a554a44d980c1493a1e990832c3e7915805eea025230013e3843be9",
    "f086170ea882390cc5083700fc8ff4a53a61e8569f5467f23b284a912187ce16",
    "b508b057713d334fb02569a89d3479857ab97a30ab1dbe72952e2a4c3ef88a2e",
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

describe("B03 Comic Dots", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B03_LOOP_SECONDS, B03_LOOP_CYCLES, B03_LOOP_SECONDS]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const start = frame(0, size, input), label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(frame(period(input), size, input), label).toBe(start);
        expect(frame(2 * period(input), size, input), label).toBe(start);
        expect(frame(period(input) / 5, size, input), label).not.toBe(start);
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

  it("paints every pixel: an opaque, full-frame cream card under everything (ART_DIRECTION §10, base C→D)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.paper)).toBe(true);
    }
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "travel_note" } }), PORTRAIT, "#FFFDF7")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B03_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("prints one square screen twice, accent then ink on top, a few pixels off register", () => {
    for (const t of [0, 1.7, 4.2]) {
      const [accent, ink] = dotPaths(frame(t));
      expect([accent.fill, ink.fill]).toEqual([palette.accent, palette.ink]);
      expect(accent.dots.length).toBe(ink.dots.length);
      // Every accent dot is the ink dot's twin: same size, shifted by the misregistration (0.2 ± 0.04 pitch, pitch 40 px here).
      for (let index = 0; index < ink.dots.length; index += 1) {
        const shift = Math.hypot(accent.dots[index].x - ink.dots[index].x, accent.dots[index].y - ink.dots[index].y);
        expect(shift).toBeGreaterThan(0.15 * 40);
        expect(shift).toBeLessThan(0.25 * 40);
        expect(Math.abs(accent.dots[index].r - ink.dots[index].r)).toBeLessThan(0.11);
      }
      // The ink screen is axis-aligned and square, centred on the frame.
      for (const dot of ink.dots) expect(Math.abs((((dot.x - 540) / 40) % 1 + 1.5) % 1 - 0.5) * 40).toBeLessThan(0.11);
    }
  });

  it("carries the card from fine dots on cream to big, nearly touching dots (dark) with a tone that travels toward +x", () => {
    for (const t of [0, 1.5, 3, 4.5]) {
      const ink = dotPaths(frame(t))[1].dots;
      expect(Math.max(...ink.map(dot => dot.r))).toBeGreaterThan(0.47 * 40);
      expect(Math.max(...ink.map(dot => dot.r))).toBeLessThan(0.51 * 40);
      expect(Math.min(...ink.map(dot => dot.r))).toBeLessThan(0.06 * 40);
    }
    // Along one row the size at x after a short step equals the size at x − (travel) before it: the tone moves right.
    const row = (t: number) => dotPaths(frame(t))[1].dots.filter(dot => Math.abs(dot.y - 960) < 1).sort((a, b) => a.x - b.x).map(dot => dot.r);
    const a = row(1), b = row(1.15);
    const shiftOf = (lag: number) => a.slice(0, a.length - lag).reduce((sum, value, index) => sum + Math.abs(value - b[index + lag]), 0) / (a.length - lag);
    expect(shiftOf(1)).toBeLessThan(shiftOf(0));
  });

  it("is deterministic; seed, energy, speed and density change the frame", () => {
    expect(frame(2.1, LANDSCAPE, { seed: 7 })).toBe(frame(2.1, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 2 }, { speed: 0.5 }, { density: 2 }]) {
      expect(frame(2.1, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(2.1, LANDSCAPE));
    }
  });
});
