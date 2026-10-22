import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B22_LOOP_CYCLES, B22_LOOP_SECONDS, ribbonCount, twistAngle } from "./B22_stripeTwist";

const ID = "B22";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "09488e20c37e76060e33832516376ef07ab4b4281fcb5cfbb77a1890e5025e1f",
    "13eb08ac19716e5ba4fb00a1269be0da756fd9de64f5c83b20ed849ef90be148",
    "8ec9c6bb202daa2457159a9eea03f738c62f62815ba35d54ffbb2d6c7fe7cf3f",
    "9d8b45358088a5e6a7b8dd2a190bf1e4f449929f29a2a6a99935299357dde4a9",
    "a6e1d58336565efdaac5b002508038175e63188971b18fccfd2bd2ccfbe9d663",
  ],
  landscape: [
    "5d249afc0841bea99ed78283e042dc838752d0e0ab44fbb7b5902cf59fda4936",
    "81cf3c603dfc9892939f21fe835e7a51c8f0f618a8d99c7b46f1f1959ce869e0",
    "b6c9694038e30fce0d966babf15338bc81f39c9d24d222089f857ceae585ec25",
    "713eb1f44c4ae8bf8c26e1a80cc4684faccac071afad3fd60a183fb39cca954c",
    "5ac487555ae3ff0b50d58ee9cc0ef1fd7348834d8a286435aebf1bec368bffb5",
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

describe("B22 Stripe Twist", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B22_LOOP_SECONDS, B22_LOOP_CYCLES, B22_LOOP_SECONDS]);
    expect(item.revision).toBe(2);
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

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B22_LOOP_SECONDS);
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

  it("twists along the ribbon and over time, whole turns per cycle", () => {
    expect(Math.cos(twistAngle(0.3, 1, 0.2, 1))).toBeCloseTo(Math.cos(twistAngle(0.3, 0, 0.2, 1)), 12);
    expect(twistAngle(0, 0, 0, 1)).toBe(0);
  });

  it("shows each ribbon's front in ink and its back in the deep shade, pinched to a point where it turns over", () => {
    const svg = frame(1.3);
    expect(svg).toContain(`fill="${palette.ink}"`);
    expect(svg).toContain(`fill="${palette.accent2}"`);
    const lenses = [...svg.matchAll(/<path d="([^"]*)" fill="#[0-9A-F]{6}"/g)].flatMap(([, d]) => d.split("Z").filter(Boolean));
    expect(lenses.length).toBeGreaterThan(9);
    // At most 12 wide ribbons across the frame (H.264-safe): 9 at density 1, never more than 12 or fewer than 6.
    expect([ribbonCount(0.5), ribbonCount(1), ribbonCount(1.25), ribbonCount(2)]).toEqual([6, 9, 11, 12]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const centres = new Set<number>();
      for (const [, d] of frame(1.3, size, { density: 2 }).matchAll(/<path d="([^"]*)" fill="#[0-9A-F]{6}"/g)) {
        for (const lens of d.split("Z").filter(Boolean)) {
          const xs = [...lens.matchAll(/[ML](-?[\d.]+) /g)].map(([, x]) => Number(x));
          centres.add(Math.round((Math.max(...xs) + Math.min(...xs)) / 2));
        }
      }
      expect(centres.size).toBeLessThanOrEqual(12);
    }
    // Each ribbon is wide: its full width is 0.62 of the spacing (about 74 px across a 1080 px frame, energy up to 1.15).
    const widths = lenses.map(lens => {
      const xs = [...lens.matchAll(/[ML](-?[\d.]+) /g)].map(([, x]) => Number(x));
      return Math.max(...xs) - Math.min(...xs);
    });
    expect(Math.max(...widths)).toBeGreaterThan(60);
    expect(Math.max(...widths)).toBeLessThan((0.62 * 1080 / 9) * 1.15 + 0.5);
  });
});
