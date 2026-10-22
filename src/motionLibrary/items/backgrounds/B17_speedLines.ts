import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B17 Speed Lines (ART_DIRECTION §10, base D): horizontal streaks race across the
 * dark card in seeded lanes, as in the reference: lines of every thickness from a
 * hairline to a bold bar, short and long, in the accent and in cream, with round
 * ends. Each lane runs at its own whole-number speed, so faster and slower lanes
 * slip past each other. Some lanes are left empty, so the field reads as speed, not
 * as a solid block. This one is meant to be loud (疾走・転換), but the lines stay thin
 * enough for a bold title on top.
 *
 * Loop: a line crosses the frame (plus its own length) a whole number of times per
 * cycle (1–3, seeded per lane); one cycle per loop at speed 1 (backgroundLoop).
 * density sets the lane pitch. Energy scales the line thickness; the seed sets the
 * lanes, their lengths, colours and speeds, and the direction.
 */

const ID = "B17";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B17_LOOP_SECONDS = 2;
/** Cycles per loop at speed 1 (each lane wraps 1–3 times per cycle). */
export const B17_LOOP_CYCLES = 1;
/** Lane pitch (authored px, 1080 short side). */
const BASE_LANE = 38;
/** Share of lanes left empty; share of lines in the accent (the rest cream). */
const EMPTY = 0.32, ACCENT_SHARE = 0.42;
/** Line thickness range (authored px, biased thin by THICK_BIAS) and length range (× frame width). */
const THIN = 2.2, THICK = 17, THICK_BIAS = 1.5, SHORT = 0.12, LONG = 0.75;
/** Share of lanes that carry a second streak half a lap behind the first. */
const DOUBLE = 0.35;

/** x of a line's tail for lane wraps `k`, cycle phase `p` and seeded offset (0..1), over a run of `span` px; direction ±1. */
export function laneX(p: number, k: number, offset: number, span: number, length: number, direction: 1 | -1): number {
  const travel = (((k * p + offset) % 1) + 1) % 1;
  return direction > 0 ? -length + travel * span : span - length - travel * span;
}

export const B17_speedLines = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const lane = (BASE_LANE * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B17_LOOP_SECONDS, B17_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const weight = clamp(energyProfile(params.energy).amplitude, 0.75, 1.3);
  const rng = createSeededRng(ID, params.seed);
  const direction = rng.sign();
  const cy = size.height / 2, rows = Math.ceil(cy / lane) + 1;
  const accent = pathData(1), paper = pathData(1);

  for (let row = -rows; row <= rows; row += 1) {
    // A stream per lane (by its index from the centre), so the lanes don't depend on the frame height.
    const laneRng = rng.fork(row);
    if (laneRng.chance(EMPTY)) continue;
    const y = cy + row * lane + laneRng.range(-0.18, 0.18) * lane;
    const k = laneRng.int(1, 3), offset = laneRng.next();
    const streaks = laneRng.chance(DOUBLE) ? 2 : 1;
    for (let streak = 0; streak < streaks; streak += 1) {
      const thickness = Math.min(0.6 * lane, (THIN + (THICK - THIN) * laneRng.next() ** THICK_BIAS) * unit * weight);
      const length = (SHORT + (LONG - SHORT) * laneRng.next() ** 1.6) * size.width * (streak ? 0.6 : 1);
      const builder = laneRng.chance(ACCENT_SHARE) ? accent : paper;
      // The line runs from fully off one edge to fully off the other (a cap's margin each side), so it is culled on
      // both sides of the wrap. A second streak trails by half a lap.
      const r = thickness / 2;
      const x = laneX(p, k, offset + streak * 0.5, size.width + length + 2 * thickness, length + thickness, direction);
      if (x >= size.width || x + length <= 0) continue;
      builder.M(x + r, y - r).H(x + length - r).A(r, r, 0, false, true, x + length - r, y + r).H(x + r).A(r, r, 0, false, true, x + r, y - r).Z();
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(paper.toString(), { fill: params.palette.paper }), path(accent.toString(), { fill: params.palette.accent }));
}, { revision: REVISION, loopSeconds: B17_LOOP_SECONDS, loopCycles: B17_LOOP_CYCLES });
