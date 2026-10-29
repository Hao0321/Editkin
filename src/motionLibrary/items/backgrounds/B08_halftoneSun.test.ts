import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B08_LOOP_CYCLES, B08_LOOP_SECONDS } from "./B08_halftoneSun";

const ID = "B08";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1.1, 3.2, 5.6, 7.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "3d48c8763b0fe2f86ec82123859d1a4e3b4f4638759840d55ed54db05a9b8a0d",
    "f7f77e6d2c38b731f7ab0e92619ce4d72c9b8d35c1f5f3d54a3a58c5f26a676f",
    "b3f3408bf8535bbf271b56e71b75ae582adbc548db4b752f6967ec5bc0d36013",
    "d86596ff136344372c59a51ceedfb4819ea90301066aa213552f6e592f41bb18",
    "9a93b6e840079d1ca3448e56b3e943eb1ebda381f880982803c2ff92950f0480",
  ],
  landscape: [
    "72a7bbce5663b6e6e531db2a672add2e79c0328cdd67d23515dfa260e32e96e7",
    "eae846f12bd86dc73a3e7674b52444513edd45bd98874b1ed3f363cc8b4a5aa5",
    "369bdefe121d04df128261b918ed98cebad50e03698abac80e118534f778eafa",
    "73bcd255e9e4243f3f6917eddcacfcc225350f811178a30cccc7b9d47f0084b6",
    "4de8d41df98351f121d586e695ae8da20c83b242388b63e54de1729cca8534cf",
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
/** Dot paths: fill and the dots (centre and radius) of each. */
function dotPaths(svg: string): Array<{ fill: string; dots: Array<{ x: number; y: number; r: number }> }> {
  return [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)].map(([, d, fill]) => ({
    fill, dots: [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)a([\d.]+) /g)].map(([, x, y, r]) => ({ x: Number(x) + Number(r), y: Number(y), r: Number(r) })),
  }));
}
/** Ray phase (degrees, modulo the ray spacing) about the sun centre (cx, cy): a circular mean over every ray dot. */
function rayPhase(svg: string, cx: number, cy: number, rays: number): number {
  let x = 0, y = 0;
  for (const dot of dotPaths(svg)[0].dots) {
    const angle = Math.atan2(dot.y - cy, dot.x - cx) * rays; // × rays: one ray spacing becomes a full turn
    x += Math.cos(angle); y += Math.sin(angle);
  }
  const spacing = 360 / rays;
  return ((((Math.atan2(y, x) / rays) * 180) / Math.PI) % spacing + spacing) % spacing;
}

describe("B08 Halftone Sun", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B08_LOOP_SECONDS, B08_LOOP_CYCLES, B08_LOOP_SECONDS]);
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
        const before = numbers(frame(period(input) - 1e-4, size, input)), start = numbers(frame(0, size, input));
        expect(before.length).toBe(start.length);
        expect(maxDifference(before, start), JSON.stringify(input)).toBeLessThan(0.25);
      }
    }
  });

  it("paints every pixel: an opaque, full-frame dark card under everything (ART_DIRECTION §10, base D)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.bg)).toBe(true);
    }
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "hao_impact" } }), PORTRAIT, "#121216")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B08_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("sets a full accent sun low in the frame with rays of crisp cream dots that shrink with distance", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const svg = frame(2, size), short = Math.min(size.width, size.height);
      const sx = size.width / 2, sy = size.height * 0.74, sunR = short * 0.15;
      expect(svg.endsWith(`<circle cx="${sx}" cy="${Number(sy.toFixed(3))}" r="${Number(sunR.toFixed(3))}" fill="${palette.accent}"/></svg>`)).toBe(true);
      const [rays] = dotPaths(svg);
      expect(rays.fill).toBe(palette.paper);
      const fromSun = (dot: { x: number; y: number }) => Math.hypot(dot.x - sx, dot.y - sy);
      for (const dot of rays.dots) expect(fromSun(dot)).toBeGreaterThan(sunR * 1.3);
      const near = rays.dots.filter(dot => fromSun(dot) < sunR * 2), far = rays.dots.filter(dot => fromSun(dot) > sunR * 4);
      const mean = (dots: Array<{ r: number }>) => dots.reduce((sum, dot) => sum + dot.r, 0) / dots.length;
      expect(mean(near)).toBeGreaterThan(2 * mean(far));
      // The burst dissolves before the far edge: no ray dot farther than 1.05 short sides from the sun.
      for (const dot of rays.dots) expect(fromSun(dot)).toBeLessThan(short * 1.05);
    }
  });

  it("turns the rays one ray spacing per loop (two at speed 2); density adds rays", () => {
    // 28 rays turn one spacing (12.857°) per 8 s loop: after 1 s the pattern has turned 1.607° (3.214° at speed 2). Sun centre (540, 1420.8).
    const phase = (t: number, input?: unknown) => rayPhase(frame(t, PORTRAIT, input), 540, 1420.8, 28);
    const spacing = 360 / 28, turned = (a: number, b: number) => ((b - a) % spacing + 1.5 * spacing) % spacing - spacing / 2;
    expect(turned(phase(0), phase(1))).toBeCloseTo(360 / 28 / 8, 1);
    expect(turned(phase(0), phase(1, { speed: 2 }))).toBeCloseTo((2 * 360) / 28 / 8, 1);
    expect(turned(phase(0), phase(B08_LOOP_SECONDS - 1e-4))).toBeCloseTo(0, 1);
    const rays = (input?: unknown) => new Set(dotPaths(frame(0.5, PORTRAIT, input))[0].dots.map(dot => Math.round((Math.atan2(dot.y - 1420.8, dot.x - 540) * 180) / Math.PI))).size;
    expect(rays({ density: 2 })).toBeGreaterThan(rays());
  });

  it("is deterministic; seed, energy and speed change the frame", () => {
    expect(frame(3.2, LANDSCAPE, { seed: 7 })).toBe(frame(3.2, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 2 }]) {
      expect(frame(3.2, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(3.2, LANDSCAPE));
    }
  });
});
