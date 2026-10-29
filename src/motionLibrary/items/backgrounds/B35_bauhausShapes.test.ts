import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { mixHex } from "../../svg/color";
import { sineInOut } from "../../svg/easing";
import { B35_LOOP_CYCLES, B35_LOOP_SECONDS, bauhausQuarters, bauhausTile, bauhausTiles } from "./B35_bauhausShapes";

const ID = "B35";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "65fef874ca5db687b92cc04577a937fb9547dc10c7ebbfff46ddb31cd0b66f69",
    "8487c69c2d932eabd46a76dd7ad7cee6d0d04d0e814d7cdd7bf11dd239658302",
    "3df674bc4a90caee529ed39765f3df59d594700811bce54340f6146c1077a925",
    "bf42050d7ca61956180563c4635c04ff22e23c93aaba76b81ec0c4bf2d181f87",
    "6c4b307e3d7ea80d5f9e6d4dd9fd8fde6f4ec0a5db66ff2c075c51058135a6b3",
  ],
  landscape: [
    "b89a49f54dbad580de075dddbc43fa2d4c8c6f00a9b45eed64127dc9653dace9",
    "2bf359e3a4694b256e8eba5e8065de7c55bae809268a80d11a050e1084a6545f",
    "df702b480b3616afe8bcd449ffc964c7f6a9e49d7b0e948e7cf67581377290f4",
    "ecb97a6d46386600f731856269c1c1f6ab6022e02ffd1d2bb2a38e2eb64046ed",
    "40dae775db9b27caafa141e3f17502b2ac3d589fcd5619f4fa14a74230e8e671",
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

describe("B35 Bauhaus Shapes", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B35_LOOP_SECONDS, B35_LOOP_CYCLES, B35_LOOP_SECONDS]);
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

  it("paints every pixel: an opaque, full-frame cream card (ART_DIRECTION §10, base C (the reference card)) under everything", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.paper)).toBe(true);
    }
    expect(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } })).not.toBe(frame(1));
  });

  it("is crisp and phone-safe: palette roles only, no transparency, no line thinner than 3 px at a 1080 short side", () => {
    const allowed = new Set<string>([palette.bg, palette.ink, palette.paper, palette.accent, palette.accent2, mixHex(palette.paper, palette.ink, 0.07)]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of [undefined, { density: 2 }, { energy: "calm" }]) {
        for (let index = 0; index < 12; index += 1) {
          const svg = frame((index / 12) * B35_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B35_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.2, PORTRAIT, { speed: 2 })).toBe(frame(0.4));
    expect(frame(0.8, PORTRAIT, { speed: 0.5 })).toBe(frame(0.4));
    expect(frame(0.4, PORTRAIT, { speed: 0.5 })).not.toBe(frame(0.4));
    expect(frame(1.3, PORTRAIT, { density: 2 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });

  it("lays square tiles over the frame: 3 across the short side at density 1, with a faint checker under them", () => {
    expect([0.5, 0.75, 1, 1.5, 2].map(bauhausTiles)).toEqual([2, 2, 3, 5, 6]);
    for (const [size, columns, rows] of [[PORTRAIT, 3, 6], [LANDSCAPE, 6, 3]] as const) {
      const svg = frame(0, size);
      const checker = /<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/.exec(svg)!;
      expect(checker[2]).toBe(mixHex(palette.paper, palette.ink, 0.07));
      expect(checker[1].split("Z").filter(Boolean)).toHaveLength(Math.floor((columns * rows) / 2));
    }
  });

  it("holds every tile at its start orientation at the loop point, and turns tiles only in whole quarter turns", () => {
    expect(bauhausQuarters(0, 0.3, sineInOut)).toBe(0);
    expect(bauhausQuarters(1, 0.3, sineInOut)).toBe(4);
    for (let index = 0; index <= 40; index += 1) {
      const p = index / 40, q = bauhausQuarters(p, 0.3, sineInOut);
      if (index > 0) expect(q).toBeGreaterThanOrEqual(bauhausQuarters((index - 1) / 40, 0.3, sineInOut));
      expect(q).toBeLessThanOrEqual(4);
    }
    // At t = 0 every rotation is a whole quarter turn; mid-cycle some tile is caught between quarters.
    const angles = (svg: string) => [...svg.matchAll(/rotate\((-?[\d.]+) /g)].map(([, degrees]) => Number(degrees));
    expect(angles(frame(0)).every(degrees => degrees % 90 === 0)).toBe(true);
    const caught = [0.2, 0.45, 0.7, 1.2, 1.6, 2.3].some(t => angles(frame(t)).some(degrees => degrees % 90 !== 0));
    expect(caught).toBe(true);
  });

  it("mixes accent discs, ink quarter discs and half discs on ink bars; discs never turn", () => {
    const shapes = new Map<string, number>();
    for (let column = 0; column < 6; column += 1) {
      for (let row = 0; row < 6; row += 1) {
        const tile = bauhausTile(1, column, row);
        shapes.set(tile.shape, (shapes.get(tile.shape) ?? 0) + 1);
        if (tile.shape === "disc") expect(tile.turn).toBe(0);
        expect(tile.moment).toBeLessThan(0.64);
      }
    }
    for (const shape of ["disc", "quarter", "half"]) expect(shapes.get(shape) ?? 0, shape).toBeGreaterThan(4);
    expect(frame(1.3)).toMatch(new RegExp(`<circle [^>]*fill="${palette.accent}"`));
  });
});
