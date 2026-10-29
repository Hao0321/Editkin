import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B40_LOOP_CYCLES, B40_LOOP_SECONDS, nestedSquares, squareTwist } from "./B40_nestedSquares";

const ID = "B40";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.7, 1.9, 3.4, 5.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9b4b6788fadae991e20cd363622ae430e39e42ead4ace9131a83c8294daa5e3d",
    "57bfa2db4a4aa045a34ba8354696b2c965808cfa0ad9081583eaa19843008595",
    "abf344417a1bfa4fc4f57c3c651f6dea5558a8e033fe517ad6bba687615b9c95",
    "c6c8f007d0e7f430a2d46b79143654588ea4c42713cfa7a49f1dfd26d33ccb37",
    "2f31528e86193bbd44cd4a9b397cb18ed56468f4c9405b1e92cc5388691a757b",
  ],
  landscape: [
    "2e17dac85aaa5c0a73c3a3e8249b5e38a9a2264e0de85d7e6a286c4f2d52d1cb",
    "a07c38b95f5514b0c7d2cd5664679737dfe79d688b9335aba78277b260990ec2",
    "3642d56a48db990008d248ab9a5336e61c208a65e47f07f1930f49cb74348ff9",
    "7d6deda264b9f0b9a03a880dd8f6e6d115c4fb2c09aafd6073ada4b1acd262ff",
    "a168176bbadff9fe91c791aa0aec9dc7198769352d7efaa7ec41fdf4b9e77dfd",
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

describe("B40 Nested Squares", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B40_LOOP_SECONDS, B40_LOOP_CYCLES, B40_LOOP_SECONDS]);
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
          const svg = frame((index / 12) * B40_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B40_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.65, PORTRAIT, { speed: 2 })).toBe(frame(1.3));
    expect(frame(2.6, PORTRAIT, { speed: 0.5 })).toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { speed: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 2 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 2 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });

  it("nests square outlines, cream and the accent in turn, the largest running off the frame", () => {
    expect([0.5, 1, 2].map(nestedSquares)).toEqual([5, 9, 18]);
    const svg = frame(1.3, LANDSCAPE);
    const strokes = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)"/g)];
    expect(strokes.map(([, , colour]) => colour)).toEqual([palette.accent, palette.paper]);
    expect(Number(strokes[1][3])).toBeGreaterThan(Number(strokes[0][3]));
    expect(strokes[0][1].split("Z").filter(Boolean)).toHaveLength(4);
    expect(strokes[1][1].split("Z").filter(Boolean)).toHaveLength(5);
    const ys = [...strokes[1][1].matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, , y]) => Number(y));
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(1080);
  });

  it("sways back and forth: outer squares twist furthest, through square and over to the other side", () => {
    expect(squareTwist(0, 0.3, 2.6, 1)).toBe(0);
    const outer = Array.from({ length: 48 }, (_, index) => squareTwist(8, index / 48, 2.6, 1));
    expect(Math.max(...outer)).toBeGreaterThan(20);
    expect(Math.min(...outer)).toBeLessThan(-20);
    expect(Math.max(...outer.map(Math.abs))).toBeLessThanOrEqual(8 * 2.6 + 1e-9);
    expect(Math.abs(squareTwist(4, 0.5, 2.6, 1))).toBeLessThan(Math.abs(squareTwist(8, 0.25, 2.6, 1)));
  });
});
