import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase, pulse } from "../../svg/easing";
import { layoutLine } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { compactPathD, createTextDocument, textBackdrop, textFace, titleSafeBox } from "../shared";
import { inkCreamOnAccent } from "./T58_letterBounce";

/**
 * T62 Word Pulse Grid (脈衝字陣), PHYSICS, shown on the accent plate with ink
 * glyphs: a grid of small copies of the character (several characters cycle through
 * the cells in reading order) fills the title-safe box with near-square cells, 4
 * along the short side (7 × 4 in landscape, 4 × 7 in portrait, 4 × 4 square). Each
 * copy is sized so that at the full swell its ink fills at most 95% of its cell, so
 * a swollen copy never touches a neighbour's ink, even when two neighbours on the
 * same ring swell together (r1's 9 × 4 grid let them collide). A radial pulse
 * travels out from the centre at constant speed, like a ripple: each cell scales by
 * 1 + 1.3·bump(distance − front), where bump is a cosine window 1.5 cells wide,
 * and its colour turns from the text colour to the swell colour as it swells past
 * 35% (ink → cream on the violet card, cream → violet on the dark card). The turn is
 * a step, not a blend: any mix of ink and cream is a neutral grey that reads muddy on
 * the violet card, and the step happens while the copy grows fast, so it reads as the
 * copy lighting up. The front starts half a bump inside the nearest cell at t = 0
 * (the centre swells at once), crosses the farthest cell by 1.6 s and the grid rests
 * until the next pulse; one pulse every 2.1 s, a seamless 2.1 s loop (catalog
 * loopSeconds; every cell is exactly at rest at the seam). Swollen cells
 * draw on top. Copies are at least 9% of the short side tall at rest. Energy scales
 * the swell up to the room its cell has (hype saturates at 95% of the cell); the
 * tempo never changes.
 */

const ID = "T62";
/** Art revision (part of the clip cache key): 1 = first render; 2 = fewer, bigger cells so a full swell never overlaps a neighbour (Claude's p2j review). */
const REVISION = 2;
export const T62_LOOP_SECONDS = 2.1;
/** Peak extra scale, bump width (cells), front travel time (s). */
export const T62_SWELL = 1.3, T62_BUMP_WIDTH = 1.5, T62_TRAVEL = 1.6;
/** Swell at which the colour steps from the text colour to the swell colour. */
export const T62_COLOR_TURN = 0.35;
/** The largest share of its cell a fully swollen copy's ink may fill (both axes); the copy's rest size follows from it. */
export const T62_PEAK_FILL = 0.95;
/** Floor of the copy's ink height at rest (× short side). */
const GLYPH_FLOOR = 0.092;
/** Cells along the short side; the long side gets as many near-square cells as fit. */
const SHORT_CELLS = 4;

export interface PulseCell {
  readonly index: number;
  readonly column: number;
  readonly row: number;
  readonly char: string;
  readonly pathD: string;
  /** Cell centre (frame px) = the copy's ink centre; pen origin offset from it. */
  readonly cx: number;
  readonly cy: number;
  readonly penDx: number;
  readonly penDy: number;
  /** Ink half extents at rest (px). */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Distance from the frame centre in cells. */
  readonly distance: number;
}

export interface PulseGridPlan {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cells: readonly PulseCell[];
  /** Tallest copy ink height at rest (px). */
  readonly glyphHeight: number;
  /** Nearest and farthest cell distance (cells) and the swell multiplier (energy). */
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly swell: number;
  readonly restColor: string;
  readonly swellColor: string;
}

export function pulseGridDimensions(size: MotionFrameSize): { readonly columns: number; readonly rows: number } {
  const safe = titleSafeBox(size);
  const long = Math.max(safe.width, safe.height), short = Math.min(safe.width, safe.height);
  const longCells = Math.max(SHORT_CELLS, Math.round((SHORT_CELLS * long) / short));
  return safe.width >= safe.height ? { columns: longCells, rows: SHORT_CELLS } : { columns: SHORT_CELLS, rows: longCells };
}

export function pulseGridPlan(params: TextMotionParams, size: MotionFrameSize): PulseGridPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const { columns, rows } = pulseGridDimensions(size);
  const cellWidth = safe.width / columns, cellHeight = safe.height / rows;
  const chars = params.lines.flatMap(text => [...text].filter(character => character.trim().length > 0));
  const face = textFace(params.font, 900);
  // One size for every copy: at the standard full swell (× 2.3) the tallest ink fills 95% of the cell height and the
  // widest 95% of its width, so neighbours never touch; never below the 9% floor.
  const probes = chars.map(character => layoutLine(character, { ...face, size: 100 }).glyphs[0].bbox!);
  const probeH = Math.max(...probes.map(box => box.y1 - box.y0)), probeW = Math.max(...probes.map(box => box.x1 - box.x0));
  const peak = 1 + T62_SWELL;
  const roomSize = Math.min((T62_PEAK_FILL * cellHeight) / (peak * probeH), (T62_PEAK_FILL * cellWidth) / (peak * probeW)) * 100;
  // Rounded down to the 3 decimals the layout keeps, so the rounded size never exceeds the room.
  const fontSize = Math.floor(Math.max(roomSize, ((GLYPH_FLOOR * short) / probeH) * 100) * 1000) / 1000;
  const pitch = (cellWidth + cellHeight) / 2;
  const cells: PulseCell[] = [];
  let glyphHeight = 0, glyphWidth = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column, char = chars[index % chars.length];
      const glyph = layoutLine(char, { ...face, size: fontSize }).glyphs[0], box = glyph.bbox!;
      const cx = safe.x0 + (column + 0.5) * cellWidth, cy = safe.y0 + (row + 0.5) * cellHeight;
      glyphHeight = Math.max(glyphHeight, box.y1 - box.y0);
      glyphWidth = Math.max(glyphWidth, box.x1 - box.x0);
      cells.push({
        index, column, row, char, pathD: compactPathD(glyph.pathD), cx, cy,
        penDx: -(box.x0 + box.x1) / 2, penDy: -(box.y0 + box.y1) / 2, halfWidth: (box.x1 - box.x0) / 2, halfHeight: (box.y1 - box.y0) / 2,
        distance: Math.hypot(cx - safe.cx, cy - safe.cy) / pitch,
      });
    }
  }
  const [restColor, swellColor] = inkCreamOnAccent(params.palette, textBackdrop(params));
  // Energy scales the swell, capped where the fully swollen copy would fill more than 95% of its cell.
  const room = Math.min((T62_PEAK_FILL * cellHeight) / glyphHeight, (T62_PEAK_FILL * cellWidth) / glyphWidth) - 1;
  return {
    columns, rows, cellWidth, cellHeight, cells, glyphHeight,
    minDistance: Math.min(...cells.map(cell => cell.distance)), maxDistance: Math.max(...cells.map(cell => cell.distance)),
    swell: Math.max(0, Math.min(T62_SWELL * Math.min(1.5, energyProfile(params.energy).amplitude), room)), restColor, swellColor,
  };
}

/**
 * Pulse front (cells from the centre) at loop time u: half a bump inside the nearest cell at 0 (so the centre starts to swell
 * at once and is exactly at rest on the seam), half a bump past the farthest cell by T62_TRAVEL, then held there.
 */
export function pulseFront(plan: PulseGridPlan, u: number): number {
  const half = T62_BUMP_WIDTH / 2, from = plan.minDistance - half, to = plan.maxDistance + half;
  return from + (to - from) * Math.min(1, u / T62_TRAVEL);
}

/** Colour of a swelling cell: 0 (text colour) below 35% of the swell, 1 (swell colour) from it; never a grey blend. */
export function swellColorMix(swell: number): number {
  return swell >= T62_COLOR_TURN ? 1 : 0;
}

/** Swell 0..1 of a cell at loop time u (a cosine window 1.5 cells wide around the front; exactly 0 outside it). */
export function cellSwell(plan: PulseGridPlan, cell: PulseCell, u: number): number {
  return pulse(cell.distance, pulseFront(plan, u), T62_BUMP_WIDTH / 2);
}

export const T62_wordPulseGrid = defineTextMotion(ID, (params, t, size) => {
  const plan = pulseGridPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T62_LOOP_SECONDS) * T62_LOOP_SECONDS;
  const swells = plan.cells.map(cell => ({ cell, swell: cellSwell(plan, cell, u) }));
  // Resting copies first, the swollen ones on top (stable by index).
  const ordered = swells.filter(entry => entry.swell === 0).concat(swells.filter(entry => entry.swell > 0).sort((a, b) => a.swell - b.swell || a.cell.index - b.cell.index));
  const parts = ordered.map(({ cell, swell }) => {
    if (swell === 0) return path(cell.pathD, { fill: plan.restColor, transform: tf.translate(cell.cx + cell.penDx, cell.cy + cell.penDy) });
    return path(cell.pathD, {
      fill: swellColorMix(swell) === 1 ? plan.swellColor : plan.restColor,
      transform: transform(tf.translate(cell.cx, cell.cy), tf.scale(1 + plan.swell * swell), tf.translate(cell.penDx, cell.penDy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
