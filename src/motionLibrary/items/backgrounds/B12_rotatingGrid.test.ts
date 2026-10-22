import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B12_LOOP_CYCLES, B12_LOOP_SECONDS } from "./B12_rotatingGrid";

const ID = "B12";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1.7, 4.4, 6, 10.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "e918a73f567114a6612a9b0fe8ed35365080d88e9ba7ad1f93136c88732c964e",
    "3eb66a13b9a901f6831100d07e741766f722d670c6037faa6d1f187f36c18a11",
    "a74c2cfc319abc3e67ce3265155bc071413d0e0772cee60af07335137f55c755",
    "a9c7d6e1bcee185cdd70af69e81dd12bba8811d621f6f995e4054ef0eda237f2",
    "cad7a5680165e51fd57372339253b0355b566c5a4d3aa0c3eee0434f333bd3b5",
  ],
  landscape: [
    "abc46010484a23de5984a2b3fafdda03bd2223634fc5ee92c34d75fd0ab315ce",
    "79de4ded494dac0e3ff845917912719129139282b18b2b4fd5b9e8d0459e7cc4",
    "e6f6e1f0b12f5d5053a49a71a25cc73719ba282df534bf33b47f3b714955fc62",
    "b0e3954eda824ef57590519b67e914dc4929a38ede890189a268d3327c197adb",
    "40d5a2fbf14a2d4fe93f0622dd0be04aca2363666a6a8983283b960f73c2940e",
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
/** The two lattices, in drawing order: attributes and line directions (degrees, mod 90). */
function lattices(svg: string): Array<{ d: string; attrs: string; directions: number[] }> {
  return [...svg.matchAll(/<path d="([^"]*)"([^>]*)\/>/g)].map(([, d, attrs]) => ({
    d, attrs,
    directions: [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g)]
      .map(([, x0, y0, x1, y1]) => (((Math.atan2(Number(y1) - Number(y0), Number(x1) - Number(x0)) * 180) / Math.PI) % 90 + 90) % 90),
  }));
}
/** Mean direction (mod 90°) of a lattice's lines, and the angle between two directions (0..45°). */
const direction = (values: number[]) => {
  const x = values.reduce((sum, value) => sum + Math.cos((value * 4 * Math.PI) / 180), 0), y = values.reduce((sum, value) => sum + Math.sin((value * 4 * Math.PI) / 180), 0);
  return ((((Math.atan2(y, x) * 180) / Math.PI / 4) % 90) + 90) % 90;
};
const between = (a: number, b: number) => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); };
const signedTurn = (from: number, to: number) => ((to - from) % 90 + 135) % 90 - 45;
const gap = (t: number, input?: unknown) => { const [a, b] = lattices(frame(t, PORTRAIT, input)); return between(direction(a.directions), direction(b.directions)); };

describe("B12 Rotating Grid", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B12_LOOP_SECONDS, B12_LOOP_CYCLES, B12_LOOP_SECONDS]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const start = frame(0, size, input), label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(frame(period(input), size, input), label).toBe(start);
        expect(frame(2 * period(input), size, input), label).toBe(start);
        expect(frame(period(input) / 3, size, input), label).not.toBe(start);
      }
    }
  });

  it("is continuous across the seam: just before the loop point each lattice has turned a whole 90° (the same lines)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const before = frame(period(input) - 1e-4, size, input), start = frame(0, size, input);
        const [a0, b0] = lattices(start), [a1, b1] = lattices(before);
        expect(between(direction(a1.directions), direction(a0.directions)), JSON.stringify(input)).toBeLessThan(0.01);
        expect(between(direction(b1.directions), direction(b0.directions)), JSON.stringify(input)).toBeLessThan(0.01);
        const x = numbers(before), y = numbers(start);
        expect(x.length).toBe(y.length);
        expect(maxDifference(x, y), JSON.stringify(input)).toBeLessThan(0.25);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B12_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("draws a crisp cream lattice and a crisp accent lattice, half a pitch apart, counter-rotating", () => {
    const [cream, accent] = lattices(frame(0));
    expect(cream.attrs).toBe(` fill="none" stroke="${palette.paper}" stroke-width="3.2"`);
    expect(accent.attrs).toBe(` fill="none" stroke="${palette.accent}" stroke-width="3.2"`);
    // Aligned at the start and half way through the loop, 45° apart a quarter of the way (and at speed 2, twice as often).
    expect(gap(0)).toBeLessThan(0.01);
    expect(gap(B12_LOOP_SECONDS / 4)).toBeCloseTo(45, 1);
    expect(gap(B12_LOOP_SECONDS / 2)).toBeLessThan(0.01);
    expect(gap(B12_LOOP_SECONDS / 8, { speed: 2 })).toBeCloseTo(45, 1);
    // Opposite turns: the cream lattice one way, the accent the other, by the same amount.
    const [creamLater, accentLater] = lattices(frame(1));
    const creamTurn = signedTurn(direction(cream.directions), direction(creamLater.directions));
    const accentTurn = signedTurn(direction(accent.directions), direction(accentLater.directions));
    expect(Math.abs(creamTurn)).toBeGreaterThan(1);
    expect(accentTurn).toBeCloseTo(-creamTurn, 1);
  });

  it("lingers near alignment: the turn slows where the moiré flowers are largest", () => {
    const step = 0.05;
    const rate = (t: number) => Math.abs(gap(t + step) - gap(t)) / step;
    expect(rate(B12_LOOP_SECONDS / 2 - 0.4)).toBeLessThan(0.5 * rate(B12_LOOP_SECONDS / 6));
  });

  it("density sets the line pitch; deterministic per seed", () => {
    const segments = (input?: unknown) => lattices(frame(1, PORTRAIT, input)).reduce((sum, lattice) => sum + lattice.directions.length, 0);
    expect(segments({ density: 2 })).toBeGreaterThan(segments() * 1.7);
    expect(frame(4.4, LANDSCAPE, { seed: 7 })).toBe(frame(4.4, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 2 }]) {
      expect(frame(4.4, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(4.4, LANDSCAPE));
    }
  });
});
