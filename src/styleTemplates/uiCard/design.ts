/**
 * S1 v2 "UI card" design tokens (Claude's binding style frames, 2026-10-22: tmp-ek/claude/sf/style_frames.py).
 * Units are px of the 1080 × 1920 design frame; other frames scale by width / 1080 (16:9 adapts the grid later).
 * Glyph positions are ink centres measured from the style frames (PIL draws from the ascender; we place ink).
 */

export const UI_CARD_DESIGN_ID = "editkin.ui-card/s1v2" as const;

export const S1V2 = Object.freeze({
  frame: { width: 1080, height: 1920 },
  backdrop: {
    base: [14, 17, 23] as const,
    /** Warm key light top-left and cool fill bottom-right: Gaussian lobes added to the base (sRGB 0–255). */
    warm: { cx: 180, cy: 260, sx: 700, sy: 760, rgb: [46, 34, 18] as const },
    cool: { cx: 980, cy: 1650, sx: 820, sy: 900, rgb: [10, 22, 40] as const },
    /** Multiply by clip(1 - strength·((dx/(rx·W))² + (dy/(ry·H))²), floor, 1). */
    vignette: { strength: 0.38, rx: 0.72, ry: 0.62, floor: 0.55 },
    /** Fine monochrome grain, σ in 0–255 units. */
    grain: 3.2,
  },
  card: {
    x: 45, width: 990,
    square: { y: 236, height: 950 },
    /** The band the card (and a prompt bubble) live in. */
    band: { y0: 236, y1: 1186 },
    wideWithBubbleY: 640,
    radius: 28, wideRadius: 26,
    /** Two layered shadows: wide ambient + tight contact (blur = σ px, dy px, alpha 0–255). */
    shadows: [{ blur: 60, dy: 34, alpha: 150 }, { blur: 14, dy: 8, alpha: 120 }],
    rim: { width: 2, alpha: 34 },
  },
  chip: { y: 118, height: 76, radius: 38, padX: 30, gap: 18, size: 34, numberWeight: 900, labelWeight: 600,
    fillAlpha: 18, strokeAlpha: 40, strokeWidth: 2, label: "#EBECF0" },
  lower: {
    zone: { y0: 1260, y1: 1500 },
    /** Ink centres. */
    leadCenterY: 1307.5, keywordCenterY: 1463.5, subtitleCenterY: 1342,
    lead: { size: 58, weight: 600, tracking: 0.04, color: "#ECEEF2" },
    keyword: { size: 168, weight: 900, tracking: -0.03 },
    subtitle: { size: 54, weight: 600, tracking: 0.02, color: "#FAFAFA" },
    shadow: { blur: 10, dy: 6, alpha: 150 },
    maxWidth: 990,
    /** Step chips (the VO enumerates): a row in the lower third. */
    steps: { height: 92, radius: 46, size: 44, numberSize: 40, padX: 30, gap: 22, centerY: 1380 },
  },
  tag: { size: 64, weight: 900, height: 96, radius: 48, padX: 32, shadow: { blur: 12, dy: 10, alpha: 130 },
    /** Pinned to the card's top-left edge: offset of the pill's top-left from the card's top-left. */
    dx: 25, dy: -52,
    /** The style frame's text sits below the pill's centre (cap height on a CJK em box). */
    textDy: 12 },
  bubble: { x: 70, y: 330, width: 940, radius: 40, padX: 44, padTop: 34, padBottom: 30, lineHeight: 66, size: 46, weight: 600,
    fill: "#F4F4F6", text: "#1E1E22",
    label: { size: 32, weight: 600, color: "#AAB0BC", dx: 8, gap: 10 },
    shadows: [{ blur: 40, dy: 22, alpha: 120 }, { blur: 10, dy: 6, alpha: 90 }] },
  cursor: { height: 78, ripple: [{ r: 70, alpha: 60 }, { r: 46, alpha: 110 }], rippleWidth: 6, shadow: { blur: 5, dx: 4, dy: 6, alpha: 140 } },
  callout: { radius: 24, scale: 1.4, shadows: [{ blur: 46, dy: 30, alpha: 190 }, { blur: 12, dy: 8, alpha: 140 }], rim: { width: 2, alpha: 52 } },
  motion: {
    /** Card entry: slide up + fade (s, px). */
    enter: 0.45, enterDy: 40,
    /** Outgoing card on a swap: fade + slight settle. */
    exit: 0.3, exitScale: 0.97,
    punch: { scale: 1.15, attack: 0.35, hold: 0.85, release: 0.6 },
    stagger: 0.075,
    subtitleIn: 0.22, subtitleOut: 0.14, subtitleRise: 14,
    keywordPop: 0.42, keywordOvershoot: 1.06,
  },
});

export type S1V2Design = typeof S1V2;

/** Scale factor from the design frame to an output frame (portrait: by width). */
export function designScale(width: number, height: number): number {
  return height >= width ? width / S1V2.frame.width : height / S1V2.frame.height;
}

export const alpha255 = (value: number) => Math.round((value / 255) * 1000) / 1000;
