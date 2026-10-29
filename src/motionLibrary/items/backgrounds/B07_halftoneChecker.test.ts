import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B07_LOOP_CYCLES, B07_LOOP_SECONDS, bandProgress } from "./B07_halftoneChecker";

const ID = "B07";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "2f2da45bc0ab556ae27e218b5578093518105686be31dc82b45639a108597fe5",
    "5e936167171c3e6f960759bec1afc84c9feeb7e04adbf2c6c48ac257f59c7a4d",
    "6fe9d2aa05c47d2414d2035160e7af94d7997ee93b0b2ae6517cf6228dbadd6f",
    "2090614a2b732a77fe04c79b79f9f8b0cfd475abb75bcd077c5b36bc1702c307",
    "bfaca24171de8658835f07bc3b18d765da5d5ac0518250f8513c674a2ac47b22",
  ],
  landscape: [
    "b6f4228a52838d7694ba1a0c73bed23e87f4c9b334dee4434cf3cf7c932acb21",
    "752f73d540aff5e21f4a9269ea8b67614b23f9e4cc6aacab907139a0ec8ba4f1",
    "b2a6c8593cafb1599671bd7e3dbe056762c176a9b22eba0b4cc4c839ff7fe10f",
    "dd11e2d65da583a8f621d20fbcd79924240c79725e0e4cf910f7130af6104f72",
    "7c1a02483a1a3d327a9998a01d1663d3b34163639c41518e2bf90f498619b3b6",
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
type Dot = { x: number; y: number; r: number };
/** Dots by fill colour (centre and radius). */
function dotsByFill(svg: string): Map<string, Dot[]> {
  const out = new Map<string, Dot[]>();
  for (const [, d, fill] of svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)) {
    out.set(fill, [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)a([\d.]+) /g)].map(([, x, y, r]) => ({ x: Number(x) + Number(r), y: Number(y), r: Number(r) })));
  }
  return out;
}
/** The narrowest strip holding every dot: its width (px across) and the direction it is measured along (degrees, 0–180). */
function narrowestStrip(dots: readonly Dot[]): { width: number; degrees: number } {
  let best = { width: Infinity, degrees: 0 };
  for (let degrees = 0; degrees < 180; degrees += 0.5) {
    const a = (degrees * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    let low = Infinity, high = -Infinity;
    for (const dot of dots) { const s = dot.x * ca + dot.y * sa; low = Math.min(low, s); high = Math.max(high, s); }
    if (high - low < best.width) best = { width: high - low, degrees };
  }
  return best;
}

describe("B07 Halftone Checker", () => {
  const palette = item.defaultParams.palette;
  /** The pitch at density 1: 13 dots across the 1080 px short side. */
  const pitch = 1080 / 13;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B07_LOOP_SECONDS, B07_LOOP_CYCLES, B07_LOOP_SECONDS]);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B07_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("swaps a dot smoothly as the band crosses it: 0 before, 1 after, monotone", () => {
    const w = 0.12;
    expect([bandProgress(-0.5, w), bandProgress(0, w), bandProgress(w / 2, w), bandProgress(w, w), bandProgress(0.9, w)]).toEqual([0, 0, 0.5, 1, 1]);
    for (let step = 0; step < 100; step += 1) expect(bandProgress(((step + 1) / 100) * w, w)).toBeGreaterThanOrEqual(bandProgress((step / 100) * w, w));
  });

  it("reads at phone size: about 13 dots across the short side, big dots 0.85 of the pitch across and small ones 0.25, as a one-dot checker", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const accent = dotsByFill(frame(0, size)).get(palette.accent)!;
      // Dot centres inside the frame along the short side: 12 or 13 (the edges hold half dots).
      const across = new Set(accent.filter(dot => (size.width < size.height ? dot.x : dot.y) > 0 && (size.width < size.height ? dot.x : dot.y) < 1080)
        .map(dot => Math.round(size.width < size.height ? dot.x : dot.y)));
      expect(across.size).toBeGreaterThanOrEqual(12);
      expect(across.size).toBeLessThanOrEqual(14);
      // Accent dots are at rest (the band's dots are ink): radius 0.425 or 0.125 of the pitch, within the band's soft edge.
      const big = accent.filter(dot => dot.r > 0.275 * pitch), small = accent.filter(dot => dot.r <= 0.275 * pitch);
      for (const dot of big) { expect(dot.r).toBeGreaterThan(0.41 * pitch); expect(dot.r).toBeLessThan(0.426 * pitch); }
      for (const dot of small) { expect(dot.r).toBeGreaterThan(0.124 * pitch); expect(dot.r).toBeLessThan(0.14 * pitch); }
      expect(Math.abs(big.length - small.length)).toBeLessThan(0.12 * accent.length);
      // A one-dot checker: horizontal and vertical neighbours at rest are opposite sizes (unless the band lies between them).
      const at = new Map<string, number>();
      for (const dot of accent) at.set(`${Math.round(dot.x / pitch * 2)},${Math.round(dot.y / pitch * 2)}`, dot.r > 0.275 * pitch ? 1 : -1);
      let opposite = 0, same = 0;
      for (const [key, value] of at) {
        const [x, y] = key.split(",").map(Number);
        for (const neighbour of [at.get(`${x + 2},${y}`), at.get(`${x},${y + 2}`)]) {
          if (neighbour === undefined) continue;
          if (neighbour === -value) opposite += 1;
          else same += 1;
        }
      }
      expect(opposite).toBeGreaterThan(400);
      expect(same / (opposite + same)).toBeLessThan(0.1);
    }
  });

  it("swaps in one coherent diagonal ink band: always on screen, and all the ink dots share one narrow strip", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of [undefined, { seed: 7 }, { density: 2 }]) {
        const scale = (input as { density?: number } | undefined)?.density ?? 1;
        for (let step = 0; step < 40; step += 1) {
          const t = (step / 40) * B07_LOOP_SECONDS, label = `${size.width}x${size.height} ${JSON.stringify(input)} t=${t}`;
          const ink = dotsByFill(frame(t, size, input)).get(palette.ink) ?? [];
          // Only ink dots and accent dots: no third colour, and never a frame without the band.
          expect(ink.length, label).toBeGreaterThanOrEqual(5);
          if (ink.length < 15) continue; // the band is entering or leaving through a corner
          // Every ink dot lies in one strip about two pitches wide, leaning diagonally (35° ± 10° travel): no scattered ink.
          const strip = narrowestStrip(ink);
          expect(strip.width / (pitch / scale), label).toBeLessThan(2.4);
          expect(strip.degrees, label).toBeGreaterThan(23);
          expect(strip.degrees, label).toBeLessThan(47);
        }
      }
    }
  });

  it("speed is a true rate (×2 at t is ×1 at 2t, ×0.5 at 2t is ×1 at t); density scales the screen; deterministic per seed", () => {
    const count = (svg: string) => [...dotsByFill(svg).values()].reduce((sum, dots) => sum + dots.length, 0);
    // Half the pitch: about 4× the dots in frame (3.4× counting the margin ring drawn past the edges).
    expect(count(frame(1, PORTRAIT, { density: 2 }))).toBeGreaterThan(count(frame(1)) * 3);
    expect(frame(0.5, PORTRAIT, { speed: 2 })).toBe(frame(1));
    expect(frame(2, PORTRAIT, { speed: 0.5 })).toBe(frame(1));
    expect(frame(1, PORTRAIT, { speed: 2 })).not.toBe(frame(1));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });
});
