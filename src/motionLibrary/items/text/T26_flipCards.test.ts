import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache, layoutLine } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { flipCardsLayout, flipPose } from "./T26_flipCards";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T26";

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: turning in (0.12), 日出 held (0.8), the second card mid-flip (1.65), 晴天 held (2.3),
 * turning away (2.85). */
const TIMES = [0.12, 0.8, 1.65, 2.3, 2.85] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "bae024226c99db7b524637f1e35e28464a0f4065f202f669fbc6a562bf56d76d",
    "8494ab6e89f8a37e8ebe6c6177603e1117e15df7ee1e17dcc713787c7da313ce",
    "c447320c8c623a7400298f87f74966e915b32f25d75ff41fbff9d8c050f9f000",
    "e3379481283a90e42173704f5262c4a41aba81db7f8dcc2f35ebbce640703927",
    "3a2d268a248ab355fced5a77ed77a9a08393df105ddf27764ca0824d478ac3f9",
  ],
  landscape: [
    "6470c5191805c43b68795cc0f305fae9b444434a52efb2fd3982c6a7f47aff55",
    "10a08302a62d939ff4d6d33bfe5e920062d74b6c7caf44768c222e547283af96",
    "4bd9d08c04eecb41a37d05e2585308f297425430fa570236cde62430b9669cd8",
    "f85f481ae01b6fc56c67a2aaf52c6d5d74af8dcc53d158187cd2de1e28f1921f",
    "b34c126e3e5890b9dca9445827ff0a1c347cdfc27f23c78dfd15b9072c3af485",
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
/** Vertical extent of a path's coordinates near its left and right ends (perspective check). */
function edgeHeights(d: string): { left: number; right: number } {
  const points = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])] as const);
  const xs = points.map(([x]) => x), x0 = Math.min(...xs), x1 = Math.max(...xs), band = (x1 - x0) * 0.04;
  const extent = (near: (x: number) => boolean) => { const ys = points.filter(([x]) => near(x)).map(([, y]) => y); return Math.max(...ys) - Math.min(...ys); };
  return { left: extent(x => x <= x0 + band), right: extent(x => x >= x1 - band) };
}

describe("T26 Flip Cards", () => {
  for (const [format, size] of Object.entries(FORMATS) as Array<[keyof typeof FORMATS, MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => sha256(frameText(t, size)))).toEqual(GOLDEN[format]);
    });
  }

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(1.6, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * 3, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(1.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(1.6, PORTRAIT)).toBe(first);
  });

  it("flips one card per character on its vertical axis, 0.3 s each, 0.1 s apart, to the next word on the back face", () => {
    const layout = flipCardsLayout(params(), LANDSCAPE);
    expect(layout.cards.map(card => card.faces)).toEqual([["日", "晴"], ["出", "天"]]);
    expect(layout.flipStarts).toHaveLength(2);
    const start = layout.flipStarts[0];
    for (const [index, card] of layout.cards.entries()) {
      const begin = start + 0.1 * index;
      expect(flipPose(layout, card.index, begin - 0.01)).toMatchObject({ word: 0, scaleX: 1 });
      const quarter = flipPose(layout, card.index, begin + 0.075)!;
      expect(quarter.word).toBe(0);
      expect(quarter.scaleX).toBeLessThan(1);
      expect(flipPose(layout, card.index, begin + 0.15)!.scaleX).toBeLessThan(0.05); // edge-on at half time
      expect(flipPose(layout, card.index, begin + 0.225)!.word).toBe(1); // the back face: the next word
      expect(flipPose(layout, card.index, begin + 0.31)).toMatchObject({ word: 1, scaleX: 1 });
    }
    // Mid-turn the card lifts and shades.
    const mid = flipPose(layout, 0, start + 0.14)!;
    expect(mid.scale).toBeGreaterThan(1.04);
    expect(mid.shade).toBeGreaterThan(0.1);
  });

  it("turns in true perspective: mid-flip, the card's near edge is taller than its far edge", () => {
    const layout = flipCardsLayout(params(), LANDSCAPE);
    const svg = frameText(layout.flipStarts[0] + 0.12, LANDSCAPE); // card 0 about 46° into its turn
    const cardPath = /<path d="([^"]+)" fill="#[0-9A-F]{6}"\/>/.exec(svg)![1];
    const { left, right } = edgeHeights(cardPath);
    expect(Math.abs(left - right) / Math.max(left, right)).toBeGreaterThan(0.03);
    expect(frameText(0.8, LANDSCAPE)).toMatch(/<path d="M[^"]+" fill="#[0-9A-F]{6}"\/>/);
  });

  it("turns in from edge-on, holds each word, turns away and ends blank", () => {
    const layout = flipCardsLayout(params(), PORTRAIT);
    expect(flipPose(layout, 0, 0)?.scaleX ?? 0).toBeLessThan(0.02);
    expect(flipPose(layout, 1, 0.05)).toBeUndefined();
    expect(flipPose(layout, 0, 0.5)).toMatchObject({ word: 0, scaleX: 1, scale: 1 });
    expect(flipPose(layout, 1, 2.98)).toBeUndefined();
    expect(frameText(2.98, PORTRAIT)).not.toContain("<path");
    // The holds are equal and at least 0.8 s.
    const enterEnd = layout.enterSeconds, firstHold = layout.flipStarts[0] - enterEnd;
    expect(firstHold).toBeGreaterThanOrEqual(0.8);
    expect(layout.flipStarts[1] - (layout.flipStarts[0] + 0.4)).toBeCloseTo(firstHold, 6);
  });

  it("cycles three or more words and centres a shorter word on blank cards", () => {
    const layout = flipCardsLayout(params({ lines: ["春天", "夏日炎炎", "秋"], durationSeconds: 4.5 }), LANDSCAPE);
    expect(layout.cards).toHaveLength(4);
    expect(layout.cards.map(card => card.faces[0])).toEqual(["", "春", "天", ""]);
    expect(layout.cards.map(card => card.faces[2])).toEqual(["", "秋", "", ""]);
    expect(layout.flipStarts).toHaveLength(3);
  });

  it("keeps the cards inside the 5% title-safe box at their lift, glyphs at least 9% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      for (const input of [undefined, { lines: ["日出時分", "晴天霹靂"] }, { lines: ["光"] }]) {
        const safe = titleSafeBox(size), layout = flipCardsLayout(params(input), size);
        const cx = (layout.box.x0 + layout.box.x1) / 2, cy = (layout.box.y0 + layout.box.y1) / 2, lift = 1.06;
        expect(cx - (cx - layout.box.x0) * lift).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
        expect(cx + (layout.box.x1 - cx) * lift).toBeLessThanOrEqual(safe.x1 + 1e-6);
        expect(cy - (cy - layout.box.y0) * lift).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
        expect(cy + (layout.box.y1 - cy) * lift).toBeLessThanOrEqual(safe.y1 + 1e-6);
        const ink = layoutLine("日", { font: "display", weight: 900, size: layout.fontSize }).inkBox!;
        expect(ink.y1 - ink.y0).toBeGreaterThanOrEqual(0.09 * Math.min(size.width, size.height));
      }
    }
  });

  it("colours: accent cards with ink then accent2 words on the dark card; the reference's dark cards on the accent plate", () => {
    const palette = item.defaultParams.palette;
    const first = frameText(0.8, PORTRAIT), second = frameText(2.3, PORTRAIT);
    expect(first).toContain(`fill="${palette.accent}"`);
    expect(first).toContain(`fill="${palette.ink}"`);
    expect(second).toContain(`fill="${palette.accent2}"`);
    const onAccent = frameText(0.8, PORTRAIT, { plate: "accent" }).replace(plateRect(PORTRAIT, palette.accent), "");
    expect(onAccent).toContain(`fill="${palette.bg}"`);
    expect(onAccent).toContain(`fill="${palette.paper}"`);
    expect(frameText(2.3, PORTRAIT, { plate: "accent" })).toContain(`fill="${palette.accent}"`); // second word in the accent on dark cards
  });

  it("plates: transparent by default; a plate paints first and changes nothing else (ART_DIRECTION §9)", () => {
    expect(item.defaultParams.plate).toBe("none");
    expect(item.showcasePlate).toBe("accent"); // the CATALOG's dark cards on an accent background
    const palette = item.defaultParams.palette;
    for (const t of TIMES) {
      const none = frameText(t, PORTRAIT);
      expect(none).not.toContain(plateRect(PORTRAIT, palette.bg));
      const onBg = frameText(t, PORTRAIT, { plate: "bg" });
      expect(onBg.replace(plateRect(PORTRAIT, palette.bg), "")).toBe(none);
      const onAccent = frameText(t, PORTRAIT, { plate: "accent" });
      expect(onAccent.indexOf(plateRect(PORTRAIT, palette.accent))).toBe(onAccent.indexOf(">") + 1);
      expect(maskColors(onAccent.replace(plateRect(PORTRAIT, palette.accent), ""))).toBe(maskColors(none));
    }
  });
});
