import { circle, circlePathD, g, line, path, pathData, rectPathD, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, layoutFittedText, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground,
  titleSafeBox,
} from "../shared";

/**
 * T52 Magnifier Lens (放大鏡), PLAY: one line of dimmed text (the text colour at
 * 45%) and a magnifying glass gliding over it. The glass is a cream ring (stroke 3%
 * of the glyph height, at least 6 units at 1080, inner radius 0.65× the glyph
 * height) with a rounded handle at 45° to the lower right and a small glint. It
 * glides left → right → left across the line (sineInOut both ways, one round trip
 * per 2.4 s loop) with a ±4% vertical bob (of the short side, two bobs per trip).
 *
 * Inside the lens the same text shows at 1.7×, full opacity, in the accent, mapped
 * as a true magnifier: translate(c) scale(1.7) translate(−c) about the lens centre
 * c, clipped to the lens circle, so the point under the centre stays put; the
 * dimmed line is clipped away inside the lens (a frame-minus-circle clip,
 * evenodd), so the glass never shows a double image.
 *
 * Colours follow ART_DIRECTION §0: the readable text role for the line and the
 * glass (cream on the dark card, ink on cream or on the coral card), the second
 * tone for the magnified text (coral on dark; accent2 on the accent or cream
 * card). The line is hero-sized (heroTextBox, displayTracking) inside the
 * title-safe box. A seamless 2.4 s loop (catalog loopSeconds); energy scales the bob.
 */

const ID = "T52";
const REVISION = 1;
export const T52_LOOP_SECONDS = 2.4;
export const T52_MAGNIFICATION = 1.7, T52_DIM_OPACITY = 0.45;
/** Lens inner radius and ring stroke (× glyph height); minimum ring in 1080 units; bob (× short side, cycles per loop). */
const RADIUS = 0.65, RING = 0.03, RING_MIN_UNITS = 6, BOB = 0.04, BOB_CYCLES = 2;
/** Handle: length and thickness (× lens radius); glint arc (radius × lens radius, degrees). */
const HANDLE_LENGTH = 0.95, HANDLE_WIDTH = 0.26, GLINT_RADIUS = 0.76, GLINT_FROM = 200, GLINT_TO = 245;
const LINE_HEIGHT = 1.04;

export interface MagnifierPlan {
  readonly pathD: string;
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  readonly radius: number;
  readonly ring: number;
  /** Lens travel: centre x at the ends of the glide, and the resting centre y. */
  readonly fromX: number;
  readonly toX: number;
  readonly centerY: number;
  readonly bob: number;
}

export function magnifierPlan(params: TextMotionParams, size: MotionFrameSize): MagnifierPlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const safe = titleSafeBox(size);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const box = { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy };
  let glyphHeight = 0, firstCenter = Number.NaN, lastCenter = Number.NaN;
  for (const placed of text.block.lines) {
    for (const glyph of placed.layout.glyphs) {
      if (!glyph.bbox) continue;
      glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
      const centre = dx + placed.x + glyph.x + (glyph.bbox.x0 + glyph.bbox.x1) / 2;
      firstCenter = Number.isNaN(firstCenter) ? centre : Math.min(firstCenter, centre);
      lastCenter = Number.isNaN(lastCenter) ? centre : Math.max(lastCenter, centre);
    }
  }
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  if (Number.isNaN(firstCenter)) { firstCenter = box.x0; lastCenter = box.x1; }
  const radius = RADIUS * glyphHeight;
  return {
    pathD: translatePathD(text.block.pathD, dx, dy), box, glyphHeight, radius,
    ring: Math.max(RING * glyphHeight, RING_MIN_UNITS * frameUnit(size)),
    fromX: firstCenter, toX: lastCenter, centerY: (box.y0 + box.y1) / 2,
    bob: BOB * Math.min(size.width, size.height) * Math.min(1.5, energyProfile(params.energy).amplitude),
  };
}

/** Lens centre at loop phase u: left → right → left (sineInOut both ways) with the vertical bob. */
export function lensCenter(plan: MagnifierPlan, u: number): readonly [number, number] {
  const glide = (1 - Math.cos(2 * Math.PI * u)) / 2;
  return [plan.fromX + (plan.toX - plan.fromX) * glide, plan.centerY + plan.bob * Math.sin(2 * Math.PI * BOB_CYCLES * u)];
}

/** The magnifier mapping about the lens centre c: translate(c) scale(m) translate(−c). */
export function magnifierTransform(cx: number, cy: number): string {
  return transform(tf.translate(cx, cy), tf.scale(T52_MAGNIFICATION), tf.translate(-cx, -cy))!;
}

export const T52_magnifierLens = defineTextMotion(ID, (params, t, size) => {
  const plan = magnifierPlan(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  const zoomColor = secondaryTone(params.palette, backdrop);
  const glassColor = readableColor(backdrop, [params.palette.paper, textColor]);
  const [cx, cy] = lensCenter(plan, loopPhase(t, T52_LOOP_SECONDS));
  const r = plan.radius;
  // The dimmed line everywhere but inside the lens (frame minus circle, evenodd), the magnified line inside it.
  const outside = doc.clipPath(path(rectPathD(-1, -1, size.width + 2, size.height + 2) + circlePathD(cx, cy, r), { "clip-rule": "evenodd" }));
  const inside = doc.clipPath(circle(cx, cy, r));
  const handleFrom = r + plan.ring / 2, handleTo = handleFrom + HANDLE_LENGTH * r, diagonal = Math.SQRT1_2;
  const glint = pathData(2);
  const a0 = (GLINT_FROM * Math.PI) / 180, a1 = (GLINT_TO * Math.PI) / 180, gr = GLINT_RADIUS * r;
  glint.M(cx + gr * Math.cos(a0), cy + gr * Math.sin(a0)).A(gr, gr, 0, false, true, cx + gr * Math.cos(a1), cy + gr * Math.sin(a1));
  return doc.render(
    g({ "clip-path": outside }, path(plan.pathD, { fill: textColor, "fill-opacity": T52_DIM_OPACITY })),
    g({ "clip-path": inside }, path(plan.pathD, { fill: zoomColor, transform: magnifierTransform(cx, cy) })),
    line(cx + handleFrom * diagonal, cy + handleFrom * diagonal, cx + handleTo * diagonal, cy + handleTo * diagonal,
      { stroke: glassColor, "stroke-width": HANDLE_WIDTH * r, "stroke-linecap": "round" }),
    circle(cx, cy, r + plan.ring / 2, { fill: "none", stroke: glassColor, "stroke-width": plan.ring }),
    path(glint.toString(), { fill: "none", stroke: glassColor, "stroke-width": plan.ring * 0.8, "stroke-linecap": "round" }));
}, { revision: REVISION });
