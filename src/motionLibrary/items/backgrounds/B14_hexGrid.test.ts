import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B14_LOOP_CYCLES, B14_LOOP_SECONDS, hexLevel, hexWave } from "./B14_hexGrid";

const ID = "B14";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "868404740c71570a89c8f5cddde9016d6e7f1d248c3a9513f4e44a8d412aec8f",
    "91399c523cdf5f931bba26a05a3e5836d1d8e5b5874521435749fbc273530798",
    "553b2ad76f4926280d637bc08e5c44bf348f57c78a8011e0d5e00e0850b706b1",
    "fb8dba2a2afb76fdaf6d4462587fdd85af530028c232cb8392440e4f904ff684",
    "6daabc913cf2594e93dfcc828410f57d9f9b04cd3224ec40217a7d762721c30c",
  ],
  landscape: [
    "2bed9c677a1b980621ee77c5cffa6a326d2adf95c081af8933b4d6decd5d5f7f",
    "5f3a6cb899d55df1bc0dea1f15836a6ba1189fa81613af057f508fa8f1a42ee6",
    "14a47acac4ea320811785b7dc514e4dc31803fe344d461c5cf16654cea43ddf3",
    "490865bb2f3dfbe6bb24e9c3d3028c7b48dc1bdf746de3f1fd4f6a10182b719f",
    "73443c1e2a7a1bf3b283866fc86e4c9cc5ac8bfe0de50384721aea7c869f7040",
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

describe("B14 Hex Grid", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B14_LOOP_SECONDS, B14_LOOP_CYCLES, B14_LOOP_SECONDS]);
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

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B14_LOOP_SECONDS);
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

  it("steps a cell through three crisp levels as the wave passes", () => {
    expect([hexLevel(0.2, 1), hexLevel(0.6, 1), hexLevel(0.9, 1)]).toEqual([0, 1, 2]);
    expect(hexWave(0, 100, 0, 0)).toBeCloseTo(1, 12);
    expect(hexWave(50, 100, 0, 0)).toBeCloseTo(0, 12);
    expect(hexWave(30, 100, 0.3, 0)).toBeCloseTo(1, 12);
  });

  it("draws pointy-top hexagons in the accent, a mid shade and the deep shade, with ink rims on the crest", () => {
    for (const t of [0.5, 1.3, 2.75]) {
      const svg = frame(t);
      const fills = [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})" stroke="#[0-9A-F]{6}"/g)];
      expect(fills.map(([, , fill]) => fill)).toEqual([palette.accent, expect.stringMatching(/^#/), palette.accent2]);
      const cells = fills.reduce((sum, [, d]) => sum + (d.match(/M/g) ?? []).length, 0);
      expect(cells).toBeGreaterThan(300);
      // Every cell is a hexagon (M + 5 L + Z).
      for (const [, d] of fills) for (const cell of d.split("Z").filter(Boolean)) expect((cell.match(/L/g) ?? []).length).toBe(5);
      expect(svg).toContain(`stroke="${palette.ink}"`);
    }
  });
});
