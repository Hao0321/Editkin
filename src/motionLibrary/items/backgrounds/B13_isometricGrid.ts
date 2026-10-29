import { mixHex } from "../../svg/color";
import { createSvgDocument, path, pathData, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, cubicIn, energyProfile, loopPhase, smoothstep, spring } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B13 Isometric Grid (ART_DIRECTION §10, base D): a triangular line lattice on the
 * dark card, as in the reference: crisp cream lines at ±60° and quieter
 * horizontals in the accent's deep shade. Isometric cubes stand up out of it at
 * seeded cells: each cube's top face (the accent) lifts on a spring, so its cream
 * left face and shaded right face extrude out of the floor, overshoot and settle,
 * hold, then sink back and vanish. The cubes take turns, a few standing at once,
 * with the lattice open around them for a title.
 *
 * Loop: each cube rises and sinks once per cycle at its own seeded phase; the
 * timing is measured in cycle phase (the spring too), so speed is an exact rate.
 * One cycle per loop at speed 1 (backgroundLoop). density sets the lattice edge
 * (the cube count follows the area). Energy sets the spring's overshoot; the seed
 * picks the cells and the phases.
 */

const ID = "B13";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B13_LOOP_SECONDS = 4;
/** Rise-and-sink cycles per loop at speed 1. */
export const B13_LOOP_CYCLES = 1;
/** Lattice edge (authored px, 1080 short side). */
const BASE_EDGE = 84;
/** Line widths (authored px): the ±60° lines and the horizontals. */
const DIAGONAL_LINE = 1.8, HORIZONTAL_LINE = 1.6;
/** Cube footprint radius (× edge) and one cube per this many lattice cells (in edge² units). */
const CUBE = 0.86, CELLS_PER_CUBE = 30;
/** A cube's life, in fractions of a cycle: pop in, spring up, hold, sink by SINK_END, gone after. */
const POP = 0.05, SINK_START = 0.5, SINK_END = 0.62;
/** Seconds of spring per cycle (the spring runs on cycle phase × this, so every speed shows the same shape). */
const SPRING_SECONDS = 4;

/** Extrusion 0..~1.1 of a cube whose life phase is φ ∈ [0, 1) (0 = just appearing). */
export function cubeLift(phase: number, damping: number): number {
  if (phase >= SINK_END) return 0;
  const rise = spring(phase * SPRING_SECONDS, 170, damping);
  return phase < SINK_START ? rise : rise * (1 - cubicIn((phase - SINK_START) / (SINK_END - SINK_START)));
}

/** Footprint scale 0..1 of a cube at life phase φ (pops in, shrinks out after sinking). */
export function cubeScale(phase: number): number {
  return phase >= SINK_END ? 0 : smoothstep(0, POP, phase) * (1 - smoothstep(SINK_END - 0.03, SINK_END, phase));
}

export const B13_isometricGrid = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const edge = (BASE_EDGE * unit) / params.density;
  const h = (edge * Math.sqrt(3)) / 2;
  const { loopSeconds, cycles } = backgroundLoop(B13_LOOP_SECONDS, B13_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const damping = 26 / clamp(energyProfile(params.energy).amplitude, 0.75, 1.7) * 0.5;
  const rng = createSeededRng(ID, params.seed);
  const cx = size.width / 2, cy = size.height / 2;
  const reach = Math.hypot(cx, cy) + edge;

  // Three line families through the lattice centre, spaced h apart: a regular triangular lattice.
  const diagonals = pathData(2), horizontals = pathData(2);
  for (const degrees of [0, 60, 120]) {
    const a = (degrees * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const builder = degrees === 0 ? horizontals : diagonals;
    const count = Math.ceil(reach / h);
    for (let k = -count; k <= count; k += 1) {
      const px = cx + nx * k * h, py = cy + ny * k * h;
      builder.M(px - dx * reach, py - dy * reach).L(px + dx * reach, py + dy * reach);
    }
  }

  // Cube cells: lattice vertices, seeded, kept two edges apart; one per CELLS_PER_CUBE cells of area.
  const slots = Math.max(3, Math.round((size.width * size.height) / (edge * edge * CELLS_PER_CUBE)));
  const columns = Math.floor(cx / edge) - 1, rows = Math.floor(cy / h) - 1;
  const cells: Array<{ x: number; y: number; start: number }> = [];
  for (let attempt = 0; cells.length < slots && attempt < slots * 40; attempt += 1) {
    const j = rng.int(-rows, rows), i = rng.int(-columns, columns);
    const x = cx + (i + (j & 1 ? 0.5 : 0)) * edge, y = cy + j * h;
    if (cells.some(cell => Math.hypot(cell.x - x, cell.y - y) < 2.4 * edge)) continue;
    cells.push({ x, y, start: 0 });
  }
  // Stagger the cubes evenly through the cycle, in a seeded order (Fisher–Yates).
  const order = cells.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  order.forEach((index, rank) => { cells[index].start = (rank + rng.range(0, 0.6)) / cells.length; });

  const top: string[] = [], left: string[] = [], right: string[] = [];
  const shaded = mixHex(params.palette.paper, params.palette.bg, 0.32);
  for (const cell of [...cells].sort((a, b) => a.y - b.y)) {
    const phase = cycles * u - cell.start;
    const life = phase - Math.floor(phase);
    const scale = cubeScale(life);
    if (scale <= 0.001) continue;
    const r = CUBE * edge * scale, lift = cubeLift(life, damping) * r;
    const c30 = (Math.sqrt(3) / 2) * r;
    // The floor rhombus (the top face at lift 0); a full cube (lift = r) is a pointy-top hexagon centred on the cell.
    const at = (x: number, y: number, raised: boolean): Point2 => [cell.x + x, cell.y + y + r - (raised ? lift : 0)];
    const [T, UR, C, UL] = [at(0, -r, true), at(c30, -r / 2, true), at(0, 0, true), at(-c30, -r / 2, true)];
    const [URf, Cf, ULf] = [at(c30, -r / 2, false), at(0, 0, false), at(-c30, -r / 2, false)];
    top.push(polygonPathD([T, UR, C, UL], 2));
    // The side faces span the top face's lower edges and the same edges on the floor: nothing at lift 0.
    if (lift > 0.25) {
      left.push(polygonPathD([UL, C, Cf, ULf], 2));
      right.push(polygonPathD([C, UR, URf, Cf], 2));
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  const stroke = (colour: string, width: number) => ({ fill: "none", stroke: colour, "stroke-width": width * unit });
  return doc.render(
    path(horizontals.toString(), stroke(params.palette.accent2, HORIZONTAL_LINE)),
    path(diagonals.toString(), stroke(params.palette.paper, DIAGONAL_LINE)),
    path(left.join(""), { fill: params.palette.paper }),
    path(right.join(""), { fill: shaded }),
    path(top.join(""), { fill: params.palette.accent }),
  );
}, { revision: REVISION, loopSeconds: B13_LOOP_SECONDS, loopCycles: B13_LOOP_CYCLES });
