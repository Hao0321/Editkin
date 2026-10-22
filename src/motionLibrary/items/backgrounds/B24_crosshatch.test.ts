import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B24_LOOP_CYCLES, B24_LOOP_SECONDS, slideOffset } from "./B24_crosshatch";

const ID = "B24";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.5, 1.3, 2.75, 3.9] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "6819e32f20ebfee962ee89e7cace6f28f9003b5c0fd80553eb85c58517a878a5",
    "723b572d568d300d354ab5e472ec0aa89186f90c0b112131a056386f9b55cac5",
    "73b8951f77f531e505493adec0ff5e44f7314e54794cec2b4c6a8ffe2b2e4303",
    "fbc994363e2598e8f343d39ae6b6a18ddbea7e2c5e057aea0760253e875d49d7",
    "f4ea13d32e2d3111c71fb3f759e1ff92198967324fb575555b712cce10b7484f",
  ],
  landscape: [
    "6b542151ea18a01d2dfe837922e04c57015d148f8cc6632803c88e3b38c21c78",
    "5ad592fe41c597dc0fd21535b320d46a38cec5a2b1ac95dfd8d1b9d9f553e076",
    "0aad7289961026dddef2a933d12e230085a8b2f98b0455d765c53e8330b1f5b1",
    "2751891614b18097b3dfca1b0a7d7b3ce2700556909b22ecb8d0faaef33f9dc4",
    "c882fbd1266282297457463759a01bd465f18c33a378800f227a257d371092bc",
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

describe("B24 Crosshatch", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B24_LOOP_SECONDS, B24_LOOP_CYCLES, B24_LOOP_SECONDS]);
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

  it("paints every pixel: an opaque, full-frame dark card (ART_DIRECTION §10, base D) under everything", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) expect(paintsEveryPixel(frame(t, size), size, palette.bg)).toBe(true);
    }
    expect(frame(1, PORTRAIT, { palette: { theme: "swiss_blue" } })).not.toBe(frame(1));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B24_LOOP_SECONDS);
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

  it("slides the cream layer one pitch per cycle", () => {
    expect(slideOffset(0, 40)).toBe(0);
    expect(slideOffset(0.25, 40)).toBe(10);
    expect(slideOffset(1.25, 40)).toBe(10);
  });

  it("crosses an accent hatch with a turned cream hatch; only the cream layer moves", () => {
    const layers = (svg: string) => [...svg.matchAll(/<path d="([^"]*)" fill="none" stroke="(#[0-9A-F]{6})"/g)].map(([, d, stroke]) => ({ d, stroke }));
    const [cream, accent] = layers(frame(1.3)), [creamLater, accentLater] = layers(frame(2.2));
    expect([cream.stroke, accent.stroke]).toEqual([palette.paper, palette.accent]);
    expect(accentLater.d).toBe(accent.d);
    expect(creamLater.d).not.toBe(cream.d);
    expect((accent.d.match(/M/g) ?? []).length).toBeGreaterThan(40);
    // No hairlines (H.264-safe): every line is at least 3 px wide at 1080, at every energy.
    for (const energy of ["calm", "standard", "hype"]) {
      for (const [, width] of frame(1.3, PORTRAIT, { energy }).matchAll(/stroke-width="([\d.]+)"/g)) expect(Number(width), energy).toBeGreaterThanOrEqual(3);
    }
  });
});
