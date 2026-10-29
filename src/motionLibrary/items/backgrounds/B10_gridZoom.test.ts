import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B10_LOOP_CYCLES, B10_LOOP_SECONDS } from "./B10_gridZoom";

const ID = "B10";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.75, 1.3, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "e3c1db54fa71381a86bcc05d13405d978aafb832ca1ba23034acbb8bb01cf6d5",
    "10ba80faf55dd8023090c096c74e3874e02e8838afde9f283040fb6ba4c81634",
    "7a221b61dc88340f4ffb87f29064f6c7ad99aa9101d26e6e7616f24a7b9a6388",
    "0f16ad2ca6ffaae92deb0c8ec136bd8b45e689a16c58c2b4106893db7928ca59",
    "5d4b585a9ec370e453f11ea0785a58f0e108107887fca810d7c354b176464301",
  ],
  landscape: [
    "9119c5d3cd84516cdf3dd23676b677c15e74768f931e140143a5ddc80304f4f6",
    "036c369fb419dfe15e13bdd0f7d2640e6b26bb5093d525906ee7db233c37cacd",
    "67d93daa12b66c14d1773af89e656d5b1e38bf5fbbc101d5179c46798c1cc0c8",
    "e8c120124c508c5608c6c42bac445c5bf5f0a441cfc368e4f66759a86a32212c",
    "57302706169616319bb27d0edb2d2177c36d1b9c3fb54ef332564511af87621a",
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
/** Vertical grid lines (full-height bands "M x0 0H x1 V H… Z") per level path: centre x and width. */
function verticalLines(svg: string): Array<{ fill: string; lines: Array<{ x: number; width: number }> }> {
  return [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)].map(([, d, fill]) => ({
    fill, lines: [...d.matchAll(/M(-?[\d.]+) 0H(-?[\d.]+)V/g)].map(([, x0, x1]) => ({ x: (Number(x0) + Number(x1)) / 2, width: Number(x1) - Number(x0) })),
  }));
}

describe("B10 Grid Zoom", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B10_LOOP_SECONDS, B10_LOOP_CYCLES, B10_LOOP_SECONDS]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const start = frame(0, size, input), label = `${size.width}x${size.height} ${JSON.stringify(input)}`;
        expect(frame(period(input), size, input), label).toBe(start);
        expect(frame(2 * period(input), size, input), label).toBe(start);
        expect(frame(period(input) / 3, size, input), label).not.toBe(start);
      }
    }
  });

  it("is self-similar across the beat: the end of a 2× push looks like its start, to a fraction of a pixel", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of LOOP_VARIANTS) {
        const before = numbers(frame(period(input) - 1e-5, size, input)), start = numbers(frame(0, size, input));
        expect(before.length, JSON.stringify(input)).toBe(start.length);
        expect(maxDifference(before, start), JSON.stringify(input)).toBeLessThan(0.25);
      }
    }
    // Two beats per loop at speed 2: half a loop later the grid looks the same.
    const a = numbers(frame(0.3, PORTRAIT, { speed: 2 })), b = numbers(frame(0.3 + B10_LOOP_SECONDS / 2, PORTRAIT, { speed: 2 }));
    expect(a.length).toBe(b.length);
    expect(maxDifference(a, b)).toBeLessThan(0.05);
  });

  it("paints every pixel: an opaque, full-frame accent card under everything (ART_DIRECTION §10, base A)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.accent)).toBe(true);
    }
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } }), PORTRAIT, "#2457F5")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B10_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("nests ink lines by 2 around a crossing with an ink dot; lines grow bolder with their spacing; the newborn level fades in", () => {
    const svg = frame(0.5);
    expect(svg.endsWith(`<circle cx="540" cy="960" r="11" fill="${palette.ink}"/></svg>`)).toBe(true);
    const levels = verticalLines(svg).filter(level => level.lines.length);
    expect(levels.length).toBeGreaterThanOrEqual(3);
    // A level's spacing is its nearest line's distance from the centre crossing (finer levels draw only their odd lines).
    const spacing = (lines: Array<{ x: number }>) => Math.min(...lines.map(line => Math.abs(line.x - 540)).filter(distance => distance > 0.5));
    const ordered = levels.map(level => ({ ...level, spacing: spacing(level.lines), width: level.lines[0].width })).sort((a, b) => a.spacing - b.spacing);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index].spacing / ordered[index - 1].spacing).toBeGreaterThan(1.8);
      expect(ordered[index].width).toBeGreaterThanOrEqual(ordered[index - 1].width - 0.02);
    }
    // Full levels are ink; only the newborn (finest) level may still be fading in from the card colour.
    for (const level of ordered.slice(1)) expect(level.fill).toBe(palette.ink);
    // No line is drawn twice: a coarse line is never repeated by a finer level; a crossing sits at the centre.
    const all = levels.flatMap(level => level.lines.map(line => line.x.toFixed(1)));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("540.0");
  });

  it("pushes in by exactly 2× per beat: the reference level grows from 112 to 224 px, once per beat", () => {
    /** Spacing of the one level whose spacing lies in one factor-of-2 window, [112, 224) px less 0.05% (the reference cell is 112 px at density 1). */
    const tracked = (t: number, input?: unknown) => {
      const spacings = verticalLines(frame(t, PORTRAIT, input)).filter(level => level.lines.length > 1)
        .map(level => Math.min(...level.lines.map(line => Math.abs(line.x - 540)).filter(distance => distance > 0.5)));
      const inRange = spacings.filter(value => value >= 112 * 0.9995 && value < 224 * 0.9995);
      expect(inRange.length).toBe(1);
      return inRange[0];
    };
    for (const [speed, beats] of [[1, 1], [2, 2]] as const) {
      const samples = Array.from({ length: 10 }, (_, index) => tracked((index * B10_LOOP_SECONDS) / 10, { speed }));
      const drops = samples.filter((value, index) => samples[(index + 1) % samples.length] < value).length;
      expect(drops, `speed ${speed}`).toBe(beats);
    }
  });

  it("density sets the cell size; energy the push curve; deterministic per seed", () => {
    const lines = (input?: unknown) => verticalLines(frame(0.5, PORTRAIT, input)).reduce((sum, level) => sum + level.lines.length, 0);
    expect(lines({ density: 2 })).toBeGreaterThan(lines() * 1.5);
    expect(frame(0.75, LANDSCAPE, { seed: 7 })).toBe(frame(0.75, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 2 }]) {
      expect(frame(0.75, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(0.75, LANDSCAPE));
    }
  });
});
