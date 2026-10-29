import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B04_LOOP_CYCLES, B04_LOOP_SECONDS, sweepBandStrength } from "./B04_halftoneSweep";

const ID = "B04";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.6, 1.4, 2.5, 3.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "e89bbd076c8403ba810d1c90142c25f93422ac443a26e6dc9174e4dd778c0672",
    "8ef218df62b3be02ca20f60f0f95cce10d749ea5911ce4dd311afcdc7dcc2a49",
    "bf3760561fc838e51204c15059517c0ca5c7c691eef1010ec8e686733c500256",
    "9ad1ae6eaaf9a5ce2b2efbdba1edd78640ca82bed12127ced9f52a0a5c1c92ab",
    "5003aec6370cdffb26331f05f985e5831a7aed41223461c035d8ee4e332a659e",
  ],
  landscape: [
    "3080c6a4c4e5f632334a913704ed196e1bec1f0ffaff7fe6adfaef23e152bfee",
    "dc59392bab11f07ebbc55b46ff312a2afdffcceff74dc52424d5f0182c956035",
    "b43ef98958be4bf66378c8ee1324394df5ebf6e0a7b7d823cd276b0e7db7dd92",
    "0b41bd8afa0b1e12dd1baaa56b756931378a7cfe7b93534978850bd2855e2775",
    "761cd206fd9567fd2558a35cef6a46b257f7e76d005714ba3c07ab8769bbb3d6",
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

describe("B04 Halftone Sweep", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B04_LOOP_SECONDS, B04_LOOP_CYCLES, B04_LOOP_SECONDS]);
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
    expect(paintsEveryPixel(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } }), PORTRAIT, "#F4F4F0")).toBe(true);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B04_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("shapes the band like a roller: a short steep leading edge and a long trailing edge, exactly 0 beyond both", () => {
    expect(sweepBandStrength(0, 100, 400)).toBe(1);
    expect(sweepBandStrength(100, 100, 400)).toBe(0);
    expect(sweepBandStrength(-400, 100, 400)).toBe(0);
    expect(sweepBandStrength(1e6, 100, 400)).toBe(0);
    expect(sweepBandStrength(50, 100, 400)).toBeCloseTo(sweepBandStrength(-200, 100, 400), 12);
    for (let d = -400; d < 0; d += 20) expect(sweepBandStrength(d + 20, 100, 400)).toBeGreaterThan(sweepBandStrength(d, 100, 400));
  });

  it("sweeps a band of large accent dots over a square screen of fine cream dots, each dot one colour or the other", () => {
    let banded = 0;
    for (let step = 0; step < 16; step += 1) {
      const paths = dotPaths(frame((step / 16) * B04_LOOP_SECONDS));
      const field = paths.find(entry => entry.fill === palette.paper)?.dots ?? [];
      const accent = paths.find(entry => entry.fill === palette.accent)?.dots ?? [];
      expect(paths.every(entry => entry.fill === palette.paper || entry.fill === palette.accent)).toBe(true);
      // Pitch 34 px: the field stays at or below the switch size, the band starts above it (no in-between colours).
      for (const dot of field) expect(dot.r).toBeLessThan((0.11 + 0.34 * 0.3) * 34 + 0.06);
      for (const dot of accent) expect(dot.r).toBeGreaterThan((0.11 + 0.34 * 0.3) * 34 - 0.06);
      if (accent.length) banded += 1;
      for (const dot of [...field, ...accent]) expect(Math.abs((((dot.x - 540) / 34) % 1 + 1.5) % 1 - 0.5) * 34).toBeLessThan(0.11);
    }
    expect(banded).toBeGreaterThanOrEqual(10); // the band is on screen most of the time
    // The band core moves toward +x + y (the far corner) as time runs.
    const core = (t: number) => {
      const dots = dotPaths(frame(t)).find(entry => entry.fill === palette.accent)?.dots.filter(dot => dot.r > 0.4 * 34) ?? [];
      return dots.reduce((sum, dot) => sum + dot.x + dot.y, 0) / dots.length;
    };
    expect(core(1.6)).toBeGreaterThan(core(1.4));
    expect(core(1.8)).toBeGreaterThan(core(1.6));
  });

  it("is deterministic; seed, energy, speed and density change the frame", () => {
    expect(frame(1.4, LANDSCAPE, { seed: 7 })).toBe(frame(1.4, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }, { speed: 2 }, { density: 2 }]) {
      expect(frame(1.4, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.4, LANDSCAPE));
    }
  });
});
