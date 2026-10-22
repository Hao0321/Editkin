import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { maskPatternPlan, stripeOffset, T35_ANGLE, T35_LOOP_SECONDS, T35_PERIOD } from "./T35_textMaskPattern";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T35";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.3, 0.75, 1.2, 1.7] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "70966315420c1a412dc8b3eadbbb3baa12009041fc100f940aaa281f2eecc238",
    "26ee158f81ac520e4781c0beb8de4645d7219a2130ad00796c16d4f2c9a321a7",
    "ac6ea498be20067902102a0e4d9c311bcb38c3be861937f39b54f12fa6d6d851",
    "1df8c5d1e26ee3ccfa1295cb009e55c4fadd40a647933e822c38d5c65a162e63",
    "163d3c3a3714d783628a67ebbf5d0d094f7fc3f665737b4f40e4b70f99a85469",
  ],
  landscape: [
    "552d8903479896b398361e8ac840a684ae07656410830fdc61584f697309b935",
    "245d221481301e51d9b5d7f581f8a85b9d8e76b21f1a708f3c34722318a1019e",
    "bf18630fc0ff4220e968ba1589cedd7816786256703056ae803f7903192a4f44",
    "35f3b69fe525e11d6da0f54b71e6b3f138fbf7377d7602cc1101c392baea97c1",
    "3ff299acf5726b886730535d3373673ec65c3379c86ca02212836c9bbd574017",
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

describe("T35 Text Mask Pattern", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("loops seamlessly: the stripes travel whole periods per loop, so the frame at loopSeconds equals frame 0", () => {
    expect(item.loopSeconds).toBe(T35_LOOP_SECONDS);
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { energy: "calm" }, { plate: "paper" }]) {
        const start = frameText(0, size, input);
        expect(frameText(T35_LOOP_SECONDS, size, input), JSON.stringify(input)).toBe(start);
        expect(frameText(2 * T35_LOOP_SECONDS, size, input)).toBe(start);
        expect(frameText(T35_LOOP_SECONDS * 0.37, size, input)).not.toBe(start);
      }
    }
    expect(frameText(60 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
    const plan = maskPatternPlan(params(), PORTRAIT);
    expect(plan.periodsPerLoop).toBe(1);
    expect(stripeOffset(plan, 0)).toBe(0);
    expect(stripeOffset(plan, 0.5)).toBeCloseTo(plan.period / 2, 9);
    expect(maskPatternPlan(params({ energy: "hype" }), PORTRAIT).periodsPerLoop).toBe(2);
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * T35_LOOP_SECONDS, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.75, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.75, PORTRAIT)).toBe(first);
  });

  it("the word is a clip window onto 45° candy stripes of 20% of the glyph height; nothing is drawn outside the glyphs", () => {
    expect([T35_PERIOD, T35_ANGLE]).toEqual([0.2, -45]);
    const plan = maskPatternPlan(params(), PORTRAIT);
    expect(plan.period).toBeCloseTo(0.2 * plan.glyphHeight, 9);
    const svg = frameText(0.75, PORTRAIT);
    expect(svg).toMatch(/<defs><clipPath id="m[a-z]*\d+" clipPathUnits="userSpaceOnUse"><path d="M[^"]+"\/><\/clipPath><\/defs>/);
    // One clipped group holds everything: the stripe ground and the stripe path.
    expect(svg).toMatch(/^<svg [^>]+><defs>.*<\/defs><g clip-path="url\(#[^)]+\)"><rect [^>]+\/><path [^>]+rotate\(-45\)"\/><\/g><\/svg>$/);
  });

  it("stripes use the item's two tones: cream and orange on dark, ink and orange on cream, ink and cream on the accent card", () => {
    const palette = item.defaultParams.palette;
    const pair = (input?: unknown) => { const plan = maskPatternPlan(params(input), PORTRAIT); return [plan.stripeA, plan.stripeB]; };
    expect(pair()).toEqual([palette.paper, palette.accent]);
    expect(pair({ plate: "paper" })).toEqual([palette.ink, palette.accent]);
    expect(pair({ plate: "accent" })).toEqual([palette.ink, palette.paper]);
  });

  it("the word fills 80–90% of the title-safe width and stays inside it, at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["祭"] }, { lines: ["夏日", "祭典"] }]) {
        const plan = maskPatternPlan(params(input), size), safe = titleSafeBox(size);
        expect(plan.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        if (input === undefined && size !== LANDSCAPE) {
          const fill = (plan.box.x1 - plan.box.x0) / safe.width;
          expect(fill).toBeGreaterThanOrEqual(0.8);
          expect(fill).toBeLessThanOrEqual(0.9);
        }
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
    expect(item.showcasePlate).toBe("paper"); // stripes on cream outside the type, as in the reference
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(onAccent.startsWith(header(size))).toBe(true);
        expect(onAccent.indexOf(plateRect(size, palette.accent))).toBe(onAccent.indexOf("</defs>") + 7);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
