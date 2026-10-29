import { mixHex } from "../../svg/color";
import { createSvgDocument, path, pathData, rectPathD } from "../../svg/document";
import { clamp, cubicInOut, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B15 Truchet Tiles (ART_DIRECTION §10, base C): quarter-circle Truchet tiles on the
 * cream card, as in the reference: a pale checker of the accent's tint under bold
 * arcs in ink and in the accent's deep shade. Each tile carries two quarter arcs
 * joining the midpoints of its edges, so the arcs link into a meandering maze. A
 * seeded share of the tiles rotates a quarter turn now and then: while a tile turns,
 * its arcs break away from their neighbours, and when it lands the maze has been
 * rerouted.
 *
 * Loop: a turning tile makes two quarter turns per cycle (180°, which maps a tile
 * with two same-coloured arcs onto itself), at its own seeded phases; one cycle per
 * loop at speed 1 (backgroundLoop). density sets the tile size. Energy sets how many
 * tiles turn; the seed sets the start pattern, the colours and the phases.
 */

const ID = "B15";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B15_LOOP_SECONDS = 4;
/** Turn cycles per loop at speed 1 (each turning tile makes two quarter turns per cycle). */
export const B15_LOOP_CYCLES = 1;
/** Tile size (authored px, 1080 short side). */
const BASE_TILE = 120;
/** Arc stroke width (× tile). */
const STROKE = 0.085;
/** Share of tiles that turn at standard energy; how much of the accent the light checker squares carry. */
const TURNING = 0.3, CHECKER_TINT = 0.24;
/** A quarter turn lasts this fraction of a cycle. */
const TURN = 0.14;
/** Share of tiles drawn in the deep shade (the rest in ink). */
const DEEP_SHARE = 0.4;

/** Rotation (in quarter turns, 0..2) of a turning tile at cycle phase `p`, with quarter turns starting at `a` and `a + 0.5`. */
export function tileTurns(p: number, a: number): number {
  const f = (((p - a) % 1) + 1) % 1;
  const first = cubicInOut(clamp(f / TURN, 0, 1));
  const second = cubicInOut(clamp((f - 0.5) / TURN, 0, 1));
  return first + second;
}

export const B15_truchetTiles = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const tile = (BASE_TILE * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B15_LOOP_SECONDS, B15_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const turning = clamp(TURNING * energyProfile(params.energy).amplitude, 0.15, 0.5);
  const rng = createSeededRng(ID, params.seed);
  const cx = size.width / 2, cy = size.height / 2;
  const columns = Math.ceil(cx / tile) + 1, rows = Math.ceil(cy / tile) + 1;
  const checker: string[] = [];
  const ink = pathData(2), deep = pathData(2);
  const r = tile / 2;

  for (let row = -rows; row < rows; row += 1) {
    for (let column = -columns; column < columns; column += 1) {
      const x0 = cx + column * tile, y0 = cy + row * tile;
      if (((row + column) & 1) === 0) checker.push(rectPathD(x0, y0, tile, tile, 2));
      // Seeded per tile, independent of the frame size's extra rows: a stream per cell.
      const cell = rng.fork(`${column},${row}`);
      const flipped = cell.chance(0.5), turns = cell.chance(turning), start = cell.next();
      const builder = cell.chance(DEEP_SHARE) ? deep : ink;
      const quarter = (flipped ? 1 : 0) + (turns ? tileTurns(p, start) : 0);
      const angle = (quarter * Math.PI) / 2, ca = Math.cos(angle), sa = Math.sin(angle);
      const mx = x0 + r, my = y0 + r;
      // Two arcs of radius r, centred on opposite corners; rotate their end points about the tile centre.
      const rot = (x: number, y: number) => [mx + x * ca - y * sa, my + x * sa + y * ca] as const;
      for (const [ex, ey] of [[-1, -1], [1, 1]] as const) {
        const [ax, ay] = rot(ex * r, 0), [bx, by] = rot(0, ey * r);
        // Short arc, negative-angle sweep: the circle centred on the corner (not the one through the tile centre).
        builder.M(ax, ay).A(r, r, 0, false, false, bx, by);
      }
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  const arc = (colour: string) => ({ fill: "none", stroke: colour, "stroke-width": STROKE * tile, "stroke-linecap": "round" });
  return doc.render(
    path(checker.join(""), { fill: mixHex(params.palette.paper, params.palette.accent, CHECKER_TINT) }),
    path(deep.toString(), arc(params.palette.accent2)),
    path(ink.toString(), arc(params.palette.ink)),
  );
}, { revision: REVISION, loopSeconds: B15_LOOP_SECONDS, loopCycles: B15_LOOP_CYCLES });
