import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B26_LOOP_CYCLES, B26_LOOP_SECONDS, driftOffset } from "./B26_floatingShapes";

const ID = "B26";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1, 2.6, 5.5, 7.8] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9e21c6050d90f214a14fb4bb96d6223aee69737e615e93b12560cb2a03b1e0c9",
    "6038ecc483feeedc689370101a442116765b0b58f3544173d1198253aff1cbd4",
    "628c9f3caf1d2511e430738e2fa4cdf521c4377661b3fe39dd41a63029ab7147",
    "bd2d8e6f94b6e4b65c415490b52c8c417b3c62211c75faec6233f100b708d6f0",
    "d5c67509aa64a6298eb3d767a00e913ea3cb10491ed7c0ce86926ed4cb8e4e1c",
  ],
  landscape: [
    "232ba6938afc862040a4a59a200e6ac685dea8e5297e4189a2972d56817c3590",
    "d265d677a33620107fe35629b5838a357570a244742124cf260873ebef527681",
    "0e5c3deb9cca97528740caba151c231ceac6bbadd5334da4661101c3a6e33344",
    "3062048db36f11dff8cabda52b7198f7056b483172f4e231748dfac0d4a8c639",
    "3268b83530b53b529c806acd94e6cde4894305b1a4a3a7bf1b0637c5138b76e8",
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

describe("B26 Floating Shapes", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B26_LOOP_SECONDS, B26_LOOP_CYCLES, B26_LOOP_SECONDS]);
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
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B26_LOOP_SECONDS);
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

  it("drifts every shape on a closed path with whole frequencies", () => {
    const [x0, y0] = driftOffset(0, 2, 1, 0.3), [x1, y1] = driftOffset(1, 2, 1, 0.3);
    expect(x1).toBeCloseTo(x0, 12);
    expect(y1).toBeCloseTo(y0, 12);
  });

  it("floats fat pills in cream, a light tint, the deep shade and ink, with bold cream squiggles (no thin strokes)", () => {
    const svg = frame(2.6);
    const fills = [...svg.matchAll(/<path d="M[^"]*" fill="(#[0-9A-F]{6})"\/>/g)].map(([, fill]) => fill);
    expect(fills).toEqual([palette.paper, expect.stringMatching(/^#/), palette.accent2, palette.ink]);
    const squiggle = /stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)"/.exec(svg)!;
    expect(squiggle[1]).toBe(palette.paper);
    expect(Number(squiggle[2])).toBeGreaterThanOrEqual(8);
  });
});
