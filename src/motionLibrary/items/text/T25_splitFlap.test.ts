import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache, layoutLine } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { flapState, splitFlapLayout, splitFlapOpenAmount, splitFlapRows } from "./T25_splitFlap";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T25";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: unfolding and riffling (0.1), riffling (0.45), settling left to right (0.7), the
 * hold (1.5), folding shut (2.3). */
const TIMES = [0.1, 0.45, 0.7, 1.5, 2.3] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "70593d31e2e1e519a1b43ef968a35df2797d71f19907df943f62bd51e7bbf790",
    "22aeae9499bc6154b69ad0d46f4cefc655cafca8333334824710cb6008b4ddbf",
    "7e630e81d28ec3f301d1d0b9be5917a1f866479132a37091a06838f42fd34331",
    "322fb76ea2486e541b9e71b592de7bda45eb93d50f357844a9eacbdd1bf67d35",
    "917df90659b5c3ea9524063dfce6fa5d11cf211474dd1d7b232e61bd8d03b02d",
  ],
  landscape: [
    "c3a112281d78552ccf98047f854a8f1295b432c799ac3301760b2bd889ff1e89",
    "ddd766d11af69effc677b49988351d47806ab855855f2f075d963426e978be99",
    "cbbda3ff371d8ecea0e65cd1d5616f5f76a11c738f1255470a1ddeed9d973054",
    "cfc72fee2ba35e8875d840fc1a07a149d8139626b401f7a4dba5304e9ce47c07",
    "70d9847637077bbd02fa71a5a8f3a9c4ff24f4498b8b82806c81d364e7fb3536",
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

describe("T25 Split Flap", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.45, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 2.5, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.45, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.45, PORTRAIT)).toBe(first);
  });

  it("riffles every card through 40–60 ms flips and settles it on its character left to right, 0.08 s apart", () => {
    const layout = splitFlapLayout(params(), LANDSCAPE);
    expect(layout.cards.map(card => card.char)).toEqual(["出", "發", "時", "刻"]);
    expect(layout.cards.map(card => Number(card.settle.toFixed(6)))).toEqual([0.62, 0.7, 0.78, 0.86]);
    for (const card of layout.cards) {
      expect(card.flips.length).toBeGreaterThanOrEqual(8);
      card.flips.forEach((flip, index) => {
        expect(flip.end - flip.start).toBeGreaterThanOrEqual(0.04 - 1e-9);
        expect(flip.end - flip.start).toBeLessThanOrEqual(0.06 + 1e-9);
        if (index > 0) { expect(flip.start).toBeCloseTo(card.flips[index - 1].end, 9); expect(flip.from).toBe(card.flips[index - 1].to); }
        expect(flip.from).not.toBe(flip.to);
        if (index < card.flips.length - 1) expect(flip.to).not.toBe(card.char); // the target only shows at the landing
      });
      const last = card.flips[card.flips.length - 1];
      expect(last.end).toBeCloseTo(card.settle, 9);
      expect(last.to).toBe(card.char);
      expect(card.flips[0].start).toBeGreaterThanOrEqual(card.appear);
    }
    // Mid-flip the upper flap falls toward the seam (scaleY = cos θ); past edge-on its back shows the new lower half.
    const card = layout.cards[0], flip = card.flips[3], quarter = flip.start + (flip.end - flip.start) / 4;
    const falling = flapState(card, quarter, layout.timeScale);
    expect(falling.flap?.half).toBe("top");
    expect(falling.flap?.scale).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(falling.upper).toBe(flip.to);
    expect(falling.lower).toBe(flip.from);
    const landing = flapState(card, flip.start + (flip.end - flip.start) * 0.75, layout.timeScale);
    expect(landing.flap?.half).toBe("bottom");
    expect(landing.flap?.char).toBe(flip.to);
    // Settled: the target in both halves after the bounce.
    expect(flapState(card, card.settle + 0.2, layout.timeScale)).toEqual({ upper: "出", lower: "出", cast: 0 });
    // The landing flap bounces once.
    expect(flapState(card, card.settle + 0.05, layout.timeScale).flap?.scale).toBeLessThan(0.95);
  });

  it("unfolds the cards out of their seams, holds, folds them shut and ends blank", () => {
    const layout = splitFlapLayout(params(), PORTRAIT);
    expect(splitFlapOpenAmount(layout.cards[0], 0, layout.timeScale)).toBe(0);
    expect(splitFlapOpenAmount(layout.cards[0], 0.25, layout.timeScale)).toBe(1);
    for (const card of layout.cards) expect(splitFlapOpenAmount(card, 1.5, layout.timeScale)).toBe(1);
    expect(splitFlapOpenAmount(layout.cards[3], 2.45, layout.timeScale)).toBe(0);
    expect(frameText(0, PORTRAIT)).not.toContain("<path");
    expect(frameText(2.45, PORTRAIT)).not.toContain("<path");
    expect(frameText(1.5, PORTRAIT)).not.toContain("scale(");
  });

  it("wraps a single portrait line onto two rows when that makes the cards larger; landscape keeps one row", () => {
    const hero = { maxWidth: 1000, maxHeight: 1000 };
    expect(splitFlapRows(["出發時刻"], PORTRAIT, hero)).toEqual([["出", "發"], ["時", "刻"]]);
    expect(splitFlapRows(["出發時刻"], LANDSCAPE, hero)).toEqual([["出", "發", "時", "刻"]]);
    expect(splitFlapRows(["NEXT TRAIN"], PORTRAIT, hero)).toEqual([[..."NEXT"], [..."TRAIN"]]); // at the space nearest the middle
    expect(splitFlapRows(["出發", "時刻"], PORTRAIT, hero)).toEqual([["出", "發"], ["時", "刻"]]);
    const portrait = splitFlapLayout(params(), PORTRAIT), landscape = splitFlapLayout(params(), LANDSCAPE);
    expect(new Set(portrait.cards.map(card => card.cy)).size).toBe(2);
    expect(new Set(landscape.cards.map(card => card.cy)).size).toBe(1);
  });

  it("keeps the board inside the 5% title-safe box, with glyphs at least 9% of the short side tall", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["東京", "大阪"] }, { lines: ["NEXT TRAIN 08:45"] }]) {
        const safe = titleSafeBox(size), layout = splitFlapLayout(params(input), size);
        expect(layout.box.x0).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(layout.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(layout.box.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(layout.box.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
        if (input === undefined) {
          const ink = layoutLine("出", { font: "display", weight: 900, size: layout.fontSize }).inkBox!;
          expect(ink.y1 - ink.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
        }
      }
    }
  });

  it("draws cream cards with ink glyphs on the dark card; riffle glyphs in the deep shade; dark cards on a light plate", () => {
    const palette = item.defaultParams.palette;
    const hold = frameText(1.5, PORTRAIT);
    expect(hold).toContain(`fill="${palette.paper}"`);
    expect(hold).toContain(`fill="${palette.ink}"`);
    expect(hold).not.toContain(`fill="${palette.accent2}"`);
    expect(frameText(0.45, PORTRAIT)).toContain(`fill="${palette.accent2}"`); // riffling
    // On a cream plate the cards turn dark (bg) and the glyphs paper.
    const onPaper = frameText(1.5, PORTRAIT, { plate: "paper" }).replace(plateRect(PORTRAIT, palette.paper), "");
    expect(onPaper).toContain(`fill="${palette.bg}"`);
    expect(onPaper).toContain(`fill="${palette.paper}"`);
    expect(onPaper).not.toContain(`fill="${palette.ink}"`);
  });

  it("is seeded: another seed riffles different glyphs and lands on the same characters", () => {
    const a = splitFlapLayout(params(), LANDSCAPE), b = splitFlapLayout(params({ seed: 9 }), LANDSCAPE);
    expect(b.cards.map(card => card.flips.map(flip => flip.to).join(""))).not.toEqual(a.cards.map(card => card.flips.map(flip => flip.to).join("")));
    expect(b.cards.map(card => card.flips[card.flips.length - 1].to)).toEqual(["出", "發", "時", "刻"]);
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("bg");
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onPaper = frameText(t, PORTRAIT, { plate: "paper" });
      const first = onPaper.includes("</defs>") ? onPaper.indexOf("</defs>") + 7 : onPaper.indexOf(">") + 1;
      expect(onPaper.indexOf(plateRect(PORTRAIT, palette.paper))).toBe(first);
      expect(maskColors(onPaper.replace(plateRect(PORTRAIT, palette.paper), ""))).toBe(maskColors(none));
    }
  });
});
