import { g, path, rect, tf, transform } from "../../svg/document";
import { clamp01, cubicIn, energyProfile, loopPhase, quartOut } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground } from "../shared";
import { marqueeRepeatStarts, marqueeUnit, marqueeUnitText, type MarqueeUnit } from "./T09_hugeTextScroll";

/**
 * T33 Outline Text (輪郭文字), STYLE: the frame is ruled with diagonal rows
 * (−8°, rising to the right) of the repeated text 「疾風怒濤・」 in hollow outline
 * type. One row at a time, top to bottom, the outline fills with the accent: a
 * wipe runs along the row (0.4 s, quartOut) and the next row starts a beat later,
 * until the whole wall is solid; then every row empties at once (a wipe off to
 * the right) and the cycle starts again. Rows scroll slowly, alternating
 * direction, one whole repeat per loop.
 *
 * The outline is a ring outside each glyph's union silhouette (a stroke of twice
 * the ring width with the glyphs masked out), so the font's overlapping stroke
 * contours never draw lines inside a letter; a filled glyph is the same
 * silhouette in the fill colour (fill plus a stroke of the same width), so the
 * wipe never changes a letter's size. Separators (・) are solid dots in the fill
 * colour throughout.
 *
 * Colours follow ART_DIRECTION §0: cream outlines and orange fills on the dark
 * card (ink and accent2 on the accent card; ink and the readable second tone on
 * cream). The rows run edge to edge by definition (the effect bleeds); the row
 * text is 19% of the short side tall. A seamless 4 s loop (catalog loopSeconds):
 * scrolling moves whole repeats and the fill program is a function of the loop
 * phase, empty at the seam. Energy scales the scroll speed (whole repeats only).
 */

const ID = "T33";
const REVISION = 1;
export const T33_LOOP_SECONDS = 4;
export const T33_ANGLE = -8;
/** Row text ink height (× short side), row pitch (× ink height), outline ring (× font size). */
const INK = 0.24, PITCH = 1.32, RING = 0.02;
const WEIGHT = 800, TRACKING = -0.02;
/** Fill program (seconds within the loop): first wipe start, last wipe end, wipe length, reset start and length. */
export const T33_FILL_START = 0.2, T33_FILL_END = 2.85, T33_WIPE = 0.4, T33_RESET_AT = 3.2, T33_RESET = 0.35;

export interface OutlineRow {
  /** Row centre (frame px); the row runs at T33_ANGLE through it. */
  readonly cx: number;
  readonly cy: number;
  /** Whole repeats per loop, signed (positive moves toward −x along the row). */
  readonly repeatsPerLoop: number;
  /** Fill order (top to bottom). Only rows that reach the frame are planned. */
  readonly order: number;
  /** The row's visible span along its own axis (row coordinates), where the wipe runs. */
  readonly span: readonly [number, number];
}

export interface OutlinePlan {
  readonly unit: MarqueeUnit;
  readonly baseline: number;
  readonly ring: number;
  readonly rows: readonly OutlineRow[];
  readonly visibleRows: number;
  /** Half the row length (px): long enough to cross the frame at the angle. */
  readonly halfLength: number;
}

export function outlinePlan(params: TextMotionParams, size: MotionFrameSize): OutlinePlan {
  const short = Math.min(size.width, size.height);
  const face = textFace(params.font, WEIGHT);
  const text = marqueeUnitText(params.lines[0], face);
  const probe = marqueeUnit(text, face, 100, TRACKING);
  const fontSize = (INK * short * 100) / Math.max(1, probe.ink.y1 - probe.ink.y0);
  const unit = marqueeUnit(text, face, fontSize, TRACKING);
  const inkHeight = unit.ink.y1 - unit.ink.y0;
  const radians = (T33_ANGLE * Math.PI) / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const pitch = PITCH * inkHeight;
  // Rows are stacked along the row normal n = (−sin, cos) through the frame centre.
  const nx = -sin, ny = cos;
  const corners = [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]].map(([x, y]) => (x - size.width / 2) * nx + (y - size.height / 2) * ny);
  const reachMin = Math.min(...corners), reachMax = Math.max(...corners);
  const half = inkHeight / 2 + RING * fontSize;
  const first = Math.floor((reachMin - half) / pitch), last = Math.ceil((reachMax + half) / pitch);
  const halfLength = Math.hypot(size.width, size.height) / 2 + inkHeight;
  const speed = Math.max(1, Math.round(energyProfile(params.energy).amplitude));
  const rows: OutlineRow[] = [];
  let order = 0;
  for (let k = first; k <= last; k += 1) {
    const offset = k * pitch;
    if (!(offset + half > reachMin && offset - half < reachMax)) continue;
    const cx = size.width / 2 + offset * nx, cy = size.height / 2 + offset * ny;
    rows.push({ cx, cy, repeatsPerLoop: (k % 2 === 0 ? 1 : -1) * speed, order: order++, span: rowSpan(cx, cy, cos, sin, size, halfLength) });
  }
  return { unit, baseline: -(unit.ink.y0 + unit.ink.y1) / 2, ring: RING * fontSize, rows, visibleRows: order, halfLength };
}

/** Where the row's centre line crosses the frame, in row coordinates (with a small margin). */
function rowSpan(cx: number, cy: number, cos: number, sin: number, size: MotionFrameSize, halfLength: number): readonly [number, number] {
  let lo = -halfLength, hi = halfLength;
  // Clip the line p(s) = (cx + s·cos, cy + s·sin) to the frame rectangle (Liang–Barsky on s).
  for (const [p, q] of [[-cos, cx], [cos, size.width - cx], [-sin, cy], [sin, size.height - cy]] as const) {
    if (Math.abs(p) < 1e-12) continue;
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r); else hi = Math.min(hi, r);
  }
  if (!(hi > lo)) return [0, 0];
  const margin = 0.05 * (hi - lo);
  return [lo - margin, hi + margin];
}

/** Fill state of a row at loop time u (seconds): the filled span [from, to] in 0..1 along the row's visible span. */
export function rowFill(plan: OutlinePlan, row: OutlineRow, u: number): { readonly from: number; readonly to: number } {
  const stagger = plan.visibleRows > 1 ? (T33_FILL_END - T33_WIPE - T33_FILL_START) / (plan.visibleRows - 1) : 0;
  const start = T33_FILL_START + row.order * stagger;
  if (u >= T33_RESET_AT + T33_RESET) return { from: 0, to: 0 };
  const to = quartOut(clamp01((u - start) / T33_WIPE));
  const from = u < T33_RESET_AT ? 0 : cubicIn(clamp01((u - T33_RESET_AT) / T33_RESET));
  return { from, to };
}

export const T33_outlineText = defineTextMotion(ID, (params, t, size) => {
  const plan = outlinePlan(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const outline = textOnBackground(params.palette, backdrop);
  const fill = secondaryTone(params.palette, backdrop);
  const phase = loopPhase(t, T33_LOOP_SECONDS), u = phase * T33_LOOP_SECONDS;
  const { unit, baseline, ring, halfLength } = plan;
  const half = halfLength;
  const rowTransform = (row: OutlineRow) => transform(tf.translate(row.cx, row.cy), tf.rotate(T33_ANGLE));
  const glyphs = (row: OutlineRow, attrs: Record<string, string | number>) =>
    marqueeRepeatStarts(unit, -half, row.repeatsPerLoop * phase, -half, half).map(x => path(unit.textPathD, { ...attrs, transform: tf.translate(x, baseline) }));
  const dots = (row: OutlineRow) => unit.separatorPathD
    ? marqueeRepeatStarts(unit, -half, row.repeatsPerLoop * phase, -half, half).map(x => path(unit.separatorPathD, { transform: tf.translate(x, baseline) }))
    : [];

  // The rows whose outline still shows somewhere (a fully filled row covers its outline exactly).
  const fills = plan.rows.map(row => rowFill(plan, row, u));
  const outlined = plan.rows.filter((_, index) => !(fills[index].from <= 0 && fills[index].to >= 1));
  const parts: string[] = [];
  if (outlined.length) {
    // Outline ring: strokes of twice the ring width, the glyphs themselves masked out.
    const mask = doc.mask([rect(0, 0, size.width, size.height, { fill: "#FFFFFF" }),
      ...outlined.map(row => g({ transform: rowTransform(row) }, glyphs(row, { fill: "#000000" })))]);
    parts.push(g({ mask, fill: "none", stroke: outline, "stroke-width": 2 * ring, "stroke-linejoin": "round" },
      outlined.map(row => g({ transform: rowTransform(row) }, glyphs(row, {})))));
  }
  // Solid fills, each clipped to its row's wipe (row coordinates).
  plan.rows.forEach((row, index) => {
    const { from, to } = fills[index];
    if (!(to > from)) return;
    const [s0, s1] = row.span;
    const full = from <= 0 && to >= 1;
    const content = glyphs(row, {});
    const filled = g({ fill, stroke: fill, "stroke-width": 2 * ring, "stroke-linejoin": "round" }, content);
    if (full) { parts.push(g({ transform: rowTransform(row) }, filled)); return; }
    const x0 = from <= 0 ? -half : s0 + (s1 - s0) * from, x1 = to >= 1 ? half : s0 + (s1 - s0) * to;
    const clip = doc.clipPath(rect(x0, -unit.size, x1 - x0, 2 * unit.size));
    parts.push(g({ transform: rowTransform(row) }, g({ "clip-path": clip }, filled)));
  });
  // Separators: solid dots in the fill colour.
  parts.push(g({ fill }, plan.rows.map(row => g({ transform: rowTransform(row) }, dots(row)))));
  return doc.render(parts);
}, { revision: REVISION });
