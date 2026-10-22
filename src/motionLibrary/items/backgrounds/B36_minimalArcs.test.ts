import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { cubicInOut } from "../../svg/easing";
import { B36_LOOP_CYCLES, B36_LOOP_SECONDS, arcRings, arcSpin } from "./B36_minimalArcs";

const ID = "B36";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.9, 2.5, 4.4, 7.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "8017ace98551276cd341c1bb7335d1867e352dec82f5d795f3a0e3fff60aefc1",
    "133f7d588c40db472e8cb32fdc60b7826d936d573afab11703c1083b364cbbc2",
    "6625e83c843248e8feb0280474e9f3d990188df348d4dca5872edb4e5cb8ee02",
    "7140e7c0ab0ed2073f05f5577592b9fa6547ca0fcf11cf9943bacfc725fdf46f",
    "44f56c5519dc20aa39ce87180437b1832a398d9a3eb8120341d35d54439eb248",
  ],
  landscape: [
    "aeac4225d0d333a364f74593562b05fe5815056d84d444783ff4c7e2af8883c5",
    "a475b703e5653fcf5979345a532f43e109bfd305506ec02c9fdbdb2003dc2d54",
    "c4ec8533f875bc18c90e806b85b148c967c45b542f70485b5754700e3fe3b1ec",
    "1ece14c98cc4ecae2e13eb01f2b5c10865b39a0fbf5c86d1d25c9c5d4c81594e",
    "78a8b7a7fb91767cc01b2275fd49f7098790116c65e7411906674e389647d48e",
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

describe("B36 Minimal Arcs", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B36_LOOP_SECONDS, B36_LOOP_CYCLES, B36_LOOP_SECONDS]);
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
          const svg = frame((index / 12) * B36_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B36_LOOP_SECONDS);
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

  /** Half rings of a frame: start point, middle point, radius and colour (two quarter arcs each). */
  function arcs(svg: string, size: MotionFrameSize) {
    const result: Array<{ colour: string; r: number; startAngle: number; middleAngle: number }> = [];
    for (const [, d, colour] of svg.matchAll(/<path d="([^"]+)" fill="none" stroke="(#[0-9A-F]{6})"/g)) {
      for (const [, x0, y0, r, x1, y1] of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)A([\d.]+) [\d.]+ 0 0 1 (-?[\d.]+) (-?[\d.]+)/g)) {
        const angle = (x: string, y: string) => (Math.atan2(Number(y) - size.height / 2, Number(x) - size.width / 2) * 180) / Math.PI;
        result.push({ colour, r: Number(r), startAngle: angle(x0, y0), middleAngle: angle(x1, y1) });
      }
    }
    return result.sort((a, b) => a.r - b.r);
  }

  it("gathers every half ring into one bowl below the centre at the loop point, and holds it there for a moment", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const bowl = arcs(frame(0, size), size);
      expect(bowl).toHaveLength(5);
      for (const ring of bowl) expect(ring.middleAngle).toBeCloseTo(90, 1);
      expect(bowl.map(ring => ring.colour)).toEqual([palette.accent, palette.paper, palette.accent, palette.paper, palette.accent]);
    }
    expect(frame(0.25)).toBe(frame(0));
    expect(arcSpin(0.05, cubicInOut)).toBe(0);
    expect(arcSpin(0.96, cubicInOut)).toBe(1);
    expect(arcSpin(1.5, cubicInOut)).toBeCloseTo(1.5, 6);
  });

  it("spins the rings apart at different speeds and in both directions between gathers", () => {
    expect([0.5, 1, 2].map(arcRings)).toEqual([3, 5, 10]);
    const middle = (t: number) => arcs(frame(t, LANDSCAPE), LANDSCAPE).map(ring => ring.middleAngle);
    const a = middle(1.0), b = middle(1.1);
    const turned = a.map((angle, index) => ((b[index] - angle + 540) % 360) - 180);
    expect(turned.some(delta => delta > 0.5)).toBe(true);
    expect(turned.some(delta => delta < -0.5)).toBe(true);
    expect(new Set(turned.map(delta => Math.round(Math.abs(delta)))).size).toBeGreaterThan(1);
  });
});
