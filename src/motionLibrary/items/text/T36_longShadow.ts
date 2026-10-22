import { fmt, g, path } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T36 Long Shadow (ロングシャドウ), STYLE: a flat long shadow, the text extruded
 * along a direction d for 2× the glyph height, in one flat colour under the
 * cream text. The direction makes one full clockwise turn per 3 s loop (starting
 * at 45° to the lower right), so the shadow swings round the word like a sundial.
 *
 * The shadow is ONE exact swept shape, the union of the text translated by s·d for
 * s in 0..1, never a stack of offset copies. The glyph outlines are flattened once
 * (chords within about 0.1 px of the curves); every edge p0→p1 gives the quad
 * (p0, p1, p1 + d, p0 + d) with the outer contours' winding; the glyphs at 0 and at
 * d are added with their own curves; the whole path fills with nonzero, so there
 * are no seams between quads and the counters stay open at the far end. Only the
 * edges facing away from d emit their quad: a point of the sweep that lies outside
 * both glyph copies is reached, going back along −d, through one edge facing d
 * and one facing away, so either class alone covers the sweep exactly, and the
 * class facing away leaves the visible far end on the true glyph curves (the
 * near side lies under the text). Measured against the all-edges construction:
 * the same coverage, librsvg raster 136 → 45 ms per 1080×1920 frame.
 *
 * Colours follow ART_DIRECTION §0: the readable text role (cream on the dark
 * card) and the second tone for the shadow (the orange accent on dark; accent2 on
 * the accent card; on cream the accent when it reads, else accent2). The word is
 * hero-sized (heroTextBox, displayTracking) and static inside the title-safe box;
 * the shadow is an effect and may run off the frame. Energy scales the shadow
 * length (never the period). A seamless 3 s loop (catalog loopSeconds): the
 * direction is a function of the loop phase.
 */

const ID = "T36";
const REVISION = 1;
export const T36_LOOP_SECONDS = 3;
/** Shadow length in glyph heights; start direction (degrees, y-down, clockwise from +x: 45 = lower right). */
export const T36_LENGTH = 2, T36_START_DEGREES = 45;
/** Flattening chord length (px): the sagitta stays near 0.1 px on the tightest glyph curves at display sizes. */
const FLATTEN_SEGMENT = 4;
const LINE_HEIGHT = 1.04;

export interface LongShadowPlan {
  /** Text outline in frame px (all lines). */
  readonly pathD: string;
  /** Flattened contours of pathD (frame px). */
  readonly contours: readonly (readonly FlatPoint[])[];
  /** +1 or −1: the sign of the outer contours' area (y-down shoelace); every sweep quad carries this sign. */
  readonly outerSign: 1 | -1;
  /** Ink box of the text (frame px). */
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  /** Shadow length (px, energy applied). */
  readonly length: number;
}

const planCache = new Map<string, LongShadowPlan>();

/** Signed area of a closed polygon, y-down shoelace (positive = clockwise on screen). */
export function signedArea(points: readonly FlatPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

/** Word fit, outline, flattened contours and shadow length (shared by the generator and its tests; cached). */
export function longShadowPlan(params: TextMotionParams, size: MotionFrameSize): LongShadowPlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const safe = titleSafeBox(size);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const energy = energyProfile(params.energy).amplitude;
  const key = `${size.width}x${size.height}\u0000${text.block.size}\u0000${params.font}\u0000${energy}\u0000${params.lines.join("\u0001")}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const pathD = translatePathD(text.block.pathD, dx, dy);
  const contours = flattenPathD(pathD, { segmentLength: FLATTEN_SEGMENT, label: ID });
  // The outer contours dominate the total area, so its sign is theirs (holes run the other way).
  const total = contours.reduce((sum, contour) => sum + signedArea(contour), 0);
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const plan: LongShadowPlan = Object.freeze({
    pathD, contours, outerSign: total >= 0 ? 1 : -1,
    box: Object.freeze({ x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy }),
    glyphHeight, length: T36_LENGTH * glyphHeight * (0.75 + 0.25 * energy),
  });
  planCache.set(key, plan);
  if (planCache.size > 32) planCache.delete(planCache.keys().next().value!);
  return plan;
}

/** Shadow direction (degrees, y-down, clockwise from +x) at loop phase u: one full clockwise turn per loop. */
export function longShadowDegrees(u: number): number {
  return T36_START_DEGREES + 360 * u;
}

/** The shadow vector (px, rounded to 0.1 px) at loop phase u. */
export function longShadowVector(plan: LongShadowPlan, u: number): readonly [number, number] {
  const radians = (longShadowDegrees(u) * Math.PI) / 180;
  return [Number(fmt(plan.length * Math.cos(radians), 1)), Number(fmt(plan.length * Math.sin(radians), 1))];
}

/**
 * The sweep quads of the outline along (dx, dy) as path data. `faces` picks the edges: "away" (default, shipped)
 * emits the edges facing away from d, whose quads already carry the outer winding; "all" emits every edge, each
 * normalised to the outer winding (the textbook construction, kept for tests). Edges parallel to d add nothing.
 * Every quad starts from an absolute moveto, so rounding never accumulates across quads.
 */
export function sweepQuadsPathD(contours: readonly (readonly FlatPoint[])[], dx: number, dy: number, outerSign: 1 | -1,
  faces: "away" | "all" = "away"): string {
  const parts: string[] = [];
  const n = (value: number) => fmt(value, 1);
  const rdx = Number(n(dx)), rdy = Number(n(dy));
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const p0 = contour[index], p1 = contour[(index + 1) % contour.length];
      const x0 = Number(n(p0[0])), y0 = Number(n(p0[1]));
      const ax = Number(n(p1[0] - x0)), ay = Number(n(p1[1] - y0));
      // The signed area of (p0, p1, p1 + d, p0 + d) in the y-down shoelace convention is a × d.
      const area = (ax * rdy - ay * rdx) * outerSign;
      if (area >= 0.05) parts.push(`M${n(x0)} ${n(y0)}l${n(ax)} ${n(ay)} ${n(rdx)} ${n(rdy)} ${n(-ax)} ${n(-ay)}z`);
      else if (faces === "all" && area <= -0.05) parts.push(`M${n(x0)} ${n(y0)}l${n(rdx)} ${n(rdy)} ${n(ax)} ${n(ay)} ${n(-rdx)} ${n(-rdy)}z`);
    }
  }
  return parts.join("");
}

/** The whole shadow path at loop phase u: the sweep quads plus the glyphs at 0 and at d (fill nonzero). */
export function longShadowPathD(plan: LongShadowPlan, u: number, faces: "away" | "all" = "away"): string {
  const [dx, dy] = longShadowVector(plan, u);
  return sweepQuadsPathD(plan.contours, dx, dy, plan.outerSign, faces) + plan.pathD + translatePathD(plan.pathD, dx, dy);
}

export const T36_longShadow = defineTextMotion(ID, (params, t, size) => {
  const plan = longShadowPlan(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  const shadowColor = secondaryTone(params.palette, backdrop);
  const shadow = longShadowPathD(plan, loopPhase(t, T36_LOOP_SECONDS));
  return doc.render(g(undefined, path(shadow, { fill: shadowColor }), path(plan.pathD, { fill: textColor })));
}, { revision: REVISION });
