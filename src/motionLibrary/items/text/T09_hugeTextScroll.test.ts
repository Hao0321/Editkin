import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateAnyMotionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { clearMotionLibraryLayoutCache } from "../../svg/glyphs";
import type { MotionFrameSize, TextMotionItem, TextMotionParams } from "../../types";
import { titleSafeBox } from "../shared";
import { compactPathD, hugeScrollRate, hugeScrollTravel, hugeTextScrollPlan, marqueeRepeatStarts, marqueeUnit, marqueeUnitText } from "./T09_hugeTextScroll";

const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const SQUARE: MotionFrameSize = { width: 1080, height: 1080 };
const FORMATS = { portrait: PORTRAIT, landscape: LANDSCAPE } as const;
const ID = "T09";
const LOOP = 4;

/** Golden SVG SHA-256 at 5 fixed times × 2 formats (default params). Regenerate only for an intentional, reviewed art change
 * and bump the item's revision. Times: slowest (0), fast with smear (0.6), slow (1.3), fast (2.25), late (3.4). */
const TIMES = [0, 0.6, 1.3, 2.25, 3.4] as const;
const GOLDEN: Record<keyof typeof FORMATS, readonly string[]> = {
  portrait: [
    "9d44d9ad322a77150cb2627615b3d707ae315da172b9bad544ae236f448be458",
    "98428d134887b79bbc772d2471ea72335521018120e128c8503020d0942b48e2",
    "8d218a8a554d5826de5705338dc7ede6ddc91f58cbee6f6c8d3cbee4e286bd2a",
    "7a96bf94e5239668fa3566ba71b0cdf30c437e526c3c9ca06750dff99a7607fa",
    "29d2877ac963896428304c44ff07e914d5d34ccda25efc1e7045cc652c325db5",
  ],
  landscape: [
    "d12ebc9d5f0505aa3472665767cbac63e496757be4e8adcee1136d4b07757038",
    "260ba817668f39d35788e6b11501818d1b782ae126bbbc51012de69f399fe270",
    "f8e48ee731df011a9900fb4f78675f46c8f2fc900ce66c6b4c156a73273d655b",
    "d85d73768780e1919823d2af0a770f8d86cd74a3fc09367b509d3f1c9a6fb62e",
    "b39eb174487db16a2da6b56946da385d7f00432efe70c4ed2648ab1a2a2e2318",
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
/** The drawn content after the root tag and any defs. */
const body = (svg: string) => svg.replace(/^<svg[^>]*>(?:<defs>.*?<\/defs>)?/, "");
const maskColors = (svg: string) => svg.replace(/#[0-9A-F]{6}/g, "#");
const colours = (svg: string) => new Set(svg.match(/#[0-9A-F]{6}/g) ?? []);
const PALETTE_A = { bg: "#101820", ink: "#0A0A0A", paper: "#FAFAF0", accent: "#E0A030", accent2: "#704010" };
const PALETTE_B = { bg: "#203040", ink: "#000814", paper: "#F0F8FF", accent: "#30C0E0", accent2: "#105070" };

describe("T09 Huge Text Scroll", () => {
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
    // The renderer samples t = i / fps: frame N = loop · fps is frame 0 again.
    expect(frameText(120 / 30, PORTRAIT)).toBe(frameText(0, PORTRAIT));
  });

  it("generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms for a loaded machine)", () => {
    frameText(0.5, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frameText((index / 30) * LOOP, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });

  it("same params and time give byte-identical SVG, with or without warm caches", () => {
    const first = frameText(0.6, PORTRAIT);
    clearMotionLibraryLayoutCache();
    expect(frameText(0.6, PORTRAIT)).toBe(first);
  });

  it("緩急: the giant line swings between 0.3× and 1.8× of its base speed, 2 s per swing, slowest at t = 0, one repeat per loop", () => {
    const plan = hugeTextScrollPlan(params(), PORTRAIT);
    expect(plan.swings).toBe(2);
    const rates = Array.from({ length: 400 }, (_, index) => hugeScrollRate(index / 400, plan.easeDepth, plan.swings));
    const slowest = Math.min(...rates), fastest = Math.max(...rates);
    expect(fastest / slowest).toBeCloseTo(1.8 / 0.3, 2);
    expect(hugeScrollRate(0, plan.easeDepth, plan.swings)).toBeCloseTo(slowest, 9);
    expect(hugeScrollTravel(0, plan.easeDepth, plan.swings)).toBe(0);
    expect(hugeScrollTravel(1, plan.easeDepth, plan.swings)).toBeCloseTo(1, 12);
    for (let index = 1; index <= 400; index += 1) {
      expect(hugeScrollTravel(index / 400, plan.easeDepth, plan.swings)).toBeGreaterThan(hugeScrollTravel((index - 1) / 400, plan.easeDepth, plan.swings));
    }
    // Energy deepens the swing, never the period.
    const hype = hugeTextScrollPlan(params({ energy: "hype" }), PORTRAIT);
    expect(hype.easeDepth).toBeGreaterThan(plan.easeDepth);
    expect(hype.easeDepth).toBeLessThan(1);
    expect(hype.swings).toBe(2);
  });

  it("smears the giant line along x only while it runs fast", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      expect(frameText(0, size)).not.toContain("feGaussianBlur");
      const fast = frameText(0.5, size); // peak speed: u = 0.125
      expect(fast).toMatch(/<feGaussianBlur in="SourceGraphic" stdDeviation="[\d.]+ 0"\/>/);
    }
  });

  it("giant type bleeds by design: about 1.2× the frame height in landscape; one character per frame width in portrait", () => {
    const landscape = hugeTextScrollPlan(params(), LANDSCAPE);
    const inkHeight = landscape.giant.ink.y1 - landscape.giant.ink.y0;
    expect(inkHeight / LANDSCAPE.height).toBeCloseTo(1.2, 2);
    expect(landscape.giantBaseline + landscape.giant.ink.y0).toBeLessThan(0);
    expect(landscape.giantBaseline + landscape.giant.ink.y1).toBeGreaterThan(LANDSCAPE.height);
    const portrait = hugeTextScrollPlan(params(), PORTRAIT);
    expect(portrait.giant.period / portrait.giant.glyphCount).toBeLessThanOrEqual(0.92 * PORTRAIT.width + 1e-6);
    expect(portrait.giant.period / portrait.giant.glyphCount).toBeGreaterThan(0.85 * PORTRAIT.width);
    // Long lines get smaller instead of faster (mean speed ≤ 1.25 frame widths per second).
    const long = hugeTextScrollPlan(params({ lines: ["一二三四五六七八九十一二三四五六七八九十"] }), LANDSCAPE);
    expect(long.giant.period / LOOP).toBeLessThanOrEqual(1.25 * LANDSCAPE.width + 1e-6);
  });

  it("keeps the ticker band inside the 5% title-safe box, its text at least 4.5% of the short side", () => {
    for (const size of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const plan = hugeTextScrollPlan(params(), size), safe = titleSafeBox(size), short = Math.min(size.width, size.height);
      expect(plan.band.y0).toBeGreaterThanOrEqual(safe.y0 - 1e-6);
      expect(plan.band.y1).toBeLessThanOrEqual(safe.y1 + 1e-6);
      expect(plan.tickerBaseline + plan.ticker.ink.y0).toBeGreaterThan(plan.band.y0);
      expect(plan.tickerBaseline + plan.ticker.ink.y1).toBeLessThan(plan.band.y1);
      expect(plan.ticker.ink.y1 - plan.ticker.ink.y0).toBeGreaterThanOrEqual(0.045 * short);
      expect(Number.isInteger(plan.tickerRepeatsPerLoop) && plan.tickerRepeatsPerLoop >= 1).toBe(true);
    }
  });

  it("line 1 is the giant marquee; lines 2–4 join into the ticker (line 1 alone feeds both)", () => {
    const plan = hugeTextScrollPlan(params(), PORTRAIT);
    expect(plan.giant.text).toBe("東京夜行・");
    expect(plan.ticker.text).toBe("TOKYO NIGHT RIDE • ");
    const single = hugeTextScrollPlan(params({ lines: ["夜行"] }), PORTRAIT);
    expect(single.giant.text).toBe("夜行・");
    expect(single.ticker.text).toBe("夜行・");
    expect(hugeTextScrollPlan(params({ lines: ["夜行", "A", "B"] }), PORTRAIT).ticker.text).toBe("A  •  B • ");
  });

  it("colours follow ART_DIRECTION §0: cream giant line with accent separators on the dark card; ink on the accent ticker band", () => {
    const palette = item.defaultParams.palette;
    const plan = hugeTextScrollPlan(params(), PORTRAIT);
    expect([plan.giantColor, plan.giantSeparatorColor, plan.band.color, plan.tickerColor]).toEqual([palette.paper, palette.accent, palette.accent, palette.ink]);
    // On a light plate the giant line turns ink and the separators the accent's deep shade when the accent reads poorly.
    const paper = hugeTextScrollPlan(params({ plate: "paper" }), PORTRAIT);
    expect(paper.giantColor).toBe(palette.ink);
    expect([palette.accent, palette.accent2]).toContain(paper.giantSeparatorColor);
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
        expect(body(none).startsWith(plateRect(size, palette.bg))).toBe(false);
        expect(frameText(t, size, { plate: "none" })).toBe(none);
        const onBg = frameText(t, size, { plate: "bg" });
        expect(body(onBg).startsWith(plateRect(size, palette.bg))).toBe(true);
        expect(onBg.replace(plateRect(size, palette.bg), "")).toBe(none);
        const onPaper = frameText(t, size, { plate: "paper" });
        expect(body(onPaper).startsWith(plateRect(size, palette.paper))).toBe(true);
        expect(maskColors(onPaper.replace(plateRect(size, palette.paper), ""))).toBe(maskColors(none));
      }
    }
  });

  it("marquee helpers: whole-repeat travel gives the same strip; units keep text and separators apart", () => {
    const face = { font: "display" as const, weight: 900 };
    expect(marqueeUnitText("東京", face)).toBe("東京・");
    expect(marqueeUnitText("東京・", face)).toBe("東京・");
    expect(marqueeUnitText("A|", { font: "latin" })).toBe("A| ");
    expect(marqueeUnitText("RIDE", { font: "latin" })).toBe("RIDE • ");
    const unit = marqueeUnit("東京・", face, 120, -0.04);
    expect(unit.glyphCount).toBe(3);
    expect(unit.separatorPathD).not.toBe("");
    expect(marqueeRepeatStarts(unit, 0, 0.25, 0, 1080)).toEqual(marqueeRepeatStarts(unit, 0, 3.25, 0, 1080));
    const starts = marqueeRepeatStarts(unit, 0, 0.25, 0, 1080);
    expect(starts[0] + unit.ink.x1).toBeGreaterThanOrEqual(0);
    expect(starts[starts.length - 1] + unit.ink.x0).toBeLessThanOrEqual(1080);
  });

  it("compactPathD writes relative path data that stays within half a unit of the source", () => {
    const d = "M10 20L30.04 20.06Q40 50 60.55 20.04C70 10 80 10 90 20Z M100 100L110 100L110 110Z";
    const compact = compactPathD(d, 1);
    expect(compact.startsWith("m10 20l20 .1q10 29.9 ")).toBe(true);
    expect(compact).toMatch(/^[mlqcz0-9 .-]+$/); // relative commands only, no leading zeros needed
    expect(compact.match(/z/g)).toHaveLength(2);
    expect(compact.length).toBeLessThan(d.length);
    // Replay the relative steps and compare every endpoint with the source.
    const tokens = compact.match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)/g)!;
    const absolute: number[] = [];
    let x = 0, y = 0, command = "", index = 0, startX = 0, startY = 0;
    const counts: Record<string, number> = { m: 2, l: 2, q: 4, c: 6 };
    while (index < tokens.length) {
      if (/[a-z]/.test(tokens[index])) { command = tokens[index++]; if (command === "z") { x = startX; y = startY; continue; } }
      const values = tokens.slice(index, index + counts[command]).map(Number);
      index += counts[command];
      x += values[values.length - 2]; y += values[values.length - 1];
      if (command === "m") { startX = x; startY = y; }
      absolute.push(x, y);
    }
    const expected = [10, 20, 30.04, 20.06, 60.55, 20.04, 90, 20, 100, 100, 110, 100, 110, 110];
    absolute.forEach((value, position) => expect(Math.abs(value - expected[position]), `${position}`).toBeLessThanOrEqual(0.05 + 1e-9));
    expect(compactPathD("")).toBe("");
  });
});
