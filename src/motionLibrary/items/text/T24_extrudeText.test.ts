import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { T24_LOOP_SECONDS, T24_MAX_DEPTH, T24_MAX_OFFSETS, extrudeDirection, extrudeLayout } from "./T24_extrudeText";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T24";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.6, 1.3, 2.0, 2.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9b6c6b2699d45c7d39e00eab22cd2174fdaa3d9731f8f741bcf5f019128590c8",
    "cfa4ebc09ac5f307248e974a1077aff2c3c17f12a1634661d4a4998fabab184f",
    "bda9faf187f416a64678fa31c44b201a198e25a6b472c16f71f2cbe9a0810e74",
    "24ea61ed0cedfae583e44cac4a20f3fe65159e64b9d99f45863ae8b5b9fa0940",
    "841aa21a9a44b04c218096434abc12f6fe2976747a6e41f5a299fb0b1e28063f",
  ],
  landscape: [
    "122db7e47c0bd037a8b2812eaf6a93c28187aca04ca45749a47579127bdd4db1",
    "337ffe464b1286a34ef8480ff3a3167cecfe2bcff3f021029e757eb717f7e24f",
    "a7390c7ea1521177088d8f079dc58d9d1857adfe466247d72f9b4fdffa7e2301",
    "df01fcf5d1bc067dd917482fa033f8569bdeb8e663a9cc7ab217c530ce164892",
    "acee7ede84001b36c057c9a0c2cb520c5bd148102f39eed71d46be4e9534b6b9",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const header = (size: MotionFrameSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T24 Extrude Text (thin)", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T24_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "bg" }, { lines: ["立體", "感覺"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T24_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T24_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T24_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(90 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T24_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("stays thin (the batch ruling): at most 6 stacked offsets, total depth at most 4% of the glyph height", () => {
    expect(T24_MAX_OFFSETS).toBeLessThanOrEqual(6);
    expect(T24_MAX_DEPTH).toBeLessThanOrEqual(0.04);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["立體", "感覺"] }]) {
        const layout = extrudeLayout(params(input), size);
        expect(layout.offsets).toBeLessThanOrEqual(6);
        expect(layout.depth / layout.glyphHeight).toBeLessThanOrEqual(0.04 + 1e-12);
        // The drawn offsets: one translated group per offset, the deepest exactly `depth` away.
        for (const t of [0, 0.9, 2.1]) {
          const shifts = [...frameText(t, size, input).matchAll(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">/g)].map(match => Math.hypot(Number(match[1]), Number(match[2])));
          expect(shifts).toHaveLength(layout.offsets);
          expect(Math.max(...shifts)).toBeCloseTo(layout.depth, 1);
        }
      }
    }
    // The catalog keeps the ruling: tagged no_va_default, notes say thin only and not a VA default.
    expect(item.tags).toContain("no_va_default");
    expect(item.notes).toMatch(/ART_REJECTED/);
    expect(item.notes).toMatch(/not a VA default/);
  });

  it("sweeps the extrusion a full turn per loop over a two-tone face", () => {
    const [x0, y0] = extrudeDirection(0);
    expect(Math.atan2(y0, x0) * (180 / Math.PI)).toBeCloseTo(45, 9);
    const [x1, y1] = extrudeDirection(0.25);
    expect(Math.atan2(y1, x1) * (180 / Math.PI)).toBeCloseTo(135, 9);
    const palette = item.defaultParams.palette;
    const layout = extrudeLayout(params(), PORTRAIT);
    expect(layout.glyphs.map(glyph => glyph.face)).toEqual([palette.paper, palette.accent]);
    // The side is the deep shade, darker in shadow (down-right at t = 0) than when it faces the upper-left light (t = 1.5).
    const side = (t: number) => /<g fill="(#[0-9A-F]{6})">/.exec(frameText(t, PORTRAIT))![1];
    expect(side(0)).toBe(layout.sideShadow);
    expect(side(0)).not.toBe(side(1.5));
  });

  it("keeps face and extrusion inside the 5% title-safe box at every angle; the word is ≥ 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["立體", "感覺"] }]) {
        const layout = extrudeLayout(params(input), size), safe = titleSafeBox(size);
        expect(layout.box.x0 - layout.depth).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1 + layout.depth).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0 - layout.depth).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1 + layout.depth).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(layout.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("draws palette roles only: two unrelated palettes share no colour", () => {
    for (const t of TIMES) {
      const a = colours(frameText(t, PORTRAIT, { palette: PALETTE_A, plate: "bg" }));
      const b = colours(frameText(t, PORTRAIT, { palette: PALETTE_B, plate: "bg" }));
      expect([...a].filter(colour => b.has(colour)), `t=${t}`).toEqual([]);
    }
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.startsWith(header(size) + plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.startsWith(header(size) + plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        for (const plate of ["paper", "accent"] as const) {
          const plated = frameText(t, size, { plate });
          expect(plated.startsWith(header(size) + plateRect(size, palette[plate]))).toBe(true);
          expect(maskColors(plated.replace(plateRect(size, palette[plate]), ""))).toBe(maskColors(none));
        }
      }
    }
  });
});
