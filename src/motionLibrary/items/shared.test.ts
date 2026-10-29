import { describe, expect, it } from "vitest";
import { MOTION_PALETTES } from "../palettes";
import { contrastRatio } from "../svg/color";
import { MOTION_REFERENCE_PALETTE_THEMES } from "../types";
import {
  backdropTone, displayTracking, heroTextBox, layoutFittedText, readableColor, secondaryTone, textFace, textOnBackground, travelFrame,
} from "./shared";

const PORTRAIT = { width: 1080, height: 1920 }, LANDSCAPE = { width: 1920, height: 1080 };

describe("displayTracking (ART_DIRECTION §0)", () => {
  it("is −0.04 em for 3+ visible characters and −0.02 for 1–2", () => {
    expect(displayTracking(["滿"])).toBe(-0.02);
    expect(displayTracking(["爆發"])).toBe(-0.02);
    expect(displayTracking(["A B"])).toBe(-0.02);
    expect(displayTracking(["爆發", "完成了"])).toBe(-0.04);
    expect(displayTracking(["炸裂四散"])).toBe(-0.04);
  });
});

describe("heroTextBox (ART_DIRECTION §0)", () => {
  const widthShare = (lines: string[], size: typeof PORTRAIT, headroom = 1) => {
    const fitted = layoutFittedText(lines, textFace("display", 900), { ...heroTextBox(size, { headroom }), lineHeight: 1.04, tracking: displayTracking(lines) });
    return { width: (fitted.ink.x1 - fitted.ink.x0) / (0.9 * size.width), height: (fitted.ink.y1 - fitted.ink.y0) / (0.9 * size.height) };
  };
  it("fills 80–90% of the title-safe width in portrait and landscape", () => {
    for (const lines of [["爆發"], ["正面反面"], ["炸裂四散"], ["衝過夜晚", "就是現在"]]) {
      const portrait = widthShare(lines, PORTRAIT);
      expect(portrait.width, lines.join("/")).toBeGreaterThanOrEqual(0.8);
      expect(portrait.width, lines.join("/")).toBeLessThanOrEqual(0.9);
    }
    for (const lines of [["正面反面"], ["炸裂四散"]]) {
      const landscape = widthShare(lines, LANDSCAPE);
      expect(landscape.width, lines.join("/")).toBeGreaterThanOrEqual(0.8);
      expect(landscape.width, lines.join("/")).toBeLessThanOrEqual(0.9);
    }
  });
  it("caps the height so a short word cannot fill a landscape frame top to bottom", () => {
    const short = widthShare(["爆發"], LANDSCAPE);
    expect(short.height).toBeLessThanOrEqual(0.62 + 1e-9);
    expect(short.height).toBeGreaterThan(0.5);
  });
  it("leaves room for a peak scale and validates its options", () => {
    const box = heroTextBox(PORTRAIT), roomy = heroTextBox(PORTRAIT, { headroom: 1.25 });
    expect(box.maxWidth).toBeCloseTo(0.86 * 972, 9);
    expect(roomy.maxWidth * 1.25).toBeLessThanOrEqual(0.98 * 972 + 1e-9);
    expect(heroTextBox(PORTRAIT, { headroom: 1.1 }).maxWidth).toBeCloseTo(0.86 * 972, 9); // 0.86 × 1.1 < 0.98: no shrink needed
    expect(heroTextBox(PORTRAIT, { fill: 0.8, heightFill: 0.4 })).toMatchObject({ maxWidth: 0.8 * 972, maxHeight: 0.4 * 1728 });
    expect(() => heroTextBox(PORTRAIT, { fill: 0 })).toThrow(/fill/);
    expect(() => heroTextBox(PORTRAIT, { headroom: 0.9 })).toThrow(/headroom/);
  });
});

describe("colour rules (ART_DIRECTION §0)", () => {
  it("readableColor picks the first candidate at 3:1, else the most contrasting", () => {
    expect(readableColor("#15191F", ["#FF5252", "#F5F1E6"])).toBe("#FF5252");
    expect(readableColor("#F5F1E6", ["#FF5252", "#7A1E1E"])).toBe("#7A1E1E"); // red on cream is 2.8:1
    expect(readableColor("#F5F1E6", ["#C7FF3E", "#F0F0F0"])).toBe("#C7FF3E"); // nothing reads: the most contrasting
    expect(readableColor("#F5F1E6", ["#FF5252"], 2)).toBe("#FF5252");
    expect(() => readableColor("#000000", [])).toThrow();
  });
  it("classifies backdrops as the accent card, a dark card or a light card", () => {
    const palette = MOTION_PALETTES.ref_lime;
    expect(backdropTone(palette, palette.accent)).toBe("accent");
    expect(backdropTone(palette, palette.bg)).toBe("dark");
    expect(backdropTone(palette, palette.accent2)).toBe("dark");
    expect(backdropTone(palette, palette.paper)).toBe("light");
  });
  it("pairs paper + accent on dark, ink + accent2 on accent, ink + accent2 (or a 3:1 accent) on cream, for every reference theme", () => {
    for (const theme of MOTION_REFERENCE_PALETTE_THEMES) {
      const palette = MOTION_PALETTES[theme];
      expect([textOnBackground(palette, palette.bg), secondaryTone(palette, palette.bg)], theme).toEqual([palette.paper, palette.accent]);
      expect([textOnBackground(palette, palette.accent), secondaryTone(palette, palette.accent)], theme).toEqual([palette.ink, palette.accent2]);
      expect(textOnBackground(palette, palette.paper), theme).toBe(palette.ink);
      const onCream = secondaryTone(palette, palette.paper);
      expect(onCream, theme).toBe(contrastRatio(palette.accent, palette.paper) >= 3 ? palette.accent : palette.accent2);
      // The second tone reads on every card (never paper on accent, never two different hues).
      for (const backdrop of [palette.bg, palette.accent, palette.paper]) {
        expect(contrastRatio(secondaryTone(palette, backdrop), backdrop), `${theme} on ${backdrop}`).toBeGreaterThanOrEqual(3);
      }
    }
    // The examples from the references: lime on dark, deep teal on teal, olive on cream.
    expect(secondaryTone(MOTION_PALETTES.ref_lime, "#15191F")).toBe("#C7FF3E");
    expect(secondaryTone(MOTION_PALETTES.ref_teal, "#2DDAC4")).toBe("#016B63");
    expect(secondaryTone(MOTION_PALETTES.ref_lime, "#F5F1E6")).toBe("#435A08");
  });
  it("falls back to the text colour when no second tone reads (Hao's themes stay usable)", () => {
    const hud = MOTION_PALETTES.esports_hud; // accent2 is a second hue that does not read on the accent
    expect(secondaryTone(hud, hud.accent)).toBe(textOnBackground(hud, hud.accent));
    expect(secondaryTone(MOTION_PALETTES.swiss_blue, MOTION_PALETTES.swiss_blue.bg)).toBe(MOTION_PALETTES.swiss_blue.accent);
  });
});

describe("travelFrame", () => {
  it("maps (u along the wipe, v across) to frame px for all four directions", () => {
    const size = { width: 1920, height: 1080 };
    const cases = { left_to_right: [1920, 1080, [100, 20]], right_to_left: [1920, 1080, [1820, 20]], top_to_bottom: [1080, 1920, [20, 100]],
      bottom_to_top: [1080, 1920, [20, 980]] } as const;
    for (const [direction, [length, cross, point]] of Object.entries(cases)) {
      const frame = travelFrame(direction as keyof typeof cases, size);
      expect([frame.length, frame.cross, frame.toFrame(100, 20)], direction).toEqual([length, cross, point]);
      expect(frame.toFrame(0, 0), direction).toEqual(direction === "right_to_left" ? [1920, 0] : direction === "bottom_to_top" ? [0, 1080] : [0, 0]);
    }
    expect(() => travelFrame("diagonal" as never, size)).toThrow(/direction/);
  });
});
