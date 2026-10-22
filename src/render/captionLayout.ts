import type { CaptionStyle } from "../domain/types";
import { breakCaptionLines, libassWrapText } from "../typography/captionLineBreak";
import { bundledFontAssLineMetrics } from "../typography/fontEmMetrics";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { assGlyphText } from "./assText";

/**
 * How an exported caption looks, written once for the ASS writer, the HTML preview and the native GPU
 * preview. libass (the vendored FFmpeg) is the reference renderer:
 * - the ASS Fontsize is the face's OS/2 win ascent + descent, so the CSS em is smaller than the size
 *   (Noto Sans TC 95 → 65.6 px em, about 62 px CJK ink); lines stack by the face's hhea ascent + descent;
 * - MarginL/MarginR are 40 px; a bottom caption's last line box ends MarginV above the frame bottom;
 * - an outline is the glyph dilated by Outline px; the drop shadow is that dilated shape (the glyph alone
 *   without an outline) offset by Shadow px in BackColour;
 * - `\blur b` is a Gaussian of σ = b·2/√ln 256 on the outline and the shadow only; the fill stays sharp;
 * - a visible background colour draws BorderStyle 3 instead: one opaque box per line, padded by
 *   max(8, outline), with the shadow box offset by Shadow px in the same colour.
 */

/** Measured with the vendored FFmpeg/libass on a straight edge: \blur 1/2/3/4/6 → σ 0.84/1.66/2.58/3.40/5.10 px. */
export const LIBASS_BLUR_SIGMA_PER_UNIT = 2 / Math.sqrt(Math.log(256));
/** MarginL and MarginR of the exported caption Style. */
export const CAPTION_SIDE_MARGIN = 40;
/** The strongest `\blur` the ASS writer emits for a caption edge. */
export const CAPTION_MAX_EDGE_BLUR = 32;

/** The caption's lines exactly as the export breaks them: balanced whole-word lines when the style sets
 * maxLineEm (explicit newlines kept); otherwise the text as typed, and libass wraps an over-wide line. */
export function captionLineText(text: string, style: Pick<CaptionStyle, "maxLineEm">): string {
  return style.maxLineEm ? breakCaptionLines(text, style.maxLineEm) : text;
}

/** What the export draws: its line breaks plus the ASS writer's full-width stand-ins for the ASCII comma,
 * braces and backslash. */
export function captionDisplayText(text: string, style: Pick<CaptionStyle, "maxLineEm">): string {
  return assGlyphText(captionLineText(text, style));
}

/** The lines both previews draw for one caption line source: the export's text and glyphs, then wrapped where
 * libass wraps a line wider than the space between the 40 px side margins. */
function captionWrappedText(displayText: string, face: CaptionFaceLayout, letterSpacing: number, canvasWidth: number): string {
  return libassWrapText(displayText, (canvasWidth - 2 * CAPTION_SIDE_MARGIN) / face.emSize, letterSpacing / face.emSize);
}

export function captionPreviewText(text: string, style: CaptionStyle, canvasWidth: number): string {
  return captionWrappedText(captionDisplayText(text, style), captionFaceLayout(style.fontFamily, style.bold, style.fontSize), style.letterSpacing, canvasWidth);
}

/** The translation line the export appends after the caption (\N), as the previews draw it. */
export function captionPreviewTranslationText(text: string, style: CaptionStyle, canvasWidth: number): string {
  return captionWrappedText(assGlyphText(text), captionFaceLayout(style.translationFontFamily, style.translationBold, Math.round(style.translationFontSize)),
    style.letterSpacing, canvasWidth);
}

/** A visible background colour turns the caption into libass BorderStyle 3 (opaque box per line). */
export function captionBoxVisible(style: Pick<CaptionStyle, "backgroundColor">): boolean {
  const background = style.backgroundColor;
  return /^#[0-9a-f]{6}$/i.test(background) || (/^#[0-9a-f]{8}$/i.test(background) && background.slice(7, 9).toUpperCase() !== "00");
}

/** ASS BackColour. A box shadows in the box colour; without a box an authored shadowColor wins and an omitted
 * one keeps the legacy backgroundColor (transparent for the long-form default, which therefore has no shadow). */
export function captionShadowColor(style: Pick<CaptionStyle, "backgroundColor" | "shadowColor">): string {
  return captionBoxVisible(style) ? style.backgroundColor : style.shadowColor ?? style.backgroundColor;
}

/** The caption `\blur` strength: softness for the outline and shadow only, so it needs an outline and no box. */
export function captionEdgeBlur(style: Pick<CaptionStyle, "backgroundColor" | "outlineWidth" | "shadowBlur">): number {
  return !captionBoxVisible(style) && style.outlineWidth > 0 && Number.isFinite(style.shadowBlur) && style.shadowBlur! > 0
    ? Math.min(CAPTION_MAX_EDGE_BLUR, style.shadowBlur!) : 0;
}

/** BorderStyle 3 box padding: the ASS Outline value the writer uses for a boxed caption. */
export function captionBoxPadding(style: Pick<CaptionStyle, "outlineWidth">): number {
  return Math.max(8, style.outlineWidth);
}

/** "#RRGGBB" / "#RRGGBBAA" split into an opaque colour and its alpha (0–1); anything else stays as-is and opaque. */
export function captionColorParts(color: string): { rgb: string; alpha: number } {
  if (/^#[0-9a-f]{8}$/i.test(color)) return { rgb: color.slice(0, 7), alpha: Number.parseInt(color.slice(7, 9), 16) / 255 };
  return { rgb: color, alpha: 1 };
}

export interface CaptionFaceLayout {
  /** The face to draw with: the bundled physical face when there is one. */
  family: string;
  weight: number;
  requestedWeight: number;
  weightSubstituted: boolean;
  /** CSS font-size, in canvas pixels, that renders like libass at the ASS Fontsize. */
  emSize: number;
  /** libass's line pitch and baseline offset from the line top at that size, in canvas pixels. */
  lineHeight: number;
  ascent: number;
  /** "libass": verified bundled metrics; "unverified": a family without metrics, drawn at the typed size. */
  metrics: "libass" | "unverified";
}

export function captionFaceLayout(family: string, bold: boolean, assFontSize: number): CaptionFaceLayout {
  const requestedWeight = bold ? 800 : 400;
  const face = resolveBundledFontFace(family, requestedWeight);
  const metrics = face ? bundledFontAssLineMetrics(family, requestedWeight, assFontSize) : undefined;
  if (!face || !metrics) {
    // No verified metrics for this family: keep the typed size rather than guess the face's proportions.
    return { family, weight: requestedWeight, requestedWeight, weightSubstituted: false, emSize: assFontSize,
      lineHeight: assFontSize * 1.18, ascent: assFontSize, metrics: "unverified" };
  }
  return { family: face.fontFamily, weight: face.fontWeight, requestedWeight, weightSubstituted: face.weightSubstituted,
    emSize: metrics.emSize, lineHeight: metrics.lineHeight, ascent: metrics.ascent, metrics: "libass" };
}

export interface CaptionRenderModel {
  primary: CaptionFaceLayout;
  translation: CaptionFaceLayout;
  alignment: CaptionStyle["alignment"];
  marginV: number;
  sideMargin: number;
  letterSpacing: number;
  /** BorderStyle 3: an opaque box per line in this colour, padded on every side. */
  box?: { color: string; padding: number };
  /** BorderStyle 1 glyph border width. It also widens the shadow shape when its own colour is transparent. */
  borderWidth: number;
  outlineColor: string;
  /** Drop shadow (of the box, the bordered glyph, or the bare glyph) offset right and down by `offset` px. */
  shadow?: { color: string; offset: number };
  /** Gaussian σ (px) libass applies to the outline and the shadow; 0 = hard edges. */
  edgeBlurSigma: number;
}

export function captionRenderModel(style: CaptionStyle): CaptionRenderModel {
  const boxed = captionBoxVisible(style);
  const shadowColor = captionShadowColor(style);
  return {
    primary: captionFaceLayout(style.fontFamily, style.bold, style.fontSize),
    // The writer emits the translation size rounded (\fs).
    translation: captionFaceLayout(style.translationFontFamily, style.translationBold, Math.round(style.translationFontSize)),
    alignment: style.alignment,
    marginV: style.marginV,
    sideMargin: CAPTION_SIDE_MARGIN,
    letterSpacing: style.letterSpacing,
    box: boxed ? { color: style.backgroundColor, padding: captionBoxPadding(style) } : undefined,
    borderWidth: boxed ? 0 : Math.max(0, style.outlineWidth),
    outlineColor: style.outlineColor,
    shadow: style.shadow > 0 && captionColorParts(shadowColor).alpha > 0 ? { color: shadowColor, offset: style.shadow } : undefined,
    edgeBlurSigma: captionEdgeBlur(style) * LIBASS_BLUR_SIGMA_PER_UNIT,
  };
}
