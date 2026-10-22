import { mixHex } from "../../svg/color";
import { g, path, roundRect, tf, transform } from "../../svg/document";
import { backOut, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { layoutLine, type GlyphBox, type LineLayout } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD, distinctFrom } from "./T09_hugeTextScroll";

/**
 * T11 Repeating Text (リピート波): a grid of the same word in a muted tone (the
 * text colour mixed 22% into the backdrop) fills the 5% title-safe box, one line
 * per row when several lines are given. A diagonal wave of colour inversion
 * travels from top-left to bottom-right: highlight h = smoothstep(0.45, 0.95,
 * sin(k·(col + row) − ωt)) with about 1.25 waves across the diagonal. As h rises,
 * the muted word is replaced by a pop card: an accent tile with the word inverted
 * to the tile's readable colour, scaling from 40% to full with a slight overshoot
 * over a narrow band of h (a few frames), so no frame shows a half-covered word;
 * the cell also swells up to 5% (energy scales the swell). Words are never clipped
 * by the frame.
 *
 * A seamless 2 s loop (catalog loopSeconds): the wave advances one period per
 * loop, so frame 0 equals the frame at 2 s.
 */

const ID = "T11";
const REVISION = 1;
export const T11_LOOP_SECONDS = 2;
/** Target word em (× short side) before fitting, gaps between words (em), tile padding around the ink (em). */
const TARGET_EM = 0.11, GAP_X = 0.5, GAP_Y = 0.44, TILE_PAD = 0.14, TILE_RADIUS = 0.12;
const MUTED = 0.26, WAVES_ACROSS = 1.25, EDGE_LOW = 0.45, EDGE_HIGH = 0.95, SWELL = 0.05;
/** Pop card: grows over h 0.12–0.55 from CARD_START of its size with a small backOut overshoot. */
const POP_LOW = 0.12, POP_HIGH = 0.55, TILE_OVERSHOOT = 1.1, CARD_START = 0.4;

export interface RepeatingCell {
  readonly column: number;
  readonly row: number;
  readonly layout: LineLayout;
  /** Pen origin of the word (frame px) and its ink box at rest. */
  readonly x: number;
  readonly baseline: number;
  readonly box: GlyphBox;
}

export interface RepeatingTextPlan {
  readonly fontSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly RepeatingCell[];
  readonly muted: string;
  readonly tile: string;
  readonly tileText: string;
  /** Radians per diagonal step. */
  readonly k: number;
  readonly swell: number;
}

export function repeatingTextPlan(params: TextMotionParams, size: MotionFrameSize): RepeatingTextPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const face = textFace(params.font, 900);
  const words = params.lines.map(line => line.trim());
  const tracking = displayTracking(words);
  const probes = words.map(word => layoutLine(word, { ...face, size: 100, tracking }));
  const inkOf = (layout: LineLayout): GlyphBox => layout.inkBox ?? { x0: 0, y0: -0.88 * layout.size, x1: Math.max(1, layout.width), y1: 0.12 * layout.size };
  const wordWidth = Math.max(...probes.map(probe => inkOf(probe).x1 - inkOf(probe).x0)) / 100;
  const wordHeight = Math.max(...probes.map(probe => inkOf(probe).y1 - inkOf(probe).y0)) / 100;
  // Columns and rows at the target size, then the largest em that fits them in the safe box.
  const target = TARGET_EM * short;
  const columns = Math.max(1, Math.floor((safe.width + GAP_X * target) / ((wordWidth + GAP_X) * target)));
  const rows = Math.max(2, Math.floor((safe.height + GAP_Y * target) / ((wordHeight + GAP_Y) * target)));
  // Fit with room for the swell, so a fully swollen edge word still sits inside the safe box.
  const swell = SWELL * energyProfile(params.energy).scaleDepth, room = 1 + swell;
  const em = Math.min(safe.width / room / (columns * wordWidth + (columns - 1) * GAP_X), safe.height / room / (rows * wordHeight + (rows - 1) * GAP_Y));
  const pitchX = (wordWidth + GAP_X) * em, pitchY = (wordHeight + GAP_Y) * em;
  const gridWidth = columns * wordWidth * em + (columns - 1) * GAP_X * em, gridHeight = rows * wordHeight * em + (rows - 1) * GAP_Y * em;
  const left = safe.cx - gridWidth / 2, top = safe.cy - gridHeight / 2;
  const cells: RepeatingCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    const layout = layoutLine(words[row % words.length], { ...face, size: em, tracking });
    const ink = inkOf(layout);
    for (let column = 0; column < columns; column += 1) {
      // Centre each word's ink in its cell (lines of different widths stay centred on the grid).
      const cx = left + column * pitchX + (wordWidth * em) / 2, cy = top + row * pitchY + (wordHeight * em) / 2;
      const x = cx - (ink.x0 + ink.x1) / 2, baseline = cy - (ink.y0 + ink.y1) / 2;
      cells.push({ column, row, layout, x, baseline, box: { x0: x + ink.x0, y0: baseline + ink.y0, x1: x + ink.x1, y1: baseline + ink.y1 } });
    }
  }
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const tile = distinctFrom(backdrop, params.palette.accent, [primary, params.palette.accent2]);
  return {
    fontSize: em, columns, rows, cells, muted: mixHex(backdrop, primary, MUTED), tile, tileText: textOnBackground(params.palette, tile),
    k: (2 * Math.PI * WAVES_ACROSS) / Math.max(1, columns + rows - 2), swell,
  };
}

/** Tile size (0..1) for a highlight: the tile pops over a narrow band of h, so a cell is rarely caught half-grown. */
export function repeatingTilePop(h: number): number {
  return smoothstep(POP_LOW, POP_HIGH, h);
}

/** Highlight of a cell at loop phase u (0..1): the wave crest moves toward larger col + row. */
export function repeatingHighlight(plan: RepeatingTextPlan, cell: Pick<RepeatingCell, "column" | "row">, u: number): number {
  return smoothstep(EDGE_LOW, EDGE_HIGH, Math.sin(plan.k * (cell.column + cell.row) - 2 * Math.PI * u));
}

export const T11_repeatingText = defineTextMotion(ID, (params, t, size) => {
  const plan = repeatingTextPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T11_LOOP_SECONDS);
  const pad = TILE_PAD * plan.fontSize, radius = TILE_RADIUS * plan.fontSize;
  const base: string[] = [], lit: string[] = [];
  for (const cell of plan.cells) {
    const h = repeatingHighlight(plan, cell, u);
    const cx = (cell.box.x0 + cell.box.x1) / 2, cy = (cell.box.y0 + cell.box.y1) / 2;
    const swell = 1 + plan.swell * h;
    const place = transform(swell !== 1 && tf.translate(cx, cy), swell !== 1 && tf.scale(swell), tf.translate(swell !== 1 ? cell.x - cx : cell.x, swell !== 1 ? cell.baseline - cy : cell.baseline));
    const word = compactPathD(cell.layout.pathD);
    // Pop card: the muted word is replaced by a complete card (tile + inverted word) that scales from 40% to full
    // with a slight overshoot in a few frames, so no frame shows a half-covered word.
    const pop = repeatingTilePop(h);
    if (pop < 0.01) { base.push(path(word, { fill: plan.muted, transform: place })); continue; }
    const grow = (CARD_START + (1 - CARD_START) * backOut(pop, TILE_OVERSHOOT)) * swell;
    const halfW = ((cell.box.x1 - cell.box.x0) / 2 + pad) * grow, halfH = ((cell.box.y1 - cell.box.y0) / 2 + pad) * grow;
    lit.push(roundRect(cx - halfW, cy - halfH, 2 * halfW, 2 * halfH, radius * grow, { fill: plan.tile }),
      path(word, { fill: plan.tileText, transform: transform(tf.translate(cx, cy), tf.scale(grow), tf.translate(cell.x - cx, cell.baseline - cy)) }));
  }
  return doc.render(g(undefined, base), g(undefined, lit));
}, { revision: REVISION });
