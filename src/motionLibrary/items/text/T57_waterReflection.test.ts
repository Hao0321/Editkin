import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import {
  T57_DEPTH, T57_LOOP_SECONDS, T57_SLICE, T57_SWAY, T57_TOP_OPACITY, reflectionLayout, reflectionSway,
} from "./T57_waterReflection";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T57";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.9, 1.5, 2.0] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "aceab6ff75f26f6315f958aa89aa24d9ce4775c2e1a78cc35eed3ed077fe51ba",
    "f52af9c8b5a9f7b5eba9a80c09975ab9633474d3cc4cdba21f0ba9b9a102eef4",
    "24959b37892b9093609bd77c389ec6f8a1459f8bdad65220d77071c818085fb3",
    "bf7c5b0a056d519d218e8ca41257bb161abfaff31c5658d0b1ada743be039736",
    "af2819502cb73aeb9dd84738f227270dc800e4b9ff89c3de8e483e4299b29ca0",
  ],
  landscape: [
    "ceb1a76ecc1095b6a361fc5073026d8253332832173c8db05ab65ead3ac634dc",
    "3a1ad5fed25ae86104937ee7cfedca957fd7e265a48d2692b217e960d4437845",
    "733aec933927e4712bce1763ed8ddb60aa1720103e053d00ec29940554fcb757",
    "e0a4ac62af324855febd670fba0bc788ccd8506caac96b0178a84d808e8e6078",
    "94ab2f01f8e45ec943b9a7ccf6785c3e6306521c44edbdb62db1633e6caf594e",
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

describe("T57 Water Reflection", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(T57_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "bg" }, { lines: ["湖面", "倒影"] }]) {
        const start = frameText(0, size, input);
        expect(frameText(T57_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T57_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T57_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(72 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.3, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T57_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.9, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.9, PORTRAIT)).toBe(first);
  });

  it("slices the mirrored word into pixel-aligned horizontal bands (3% of the glyph height) fading from 70% to 0 at 0.9 h", () => {
    const layout = reflectionLayout(params(), PORTRAIT);
    const slice = Math.max(2, Math.round(T57_SLICE * layout.glyphHeight));
    expect(layout.bands.length).toBeGreaterThan(20);
    layout.bands.forEach((band, index) => {
      expect(Number.isInteger(band.y0) && Number.isInteger(band.y1)).toBe(true);
      expect(band.y1 - band.y0).toBe(slice);
      if (index > 0) expect(band.y0).toBe(layout.bands[index - 1].y1);
      expect(band.opacity).toBeLessThanOrEqual(T57_TOP_OPACITY);
    });
    expect(layout.bands[0].y0).toBe(layout.waterline);
    expect(layout.bands[0].opacity).toBeGreaterThan(0.65);
    expect(layout.bands[layout.bands.length - 1].y1).toBeLessThanOrEqual(layout.waterline + T57_DEPTH * layout.glyphHeight + slice);
    for (let index = 1; index < layout.bands.length; index += 1) expect(layout.bands[index].opacity).toBeLessThan(layout.bands[index - 1].opacity);
    // Ripple sway: 2.5% of the glyph height at full depth, a travelling sine (two waves per loop), smaller near the line.
    const deep = Math.max(...Array.from({ length: 200 }, (_, index) => Math.abs(reflectionSway(layout, T57_DEPTH * layout.glyphHeight, index / 200))));
    expect(deep).toBeCloseTo(T57_SWAY * layout.glyphHeight, 1);
    const near = Math.max(...Array.from({ length: 200 }, (_, index) => Math.abs(reflectionSway(layout, 0, index / 200))));
    expect(near).toBeLessThan(deep * 0.5);
    // Slices only: no turbulence or displacement filters (librsvg's slow path).
    const svg = frameText(0.9, PORTRAIT);
    expect(svg).not.toMatch(/feTurbulence|feDisplacementMap|<filter/);
    expect(svg.match(/fill-opacity=/g)?.length).toBe(layout.bands.length);
  });

  it("draws the waterline (1.5 px at 1080 units, 50%) and opens a ripple ring every 0.8 s that fades within 0.7 s", () => {
    const palette = item.defaultParams.palette;
    const svg = frameText(0.3, PORTRAIT);
    expect(svg).toMatch(new RegExp(`<line x1="54" y1="\\d+" x2="1026" y2="\\d+" stroke="${palette.paper}" stroke-width="1.5" opacity="0.5"/>`));
    expect(svg.match(/<ellipse /g)).toHaveLength(1);
    expect(frameText(0.75, PORTRAIT).match(/<ellipse /g)).toBeNull();
    expect(frameText(0.85, PORTRAIT).match(/<ellipse /g)).toHaveLength(1);
    // Word on the readable light tone, reflection in the second tone (violet on the dark card).
    expect(svg).toContain(`<g fill="${palette.accent}">`);
    expect(svg).toContain(`fill="${palette.paper}" transform=`);
  });

  it("keeps the word and its reflection inside the 5% title-safe box; the word is ≥ 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["湖面", "倒影"] }, { energy: "hype" }]) {
        const layout = reflectionLayout(params(input), size), safe = titleSafeBox(size);
        expect(layout.box.x0 - layout.sway).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1 + layout.sway).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.waterline + T57_DEPTH * layout.glyphHeight).toBeLessThanOrEqual(safe.y1 + 1e-6);
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
