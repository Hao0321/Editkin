import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { columnRepeatStarts, columnUnit, columnUnitText, verticalTypographyPlan, visibleIntervals } from "./T10_verticalTypography";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T10";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. */
const TIMES = [0, 0.7, 1.5, 2.6, 3.55] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "3f4fff5b002ce919f9a249fe73cb58ca9e9b4aa63c6c602d974408c6a2c91243",
    "a3cbf1a062efc287b21e5832768910b8d1c0ef82307c24a28615f46e8825a75b",
    "bc95f3abbd1bbdfa9dcddb4860d67bca9a7cb5a7f562c80ccb88e546811067c9",
    "1fb4e2b73cb54911996e262b721be0b0f4dcc26812f67707b5a89055430a0acf",
    "949f49d602b8e904ef40a7c38e9458cb35f306f3cc816b03ea2bda275f463254",
  ],
  landscape: [
    "c61b7745bfafe02833e8269516559433e8f8e889a864a60274cc72e21a53c1ea",
    "179ae4ccf0fc435e9ceda963759fb1b8b164258f6eb0117a81a57c19b50a6573",
    "c9e8db73c86d63440631ec225bebcbe588749ddf72d4244b2a7ca0d8d5130c82",
    "daf62f009c537fd421442c203d5d1a6724ad80ea1a49e38cc6687ba74784856e",
    "605940afa825875eba27d60aa5b17509b2df123506f33f936c3af5c903e4072b",
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
const body = (svg: string) => svg.replace(/^<svg[^>]*>(?:<defs>.*?<\/defs>)?/, "");
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

/** The rectangles of the column clip path (frame px). */
function clipRects(svg: string): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  const d = /<clipPath[^>]*><path d="([^"]+)"/.exec(svg)?.[1] ?? "";
  return [...d.matchAll(/M([\d.-]+) ([\d.-]+)H([\d.-]+)V([\d.-]+)H[\d.-]+Z/g)]
    .map(match => ({ x0: Number(match[1]), y0: Number(match[2]), x1: Number(match[3]), y1: Number(match[4]) }));
}

describe("T10 Vertical Typography", () => {
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
        expect(frameText(LOOP * 0.37, size, input)).not.toBe(start); // asymmetric probe: at hype every column has an even repeat count
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
    const first = frameText(0.7, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.7, PORTRAIT)).toBe(first);
  });

  it("anchors stay inside the 5% title-safe box at every drift phase, at least 10% of the short side per character", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const input of [undefined, { energy: "hype" }, { lines: ["靜"] }, { lines: ["夜晚的城市", "疾走"] }]) {
        const plan = verticalTypographyPlan(params(input), size), safe = titleSafeBox(size);
        expect(plan.anchorSize).toBeGreaterThanOrEqual(0.1 * Math.min(size.width, size.height) - 1e-6);
        for (const anchor of plan.anchors) {
          const reach = Math.abs(anchor.drift);
          expect(anchor.box.x0, JSON.stringify(input)).toBeGreaterThanOrEqual(safe.x0 - 1e-6);
          expect(anchor.box.x1).toBeLessThanOrEqual(safe.x1 + 1e-6);
          expect(anchor.box.y0 - reach).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
          expect(anchor.box.y1 + reach).toBeLessThanOrEqual(safe.y1 + 1e-6);
        }
      }
    }
  });

  it("reads right to left: line 1 anchors upper right, line 2 lower left; they drift in opposite directions", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const [first, second] = verticalTypographyPlan(params(), size).anchors;
      expect(first.x).toBeGreaterThan(second.x);
      expect(first.box.y0).toBeLessThan(second.box.y0);
      expect(Math.sign(first.drift)).toBe(-Math.sign(second.drift));
    }
  });

  it("columns alternate up and down at whole repeats per loop, with different speeds", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = verticalTypographyPlan(params(), size);
      expect(plan.columns.length).toBeGreaterThanOrEqual(3);
      plan.columns.forEach((column, index) => {
        expect(Number.isInteger(column.repeatsPerLoop) && column.repeatsPerLoop !== 0).toBe(true);
        expect(Math.sign(column.repeatsPerLoop)).toBe(index % 2 === 0 ? 1 : -1);
      });
      expect(new Set(plan.columns.map(column => Math.abs(column.repeatsPerLoop))).size).toBeGreaterThan(1);
    }
    const calm = verticalTypographyPlan(params({ energy: "calm" }), PORTRAIT).columns.map(column => Math.abs(column.repeatsPerLoop));
    const hype = verticalTypographyPlan(params({ energy: "hype" }), PORTRAIT).columns.map(column => Math.abs(column.repeatsPerLoop));
    expect(Math.max(...hype)).toBeGreaterThan(Math.max(...calm));
  });

  it("never runs a column through an anchor: the clip leaves each anchor's zone clear, never slicing a column lengthwise", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const plan = verticalTypographyPlan(params(), size);
      const columnWidth = 2 * (Math.max(-plan.unit.ink.x0, plan.unit.ink.x1) + 1);
      for (const t of [0, 0.55, 1.3, 2.05, 3.1]) {
        const sway = Math.sin((2 * Math.PI * t) / LOOP);
        const rects = clipRects(frameText(t, size));
        expect(rects.length).toBeGreaterThan(0); // a column between both anchors may be cleared entirely (no slivers)
        for (const rect of rects) expect(rect.x1 - rect.x0).toBeCloseTo(columnWidth, 1);
        for (const anchor of plan.anchors) {
          const offset = anchor.drift * sway;
          for (const rect of rects) {
            const overlaps = rect.x0 < anchor.box.x1 && rect.x1 > anchor.box.x0 && rect.y0 < anchor.box.y1 + offset && rect.y1 > anchor.box.y0 + offset;
            expect(overlaps, `t=${t}`).toBe(false);
          }
        }
      }
    }
  });

  it("colours follow ART_DIRECTION §0: ink anchors with deep-shade columns on the accent card, cream and accent over footage", () => {
    const palette = item.defaultParams.palette;
    const accent = verticalTypographyPlan(params({ plate: "accent" }), PORTRAIT);
    expect([accent.anchorColor, accent.columnColor]).toEqual([palette.ink, palette.accent2]);
    const footage = verticalTypographyPlan(params(), PORTRAIT);
    expect([footage.anchorColor, footage.columnColor]).toEqual([palette.paper, palette.accent]);
    expect(item.defaultParams.font).toBe("serif");
  });

  it("column helpers: repeats join with ・, whole-repeat travel gives the same column, intervals skip covered spans", () => {
    expect(columnUnitText("靜寂")).toBe("靜寂・");
    expect(columnUnitText("靜寂・")).toBe("靜寂・");
    const unit = columnUnit("靜寂・", { font: "serif", weight: 500 }, 60, 0.08);
    expect(unit.period).toBeCloseTo(3 * unit.size + 3 * 0.08 * unit.size, 6); // three one-em cells plus three tracking gaps
    expect(columnRepeatStarts(unit, 0, 0.25, 0, 1920)).toEqual(columnRepeatStarts(unit, 0, 5.25, 0, 1920));
    expect(visibleIntervals(0, 100, [{ y0: 10, y1: 20 }, { y0: 15, y1: 30 }, { y0: 50, y1: 60 }])).toEqual([[0, 10], [30, 50], [60, 100]]);
    expect(visibleIntervals(0, 100, [{ y0: -5, y1: 120 }])).toEqual([]);
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
    expect(item.showcasePlate).toBe("accent");
    const palette = item.defaultParams.palette;
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const t of TIMES) {
        const none = frameText(t, size);
        expect(body(none).startsWith(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(body(onBg).startsWith(plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onAccent = frameText(t, size, { plate: "accent" });
        expect(body(onAccent).startsWith(plateRect(size, palette.accent))).toBe(true);
        expect(maskColors(onAccent.replace(plateRect(size, palette.accent), ""))).toBe(maskColors(none));
      }
    }
  });
});
