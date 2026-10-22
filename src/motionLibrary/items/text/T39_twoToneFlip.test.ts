import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { cardOpening, flipProgress, T39_BOUNDARY_DEGREES, twoToneFlipPlan } from "./T39_twoToneFlip";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T39";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: card open, flip one mid-sweep, inverted hold, flip two mid-sweep, closing. */
const TIMES = [0.15, 0.7, 1.3, 2, 2.85] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "f63164e6edd20cdefc52c1fa6efc38228b3e9b7a1f76acda81fb8d25bd58bdad",
    "e449b9efdb0b5dcbd02ad39087b917bf3b97e78f335d2e23f6dab400537dca1f",
    "8bf551314e6c1d3a17d2a0a13b7e6959ddd6127b94981c41f76077006d7668cc",
    "90ff6e9f05b8389ca0fcdcf19f6e8675bdfed56fdacd5a0bdb456158db3b727f",
    "50bba1a507f40c8ca03f8ae9e0ba30d0f2326869137b955cae765487fe95d052",
  ],
  landscape: [
    "cc2a687e9868224ea98c69573340ceb8dfb939f9f3c917854a605f158b34df83",
    "9179147e4e2fb64ce28e890bad052ec177887bf67bfe6967f15ea9ad2fcd98b6",
    "f512aca70de0ad780b1d17b69481bed883b589c08117189a613a218bcf278382",
    "c07ff99faa4e1ac83efeba04d11dec2e319dd04eb726f1f4be901c1ab26f3d2b",
    "92998c0245f4cd340b632b6cbbca067d6f2731680c508b3c4fa0e0a74795c9cd",
  ],
};

const item = getMotionLibraryItem(ID) as TextMotionItem;
const params = (input?: unknown): TextMotionParams => resolveMotionLibraryParams(item, input);
function frameText(t: number, size: MotionFrameSize, input?: unknown): string {
  const frame = generateAnyMotionFrame(item, params(input), t, size);
  return "svg" in frame ? frame.svg : frame.matte;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plateRect = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T39 Two-tone Flip", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 3, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.7, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.7, PORTRAIT)).toBe(first);
  });

  it("a slanted boundary sweeps across the card; behind it the colours invert, and the text is cut by one clipPath polygon", () => {
    expect(T39_BOUNDARY_DEGREES).toBe(62);
    const plan = twoToneFlipPlan(params(), PORTRAIT);
    expect(flipProgress(plan, 0.4)).toEqual({ first: 0, second: 0 });
    expect(flipProgress(plan, 1.2)).toEqual({ first: 1, second: 0 });
    expect(flipProgress(plan, 2.4)).toEqual({ first: 1, second: 1 });
    const palette = item.defaultParams.palette;
    const normal = frameText(0.4, PORTRAIT);
    expect(normal).toContain(`fill="${palette.bg}"`);
    expect(normal).toContain(`fill="${palette.paper}"`);
    expect(normal).not.toContain(`fill="${palette.ink}"`);
    // Mid-sweep: the normal layer, then the inverted layer clipped to one polygon (cream card, ink type), then the accent stripe.
    const sweep = frameText(0.7, PORTRAIT);
    expect(sweep).toMatch(/<clipPath [^>]+><polygon points="[^"]+"\/><\/clipPath>/);
    expect(sweep).toContain(`fill="${palette.ink}"`);
    expect(sweep).toContain(`fill="${palette.accent}"`);
    const inverted = frameText(1.3, PORTRAIT);
    expect(inverted).toContain(`fill="${palette.ink}"`);
    expect(inverted).not.toContain(`fill="${palette.accent}"`); // the stripe only rides a moving boundary
    // In / out: the card opens from its centre and closes back to it; the clip is empty at both ends.
    expect(cardOpening(plan, 0, 3)).toBe(0);
    expect(frameText(0, PORTRAIT)).not.toContain("<path");
    expect(frameText(2.9999, PORTRAIT)).not.toContain("<path");
  });

  it("the card stays inside the 5% title-safe box; the word fills 80% of the safe width and is at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { lines: ["反"] }, { lines: ["黑白", "反轉"] }]) {
        const plan = twoToneFlipPlan(params(input), size), safe = titleSafeBox(size);
        expect(plan.card.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(plan.card.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(plan.card.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(plan.card.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        expect(plan.glyphHeight).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        if (input === undefined && size === PORTRAIT) expect((plan.box.x1 - plan.box.x0) / safe.width).toBeCloseTo(0.8, 2);
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
        expect(none.includes(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        expect(frameText(t, size, { plate: "bg" }).replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
