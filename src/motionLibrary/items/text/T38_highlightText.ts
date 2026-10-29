import { tint } from "../../svg/color";
import { g, path, rect, roundRect } from "../../svg/document";
import { clamp01, cubicIn, expoOut, quartOut } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T38 Highlight Text (マーカー), STYLE, shown on the accent plate: mincho type
 * (Noto Serif TC 900 by default; the catalog sets the serif face) in a cream box,
 * and a highlighter stroke that swipes left to right behind each line in 0.4 s
 * (quartOut), with rounded ends, covering the lower half of the glyphs.
 *
 * The band is a tint of the accent (the accent mixed 30% toward cream: exactly a
 * translucent marker over the cream box, drawn opaque so it stays crisp). The box
 * is the text's own backdrop, so the item reads over any footage, and the type is
 * ink on it. Program (standard-energy seconds, compressed for short clips): the
 * box unfolds from its middle line 0–0.28 s (expoOut) with the text in it, the
 * marker swipes 0.38–0.78 s (lines 0.12 s apart), everything holds, and the box
 * folds back to its middle line over the last 0.3 s (cubicIn).
 *
 * Size: the text takes 84% of the title-safe width (heroTextBox) and the box
 * adds padding while staying inside the 5% title-safe box.
 */

const ID = "T38";
const REVISION = 1;
const OPEN = 0.28, SWIPE_AT = 0.38, SWIPE = 0.4, LINE_STAGGER = 0.12, CLOSE = 0.3, MIN_HOLD = 0.8;
const NATURAL_SECONDS = SWIPE_AT + SWIPE + MIN_HOLD + CLOSE;
/** Marker: tint toward cream, band from 48% of the glyph height down to 8% below the ink, overhang (× glyph height). */
export const T38_TINT = 0.3;
const BAND_TOP = 0.48, BAND_BOTTOM = 0.08, OVERHANG = 0.14;
/** Box padding (× glyph height) and corner radius (× box height). */
const PAD_X = 0.34, PAD_Y = 0.3, CORNER = 0.035;
const LINE_HEIGHT = 1.18;

export interface HighlightLine {
  /** Ink box of the line (frame px). */
  readonly box: GlyphBox;
  readonly glyphHeight: number;
}

export interface HighlightPlan {
  readonly pathD: string;
  readonly lines: readonly HighlightLine[];
  /** Ink box of all lines and the cream box (frame px). */
  readonly ink: GlyphBox;
  readonly card: GlyphBox;
  readonly timeScale: number;
}

export function highlightPlan(params: TextMotionParams, size: MotionFrameSize): HighlightPlan {
  const safe = titleSafeBox(size);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { fill: 0.84, heightFill: 0.5 }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const lines: HighlightLine[] = [];
  let tallest = 0;
  for (const placed of text.block.lines) {
    const ink = placed.layout.inkBox;
    if (!ink) continue;
    let glyphHeight = 0;
    for (const glyph of placed.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
    tallest = Math.max(tallest, glyphHeight);
    lines.push({ box: { x0: ink.x0 + placed.x + dx, y0: ink.y0 + placed.baselineY + dy, x1: ink.x1 + placed.x + dx, y1: ink.y1 + placed.baselineY + dy }, glyphHeight });
  }
  const ink = { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy };
  const padX = Math.min(PAD_X * tallest, (0.98 * safe.width - (ink.x1 - ink.x0)) / 2);
  const padY = Math.min(PAD_Y * tallest, (0.98 * safe.height - (ink.y1 - ink.y0)) / 2);
  return {
    pathD: translatePathD(text.block.pathD, dx, dy), lines, ink,
    card: { x0: ink.x0 - padX, y0: ink.y0 - padY, x1: ink.x1 + padX, y1: ink.y1 + padY + BAND_BOTTOM * tallest * 0.5 },
    timeScale: itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS).timeScale,
  };
}

/** Marker progress of line `index` at time t (0..1). */
export function markerProgress(plan: HighlightPlan, index: number, t: number): number {
  const s = plan.timeScale;
  return quartOut(clamp01((t - (SWIPE_AT + index * LINE_STAGGER) * s) / (SWIPE * s)));
}

/** How far the box is unfolded (0..1). */
export function boxOpening(plan: HighlightPlan, t: number, duration: number): number {
  const s = plan.timeScale, closeAt = duration - CLOSE * s;
  if (t >= closeAt) return 1 - cubicIn(clamp01((t - closeAt) / (CLOSE * s)));
  return expoOut(clamp01(t / (OPEN * s)));
}

export const T38_highlightText = defineTextMotion(ID, (params, t, size) => {
  const plan = highlightPlan(params, size);
  const doc = createTextDocument(size, params);
  const opening = boxOpening(plan, t, params.durationSeconds);
  if (opening <= 0.001) return doc.render();
  const boxColor = params.palette.paper;
  const textColor = textOnBackground(params.palette, boxColor);
  const bandColor = tint(params.palette.accent, T38_TINT, boxColor);
  const { card } = plan;
  const cy = (card.y0 + card.y1) / 2;
  const radius = CORNER * (card.y1 - card.y0);
  const bands: string[] = [];
  plan.lines.forEach((line, index) => {
    const p = markerProgress(plan, index, t);
    if (p <= 0) return;
    const h = line.glyphHeight;
    const y0 = line.box.y1 - (1 - BAND_TOP) * h, y1 = line.box.y1 + BAND_BOTTOM * h, height = y1 - y0;
    const x0 = line.box.x0 - OVERHANG * h, full = line.box.x1 + OVERHANG * h - x0;
    // The tip is round from the first frame: the band grows from a dot (its own height) to its full length.
    bands.push(roundRect(x0, y0, height + (full - height) * p, height, height / 2, { fill: bandColor }));
  });
  const content = g(undefined,
    roundRect(card.x0, card.y0, card.x1 - card.x0, card.y1 - card.y0, radius, { fill: boxColor }),
    bands,
    path(plan.pathD, { fill: textColor }));
  if (opening >= 0.999) return doc.render(content);
  // Unfold: the box (and everything in it) is revealed from its middle line outward.
  const half = ((card.y1 - card.y0) / 2) * opening;
  const reveal = doc.clipPath(rect(card.x0 - 2, cy - half, card.x1 - card.x0 + 4, 2 * half));
  return doc.render(g({ "clip-path": reveal }, content));
}, { revision: REVISION });
