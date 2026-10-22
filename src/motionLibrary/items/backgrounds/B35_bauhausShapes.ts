import { mixHex } from "../../svg/color";
import { circle, createSvgDocument, g, path, pathData, rectPathD, tf } from "../../svg/document";
import { backOut, clamp, loopPhase, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type MotionEnergy } from "../../types";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B35 Bauhaus Shapes (ART_DIRECTION §10; base C, as the reference card is cream):
 * a grid of square Bauhaus tiles on a cream card with a faint checker, as in the
 * reference. Each tile holds one bold shape: an accent disc, an ink quarter disc
 * swung from one corner, or an accent half disc sitting on an ink bar. Tiles turn
 * a quarter turn now and then with a quick, springy snap, each at its own moment,
 * so the pattern keeps rearranging while most of the grid holds still. Discs are
 * round and never turn.
 *
 * Loop: a turning tile turns four quarter turns per cycle (one in each quarter of
 * the cycle, at a seeded moment), so it is back where it started; one cycle per loop
 * at speed 1 (backgroundLoop). density sets the tile size (3 tiles across the short
 * side at density 1). Energy sets the snap (calm glide, standard, punchy and hype
 * overshoot); the seed sets the shapes, their corners and turn moments.
 */

const ID = "B35";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B35_LOOP_SECONDS = 4;
/** Cycles per loop at speed 1 (a turning tile makes four quarter turns per cycle). */
export const B35_LOOP_CYCLES = 1;
/** Tiles across the short side at density 1. */
const BASE_TILES = 3;
/** Shape sizes (× tile): disc radius, quarter-disc inset, half disc radius, bar depth (× half disc radius). */
const DISC = 0.4, INSET = 0.08, HALF = 0.4, BAR = 0.8;
/** Share of tiles that turn; length of one quarter turn (× a quarter of the cycle). */
const TURNING = 0.55, TURN = 0.36;
/** Checker: every other tile is the cream mixed this far toward ink. */
const CHECKER = 0.07;

const SNAP: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: p => backOut(p, 1.4),
  punchy: p => backOut(p, 2.1),
  hype: p => backOut(p, 2.8),
};

export type BauhausShape = "disc" | "quarter" | "half";

export interface BauhausTile {
  readonly shape: BauhausShape;
  /** Starting orientation in quarter turns. */
  readonly quarter: number;
  /** +1 clockwise, -1 counter-clockwise, 0 still. */
  readonly turn: -1 | 0 | 1;
  /** Turn moment within each quarter of the cycle, 0 … 1 − TURN. */
  readonly moment: number;
}

/** Tiles across the short side at a density (3 at 1, 2 at 0.5–0.75, 6 at 2). */
export function bauhausTiles(density: number): number {
  return Math.max(2, Math.round(BASE_TILES * density));
}

/** The seeded tile at grid cell (column, row). */
export function bauhausTile(seed: number, column: number, row: number): BauhausTile {
  const rng = createSeededRng(ID, seed, `tile/${column},${row}`);
  const roll = rng.next();
  const shape: BauhausShape = roll < 0.3 ? "disc" : roll < 0.65 ? "quarter" : "half";
  const quarter = rng.int(0, 3);
  const turning = shape !== "disc" && rng.chance(TURNING / 0.7);
  const turn = turning ? rng.sign() : 0;
  return { shape, quarter, turn, moment: rng.range(0, 1 - TURN) };
}

/** Quarter turns completed by a turning tile at cycle phase p (whole quarters plus the eased part of the current one). */
export function bauhausQuarters(p: number, moment: number, ease: EasingFunction): number {
  const q = 4 * p - moment, whole = Math.floor(q), local = q - whole;
  return whole + ease(clamp(local / TURN, 0, 1));
}

export const B35_bauhausShapes = defineBackgroundMotion(ID, (params, t, size) => {
  const { loopSeconds, cycles } = backgroundLoop(B35_LOOP_SECONDS, B35_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const ease = SNAP[params.energy];
  const across = bauhausTiles(params.density);
  const tile = Math.min(size.width, size.height) / across;
  const columns = Math.ceil(size.width / tile), rows = Math.ceil(size.height / tile);
  // Centre the grid: any partial tiles are split evenly between opposite edges.
  const x0 = (size.width - columns * tile) / 2, y0 = (size.height - rows * tile) / 2;
  const { paper, ink, accent } = params.palette;
  const checker = pathData(2);
  const still: string[] = [], turning: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = x0 + column * tile, top = y0 + row * tile, cx = left + tile / 2, cy = top + tile / 2;
      if ((column + row) % 2 === 1) checker.M(left, top).H(left + tile).V(top + tile).H(left).Z();
      const spec = bauhausTile(params.seed, column, row);
      if (spec.shape === "disc") {
        still.push(circle(cx, cy, DISC * tile, { fill: accent }));
        continue;
      }
      // Draw the shape upright about the tile centre, then rotate it: the start orientation plus the turns so far.
      // Whole turns are dropped (mod 360), so the end of the loop draws exactly what the start did.
      const quarters = spec.quarter + spec.turn * bauhausQuarters(p, spec.moment, ease);
      const degrees = (((90 * quarters) % 360) + 360) % 360;
      let shape: string;
      if (spec.shape === "quarter") {
        // Ink quarter disc pivoting on the tile's lower-left corner (inset), reaching the opposite corner.
        const h = tile / 2 - INSET * tile, ax = cx - h, ay = cy + h, r = 2 * h;
        shape = path(pathData(2).M(ax, ay).V(ay - r).A(r, r, 0, false, true, ax + r, ay).Z().toString(), { fill: ink });
      } else {
        // Accent half disc on an ink bar: a dome whose flat side sits on the tile's centre line.
        const r = HALF * tile;
        shape = path(pathData(2).M(cx - r, cy).A(r, r, 0, false, true, cx + r, cy).Z().toString(), { fill: accent })
          + path(rectPathD(cx - r, cy, 2 * r, BAR * r, 2), { fill: ink });
      }
      (spec.turn === 0 ? still : turning).push(degrees === 0 ? shape : g({ transform: tf.rotate(degrees, cx, cy) }, shape));
    }
  }

  const doc = createSvgDocument(size, { background: paper });
  return doc.render(path(checker.toString(), { fill: mixHex(paper, ink, CHECKER) }), still, turning);
}, { revision: REVISION, loopSeconds: B35_LOOP_SECONDS, loopCycles: B35_LOOP_CYCLES });
