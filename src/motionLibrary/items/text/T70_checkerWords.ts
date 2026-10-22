import { g, path, roundRect, tf, transform } from "../../svg/document";
import { cubicInOut, loopPhase } from "../../svg/easing";
import { layoutLine } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { compactPathD, createTextDocument, readableColor, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";

/**
 * T70 Checker Words (市松翻轉), RHYTHM, shown on the accent plate: a checkerboard
 * of rounded tiles fills the title-safe box (near-square tiles, 4 along the short
 * side: 7 × 4 in landscape, 4 × 7 in portrait, 4 × 4 square), each holding the
 * character (several characters cycle through the tiles in reading order). Two
 * kinds alternate like 市松 (ichimatsu):
 * - tile A: an ink glyph on a teal tile (on the teal plate the tile is the plate);
 * - tile B: a teal glyph on a deep-teal tile.
 * A diagonal wave flips every tile once around its vertical axis (scaleX = |cos θ|,
 * θ 0 → 360°, cubicInOut over 0.6 s, a slight lift to 1.04 at edge-on), starting
 * 0.05 s later per column and 0.03 s later per row, so it rolls from the top-left
 * corner to the bottom-right. Faces swap at 90° and 270°: A shows its B face for the
 * middle of the turn and comes back as A (and B as A, then B). One wave every 2 s, a
 * seamless 2 s loop (catalog loopSeconds): every tile is at rest at t = 0 and at 2 s.
 *
 * Colours (ART_DIRECTION §0): the accent and its own deep shade; the deep tile is
 * the measured deep teal (accent2), which reads where the catalog's "ink at 25% over
 * the accent" would leave a teal glyph at 1.7:1. Glyphs on a tile take the readable
 * role for that tile (ink on teal; teal on deep teal, else cream). The glyph is
 * 62% of the tile and at least 9% of the short side. Energy does not change the
 * tempo; the board is the effect.
 */

const ID = "T70";
const REVISION = 1;
export const T70_LOOP_SECONDS = 2;
/** Flip duration, delay per column and per row (s), lift at edge-on. */
export const T70_FLIP = 0.6, T70_COLUMN_DELAY = 0.05, T70_ROW_DELAY = 0.03, T70_LIFT = 0.04;
/** Tiles along the short side; tile gap and corner (× tile), glyph ink (× tile), glyph floor (× short side). */
const SHORT_TILES = 4, GAP = 0.08, CORNER = 0.16, GLYPH_SHARE = 0.62, GLYPH_FLOOR = 0.092;

export interface CheckerTile {
  readonly index: number;
  readonly column: number;
  readonly row: number;
  /** Tile kind at rest: "A" (glyph on the accent) or "B" (glyph on the deep shade). */
  readonly kind: "A" | "B";
  readonly char: string;
  readonly pathD: string;
  /** Tile centre (frame px) and the glyph's pen offset from it (ink centred). */
  readonly cx: number;
  readonly cy: number;
  readonly penDx: number;
  readonly penDy: number;
}

export interface CheckerPlan {
  readonly columns: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly radius: number;
  readonly tiles: readonly CheckerTile[];
  readonly glyphHeight: number;
  /** Face colours: tile and glyph for A and for B. */
  readonly faceA: { readonly tile: string; readonly glyph: string };
  readonly faceB: { readonly tile: string; readonly glyph: string };
}

export function checkerDimensions(size: MotionFrameSize): { readonly columns: number; readonly rows: number } {
  const safe = titleSafeBox(size);
  const long = Math.max(safe.width, safe.height), short = Math.min(safe.width, safe.height);
  const longTiles = Math.max(SHORT_TILES, Math.round((SHORT_TILES * long) / short));
  return safe.width >= safe.height ? { columns: longTiles, rows: SHORT_TILES } : { columns: SHORT_TILES, rows: longTiles };
}

export function checkerPlan(params: TextMotionParams, size: MotionFrameSize): CheckerPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const { columns, rows } = checkerDimensions(size);
  const pitchX = safe.width / columns, pitchY = safe.height / rows;
  const tileWidth = pitchX * (1 - GAP), tileHeight = pitchY * (1 - GAP);
  const chars = params.lines.flatMap(text => [...text].filter(character => character.trim().length > 0));
  const face = textFace(params.font, 900);
  const probes = chars.map(character => layoutLine(character, { ...face, size: 100 }).glyphs[0].bbox!);
  const probeH = Math.max(...probes.map(box => box.y1 - box.y0)), probeW = Math.max(...probes.map(box => box.x1 - box.x0));
  const fontSize = Math.floor(Math.max(Math.min((GLYPH_SHARE * tileHeight) / probeH, (GLYPH_SHARE * tileWidth) / probeW) * 100,
    ((GLYPH_FLOOR * short) / probeH) * 100) * 1000) / 1000;
  const tiles: CheckerTile[] = [];
  let glyphHeight = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column, char = chars[index % chars.length];
      const glyph = layoutLine(char, { ...face, size: fontSize }).glyphs[0], box = glyph.bbox!;
      glyphHeight = Math.max(glyphHeight, box.y1 - box.y0);
      tiles.push({
        index, column, row, kind: (column + row) % 2 === 0 ? "A" : "B", char, pathD: compactPathD(glyph.pathD),
        cx: safe.x0 + (column + 0.5) * pitchX, cy: safe.y0 + (row + 0.5) * pitchY, penDx: -(box.x0 + box.x1) / 2, penDy: -(box.y0 + box.y1) / 2,
      });
    }
  }
  const { accent, accent2, ink, paper } = params.palette;
  return {
    columns, rows, tileWidth, tileHeight, radius: CORNER * Math.min(tileWidth, tileHeight), tiles, glyphHeight,
    faceA: { tile: accent, glyph: textOnBackground(params.palette, accent) },
    faceB: { tile: accent2, glyph: readableColor(accent2, [accent, paper, ink]) },
  };
}

/** Flip angle (degrees, 0 = rest … 360) of a tile at loop time u (seconds). */
export function tileAngle(tile: CheckerTile, u: number): number {
  const start = tile.column * T70_COLUMN_DELAY + tile.row * T70_ROW_DELAY;
  const p = (u - start) / T70_FLIP;
  if (p <= 0 || p >= 1) return 0;
  return 360 * cubicInOut(p);
}

/** The face a tile shows at a flip angle: its own kind while cos θ ≥ 0, the other one on the back. */
export function shownKind(tile: CheckerTile, degrees: number): "A" | "B" {
  const front = Math.cos((degrees * Math.PI) / 180) >= 0;
  return front === (tile.kind === "A") ? "A" : "B";
}

export const T70_checkerWords = defineTextMotion(ID, (params, t, size) => {
  const plan = checkerPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T70_LOOP_SECONDS) * T70_LOOP_SECONDS;
  const halfW = plan.tileWidth / 2, halfH = plan.tileHeight / 2;
  const resting: string[] = [], turning: string[] = [];
  for (const tile of plan.tiles) {
    const degrees = tileAngle(tile, u);
    const faceColors = shownKind(tile, degrees) === "A" ? plan.faceA : plan.faceB;
    const card = [
      roundRect(-halfW, -halfH, plan.tileWidth, plan.tileHeight, plan.radius, { fill: faceColors.tile }),
      path(tile.pathD, { fill: faceColors.glyph, transform: tf.translate(tile.penDx, tile.penDy) }),
    ];
    if (degrees === 0) { resting.push(g({ transform: tf.translate(tile.cx, tile.cy) }, card)); continue; }
    const radians = (degrees * Math.PI) / 180, scaleX = Math.abs(Math.cos(radians));
    if (scaleX < 0.01) continue;
    turning.push(g({ transform: transform(tf.translate(tile.cx, tile.cy), tf.scale(scaleX, 1 + T70_LIFT * Math.abs(Math.sin(radians)))) }, card));
  }
  // Turning tiles draw over resting ones (their lift can overlap the gap).
  return doc.render(g(undefined, resting), g(undefined, turning));
}, { revision: REVISION });
