import { mixHex } from "../../svg/color";
import { g, path, transform, tf } from "../../svg/document";
import { loopPhase } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T24 Extrude Text (押し出し), DEPTH, thin variant only. Hao ruled thick 3D text
 * ART_REJECTED (2026-10), so the extrusion is a thin slab: at most T24_MAX_OFFSETS stacked
 * offset copies whose total depth is at most T24_MAX_DEPTH of the glyph height, drawn in
 * the deep shade behind the face (like a cut acrylic letter, never a chunky 3D block). The
 * extrusion direction sweeps a full turn per loop, so the thin side faces swing around the
 * letters like a light moving around them. The face is two-tone (ART_DIRECTION §0): the
 * readable text colour and the second tone alternate by character (cream and aqua on the
 * dark card); its glyphs stay put and readable throughout.
 *
 * The word is hero-sized (heroTextBox, tight displayTracking) with room for the extrusion,
 * so face and side stay inside the 5% title-safe box at every angle. A seamless 3 s loop
 * (catalog loopSeconds). Not a VA default (catalog notes): it stays out of autopilot picks.
 */

const ID = "T24";
const REVISION = 1;
export const T24_LOOP_SECONDS = 3;
/** Thin-depth limits (the batch ruling): stacked offsets and total depth as a share of the glyph height. */
export const T24_MAX_OFFSETS = 6, T24_MAX_DEPTH = 0.04;
/** Where the sweep starts (degrees, 0 = right, clockwise in SVG y-down): down-right, the classic resting extrusion. */
const START_ANGLE = 45;
/** Fixed light from the upper left (unit vector toward it): the side brightens as it turns toward the light. */
const LIGHT: readonly [number, number] = [-0.6, -0.8];
const LINE_HEIGHT = 1.04;

export interface ExtrudeGlyph {
  readonly pathD: string;
  /** Pen origin (frame px, on the baseline). */
  readonly x: number;
  readonly y: number;
  readonly face: string;
}

export interface ExtrudeLayout {
  readonly glyphs: readonly ExtrudeGlyph[];
  /** Total extrusion depth (px) and the offsets drawn. */
  readonly depth: number;
  readonly offsets: number;
  /** Side colour in shadow and fully lit (the deep shade toward ink, and toward the accent). */
  readonly sideShadow: string;
  readonly sideLit: string;
  /** Face ink box (frame px) and the tallest glyph's ink height (px). */
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly glyphHeight: number;
}

export function extrudeLayout(params: TextMotionParams, size: MotionFrameSize): ExtrudeLayout {
  const safe = titleSafeBox(size);
  // Headroom for the extrusion on every side: depth ≤ 4% of the glyph height ≈ 3.5% of the em.
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: 1.06 }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop), secondary = secondaryTone(params.palette, backdrop);
  const offsetX = safe.cx - (text.ink.x0 + text.ink.x1) / 2, offsetY = safe.cy - (text.ink.y0 + text.ink.y1) / 2;
  const glyphs: ExtrudeGlyph[] = [];
  let glyphHeight = 0;
  for (const line of text.block.lines) {
    for (const glyph of line.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox || !glyph.pathD) continue;
      glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
      glyphs.push({ pathD: compactPathD(glyph.pathD), x: offsetX + line.x + glyph.x, y: offsetY + line.baselineY, face: glyphs.length % 2 === 0 ? primary : secondary });
    }
  }
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  // The side is the deep shade of the accent (toward ink in shadow, toward the accent when lit); ink if the shade is the backdrop.
  const deep = params.palette.accent2.toUpperCase() === backdrop.toUpperCase() ? params.palette.ink : params.palette.accent2;
  return {
    glyphs, depth: T24_MAX_DEPTH * glyphHeight, offsets: T24_MAX_OFFSETS,
    sideShadow: mixHex(deep, params.palette.ink, 0.3), sideLit: mixHex(deep, params.palette.accent, 0.28),
    box: { x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY }, glyphHeight,
  };
}

/** Extrusion direction (unit vector, SVG y-down) at loop phase (0..1). */
export function extrudeDirection(phase: number): readonly [number, number] {
  const angle = ((START_ANGLE + 360 * phase) * Math.PI) / 180;
  return [Math.cos(angle), Math.sin(angle)];
}

export const T24_extrudeText = defineTextMotion(ID, (params, t, size) => {
  const layout = extrudeLayout(params, size);
  const doc = createTextDocument(size, params);
  const [dx, dy] = extrudeDirection(loopPhase(t, T24_LOOP_SECONDS));
  const step = layout.depth / layout.offsets;
  // Side: the stacked offsets from the deepest to the nearest, all in the deep shade (one flat colour, so their order is moot).
  const side = [];
  for (let k = layout.offsets; k >= 1; k -= 1) {
    side.push(g({ transform: tf.translate(dx * step * k, dy * step * k) },
      layout.glyphs.map(glyph => path(glyph.pathD, { transform: tf.translate(glyph.x, glyph.y) }))));
  }
  const faces = layout.glyphs.map(glyph => path(glyph.pathD, { fill: glyph.face, transform: transform(tf.translate(glyph.x, glyph.y)) }));
  // The visible side faces face the extrusion direction: Lambert against the fixed light picks their tone.
  const lit = Math.max(0, dx * LIGHT[0] + dy * LIGHT[1]);
  return doc.render(g({ fill: mixHex(layout.sideShadow, layout.sideLit, lit) }, side), g(undefined, faces));
}, { revision: REVISION });
