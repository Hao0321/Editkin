import { fmt, g, path, rect, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { distinctFrom } from "./T09_hugeTextScroll";

/**
 * T35 Text Mask Pattern (柄マスク), STYLE: the word is a window (a clipPath of its
 * own outlines) onto candy stripes at 45° that scroll across it without end. The
 * stripes are the item's two tones (ART_DIRECTION §0): the readable text colour and
 * the accent, i.e. cream and orange on the dark card, ink and orange on cream (the
 * reference's look), ink and cream on the orange card (the accent would vanish
 * there). Outside the glyphs nothing is drawn: the clip stays transparent unless a
 * plate is set.
 *
 * The stripe period is 26% of the glyph height (each heavy stroke shows about one
 * stripe), and the pattern moves exactly a whole number of periods per loop (one at
 * standard energy, two from hype), so the 2 s loop (catalog loopSeconds) has no
 * seam: the offset is a function of the loop phase. The word is hero-sized
 * (heroTextBox, displayTracking) and static inside the title-safe box.
 */

const ID = "T35";
const REVISION = 1;
export const T35_LOOP_SECONDS = 2;
/** Stripe period (× glyph height), stripe angle (degrees, clockwise in y-down: −45 rises to the right). */
export const T35_PERIOD = 0.2, T35_ANGLE = -45;
const LINE_HEIGHT = 1.04;

export interface MaskPatternPlan {
  /** Word outline in frame px. */
  readonly pathD: string;
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  /** Stripe period (px) and whole periods travelled per loop. */
  readonly period: number;
  readonly periodsPerLoop: number;
  readonly stripeA: string;
  readonly stripeB: string;
}

export function maskPatternPlan(params: TextMotionParams, size: MotionFrameSize): MaskPatternPlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const safe = titleSafeBox(size);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const backdrop = textBackdrop(params);
  const stripeA = textOnBackground(params.palette, backdrop);
  const stripeB = distinctFrom(backdrop, params.palette.accent, [stripeA === params.palette.ink ? params.palette.paper : params.palette.ink, params.palette.accent2]);
  return {
    pathD: translatePathD(text.block.pathD, dx, dy),
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
    glyphHeight, period: T35_PERIOD * glyphHeight,
    periodsPerLoop: Math.max(1, Math.round(energyProfile(params.energy).amplitude)),
    stripeA, stripeB,
  };
}

/**
 * Stripe offset (px, across the stripes) at loop phase u: whole periods per loop, so u = 0 and u = 1 give the same
 * pattern. The offset is reduced modulo the period, so the drawn stripes are identical at the seam.
 */
export function stripeOffset(plan: MaskPatternPlan, u: number): number {
  const travel = plan.periodsPerLoop * u;
  return (travel - Math.floor(travel)) * plan.period;
}

export const T35_textMaskPattern = defineTextMotion(ID, (params, t, size) => {
  const plan = maskPatternPlan(params, size);
  const doc = createTextDocument(size, params);
  const { box, period } = plan;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  // Half the box diagonal plus a period: the rotated stripe field covers the whole word box at any offset.
  const reach = Math.hypot(box.x1 - box.x0, box.y1 - box.y0) / 2 + 2 * period;
  const offset = stripeOffset(plan, loopPhase(t, T35_LOOP_SECONDS));
  const first = Math.floor(-reach / period) - 1, last = Math.ceil(reach / period) + 1;
  const stripes: string[] = [];
  for (let k = first; k <= last; k += 1) stripes.push(`M${fmt(k * period + offset, 2)} ${fmt(-reach, 2)}h${fmt(period / 2, 2)}v${fmt(2 * reach, 2)}h${fmt(-period / 2, 2)}z`);
  const clip = doc.clipPath(path(plan.pathD));
  const pad = 2;
  return doc.render(g({ "clip-path": clip },
    rect(box.x0 - pad, box.y0 - pad, box.x1 - box.x0 + 2 * pad, box.y1 - box.y0 + 2 * pad, { fill: plan.stripeA }),
    path(stripes.join(""), { fill: plan.stripeB, transform: transform(tf.translate(cx, cy), tf.rotate(T35_ANGLE)) })));
}, { revision: REVISION });
