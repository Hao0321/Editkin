import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B38_LOOP_CYCLES, B38_LOOP_SECONDS, snapPose, squareOutlines } from "./B38_minimalSquare";

const ID = "B38";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "d9db9a4b445f7d4646b48a93273230677a70632a45ced6cbab6b449c7f51ad0e",
    "60741d7efcb395ea38d4f9c8d0eb9ef42f1e0d66e4a901c3dd0b8386e989b1d5",
    "2ffb73ef2a48145a0370ca242cbd3bc1850b70e03d2b19b4df23ce6aec882872",
    "b5fd6e186735c804c548eb202190afc42b03216ed7367a3294235ef7d6916643",
    "d9db9a4b445f7d4646b48a93273230677a70632a45ced6cbab6b449c7f51ad0e",
  ],
  landscape: [
    "adebd05b35cba2075c4c82ffc391f0e08c48000f1eca49bbe969520d37d8de00",
    "42ff7ccee75f99c5e5e43bf484bf32948d96342b351d2c3cfb9a8a8ef1c9bbc4",
    "ec1bf847b5a52e9dc3a193ff312a3e8c532503332f54deb96569578a344227da",
    "14e2179f3486bd77dbf3c8b2df676c1df9a1c96a8ebb1cb46eea4eaab0fafed1",
    "adebd05b35cba2075c4c82ffc391f0e08c48000f1eca49bbe969520d37d8de00",
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

describe("B38 Minimal Square", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B38_LOOP_SECONDS, B38_LOOP_CYCLES, B38_LOOP_SECONDS]);
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
          const svg = frame((index / 12) * B38_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B38_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.2, PORTRAIT, { speed: 2 })).toBe(frame(0.4));
    expect(frame(0.8, PORTRAIT, { speed: 0.5 })).toBe(frame(0.4));
    expect(frame(0.4, PORTRAIT, { speed: 0.5 })).not.toBe(frame(0.4));
    expect(frame(1.3, PORTRAIT, { density: 2 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 2 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });

  it("winds up against the turn, then snaps a quarter turn with an overshoot and settles square by the end of the beat", () => {
    expect(snapPose(0, 7, 0.07, 0.62)).toEqual({ degrees: 0, scale: 1 });
    expect(snapPose(0.5, 7, 0.07, 0.62).degrees).toBeLessThan(-6);
    const after = Array.from({ length: 40 }, (_, index) => snapPose(0.56 + (index / 40) * 0.34, 7, 0.07, 0.62));
    // The snap passes the quarter turn (folded: a small positive angle) and kicks the size up.
    expect(after.some(pose => pose.degrees > 2)).toBe(true);
    expect(Math.max(...after.map(pose => pose.scale))).toBeGreaterThan(1.05);
    expect(snapPose(0.95, 7, 0.07, 0.62)).toEqual({ degrees: 0, scale: 1 });
  });

  it("shows the calm, aligned mark between beats: a cream square inside an ink outline, both upright", () => {
    const squares = (svg: string) => [...svg.matchAll(/<path d="M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)L/g)].map(([, x0, y0, x1, y1]) => Number(y1) - Number(y0));
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const svg = frame(0, size);
      expect(svg).toMatch(new RegExp(`fill="${palette.paper}"`));
      expect(svg).toMatch(new RegExp(`stroke="${palette.ink}"`));
      for (const tilt of squares(svg)) expect(Math.abs(tilt)).toBeLessThan(0.02);
      expect(frame(1.9, size)).toBe(svg);
    }
    expect([0.5, 1, 1.25, 2].map(squareOutlines)).toEqual([1, 1, 2, 3]);
    expect([...frame(0, PORTRAIT, { density: 2 }).matchAll(/stroke="/g)]).toHaveLength(3);
  });
});
