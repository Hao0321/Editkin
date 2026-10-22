import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B21_LOOP_CYCLES, B21_LOOP_SECONDS, ringWidth } from "./B21_rippleRings";

const ID = "B21";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "aba3851ee5a9b76ef35942e67275ba5c85b81dedd0b3a1a47ac5c50708299f25",
    "fb34869e7c69dc3376a7b2d32e6c1b9cf872289d4feaaf4df93312d5c04638ea",
    "025b41c5a3f2bcd5e450672c3485ab44f8812fa069befd96cc77a0e67fdf1363",
    "ae0dad945e33679e85dfe9274661986bc8d0d94c3e710bc5849287f160f38a28",
    "facc129528909c0f499dca7583e1ab7d132923fcd36785f0ad4b0c2ecb14dbd9",
  ],
  landscape: [
    "90a96ef424ca4d71cb9f8642d13b521ea9c62fba95f403e549b8011b3b99f0a2",
    "97a714775e88fbdc1a37069cf1cde4b9952c1529556b0075081c597ed17221fa",
    "764b6764642458f3c4c5e96d62f79e333b56ca2bc9b19710a824e7f09cd1b8fb",
    "571d40c5932700f35f2bc8836e8280a01672655a8b0b82cd87ed688de4f71677",
    "aff19b5bbba4dd23b7723c12d48687b5d40f2887dcca91c14f99061e97cdf53d",
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

describe("B21 Ripple Rings", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B21_LOOP_SECONDS, B21_LOOP_CYCLES, B21_LOOP_SECONDS]);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B21_LOOP_SECONDS);
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

  it("thins a ring out as it grows (no transparency)", () => {
    expect(ringWidth(0, 1000, 4)).toBe(4);
    expect(ringWidth(500, 1000, 4)).toBeLessThan(4);
    expect(ringWidth(1000, 1000, 4)).toBe(0);
    expect(frame(1.3)).not.toMatch(/opacity/);
  });

  it("spreads cream rings from one centre and accent rings from another", () => {
    const svg = frame(1.3);
    const rings = [...svg.matchAll(/<path d="M(-?[\d.]+) (-?[\d.]+)a([\d.]+) [^"]*" fill="none" stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)"/g)]
      .map(([, x, y, r, stroke, width]) => ({ cx: Number(x) + Number(r), cy: Number(y), stroke, width: Number(width) }));
    const cream = rings.filter(ring => ring.stroke === palette.paper), accent = rings.filter(ring => ring.stroke === palette.accent);
    expect(cream.length).toBeGreaterThan(5);
    expect(accent.length).toBeGreaterThan(5);
    expect(new Set(cream.map(ring => `${Math.round(ring.cx)},${Math.round(ring.cy)}`)).size).toBe(1);
    expect(new Set(accent.map(ring => `${Math.round(ring.cx)},${Math.round(ring.cy)}`)).size).toBe(1);
    expect(Math.hypot(cream[0].cx - accent[0].cx, cream[0].cy - accent[0].cy)).toBeGreaterThan(400);
  });
});
