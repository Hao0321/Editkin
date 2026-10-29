import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem, motionBackgroundLoopSeconds } from "../../catalog";
import { generateMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import type { BackgroundMotionItem, MotionFrameSize } from "../../types";
import { B29_LOOP_CYCLES, B29_LOOP_SECONDS, leanAt } from "./B29_kaleidoscope";

const ID = "B29";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 1, 2.6, 5.5, 7.8] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "473058907ed8ee990bb14ab25e15e9116128d70abb415843407102890fe9176e",
    "1803a93434ff4040a0efbf4b98f4a19346a45bed37dd761c7788a8886956a089",
    "1e3c68c94fff70cecadc3c927e4c804d82d51402b1611c670cafff2b4b8d03ff",
    "c11af05793e8c72702cd1a345f61711f3e9cc390161d69bc6f2c16dff8b221c0",
    "8c4526b1ad4f1de79f33f4ef77470e0a7bb147a90e5275c78b3d396854b0444e",
  ],
  landscape: [
    "a393924744eb83eb00d94c79679e61fce5b661958ded9374ea15a57bac2e9422",
    "51818a553e678439fad2ca5031b09955a06b2d69f996c56f71ad51dd0a33a7ce",
    "f1ced1c034d92acda55bf73a8687ac7fb8eeee556af600c8ef2c427c62b13455",
    "8639db83e606b969c0abda53509e0d55f384bc2c97d751a1c19975c4ae615fca",
    "71df3cdcb4da039ae4098bde28412f5b149fada1f65d0290f687ccdd0ba9dd3d",
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

describe("B29 Kaleidoscope", () => {
  const palette = item.defaultParams.palette;

  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frame(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: t = period equals t = 0 at default, ×0.5 and ×2 speed and density, in both formats", () => {
    expect([item.loopSeconds, item.loopCycles, period()]).toEqual([B29_LOOP_SECONDS, B29_LOOP_CYCLES, B29_LOOP_SECONDS]);
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

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frame(0.2);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 30) * B29_LOOP_SECONDS);
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

  it("leans the triangles back and forth once per cycle", () => {
    expect(leanAt(0.25, 0, 0.05)).toBeCloseTo(0.25, 12);
    expect(leanAt(1.25, 0, 0.05)).toBeCloseTo(0.25, 12);
    expect(leanAt(0.75, 0, 0.05)).toBeCloseTo(0.15, 12);
  });

  it("mirrors eight ways, cream and accent, and neighbouring triangles never leave a hairline sliver (H.264-safe)", () => {
    for (const energy of ["standard", "hype"]) {
      for (const t of [0, 1.3, 2.6, 4.1, 6.2]) {
        const svg = frame(t, PORTRAIT, { energy });
        const tris = [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)].filter(([, , fill]) => fill !== palette.ink);
        const all = tris.flatMap(([, d]) => d.split("Z").filter(Boolean));
        expect(all.length).toBe(16);
        // Angular extent of each triangle about the centre; neighbours must be at least 0.05 rad apart (or overlap).
        const spans = all.map(tri => {
          const points = [...tri.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => Math.atan2(Number(y) - 960, Number(x) - 540));
          const [a, b] = [points[1], points[2]].sort((p, q) => p - q);
          return b - a > Math.PI ? [b, a + 2 * Math.PI] : [a, b];
        }).sort((p, q) => p[0] - q[0]);
        for (let index = 0; index < spans.length; index += 1) {
          const next = spans[(index + 1) % spans.length], gap = (next[0] + (index + 1 === spans.length ? 2 * Math.PI : 0)) - spans[index][1];
          expect(gap > -0.001 && gap < 0.05, `${energy} t=${t} gap ${gap}`).toBe(false);
        }
      }
    }
  });
});
