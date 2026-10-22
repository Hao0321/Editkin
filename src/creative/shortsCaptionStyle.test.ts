import { describe, expect, it } from "vitest";
import emMetrics from "../generated/fontEmMetrics.json";
import { DEFAULT_CAPTION_STYLE, type EditorialProfileId } from "../domain/types";
import { resolveBundledFontFace } from "../typography/fontFaces";
import {
  LATIN_ONLY_CAPTION_FONTS, SHORTS_CAPTION_REFERENCE, SHORTS_GAMING_EDGE_COLOR, captionStylePatchForCanvasChange, cjkSafeCaptionStyle,
  defaultCaptionStyleForCanvas, isGeneratedDefaultCaptionStyle, isVerticalCanvas, sameCaptionStyle, shortsCaptionStyle,
} from "./shortsCaptionStyle";
import { captionStyleFromPreset } from "./corePack";

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };
const PROFILES: EditorialProfileId[] = ["auto", "gaming", "food", "travel", "music_mv", "podcast_on_camera", "podcast_no_face"];

/** libass sizes a face so win ascent+descent equals Fontsize; a bottom-aligned line's baseline sits one descent above PlayResY - MarginV. */
function libassBaselineY(style: ReturnType<typeof shortsCaptionStyle>, height: number): number {
  const face = resolveBundledFontFace(style.fontFamily, style.bold ? 800 : 400)!;
  const metrics = emMetrics.faces.find((item) => item.id === face.faceId)!;
  return height - style.marginV - style.fontSize * metrics.assDescender / (metrics.assAscender + metrics.assDescender);
}

/** Em size in px: CJK ideographs fill most of the em, so this bounds the visible character height. */
function emPixels(style: ReturnType<typeof shortsCaptionStyle>): number {
  const face = resolveBundledFontFace(style.fontFamily, style.bold ? 800 : 400)!;
  const metrics = emMetrics.faces.find((item) => item.id === face.faceId)!;
  return style.fontSize * metrics.unitsPerEm / (metrics.assAscender + metrics.assDescender);
}

describe("Shorts caption style (white-first, roadmap 1.7)", () => {
  it.each(PROFILES)("%s: ~62 px CJK characters, white with a soft shadow, no box, baseline at or above y1640 on 1080×1920", (profile) => {
    const style = shortsCaptionStyle(PORTRAIT, profile);
    // fontSize is the ASS size measured to render 62 px glyphs (Noto 95, WenKai 86); the em is a little larger.
    expect(style.fontSize).toBe(SHORTS_CAPTION_REFERENCE.assFontSize[style.fontFamily as keyof typeof SHORTS_CAPTION_REFERENCE.assFontSize]);
    expect(emPixels(style)).toBeGreaterThanOrEqual(62);
    expect(emPixels(style)).toBeLessThanOrEqual(70);
    // At most 14 one-em CJK characters per line, inside 1080 minus the renderer's 40 px side margins.
    expect(style.maxLineEm).toBe(11);
    expect(style.maxLineEm! * emPixels(style)).toBeLessThanOrEqual(2 * (930 - 540)); // centred ink inside VA R12 x ≤ 930
    expect(style.color).toBe("#FFFFFF");
    expect(style.translationColor).toBe("#FFFFFF");
    expect(style.backgroundColor.slice(7, 9)).toBe("00");
    expect(style.shadow).toBeGreaterThan(0);
    expect(style.shadowColor).toMatch(/^#000000[0-9A-F]{2}$/);
    expect(style.shadowBlur).toBeGreaterThan(0);
    expect(style.outlineWidth).toBeGreaterThan(0);
    expect(style.alignment).toBe(2);
    expect(style.marginV).toBe(SHORTS_CAPTION_REFERENCE.marginV);
    expect(LATIN_ONLY_CAPTION_FONTS.has(style.fontFamily)).toBe(false);
    expect(LATIN_ONLY_CAPTION_FONTS.has(style.translationFontFamily)).toBe(false);
    expect(resolveBundledFontFace(style.fontFamily, 800)).toBeDefined();
    expect(libassBaselineY(style, 1920)).toBeLessThanOrEqual(SHORTS_CAPTION_REFERENCE.baselineLimitY);
  });

  it("uses Noto Sans TC by default, LXGW WenKai TC for the travel/food handbook theme and a green edge for gaming", () => {
    expect(shortsCaptionStyle(PORTRAIT, "auto").fontFamily).toBe("Noto Sans TC");
    expect(shortsCaptionStyle(PORTRAIT, "podcast_on_camera").fontFamily).toBe("Noto Sans TC");
    expect(shortsCaptionStyle(PORTRAIT, "travel").fontFamily).toBe("LXGW WenKai TC");
    expect(shortsCaptionStyle(PORTRAIT, "food").fontFamily).toBe("LXGW WenKai TC");
    const gaming = shortsCaptionStyle(PORTRAIT, "gaming");
    expect(gaming).toMatchObject({ fontFamily: "Noto Sans TC", color: "#FFFFFF", outlineColor: SHORTS_GAMING_EDGE_COLOR });
    expect(gaming.outlineWidth).toBeGreaterThan(shortsCaptionStyle(PORTRAIT, "auto").outlineWidth);
  });

  it("scales from the 1080×1920 reference and keeps the same relative safe area", () => {
    const small = shortsCaptionStyle({ width: 720, height: 1280 });
    expect(small.fontSize).toBe(63);
    expect(small.marginV).toBe(200);
    expect(libassBaselineY(small, 1280) / 1280).toBeLessThanOrEqual(SHORTS_CAPTION_REFERENCE.baselineLimitY / 1920);
    const large = shortsCaptionStyle({ width: 2160, height: 3840 });
    expect([large.fontSize, large.marginV]).toEqual([190, 600]);
  });

  it("is never applied to a horizontal or square canvas", () => {
    expect(isVerticalCanvas(1920, 1080)).toBe(false);
    expect(isVerticalCanvas(1080, 1080)).toBe(false);
    expect(isVerticalCanvas(1080, 1920)).toBe(true);
    expect(() => shortsCaptionStyle(LANDSCAPE)).toThrow();
    expect(sameCaptionStyle(defaultCaptionStyleForCanvas(LANDSCAPE), DEFAULT_CAPTION_STYLE)).toBe(true);
  });

  it("moves only an untouched generated default when the canvas changes orientation", () => {
    const toPortrait = captionStylePatchForCanvasChange(DEFAULT_CAPTION_STYLE, LANDSCAPE, PORTRAIT, "travel");
    expect(toPortrait).toEqual(shortsCaptionStyle(PORTRAIT, "travel"));
    expect(captionStylePatchForCanvasChange(DEFAULT_CAPTION_STYLE, LANDSCAPE, LANDSCAPE)).toBeUndefined();
    const back = captionStylePatchForCanvasChange(shortsCaptionStyle(PORTRAIT, "gaming"), PORTRAIT, LANDSCAPE);
    expect(back && sameCaptionStyle({ ...shortsCaptionStyle(PORTRAIT, "gaming"), ...back }, DEFAULT_CAPTION_STYLE)).toBe(true);
    expect(back).toHaveProperty("shadowColor", undefined);
    const edited = { ...DEFAULT_CAPTION_STYLE, fontSize: 70 };
    expect(captionStylePatchForCanvasChange(edited, LANDSCAPE, PORTRAIT)).toBeUndefined();
    expect(isGeneratedDefaultCaptionStyle({ ...shortsCaptionStyle(PORTRAIT), color: "#FFEE00" }, PORTRAIT)).toBe(false);
  });

  it("never leaves Chinese captions in a face without CJK glyphs", () => {
    const candy = captionStyleFromPreset("candy_ticket");
    expect(candy.fontFamily).toBe("Fredoka");
    expect(cjkSafeCaptionStyle(candy, ["今天吃這家拉麵"]).fontFamily).toBe("Noto Sans TC");
    expect(cjkSafeCaptionStyle(candy, []).fontFamily).toBe("Noto Sans TC");
    expect(cjkSafeCaptionStyle(candy, ["Ramen time"]).fontFamily).toBe("Fredoka");
    expect(cjkSafeCaptionStyle(candy, ["今天吃這家拉麵"]).presetId).toBe("candy_ticket");
    const noto = captionStyleFromPreset("clean_caption");
    expect(cjkSafeCaptionStyle(noto, ["中文"])).toBe(noto);
  });

  it("lets a later preset fully replace the soft-shadow fields", () => {
    const merged = { ...shortsCaptionStyle(PORTRAIT), ...captionStyleFromPreset("cobalt_system") };
    expect(merged.shadowColor).toBeUndefined();
    expect(merged.shadowBlur).toBeUndefined();
  });
});
