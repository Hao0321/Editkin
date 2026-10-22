import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B33_LOOP_CYCLES, B33_LOOP_SECONDS, blockArrangement, blockColumns } from "./B33_minimalBlocks";

const ID = "B33";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.9, 2.5, 4.4, 7.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "810b98b550ea90195cb6915cbc939b8e7ab414ca2662a4aad6b54b99ea0c713c",
    "9ae6ea22b3a791fe00b726beb32cb7fff9afaf9d17a0a01e9abfdd221c4986ba",
    "e7c8a866bf0a61e4aea60ce0037db7d5ae26f75614248179e16c56ba73a66ad5",
    "647f5ac392ee41dee8b23c8b6a44802ca1407c5b2a9cb13f8b4b946de6325a57",
    "810b98b550ea90195cb6915cbc939b8e7ab414ca2662a4aad6b54b99ea0c713c",
  ],
  landscape: [
    "983ac5d0ad8be3c769e7bb3cd6897fabaa2b3e2cfa3d45914db2d6d7e5971bef",
    "983d92cf36e3c89d10af2bed82d6e6c562849cc786555936e1354ff8f5641618",
    "bf8a66072ea645507c51e7e7c08d9aa1b66679a6ec02e4c006affe71724da170",
    "0151db346759ae7b8465572818db49c6b79fc563758ca36ceb8e46d8ae073d26",
    "983ac5d0ad8be3c769e7bb3cd6897fabaa2b3e2cfa3d45914db2d6d7e5971bef",
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

describe("B33 Minimal Blocks", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B33_LOOP_SECONDS, B33_LOOP_CYCLES, B33_LOOP_SECONDS]);
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
          const svg = frame((index / 12) * B33_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B33_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.65, PORTRAIT, { speed: 2 })).toBe(frame(1.3));
    expect(frame(2.6, PORTRAIT, { speed: 0.5 })).toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { speed: 0.5 })).not.toBe(frame(1.3));
    expect(frame(0.5, PORTRAIT, { density: 2 })).not.toBe(frame(0.5));
    expect(frame(0.5, PORTRAIT, { density: 0.5 })).not.toBe(frame(0.5));
    expect(frame(0.5, LANDSCAPE, { seed: 7 })).toBe(frame(0.5, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(0.5, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(0.5, LANDSCAPE));
    }
  });

  it("steps through four arrangements: an open accent column first, then a cream/ink split and the dark card column", () => {
    expect([0.5, 1, 1.5, 2].map(blockColumns)).toEqual([2, 3, 4, 5]);
    for (const columns of [2, 3, 4, 5]) {
      for (let step = 0; step < 4; step += 1) {
        const { bounds, splits } = blockArrangement(step, columns, 1);
        expect(bounds.length).toBe(columns + 1);
        expect([bounds[0], bounds[columns]]).toEqual([0, 1]);
        // The accent column is always wide open for a title; columns never run backwards.
        expect(bounds[1]).toBeGreaterThan(0.34);
        for (let index = 1; index <= columns; index += 1) expect(bounds[index]).toBeGreaterThanOrEqual(bounds[index - 1]);
        for (const split of splits) expect(split > 0.3 && split < 0.8).toBe(true);
        // Even arrangements close the last column (its plane reaches the far edge), as in the reference.
        if (columns > 2) expect(bounds[columns - 1] === 1).toBe(step % 2 === 0);
      }
    }
  });

  it("holds each arrangement exactly between moves, and only flat planes in cream, ink and the dark card cover the accent", () => {
    const rects = (svg: string) => [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-F]{6})"\/>/g)].slice(1);
    // Each 2 s step opens with the move to the next arrangement and holds it from 0.42 + 1.5 × 0.07 of the step:
    // step 0 (0–2 s) moves to arrangement 1 and holds it from 1.05 s.
    const held = frame(1.5, LANDSCAPE), { bounds, splits } = blockArrangement(1, 3, 1);
    expect(frame(1.95, LANDSCAPE)).toBe(held);
    const planes = rects(held);
    expect(planes.map(([, , , , , fill]) => fill)).toEqual([palette.paper, palette.ink, palette.bg]);
    expect(Number(planes[0][1])).toBeCloseTo(bounds[1] * 1920, 2);
    expect(Number(planes[1][2])).toBeCloseTo(splits[0] * 1080, 2);
    expect(Number(planes[2][1])).toBeCloseTo(bounds[2] * 1920, 2);
    // Arrangement 0 closes the card column: no dark card plane at t = 0.
    expect(rects(frame(0, LANDSCAPE)).map(([, , , , , fill]) => fill)).toEqual([palette.paper, palette.ink]);
    // Portrait turns the layout: the accent block sits on top, full width.
    const portrait = rects(frame(1.5));
    expect([Number(portrait[0][1]), Number(portrait[0][2])]).toEqual([0, Number((bounds[1] * 1920).toFixed(3))]);
    expect(held).not.toMatch(/stroke|<path/);
  });
});
