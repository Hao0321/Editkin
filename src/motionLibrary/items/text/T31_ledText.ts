import { mixHex } from "../../svg/color";
import { circlePathD, g, path, roundRect } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { lineOutlines, sampleGlyphCells } from "../../svg/glyphCells";
import { layoutLine } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, readableColor, textFace, titleSafeBox } from "../shared";

/**
 * T31 LED Text (LED), SWITCH: a dot-matrix LED board. The line (lines joined
 * with 「・」, plus a trailing 「・」) is sampled onto the board's dot grid with the
 * glyph-cell sampler (svg/glyphCells: 16 dots to the em, Noto Sans TC 600, exactly
 * one dot between characters) and scrolls as a marquee in whole-dot steps, the way a
 * real LED sign steps. Every lit dot is a round accent LED with a hot paper-tinted
 * core; its glow is drawn as two larger translucent dots under it (no blur filter),
 * which merge into a soft halo around each stroke. Off dots stay visible but dim (the
 * deep shade, darkened toward the panel). The board is an ink panel in a thin raised
 * bezel, so the sign reads over footage and on any plate.
 *
 * Layout: in landscape and square frames the board is a horizontal sign, 18 dots tall
 * (16 for the em plus a dot of margin top and bottom), filling the title-safe width,
 * the text scrolling right to left; the em is up to 40% of the short side while at
 * least 3.3 characters stay visible. In a portrait frame a full-width (CJK) line is set
 * on a vertical sign instead, 18 dots wide, the text reading top to bottom and
 * scrolling upward (tategaki, as Japanese and Taiwanese LED signs do), so the
 * characters stay big (about 44% of the short side) and the sign fills the frame's
 * height. Text with proportional (Latin) glyphs always runs horizontally.
 *
 * A seamless 4 s loop (catalog loopSeconds): the scroll offset is
 * floor(phase × unit length), one whole text repeat per loop, so frame 0 equals the
 * frame at 4 s. Energy scales the glow, never the speed.
 */

const ID = "T31";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T31_LOOP_SECONDS = 4;
/** Dots per em, dots across the sign, largest em as a fraction of the short side (horizontal / vertical sign). */
export const T31_DOTS_PER_EM = 16, T31_ACROSS = 18, T31_EM = 0.4, T31_EM_VERTICAL = 0.5;
/** The sign always shows at least this many characters (em + its one-dot gap) along its length. */
export const T31_MIN_VISIBLE = 3.3;
/** Display weight sampled onto the grid (900 fills the counters at 16 dots per em). */
const WEIGHT = 600;
/** A dot is lit when the glyph covers this much of its cell. */
const LIT_COVERAGE = 0.42;
/** Dot radii as a fraction of the pitch: LED, hot core, inner and outer glow. */
const DOT = 0.4, CORE = 0.17, GLOW_INNER = 0.62, GLOW_OUTER = 0.9;
/** Glow opacities at standard energy. */
const GLOW_INNER_OPACITY = 0.3, GLOW_OUTER_OPACITY = 0.14;
/** Panel padding and corner radius (× pitch), bezel width (× pitch). */
export const T31_PAD = 0.9, T31_BEZEL = 0.32;
const CORNER = 0.9;
const FRAME = 2 * (T31_PAD + T31_BEZEL);
const SEPARATOR = "・";

export type LedOrientation = "horizontal" | "vertical";

export interface LedBoard {
  readonly orientation: LedOrientation;
  /** Dot pitch (px). */
  readonly pitch: number;
  /** Screen dot grid. */
  readonly columns: number;
  readonly rows: number;
  /** Top-left of dot (0, 0)'s cell (px). */
  readonly x0: number;
  readonly y0: number;
  /** Dots visible along the scroll axis, and dots in one text repeat along it. */
  readonly along: number;
  readonly unitLength: number;
  /** Lit dots of one text repeat as "u,v" keys: u along the scroll (0 = the repeat's start), v across (0..17). */
  readonly lit: ReadonlySet<string>;
  readonly unit: string;
  readonly colors: { readonly led: string; readonly core: string; readonly off: string; readonly panel: string; readonly bezel: string };
}

const sampleCache = new Map<string, { readonly lit: ReadonlySet<string>; readonly unitLength: number; readonly fullWidth: boolean }>();

/** The repeat unit: every line joined with 「・」, ending with 「・」. */
export function ledUnit(lines: readonly string[]): string {
  return lines.map(line => (line.endsWith(SEPARATOR) ? line : line + SEPARATOR)).join("");
}

/** Sample one repeat onto the dot grid (cached): horizontal pens advance by the glyph + one dot; vertical slots are 17 dots tall. */
function sampleUnit(unit: string, params: TextMotionParams, pitch: number, orientation: LedOrientation) {
  const face = textFace(params.font, WEIGHT);
  const key = `${face.font}\u0000${face.weight ?? ""}\u0000${pitch}\u0000${orientation}\u0000${unit}`;
  const hit = sampleCache.get(key);
  if (hit) return hit;
  const em = pitch * T31_DOTS_PER_EM;
  const line = layoutLine(unit, { ...face, size: em, kerning: false });
  const fullWidth = line.glyphs.every(glyph => Math.abs(glyph.advance - em) <= 0.02 * em);
  const base = lineOutlines(line, 0, 0);
  // Horizontal: the em box spans rows 1..16, one dot after every character. Vertical: glyph i fills rows 17i..17i+15, columns 1..16.
  const outlines = orientation === "horizontal"
    ? base.map((outline, index) => ({ ...outline, dx: (outline.dx ?? 0) + index * pitch, dy: pitch - line.emTop }))
    : base.map((outline, index) => ({ ...outline, dx: pitch, dy: index * (T31_DOTS_PER_EM + 1) * pitch - line.emTop }));
  const cells = sampleGlyphCells(outlines, { cellSize: pitch, minCoverage: LIT_COVERAGE });
  const lit = new Set<string>();
  for (const cell of cells) {
    const u = orientation === "horizontal" ? cell.column : cell.row, v = orientation === "horizontal" ? cell.row : cell.column;
    if (u >= 0 && v >= 0 && v < T31_ACROSS) lit.add(`${u},${v}`);
  }
  const unitLength = orientation === "horizontal"
    ? Math.max(1, Math.ceil((line.width + line.glyphs.length * pitch) / pitch - 1e-6))
    : line.glyphs.length * (T31_DOTS_PER_EM + 1);
  const value = { lit, unitLength, fullWidth };
  sampleCache.set(key, value);
  if (sampleCache.size > 24) sampleCache.delete(sampleCache.keys().next().value!);
  return value;
}

/** Vertical in portrait frames for full-width (CJK) text; horizontal otherwise. */
export function ledOrientation(params: TextMotionParams, size: MotionFrameSize): LedOrientation {
  if (!(size.height > size.width * 1.1)) return "horizontal";
  const unit = ledUnit(params.lines), face = textFace(params.font, WEIGHT);
  const line = layoutLine(unit, { ...face, size: 100, kerning: false });
  return line.glyphs.every(glyph => Math.abs(glyph.advance - 100) <= 2) ? "vertical" : "horizontal";
}

export function ledBoard(params: TextMotionParams, size: MotionFrameSize): LedBoard {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const orientation = ledOrientation(params, size);
  const vertical = orientation === "vertical";
  // The sign (dots + padding + bezel) fits the safe box, its em as large as allowed while 3.3 characters stay visible.
  const lengthRoom = vertical ? safe.height : safe.width, acrossRoom = vertical ? safe.width : safe.height;
  const pitch = Math.floor(Math.min(((vertical ? T31_EM_VERTICAL : T31_EM) * short) / T31_DOTS_PER_EM,
    acrossRoom / (T31_ACROSS + FRAME), lengthRoom / (T31_MIN_VISIBLE * (T31_DOTS_PER_EM + 1) + FRAME)) * 100) / 100;
  const along = Math.floor(lengthRoom / pitch - FRAME);
  const unit = ledUnit(params.lines);
  const sampled = sampleUnit(unit, params, pitch, orientation);
  const columns = vertical ? T31_ACROSS : along, rows = vertical ? along : T31_ACROSS;
  const panel = params.palette.ink;
  const led = readableColor(panel, [params.palette.accent, params.palette.paper]);
  return {
    orientation, pitch, columns, rows, along,
    x0: size.width / 2 - (columns * pitch) / 2, y0: size.height / 2 - (rows * pitch) / 2,
    unitLength: sampled.unitLength, lit: sampled.lit, unit,
    colors: { led, core: mixHex(led, params.palette.paper, 0.6), off: mixHex(panel, params.palette.accent2, 0.5), panel,
      bezel: mixHex(panel, params.palette.paper, 0.14) },
  };
}

/** Scroll offset (whole dots) at loop phase u: one text repeat per loop. */
export function ledOffset(board: LedBoard, u: number): number {
  return Math.min(board.unitLength - 1, Math.floor(u * board.unitLength + 1e-9));
}

/** Lit screen dots [column, row] at scroll offset `offset` (horizontal signs scroll left, vertical signs up). */
export function ledLitDots(board: LedBoard, offset: number): Array<readonly [number, number]> {
  const dots: Array<readonly [number, number]> = [];
  for (let along = 0; along < board.along; along += 1) {
    const source = (((along + offset) % board.unitLength) + board.unitLength) % board.unitLength;
    for (let across = 0; across < T31_ACROSS; across += 1) {
      if (board.lit.has(`${source},${across}`)) dots.push(board.orientation === "horizontal" ? [along, across] : [across, along]);
    }
  }
  return dots;
}

export const T31_ledText = defineTextMotion(ID, (params, t, size) => {
  const board = ledBoard(params, size);
  const glow = Math.min(1.6, energyProfile(params.energy).amplitude);
  const offset = ledOffset(board, loopPhase(t, T31_LOOP_SECONDS));
  const lit = ledLitDots(board, offset);
  const litKeys = new Set(lit.map(([column, row]) => `${column},${row}`));
  const { pitch, x0, y0 } = board;
  const centre = (column: number, row: number) => [x0 + (column + 0.5) * pitch, y0 + (row + 0.5) * pitch] as const;
  let off = "", led = "", core = "", inner = "", outer = "";
  for (let row = 0; row < board.rows; row += 1) {
    for (let column = 0; column < board.columns; column += 1) {
      if (litKeys.has(`${column},${row}`)) continue;
      const [cx, cy] = centre(column, row);
      off += circlePathD(cx, cy, DOT * pitch, 1);
    }
  }
  for (const [column, row] of lit) {
    const [cx, cy] = centre(column, row);
    outer += circlePathD(cx, cy, GLOW_OUTER * pitch, 1);
    inner += circlePathD(cx, cy, GLOW_INNER * pitch, 1);
    led += circlePathD(cx, cy, DOT * pitch, 1);
    core += circlePathD(cx, cy, CORE * pitch, 1);
  }
  const panelW = (board.columns + 2 * T31_PAD) * pitch, panelH = (board.rows + 2 * T31_PAD) * pitch;
  const px = size.width / 2 - panelW / 2, py = size.height / 2 - panelH / 2, bezel = T31_BEZEL * pitch;
  return createTextDocument(size, params).render(
    roundRect(px - bezel, py - bezel, panelW + 2 * bezel, panelH + 2 * bezel, (CORNER + T31_BEZEL) * pitch, { fill: board.colors.bezel }),
    roundRect(px, py, panelW, panelH, CORNER * pitch, { fill: board.colors.panel }),
    g(undefined,
      path(off, { fill: board.colors.off }),
      path(outer, { fill: board.colors.led, opacity: Math.min(1, GLOW_OUTER_OPACITY * glow) }),
      path(inner, { fill: board.colors.led, opacity: Math.min(1, GLOW_INNER_OPACITY * glow) }),
      path(led, { fill: board.colors.led }),
      path(core, { fill: board.colors.core })),
  );
}, { revision: REVISION });
