import { DEFAULT_CAPTION_STYLE, type CaptionStyle, type EditorialProfileId } from "../domain/types";

/**
 * Hao's white-first Shorts captions (roadmap 1.7): on a 9:16 canvas the caption is white with a
 * soft shadow, its CJK characters about 62 px tall on 1080×1920 (the 60–68 px rule is the visible
 * character height, not the ASS size), and sits high enough that its baseline stays at or above
 * y 1640, clear of the platform's bottom UI; a second line grows upward. No box, no capsule, no
 * colour fill. Gaming keeps the white fill with a green edge (Game HUD accent). Travel/food use the
 * handbook Kai face. Lines hold at most 11 CJK characters (centred ink stays inside the house safe column x 150–930, VA R12),
 * break between words and never leave a
 * one-character line. Horizontal (long-video) canvases never receive this style.
 */
export const SHORTS_CAPTION_REFERENCE = Object.freeze({
  width: 1080,
  height: 1920,
  /** Target rendered CJK glyph height (white fill ink, px). */
  glyphHeight: 62,
  /** ASS Fontsize that renders glyphHeight with the bundled face (libass sizes a face so win
   * ascent + descent equals Fontsize). Measured 2026-10-10 with the vendored FFmpeg/libass on
   * 「樹上停滿獨角仙」: Noto Sans TC 800 at 95 → 62 px (94 → 61, 96 → 63); LXGW WenKai TC 700 at
   * 86 → 62 px (85 → 61, 87 → 63). */
  assFontSize: Object.freeze({ "Noto Sans TC": 95, "LXGW WenKai TC": 86 } as const),
  marginV: 300,
  /** Widest line in em (one em ≈ one CJK character ≈ 65.6 px at the reference size). Centred captions must keep their
   * ink inside VA R12's x ≤ 930 (the right-hand platform buttons), so 2 × (930 − 540) = 780 px → 11 em (≈ 722 px). */
  maxLineEm: 11,
  /** Lowest allowed caption baseline on the 1080×1920 reference canvas. */
  baselineLimitY: 1640,
});

export const SHORTS_CAPTION_PRESET_IDS = Object.freeze({
  clean: "hao_shorts_white",
  handbook: "hao_shorts_white_kai",
  gaming: "hao_shorts_white_green_edge",
});

/** Game HUD default accent (referenceMotionTemplates game_hud_v1), Hao palette v2 mint/acid green. */
export const SHORTS_GAMING_EDGE_COLOR = "#3FC9B0";

/** Bundled faces that carry no CJK glyphs; Chinese captions in them fall back to tofu or a random face. */
export const LATIN_ONLY_CAPTION_FONTS: ReadonlySet<string> = new Set(["Fredoka", "Bebas Neue"]);

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

export interface CaptionCanvas {
  width: number;
  height: number;
}

export function isVerticalCanvas(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > width;
}

type ShortsCaptionVariant = keyof typeof SHORTS_CAPTION_PRESET_IDS;

function shortsCaptionVariant(profile: EditorialProfileId | undefined): ShortsCaptionVariant {
  if (profile === "gaming") return "gaming";
  // trip_pop_v1 (旅遊手帳) is the theme for travel and food; its headline face is LXGW WenKai TC.
  if (profile === "travel" || profile === "food") return "handbook";
  return "clean";
}

/** Shorts caption style for a vertical canvas, scaled from the 1080×1920 reference. */
export function shortsCaptionStyle(canvas: CaptionCanvas, profile?: EditorialProfileId): CaptionStyle {
  if (!isVerticalCanvas(canvas.width, canvas.height)) throw new Error("Shorts 字幕樣式只用於直式畫布");
  const scale = Math.min(canvas.width / SHORTS_CAPTION_REFERENCE.width, canvas.height / SHORTS_CAPTION_REFERENCE.height);
  const px = (value: number, minimum: number) => Math.max(minimum, Math.round(value * scale));
  const variant = shortsCaptionVariant(profile);
  const gaming = variant === "gaming";
  const fontFamily = variant === "handbook" ? "LXGW WenKai TC" : "Noto Sans TC";
  return {
    ...DEFAULT_CAPTION_STYLE,
    presetId: SHORTS_CAPTION_PRESET_IDS[variant],
    fontFamily,
    fontSize: px(SHORTS_CAPTION_REFERENCE.assFontSize[fontFamily], 12),
    color: "#FFFFFF",
    // A thin translucent rim (or the gaming green edge) keeps the fill crisp; the blur softens only edge and shadow.
    outlineColor: gaming ? SHORTS_GAMING_EDGE_COLOR : "#00000073",
    outlineWidth: px(gaming ? 6 : 3, 1),
    alignment: 2,
    marginV: Math.round(SHORTS_CAPTION_REFERENCE.marginV * canvas.height / SHORTS_CAPTION_REFERENCE.height),
    bold: true,
    italic: false,
    shadow: px(4, 1),
    shadowColor: "#00000099",
    shadowBlur: px(gaming ? 1 : 4, 1),
    maxLineEm: SHORTS_CAPTION_REFERENCE.maxLineEm,
    backgroundColor: "#00000000",
    letterSpacing: 0,
    translationFontFamily: "Noto Sans TC",
    translationFontSize: px(58, 8),
    translationColor: "#FFFFFF",
    translationBold: true,
    translationItalic: false,
  };
}

const CAPTION_STYLE_KEYS = [
  "presetId", "fontFamily", "fontSize", "color", "outlineColor", "outlineWidth", "alignment", "marginV", "bold", "italic",
  "shadow", "shadowColor", "shadowBlur", "maxLineEm", "backgroundColor", "letterSpacing", "translationFontFamily", "translationFontSize",
  "translationColor", "translationBold", "translationItalic",
] as const satisfies readonly (keyof CaptionStyle)[];

export function sameCaptionStyle(left: CaptionStyle, right: CaptionStyle): boolean {
  return CAPTION_STYLE_KEYS.every((key) => left[key] === right[key]);
}

/** A full replacement patch: optional fields absent from `style` are cleared instead of surviving the merge. */
export function captionStyleReplacement(style: CaptionStyle): CaptionStyle {
  return { shadowColor: undefined, shadowBlur: undefined, maxLineEm: undefined, ...style };
}

/** The style a canvas starts with: Shorts white on vertical canvases, the legacy default elsewhere. */
export function defaultCaptionStyleForCanvas(canvas: CaptionCanvas, profile?: EditorialProfileId): CaptionStyle {
  return isVerticalCanvas(canvas.width, canvas.height) ? shortsCaptionStyle(canvas, profile) : captionStyleReplacement(DEFAULT_CAPTION_STYLE);
}

/** True only for a generated default nobody has edited: the legacy project default or a Shorts default for `canvas`. */
export function isGeneratedDefaultCaptionStyle(style: CaptionStyle, canvas: CaptionCanvas): boolean {
  if (sameCaptionStyle(style, DEFAULT_CAPTION_STYLE)) return true;
  if (!isVerticalCanvas(canvas.width, canvas.height)) return false;
  return (["auto", "travel", "gaming"] as const).some((profile) => sameCaptionStyle(style, shortsCaptionStyle(canvas, profile)));
}

/**
 * When the canvas changes orientation class, an untouched generated default follows it. Anything the
 * creator chose or edited is preserved (undefined = no change).
 */
export function captionStylePatchForCanvasChange(
  style: CaptionStyle,
  from: CaptionCanvas,
  to: CaptionCanvas,
  profile?: EditorialProfileId,
): CaptionStyle | undefined {
  if (!isGeneratedDefaultCaptionStyle(style, from)) return undefined;
  const next = defaultCaptionStyleForCanvas(to, profile);
  return sameCaptionStyle(style, next) ? undefined : next;
}

/** Swaps a Latin-only face for Noto Sans TC whenever the captions are (or may be) Chinese/Japanese/Korean. */
export function cjkSafeCaptionStyle(style: CaptionStyle, texts: readonly string[]): CaptionStyle {
  const spoken = texts.filter((text) => text.trim());
  const cjk = !spoken.length || spoken.some((text) => CJK.test(text));
  if (!cjk || !LATIN_ONLY_CAPTION_FONTS.has(style.fontFamily)) return style;
  return { ...style, fontFamily: "Noto Sans TC" };
}
