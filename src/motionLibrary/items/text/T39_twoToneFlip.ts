import { g, path, polygon, rect, roundRect, type Point2 } from "../../svg/document";
import { clamp01, cubicIn, cubicInOut, expoOut } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { distinctFrom } from "./T09_hugeTextScroll";

/**
 * T39 Two-tone Flip (2色反転), STYLE: the word sits on its own card, split in two
 * tones by a slanted boundary that sweeps across it. Behind the boundary the
 * colours are inverted: a dark card with cream type turns into a cream card with
 * ink type, then a second boundary turns it back. The text is cut exactly along
 * the boundary: the inverted side is one clipPath polygon drawn over the whole
 * normal layer, so both halves stay crisp and the edge has no seam. A thin accent
 * stripe rides each boundary while it crosses the card (the item's one accent).
 *
 * Program (standard-energy seconds, compressed for short clips): the card opens
 * from its centre 0–0.3 (expoOut); flip one sweeps left to right 0.45–1.0
 * (cubicInOut, so the split word stays on screen long enough to read); the inverted
 * card holds; flip two sweeps 1.75–2.3; the normal card
 * holds; the card closes to its centre over the last 0.3 s (cubicIn). The card is
 * the word's backdrop, so the item reads over any footage, while a text clip still
 * paints nothing outside the card (ART_DIRECTION §9). On a plate the card's
 * normal side keeps the dark card (on the dark showcase plate it melts into it, so
 * the cream side seems to sweep across the frame).
 *
 * Colours (ART_DIRECTION §0): normal = the dark card (bg) with cream type; inverted =
 * cream card with ink type; the stripe is the accent (accent2 where the accent would
 * vanish). The
 * word is hero-sized (heroTextBox, displayTracking) and the whole card stays inside
 * the 5% title-safe box.
 */

const ID = "T39";
const REVISION = 1;
/** Program (standard-energy seconds). */
const OPEN = 0.3, FLIP1_AT = 0.45, FLIP2_AT = 1.75, FLIP = 0.55, CLOSE = 0.3, MIN_TAIL_HOLD = 0.1;
const NATURAL_SECONDS = FLIP2_AT + FLIP + MIN_TAIL_HOLD + CLOSE;
/** Boundary slope (degrees from horizontal), card padding (× glyph height), stripe width (× card height), corner radius. */
export const T39_BOUNDARY_DEGREES = 62;
const PAD_X = 0.2, PAD_Y = 0.17, STRIPE = 0.045, CORNER = 0.025;
const LINE_HEIGHT = 1.04;

export interface TwoToneFlipPlan {
  readonly pathD: string;
  /** Ink box of the word (frame px). */
  readonly box: GlyphBox;
  /** The card (frame px). */
  readonly card: GlyphBox;
  readonly glyphHeight: number;
  /** Horizontal run of the slanted boundary across the card height (px). */
  readonly lean: number;
  readonly timeScale: number;
}

export function twoToneFlipPlan(params: TextMotionParams, size: MotionFrameSize): TwoToneFlipPlan {
  const safe = titleSafeBox(size);
  // Card = word + padding: the word takes 80% of the safe width so the card stays inside the safe box.
  const hero = heroTextBox(size, { fill: 0.8, heightFill: 0.56 });
  const text = layoutFittedText(params.lines, textFace(params.font, 900), { ...hero, lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines) });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const box = { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy };
  const padX = Math.min(PAD_X * glyphHeight, (0.98 * safe.width - (box.x1 - box.x0)) / 2);
  const padY = Math.min(PAD_Y * glyphHeight, (0.98 * safe.height - (box.y1 - box.y0)) / 2);
  const card = { x0: box.x0 - padX, y0: box.y0 - padY, x1: box.x1 + padX, y1: box.y1 + padY };
  return {
    pathD: translatePathD(text.block.pathD, dx, dy), box, card, glyphHeight,
    lean: (card.y1 - card.y0) / Math.tan((T39_BOUNDARY_DEGREES * Math.PI) / 180),
    timeScale: itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS).timeScale,
  };
}

/**
 * Sweep progress of the two boundaries at time t: 0 = still left of the card, 1 = past its right edge. The
 * inverted region lies between boundary two (left) and boundary one (right).
 */
export function flipProgress(plan: TwoToneFlipPlan, t: number): { readonly first: number; readonly second: number } {
  const s = plan.timeScale;
  return { first: cubicInOut(clamp01((t - FLIP1_AT * s) / (FLIP * s))), second: cubicInOut(clamp01((t - FLIP2_AT * s) / (FLIP * s))) };
}

/** How open the card is (0..1): it opens from its centre, holds, and closes back to it at the end of the clip. */
export function cardOpening(plan: TwoToneFlipPlan, t: number, duration: number): number {
  const s = plan.timeScale;
  const closeAt = duration - CLOSE * s;
  if (t >= closeAt) return 1 - cubicIn(clamp01((t - closeAt) / (CLOSE * s)));
  return expoOut(clamp01(t / (OPEN * s)));
}

/** The slanted boundary at progress p: x on the card's top and bottom edges (frame px). */
function boundaryX(plan: TwoToneFlipPlan, p: number): { readonly top: number; readonly bottom: number } {
  const { card, lean } = plan;
  // Travel: from fully left of the card (its top point at the card's left edge minus a margin) to fully right.
  const margin = 0.06 * (card.y1 - card.y0);
  const start = card.x0 - margin, end = card.x1 + lean + margin;
  const top = start + (end - start) * p;
  return { top, bottom: top - lean };
}

export const T39_twoToneFlip = defineTextMotion(ID, (params, t, size) => {
  const plan = twoToneFlipPlan(params, size);
  const doc = createTextDocument(size, params);
  const palette = params.palette;
  const opening = cardOpening(plan, t, params.durationSeconds);
  if (opening <= 0.001) return doc.render();
  const backdrop = textBackdrop(params);
  const cardNormal = palette.bg, cardInverted = palette.paper;
  const textNormal = textOnBackground(palette, cardNormal), textInverted = textOnBackground(palette, cardInverted);
  const stripeColor = distinctFrom(cardInverted, distinctFrom(backdrop, palette.accent, [palette.accent2]), [palette.accent2]);
  const { card } = plan;
  const cx = (card.x0 + card.x1) / 2, halfWidth = ((card.x1 - card.x0) / 2) * opening;
  const radius = CORNER * (card.y1 - card.y0);
  const reveal = doc.clipPath(rect(cx - halfWidth, card.y0 - 1, 2 * halfWidth, card.y1 - card.y0 + 2));
  const cardShape = (fill?: string) => roundRect(card.x0, card.y0, card.x1 - card.x0, card.y1 - card.y0, radius, fill ? { fill } : undefined);
  const parts: string[] = [cardShape(cardNormal), path(plan.pathD, { fill: textNormal })];

  const { first, second } = flipProgress(plan, t);
  const b1 = boundaryX(plan, first), b2 = boundaryX(plan, second);
  const y0 = card.y0, y1 = card.y1;
  if (first > second) {
    const region: Point2[] = [[b2.top, y0], [b1.top, y0], [b1.bottom, y1], [b2.bottom, y1]];
    const inverted = doc.clipPath(polygon(region));
    parts.push(g({ "clip-path": inverted }, cardShape(cardInverted), path(plan.pathD, { fill: textInverted })));
  }
  // The accent stripe rides each boundary while it crosses the card (clipped to the card).
  const stripeWidth = STRIPE * (card.y1 - card.y0);
  const stripes: string[] = [];
  for (const [p, b] of [[first, b1], [second, b2]] as const) {
    if (p <= 0 || p >= 1) continue;
    stripes.push(polygon([[b.top - stripeWidth / 2, y0], [b.top + stripeWidth / 2, y0], [b.bottom + stripeWidth / 2, y1], [b.bottom - stripeWidth / 2, y1]],
      { fill: stripeColor }));
  }
  if (stripes.length) parts.push(g({ "clip-path": doc.clipPath(cardShape()) }, stripes));
  return doc.render(g({ "clip-path": reveal }, parts));
}, { revision: REVISION });
