import { g, path, rectPathD, tf } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { layoutVertical, translatePathD, type GlyphBox, type MotionFontSelector, type VerticalGlyph } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD, fraction, isMarqueeSeparator } from "./T09_hugeTextScroll";

/**
 * T10 Vertical Typography (縦書き逆走): tategaki mincho columns on the accent
 * plate. A field of thin columns repeats all the lines (「靜寂・疾走・」) and flows
 * vertically, alternate columns up and down at different speeds (1–3 whole repeats
 * per loop), while two big vertical words anchor the composition: line 1 upper
 * right, line 2 lower left (tategaki reads right to left). The anchors are
 * static-ish: they drift ±1.5% of the frame height in opposite directions once per
 * loop. The flowing columns are clipped out of a clear zone around each anchor, so
 * the big words never sit on text. Anchors take the readable text role (ink on the
 * accent plate); the columns the second readable colour (paper there, the accent
 * over a light backdrop).
 *
 * A seamless 4 s loop (catalog loopSeconds): every column advances a whole number
 * of repeats per loop and the drift is one sine cycle, so frame 0 equals the frame
 * at 4 s. Energy scales the drift and the column speeds (whole repeats only). The
 * columns flow through the top and bottom edges by definition; the anchors stay in
 * the 5% title-safe box at every phase.
 *
 * Shared with T15 and T51: columnUnitText / columnUnit lay out one vertical repeat
 * and columnRepeatStarts lists the repeats a column needs.
 */

const ID = "T10";
const REVISION = 1;
export const T10_LOOP_SECONDS = 4;
/** Anchor em: the smallest of these (× frame width, × frame height, × safe height / longest anchor line). */
const ANCHOR_WIDTH = 0.3, ANCHOR_HEIGHT = 0.33, ANCHOR_LENGTH = 0.66, ANCHOR_SPREAD = 0.74;
const ANCHOR_DRIFT = 0.015, ANCHOR_INSET = 0.07;
/** Thin columns: em (× short side), pitch (× em), tracking (em). */
const COLUMN_EM = 0.056, COLUMN_PITCH = 2.15, COLUMN_TRACKING = 0.08;
const COLUMN_SPEEDS: readonly number[] = [2, 1, 3, 2, 1, 2, 3, 1];
/** Clear zone around each anchor: horizontal and vertical padding (× anchor em). */
const CLEAR_X = 0.24, CLEAR_Y = 0.2, EDGE_STRIP = 1.6;

// ---------------------------------------------------------------------------
// Shared vertical-column helpers (T10, T15, T51)
// ---------------------------------------------------------------------------

/** The repeat unit of a vertical column: the trimmed text plus "・" unless it already ends with a separator. */
export function columnUnitText(text: string, joiner = "・"): string {
  const trimmed = text.trim();
  const last = [...trimmed].pop() ?? "";
  return isMarqueeSeparator(last) || last === "　" ? trimmed : `${trimmed}${joiner}`;
}

export interface ColumnUnit {
  readonly text: string;
  readonly size: number;
  readonly tracking: number;
  /** Distance from one repeat to the next (column height plus the tracking between repeats). */
  readonly period: number;
  /** Outlines in column coordinates (x centred on the column axis, y from the repeat's top): text and separators apart. */
  readonly textPathD: string;
  readonly separatorPathD: string;
  readonly ink: GlyphBox;
  /** The laid-out cells (T51 styles single characters). */
  readonly glyphs: readonly VerticalGlyph[];
}

const columnCache = new Map<string, ColumnUnit>();

/** Lay out one vertical repeat once (cached). */
export function columnUnit(text: string, face: MotionFontSelector, size: number, tracking = 0): ColumnUnit {
  const layout = layoutVertical(text, { ...face, size, tracking });
  const key = `${face.font}\u0000${face.weight ?? ""}\u0000${layout.size}\u0000${layout.tracking}\u0000${text}`;
  const hit = columnCache.get(key);
  if (hit) return hit;
  let textPathD = "", separatorPathD = "";
  for (const glyph of layout.glyphs) {
    if (glyph.whitespace || !glyph.pathD) continue;
    const placed = translatePathD(glyph.pathD, 0, glyph.y);
    if (isMarqueeSeparator(glyph.char)) separatorPathD += placed; else textPathD += placed;
  }
  const ink = layout.inkBox ?? { x0: -layout.width / 2, y0: 0, x1: layout.width / 2, y1: Math.max(1, layout.height) };
  const unit: ColumnUnit = Object.freeze({
    text, size: layout.size, tracking: layout.tracking, period: Math.max(1, layout.height + layout.tracking * layout.size),
    textPathD: compactPathD(textPathD), separatorPathD: compactPathD(separatorPathD), ink: Object.freeze({ ...ink }), glyphs: layout.glyphs,
  });
  columnCache.set(key, unit);
  if (columnCache.size > 96) columnCache.delete(columnCache.keys().next().value!);
  return unit;
}

/**
 * Top y of every repeat that reaches [from, to] for a column scrolled by `travel`
 * repeats (repeat 0 tops at `anchor` when travel is whole). Positive travel moves
 * the content up (toward −y); only the fractional part is used, so whole-repeat
 * advances give the same list (seamless loops).
 */
export function columnRepeatStarts(unit: ColumnUnit, anchor: number, travel: number, from: number, to: number): number[] {
  const start = anchor - fraction(travel) * unit.period;
  const first = Math.ceil((from - unit.ink.y1 - start) / unit.period - 1e-9);
  const last = Math.floor((to - unit.ink.y0 - start) / unit.period + 1e-9);
  const starts: number[] = [];
  for (let repeat = first; repeat <= last; repeat += 1) starts.push(start + repeat * unit.period);
  return starts;
}

/** Whole repeats per loop for an energy: calm halves (at least 1), punchy and hype double, standard keeps. */
export function columnRepeatsForEnergy(repeats: number, amplitude: number): number {
  if (amplitude < 0.75) return Math.max(1, Math.ceil(repeats / 2));
  return amplitude >= 1.25 ? repeats * 2 : repeats;
}

/** The parts of [from, to] not covered by any zone's [y0, y1] (sorted, disjoint; overlapping zones are fine). */
export function visibleIntervals(from: number, to: number, zones: readonly Pick<GlyphBox, "y0" | "y1">[]): Array<[number, number]> {
  const covered = zones.map(zone => [Math.max(from, zone.y0), Math.min(to, zone.y1)] as [number, number])
    .filter(([y0, y1]) => y1 > y0).sort((a, b) => a[0] - b[0]);
  const visible: Array<[number, number]> = [];
  let cursor = from;
  for (const [y0, y1] of covered) {
    if (y0 > cursor) visible.push([cursor, y0]);
    cursor = Math.max(cursor, y1);
  }
  if (cursor < to) visible.push([cursor, to]);
  return visible;
}

/** One column of repeats on axis x (frame coordinates): text in `color`, separators in `separatorColor`. */
export function columnStrip(unit: ColumnUnit, x: number, starts: readonly number[], color: string, separatorColor: string): string[] {
  return starts.map(y => g({ transform: tf.translate(x, y) },
    unit.textPathD && path(unit.textPathD, { fill: color }), unit.separatorPathD && path(unit.separatorPathD, { fill: separatorColor })));
}

// ---------------------------------------------------------------------------
// T10
// ---------------------------------------------------------------------------

export interface VerticalAnchor {
  readonly pathD: string;
  /** Column axis x and the top of the rest position (frame px). */
  readonly x: number;
  readonly top: number;
  /** Ink box at rest (frame px). */
  readonly box: GlyphBox;
  /** Drift amplitude (px, signed): offset = drift · sin(2π u). */
  readonly drift: number;
}

export interface VerticalColumn {
  readonly x: number;
  /** Whole repeats per loop, signed (positive = up). */
  readonly repeatsPerLoop: number;
  /** Seeded starting phase (repeats). */
  readonly phase: number;
}

export interface VerticalTypographyPlan {
  readonly anchorSize: number;
  readonly anchors: readonly VerticalAnchor[];
  readonly anchorColor: string;
  readonly unit: ColumnUnit;
  readonly columns: readonly VerticalColumn[];
  readonly columnColor: string;
  /** Clear-zone padding around each anchor's ink box (px). */
  readonly clearX: number;
  readonly clearY: number;
}

export function verticalTypographyPlan(params: TextMotionParams, size: MotionFrameSize): VerticalTypographyPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const backdrop = textBackdrop(params);
  const anchorColor = textOnBackground(params.palette, backdrop);
  const columnColor = secondaryTone(params.palette, backdrop);
  const energy = energyProfile(params.energy);
  const anchorFace = textFace(params.font, 900), columnFace = textFace(params.font, 500);
  const anchorLines = (params.lines.length > 1 ? params.lines.slice(0, 2) : [params.lines[0]]).map(line => line.trim());
  const longest = Math.max(...anchorLines.map(line => [...line].length));
  const anchorSize = Math.min(ANCHOR_WIDTH * size.width, ANCHOR_HEIGHT * size.height, (ANCHOR_LENGTH * safe.height) / longest);
  const spread = anchorLines.length > 1 ? Math.max(ANCHOR_SPREAD * anchorSize, 0.09 * size.width) : 0;
  const driftAmplitude = ANCHOR_DRIFT * size.height * Math.min(1.4, energy.amplitude);
  const anchors: VerticalAnchor[] = anchorLines.map((line, index) => {
    const layout = layoutVertical(line, { ...anchorFace, size: anchorSize });
    const ink = layout.inkBox ?? { x0: -anchorSize / 2, y0: 0, x1: anchorSize / 2, y1: anchorSize };
    // Line 1 on the right, upper; line 2 on the left, lower. A single line stands centred.
    const x = anchorLines.length > 1 ? safe.cx + (index === 0 ? spread : -spread) : safe.cx;
    const inset = ANCHOR_INSET * size.height + driftAmplitude;
    const top = anchorLines.length > 1
      ? (index === 0 ? safe.y0 + inset - ink.y0 : safe.y1 - inset - ink.y1)
      : safe.cy - (ink.y0 + ink.y1) / 2;
    return {
      pathD: compactPathD(layout.pathD), x, top,
      box: { x0: x + ink.x0, y0: top + ink.y0, x1: x + ink.x1, y1: top + ink.y1 },
      drift: (index === 0 ? 1 : -1) * driftAmplitude,
    };
  });

  const unit = columnUnit(columnUnitText(params.lines.map(line => line.trim()).join("・")), columnFace, COLUMN_EM * short, COLUMN_TRACKING);
  const span = safe.width - unit.size;
  const count = Math.max(3, Math.floor(span / (COLUMN_PITCH * unit.size)) + 1);
  const pitch = span / (count - 1);
  const rng = createSeededRng(ID, params.seed, "columns");
  const speedOffset = rng.int(0, COLUMN_SPEEDS.length - 1);
  const columns: VerticalColumn[] = Array.from({ length: count }, (_, index) => {
    const repeats = columnRepeatsForEnergy(COLUMN_SPEEDS[(index + speedOffset) % COLUMN_SPEEDS.length], energy.amplitude);
    return { x: safe.x0 + unit.size / 2 + index * pitch, repeatsPerLoop: (index % 2 === 0 ? 1 : -1) * repeats, phase: rng.next() };
  });
  return { anchorSize, anchors, anchorColor, unit, columns, columnColor, clearX: CLEAR_X * anchorSize, clearY: CLEAR_Y * anchorSize };
}

export const T10_verticalTypography = defineTextMotion(ID, (params, t, size) => {
  const plan = verticalTypographyPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T10_LOOP_SECONDS);
  const sway = Math.sin(2 * Math.PI * u);

  // Clear zones follow the drifting anchors. A strip shorter than EDGE_STRIP cells between a zone and the frame
  // edge would only show fragments, so the zone reaches the edge instead; that is decided over the whole drift
  // range, never per frame, so nothing pops in or out.
  const edge = EDGE_STRIP * plan.unit.size;
  const zones: GlyphBox[] = [];
  const anchorParts: string[] = [];
  for (const anchor of plan.anchors) {
    const offset = anchor.drift * sway, reach = Math.abs(anchor.drift);
    const toTop = anchor.box.y0 - plan.clearY - reach < edge, toBottom = anchor.box.y1 + plan.clearY + reach > size.height - edge;
    zones.push({ x0: anchor.box.x0 - plan.clearX, y0: toTop ? -size.height : anchor.box.y0 + offset - plan.clearY,
      x1: anchor.box.x1 + plan.clearX, y1: toBottom ? 2 * size.height : anchor.box.y1 + offset + plan.clearY });
    anchorParts.push(path(anchor.pathD, { fill: plan.anchorColor, transform: tf.translate(anchor.x, anchor.top + offset) }));
  }
  // Every column a zone touches is cleared across its full width (never sliced lengthwise). The columns never
  // overlap, so their visible intervals are disjoint rectangles and one plain (nonzero) clip path holds them all.
  const halfWidth = Math.max(-plan.unit.ink.x0, plan.unit.ink.x1) + 1;
  let clipD = "";
  for (const column of plan.columns) {
    const covering = zones.filter(zone => zone.x0 < column.x + halfWidth && zone.x1 > column.x - halfWidth);
    for (const [y0, y1] of visibleIntervals(-size.height, 2 * size.height, covering)) {
      clipD += rectPathD(column.x - halfWidth, y0, 2 * halfWidth, y1 - y0, 2);
    }
  }
  if (!clipD) return doc.render(anchorParts);
  const clip = doc.clipPath(path(clipD));
  const columnParts = plan.columns.flatMap(column => {
    const starts = columnRepeatStarts(plan.unit, 0, column.repeatsPerLoop * u + column.phase, 0, size.height);
    return columnStrip(plan.unit, column.x, starts, plan.columnColor, plan.columnColor);
  });
  return doc.render(g({ "clip-path": clip }, columnParts), anchorParts);
}, { revision: REVISION });
