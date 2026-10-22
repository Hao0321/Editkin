import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B39_LOOP_CYCLES, B39_LOOP_SECONDS, waveAmplitudes, waveLayout, waveY } from "./B39_minimalWave";

const ID = "B39";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.7, 1.9, 3.4, 5.6] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "d8f63e45dd2ba623a2abd4913ffa88db373f0010fe2ec02e24b0c54454bd7698",
    "817f7685cb7310bfa3db5d5c0969dd58a17a7cd5fd6669ff57234cb0c92fd16e",
    "9d0eef220ba21ce80c80595952723d0bbec9e9c5ace1bb76b7eeb938aad5988e",
    "9da3ae5370ce722511b8627fe6f8a3db24d83b6cbf947d21f83c61b6e26bc82e",
    "0cb7e757bfbc838ca84e3389d61f1a2c1bb92b1ec2ee89292a72d5acfd0028bd",
  ],
  landscape: [
    "b8f6f3cc70373766a95692f26d6c7ab8fbaedd4c8180f127d0ecdd927b8c92b4",
    "3c6f6ecdb80ac7a0f6b6c778d3b66f28fe4267da3181a016bcf6a02ca1b8dcff",
    "1ccd6fc2306da8aa8e3646bd87f875f734ec3e384760f1ecaa046a65375c98ac",
    "80b364ff593fc4fdfbb35f5c1f5d1b5721a7b5beaeee250caa4dcec458d6a7de",
    "0da4afd13f8f18c1b39eb22ad88278e9549b96f0edc43f5aa1185ffd28d9de55",
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

describe("B39 Minimal Wave", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B39_LOOP_SECONDS, B39_LOOP_CYCLES, B39_LOOP_SECONDS]);
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

  it("paints every pixel: an opaque, full-frame cream card (ART_DIRECTION §10, base C) under everything", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.paper)).toBe(true);
    }
    expect(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } })).not.toBe(frame(1));
  });

  it("is crisp and phone-safe: palette roles only, no transparency, no line thinner than 3 px at a 1080 short side", () => {
    const allowed = new Set<string>([palette.bg, palette.ink, palette.paper, palette.accent, palette.accent2]);
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const input of [undefined, { density: 2 }, { energy: "calm" }]) {
        for (let index = 0; index < 12; index += 1) {
          const svg = frame((index / 12) * B39_LOOP_SECONDS, size, input);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B39_LOOP_SECONDS);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("speed is a true rate (×2 at t/2 and ×0.5 at 2t both show ×1 at t); density changes the frame; deterministic per seed", () => {
    expect(frame(0.65, PORTRAIT, { speed: 2 })).toBe(frame(1.3));
    expect(frame(2.6, PORTRAIT, { speed: 0.5 })).toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { speed: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 2 })).not.toBe(frame(1.3));
    expect(frame(1.3, PORTRAIT, { density: 0.5 })).not.toBe(frame(1.3));
    expect(frame(1.3, LANDSCAPE, { seed: 7 })).toBe(frame(1.3, LANDSCAPE, { seed: 7 }));
    for (const input of [{ seed: 7 }, { energy: "hype" }]) {
      expect(frame(1.3, LANDSCAPE, input), JSON.stringify(input)).not.toBe(frame(1.3, LANDSCAPE));
    }
  });

  it("draws a thick accent wave over a thin ink wave, and the two never touch at any phase, energy or density", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const strokes = [...frame(1.3, size).matchAll(/<path d="[^"]+" fill="none" stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)"/g)];
      expect(strokes.map(([, colour]) => colour)).toEqual([palette.accent, palette.ink]);
      expect(Number(strokes[0][2]) / Number(strokes[1][2])).toBeGreaterThan(8);
      for (const input of [{}, { energy: "hype" }, { density: 2 }, { density: 0.5, energy: "hype" }]) {
        const params = resolveMotionLibraryParams(item, input);
        for (let index = 0; index < 16; index += 1) {
          const { wavelength, thick, thin } = waveLayout(size, params, index / 16);
          // Clearance between the two stroked curves: nearest thick-centre point to each thin-centre point, minus both half widths.
          let clearance = Infinity;
          for (let x = 0; x <= size.width; x += 6) {
            const ty = waveY(thin, wavelength, x);
            for (let dx = -240; dx <= 240; dx += 3) clearance = Math.min(clearance, Math.hypot(dx, ty - waveY(thick, wavelength, x + dx)));
          }
          expect(clearance - thick.width / 2 - thin.width / 2, `${size.width} ${JSON.stringify(input)} p ${index / 16}`).toBeGreaterThan(8);
        }
      }
    }
  });

  it("breathes in counterpoint: the thick wave swells while the thin one flattens", () => {
    const quarter = waveAmplitudes(0.25, 100), three = waveAmplitudes(0.75, 100), rest = waveAmplitudes(0, 100);
    expect(quarter.thick).toBeGreaterThan(rest.thick);
    expect(quarter.thin).toBeLessThan(rest.thin);
    expect(three.thick).toBeLessThan(rest.thick);
    expect(three.thin).toBeGreaterThan(rest.thin);
  });
});
