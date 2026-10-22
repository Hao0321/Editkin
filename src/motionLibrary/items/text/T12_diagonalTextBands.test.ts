import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { contrastRatio } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { diagonalBandsPlan, T12_ANGLE } from "./T12_diagonalTextBands";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T12";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.65, 1.4, 2.3, 3.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "81ac69be304aa2c673cc69f99e04ec7d431e20ccd898a738bbcf5192f6e9f198",
    "79325bb7ade05cbbd15ff926204039d0849cb1b334a0567071020904c70c6c07",
    "0e78da53c3c8bbbdf99b68d455e3ed3887202c808c565ab5aa3c0aa30de5a249",
    "e3da02b306be49ff2e0cf47e88386929b3e5baedd18b06c64c4ad048e4a0bdd7",
    "5722ad63b163f32b538ec5a63ae27320fb12f89dbd21df625d769be01f408332",
  ],
  landscape: [
    "c0b8c230a45be0fe4414ec33b96fdeaede9bf522c9176e45a94981535e99b1c8",
    "e0465997e078c472ca7f3c03c6ed573f4e33c219a4872df7e1b1647f37aa8480",
    "771c04f635342cda2debde8396ca77db7d417e9feeb3d1af780097b96f209c2c",
    "12ac581e029d6bcc2d79611e2b145a05e5c67904f53ee8439593ffe4203254ca",
    "9f0199367154deca6796937b2f04ab0e822a143ea5311f076edcf5442aea920f",
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

describe("T12 Diagonal Text Bands", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the frame at loopSeconds equals frame 0 (every format, energy and plate)", () => {
    expect(item.loopSeconds).toBe(LOOP);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: item.showcasePlate }]) {
        const start = frameText(0, size, input);
        expect(frameText(LOOP, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * LOOP, size, input)).toBe(start);
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.65, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.65, PORTRAIT)).toBe(first);
  });

  it("four bands in portrait and three in landscape at −12°, alternating gothic and mincho, adjacent bands scrolling opposite ways", () => {
    expect(T12_ANGLE).toBe(-12);
    for (const [size, count] of [[PORTRAIT, 4], [LANDSCAPE, 3], [SQUARE, 3]] as const) {
      const plan = diagonalBandsPlan(params(), size);
      expect(plan.bands).toHaveLength(count);
      plan.bands.forEach((band, index) => {
        expect(band.face.font).toBe(index % 2 === 0 ? "display" : "serif");
        expect(band.face.weight).toBe(900);
        expect(Number.isInteger(band.repeatsPerLoop) && band.repeatsPerLoop !== 0).toBe(true);
        if (index > 0) expect(Math.sign(band.repeatsPerLoop)).toBe(-Math.sign(plan.bands[index - 1].repeatsPerLoop));
      });
      expect(frameText(1, size)).toContain("rotate(-12)");
    }
  });

  it("band centres sit in the title-safe box and the text is at least 9% of the short side (the bands bleed along their length by design)", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = diagonalBandsPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      for (const band of plan.bands) {
        expect(band.cy).toBeGreaterThanOrEqual(safe.y0);
        expect(band.cy).toBeLessThanOrEqual(safe.y1);
        expect(band.unit.ink.y1 - band.unit.ink.y0).toBeGreaterThanOrEqual(0.09 * short);
        // The text fits inside its band.
        expect(band.baseline + band.unit.ink.y0).toBeGreaterThan(-band.thickness / 2);
        expect(band.baseline + band.unit.ink.y1).toBeLessThan(band.thickness / 2);
      }
      expect(plan.halfLength).toBeGreaterThanOrEqual(Math.hypot(size.width, size.height) / 2);
    }
  });

  it("colours follow ART_DIRECTION §0: accent and cream bands with readable ink text, one accent", () => {
    const palette = item.defaultParams.palette;
    const plan = diagonalBandsPlan(params(), PORTRAIT);
    expect(plan.bands.map(band => band.color)).toEqual([palette.accent, palette.paper, palette.accent, palette.paper]);
    for (const band of plan.bands) {
      expect(band.textColor).toBe(palette.ink);
      expect(contrastRatio(band.textColor, band.color)).toBeGreaterThanOrEqual(4.5);
    }
    // Lines cycle across the bands.
    const lines = diagonalBandsPlan(params({ lines: ["黎明之前", "破曉"] }), PORTRAIT).bands.map(band => band.unit.text);
    expect(lines).toEqual(["黎明之前・", "破曉・", "黎明之前・", "破曉・"]);
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
        const onPaper = frameText(t, size, { plate: "paper" });
        expect(onPaper.startsWith(header(size) + plateRect(size, palette.paper))).toBe(true);
        expect(maskColors(onPaper.replace(plateRect(size, palette.paper), ""))).toBe(maskColors(none));
      }
    }
  });
});
