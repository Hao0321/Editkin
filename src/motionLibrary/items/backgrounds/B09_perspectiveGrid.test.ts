import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B09_LOOP_CYCLES, B09_LOOP_SECONDS } from "./B09_perspectiveGrid";

const ID = "B09";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.75, 1.3, 1.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "a3f3faab5cee881716682d1890c993383a82d877b831b83d63c9b05ec8c1571b",
    "f8368e21f5019d9c6636a6ee2e92625deeaa3d6bdeadb6f74d94152076746e36",
    "dcc4e1aa23d8e7556ef596e1291797cea43827cd3c94c8229c14857790612069",
    "f8368e21f5019d9c6636a6ee2e92625deeaa3d6bdeadb6f74d94152076746e36",
    "e96172c0c5af59d65636d6f13bcc7c9f006b98976e95218de6fea9c3b8d91121",
  ],
  landscape: [
    "79a1b9aac48400116339ca98b2366ed04e447950b942e90ecbc780cb43a73a0e",
    "6b6193af7fc3148cc8fbdc26a54c1480f5056e39df47b75c9e875e6353cc78c1",
    "b81fbb8a8747c55e08f4e24af44b6ab0baf54d426598fa2de747c2a04a5abcbf",
    "6b6193af7fc3148cc8fbdc26a54c1480f5056e39df47b75c9e875e6353cc78c1",
    "bf4437b5be5c6c555f10315855bc8def27e8700d975e47a9c6af608133905a0a",
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
/** The floor's two paths (the first two in the document): accent long lines (tapers) and cream cross lines (bands). */
function floor(svg: string) {
  const paths = [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)].slice(0, 2);
  const [long, cross] = paths;
  const bands = [...cross[1].matchAll(/M0 (-?[\d.]+)H[\d.]+V(-?[\d.]+)H0Z/g)].map(([, y0, y1]) => ({ y0: Number(y0), y1: Number(y1) }));
  const tapers = [...long[1].matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)Z/g)].map(match => match.slice(1).map(Number));
  return { longFill: long[2], crossFill: cross[2], longD: long[1], crossD: cross[1], bands, tapers };
}

describe("B09 Perspective Grid", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B09_LOOP_SECONDS, B09_LOOP_CYCLES, B09_LOOP_SECONDS]);
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
        expect(before.length).toBe(start.length);
        expect(maxDifference(before, start), JSON.stringify(input)).toBeLessThan(0.25);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B09_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("draws crisp accent long lines and cream cross lines in true perspective, mirrored as the ceiling, on a cream horizon line", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const svg = frame(0.4, size), cy = size.height / 2;
      const { longFill, crossFill, longD, crossD, bands, tapers } = floor(svg);
      expect([longFill, crossFill]).toEqual([palette.accent, palette.paper]);
      expect(svg).not.toMatch(/opacity|Gradient/); // full strength: no fades, no glow
      // The ceiling is the same two paths flipped about the horizon.
      expect(svg).toContain(`<g transform="matrix(1 0 0 -1 0 ${size.height})"><path d="${longD}" fill="${palette.accent}"/><path d="${crossD}" fill="${palette.paper}"/></g>`);
      expect(svg).toMatch(new RegExp(`<rect x="0" y="[\\d.]+" width="${size.width}" height="[\\d.]+" fill="${palette.paper}"/></svg>$`));
      // Cross lines get thinner and closer together toward the horizon (perspective), all below it, never closer than ~4 px.
      const sorted = [...bands].sort((a, b) => b.y0 - a.y0);
      expect(sorted.length).toBeGreaterThan(12);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index].y0).toBeGreaterThan(cy);
        expect(sorted[index].y1 - sorted[index].y0).toBeLessThanOrEqual(sorted[index - 1].y1 - sorted[index - 1].y0 + 0.02);
        expect(sorted[index - 1].y0 - sorted[index].y0).toBeGreaterThan(3.5);
      }
      // Long lines taper to the vanishing point at the frame centre (22 in portrait, 40 in landscape).
      expect(tapers.length).toBeGreaterThan(16);
      expect(tapers.length).toBeLessThan(48);
      for (const taper of tapers) expect([taper[4], taper[5]]).toEqual([size.width / 2, cy]);
    }
  });

  it("scrolls the cross lines toward the camera, one cell per cycle; speed adds whole cells, density shrinks them", () => {
    const a = floor(frame(0.2)).bands.map(band => band.y0).sort((x, y) => x - y);
    const b = floor(frame(0.21)).bands.map(band => band.y0).sort((x, y) => x - y);
    expect(a.length).toBe(b.length);
    for (let index = 0; index < a.length; index += 1) expect(b[index]).toBeGreaterThan(a[index]);
    const nearest = (t: number, input?: unknown) => Math.max(...floor(frame(t, PORTRAIT, input)).bands.map(band => band.y0));
    expect(nearest(0.1, { speed: 2 })).not.toBe(nearest(0.1));
    const nearGap = (input?: unknown) => {
      const ys = floor(frame(0.5, PORTRAIT, input)).bands.map(band => band.y0).sort((x, y) => y - x);
      return ys[0] - ys[1];
    };
    expect(nearGap({ density: 2 }) / nearGap()).toBeGreaterThan(0.4);
    expect(nearGap({ density: 2 }) / nearGap()).toBeLessThan(0.62);
  });

  it("is deterministic; seed and energy change the frame", () => {
    expect(frame(0.75, LANDSCAPE, { seed: 7 })).toBe(frame(0.75, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(0.75, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(0.75, LANDSCAPE));
    }
  });
});
