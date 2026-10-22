import { mixHex } from "../../svg/color";
import { g, path, roundRect, tf, transform } from "../../svg/document";
import { backOut, clamp01, cubicOut, loopPhase, smoothstep } from "../../svg/easing";
import { layoutLine, type MotionFontSelector } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { compactPathD, createTextDocument, textOnBackground, titleSafeBox } from "../shared";

/**
 * T78 Text Mosaic (字體拼貼), MOOD, shown on the accent plate: a type specimen. A
 * 4 × 2 grid of rounded tiles (2 × 4 in portrait) in the gold, 8% darker than the
 * plate, each holding one character of line 1 (the first eight; a shorter line
 * repeats) in a different bundled CJK face: Noto Sans TC 900, Noto Serif TC 900,
 * Noto Sans TC 100, Noto Serif TC 200, LXGW WenKai TC 700, Noto Sans TC 500, Noto
 * Serif TC 500 and Noto Sans TC 300 (Bebas Neue and Fredoka have no CJK glyphs). The
 * font param does not apply: the faces are the item.
 *
 * A highlight steps round the grid every 0.3 s in a fixed order, clockwise along the
 * outside of the grid: the active tile darkens to 18% ink over 0.06 s and its
 * character pops 1.0 → 1.08 (backOut, 0.2 s), then eases back over 0.12 s when the
 * highlight moves on. Eight steps make a seamless 2.4 s loop (catalog loopSeconds);
 * every step starts on an exact 0.3 s beat.
 *
 * Colours: the tiles are the accent mixed toward ink (8% at rest, 18% active), the
 * glyphs ink, as in the reference; the tiles are drawn on every plate so the item
 * reads over footage too. Characters are about 62% of the tile and far above 9% of
 * the short side; the grid fills the title-safe box. Energy does not change the beat.
 */

const ID = "T78";
const REVISION = 1;
export const T78_LOOP_SECONDS = 2.4;
/** Beat (s), tile darkening at rest and active (share of ink), pop scale, darken / pop / release times (s). */
export const T78_STEP = 0.3, T78_REST_DARK = 0.08, T78_ACTIVE_DARK = 0.18, T78_POP = 1.08;
const DARKEN = 0.06, POP = 0.2, RELEASE = 0.12;
/** The eight faces, tile by tile in reading order. */
export const T78_FACES: readonly MotionFontSelector[] = Object.freeze([
  { font: "display", weight: 900 }, { font: "serif", weight: 900 }, { font: "display", weight: 100 }, { font: "serif", weight: 200 },
  { font: "hand", weight: 700 }, { font: "display", weight: 500 }, { font: "serif", weight: 500 }, { font: "display", weight: 300 },
]);
/** Tile share of its grid pitch, corner (× tile), glyph ink (× tile). */
const TILE = 0.9, CORNER = 0.12, GLYPH_SHARE = 0.62;

export interface MosaicTile {
  readonly index: number;
  readonly column: number;
  readonly row: number;
  readonly char: string;
  readonly face: MotionFontSelector;
  readonly pathD: string;
  readonly cx: number;
  readonly cy: number;
  /** Pen offset that centres the glyph's ink on the tile centre. */
  readonly penDx: number;
  readonly penDy: number;
  /** Step (0–7) at which the highlight reaches this tile. */
  readonly step: number;
  readonly inkHeight: number;
}

export interface MosaicPlan {
  readonly columns: number;
  readonly rows: number;
  readonly side: number;
  readonly radius: number;
  readonly tiles: readonly MosaicTile[];
  readonly restTile: string;
  readonly activeTile: string;
  readonly glyph: string;
}

/** Clockwise order round the outside of a columns × rows grid, starting top-left (every tile once when one side is 2). */
export function perimeterOrder(columns: number, rows: number): number[] {
  const order: number[] = [];
  for (let column = 0; column < columns; column += 1) order.push(column);
  for (let row = 1; row < rows; row += 1) order.push(row * columns + columns - 1);
  if (rows > 1) for (let column = columns - 2; column >= 0; column -= 1) order.push((rows - 1) * columns + column);
  if (columns > 1) for (let row = rows - 2; row >= 1; row -= 1) order.push(row * columns);
  return order;
}

export function mosaicPlan(params: TextMotionParams, size: MotionFrameSize): MosaicPlan {
  const safe = titleSafeBox(size), tall = size.height > size.width * 1.1;
  const columns = tall ? 2 : 4, rows = tall ? 4 : 2;
  const pitch = Math.min(safe.width / columns, safe.height / rows), side = TILE * pitch;
  const gridW = columns * pitch, gridH = rows * pitch;
  const chars = [...params.lines[0]].filter(character => character.trim().length > 0);
  const order = perimeterOrder(columns, rows);
  const tiles: MosaicTile[] = [];
  for (let index = 0; index < columns * rows; index += 1) {
    const column = index % columns, row = Math.floor(index / columns), char = chars[index % chars.length], face = T78_FACES[index];
    // Each face at the size that brings its ink to 62% of the tile (the faces' ink boxes differ).
    const probe = layoutLine(char, { ...face, size: 100 }).glyphs[0].bbox!;
    const fontSize = Math.floor(((GLYPH_SHARE * side) / Math.max(probe.y1 - probe.y0, probe.x1 - probe.x0)) * 100 * 1000) / 1000;
    const glyph = layoutLine(char, { ...face, size: fontSize }).glyphs[0], box = glyph.bbox!;
    tiles.push({
      index, column, row, char, face, pathD: compactPathD(glyph.pathD),
      cx: safe.cx - gridW / 2 + (column + 0.5) * pitch, cy: safe.cy - gridH / 2 + (row + 0.5) * pitch,
      penDx: -(box.x0 + box.x1) / 2, penDy: -(box.y0 + box.y1) / 2, step: order.indexOf(index), inkHeight: box.y1 - box.y0,
    });
  }
  const { accent, ink } = params.palette;
  return {
    columns, rows, side, radius: CORNER * side, tiles,
    restTile: mixHex(accent, ink, T78_REST_DARK), activeTile: mixHex(accent, ink, T78_ACTIVE_DARK), glyph: textOnBackground(params.palette, accent),
  };
}

export interface TileHighlight {
  /** 0 = rest colour … 1 = active colour; the glyph's scale. */
  readonly dark: number;
  readonly scale: number;
}

/** Highlight state of a tile at loop time u: its step starts at step·0.3 s; it darkens and pops, then releases. */
export function tileHighlight(tile: MosaicTile, u: number): TileHighlight {
  const since = ((u - tile.step * T78_STEP) % T78_LOOP_SECONDS + T78_LOOP_SECONDS) % T78_LOOP_SECONDS;
  if (since < T78_STEP) {
    return { dark: smoothstep(0, DARKEN, since), scale: 1 + (T78_POP - 1) * backOut(clamp01(since / POP)) };
  }
  const after = since - T78_STEP;
  if (after < RELEASE) {
    const k = 1 - cubicOut(after / RELEASE);
    return { dark: k, scale: 1 + (T78_POP - 1) * k };
  }
  return { dark: 0, scale: 1 };
}

export const T78_textMosaic = defineTextMotion(ID, (params, t, size) => {
  const plan = mosaicPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T78_LOOP_SECONDS) * T78_LOOP_SECONDS;
  const half = plan.side / 2;
  const parts = plan.tiles.map(tile => {
    const light = tileHighlight(tile, u);
    const fill = light.dark <= 0 ? plan.restTile : light.dark >= 1 ? plan.activeTile : mixHex(plan.restTile, plan.activeTile, light.dark);
    return g({ transform: tf.translate(tile.cx, tile.cy) },
      roundRect(-half, -half, plan.side, plan.side, plan.radius, { fill }),
      path(tile.pathD, { fill: plan.glyph, transform: transform(light.scale !== 1 && tf.scale(light.scale), tf.translate(tile.penDx, tile.penDy)) }));
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
