import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { mixHex } from "../../svg/color";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { ribbonPoint, textRibbonPlan } from "./T13_textRibbon";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T13";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.75, 1.6, 2.45, 3.5] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "7c64f85e4538ac045c7f8ceb5e9d88ed5b041a1d87041f83634a3fa342191608",
    "cfec6d908bb64ea37bf06351fd8a9de2b87fe347efbef3da3ec47818ee3828be",
    "1f74d2dde7a5bfe007d45f62f80b1165b7636eb571dd73c179d54119f897e986",
    "55656884c1ad68c4149003a6a93ced38c8ab12071287539fba4e8cdf05fbfa6d",
    "08c54632131797637bf30518e6e02502eeeb217ed3dbf1bfbd34d60438ed6203",
  ],
  landscape: [
    "ae61d81843187cea23a4a31803b8d13861a67c5f07c2c0e67ae207493cca7ea8",
    "8d0d796c434c755bba1a1c2e22bf446c2a9470afa707ccd9fc80aa4d665027bb",
    "51a2302c6b06ff16541fe55199b6198323adfe46e727a62556bf226094aad7b0",
    "be3370dfc7ed02faed2aefb3295350df57498c207ae7132013186dfaaf1aa0be",
    "eda906526a2abc384e1c02dfe3fa1723a85b11f70a5c06c787b4a5265af823bb",
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

describe("T13 Text Ribbon", () => {
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
    const first = frameText(0.75, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.75, PORTRAIT)).toBe(first);
  });

  it("sets the text on the wavy path: every glyph is placed and turned to the ribbon's tangent", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const svg = frameText(1.6, size);
      const angles = [...svg.matchAll(/transform="translate\([\d.-]+ [\d.-]+\) rotate\(([\d.-]+)\)"/g)].map(match => Number(match[1]));
      expect(angles.length).toBeGreaterThan(8);
      expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(25); // they follow the curve, not a straight line
    }
  });

  it("the ribbon undulates one wavelength per loop and the text flows whole repeats per loop", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = textRibbonPlan(params(), size);
      expect(Number.isInteger(plan.repeatsPerLoop) && plan.repeatsPerLoop >= 1).toBe(true);
      for (const s of [0, plan.length / 3, plan.length / 2]) {
        const [x0, y0] = ribbonPoint(plan, s, 0), [x1, y1] = ribbonPoint(plan, s, 1);
        expect(x1).toBeCloseTo(x0, 6);
        expect(y1).toBeCloseTo(y0, 6);
      }
      // The wave travels: a crest moves along the ribbon over time.
      expect(ribbonPoint(plan, plan.length / 2, 0.25)[1]).not.toBeCloseTo(ribbonPoint(plan, plan.length / 2, 0)[1], 1);
    }
  });

  it("keeps the whole swing inside the 5% title-safe box vertically (it runs edge to edge by design); text at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }]) {
        const plan = textRibbonPlan(params(input), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
        expect(0.88 * plan.fontSize).toBeGreaterThanOrEqual(0.09 * short);
        for (const u of [0, 0.2, 0.45, 0.7]) {
          for (let step = 0; step <= 200; step += 1) {
            const [x, y] = ribbonPoint(plan, (step / 200) * plan.length, u);
            if (x < 0 || x > size.width) continue;
            expect(y - plan.halfWidth, `${size.width}x${size.height} ${JSON.stringify(input)}`).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
            expect(y + plan.halfWidth).toBeLessThanOrEqual(safe.y1 + 1e-6);
          }
        }
      }
    }
  });

  it("colours follow ART_DIRECTION §0: cream text with accent separators and hems on a slightly lighter ribbon", () => {
    const palette = item.defaultParams.palette;
    const plan = textRibbonPlan(params(), PORTRAIT);
    expect([plan.textColor, plan.hemColor]).toEqual([palette.paper, palette.accent]);
    expect(plan.ribbonColor).toBe(mixHex(palette.bg, palette.paper, 0.12));
    expect(frameText(1, PORTRAIT)).toContain(`<g fill="${palette.accent}"><path`); // the ・ separators
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
