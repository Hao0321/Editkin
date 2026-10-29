import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { backIn, backOut, clamp01 } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X10 Block Wipe: the frame is a grid of near-square blocks (4 across the short
 * side: 7 × 4 landscape, 4 × 7 portrait, about 270 px at 1080). In a seeded random
 * order the blocks pop on over A (scale up from their centres with a back-out
 * overshoot) in a checkerboard of accent2 and ink (the reference's accent and ink)
 * until the frame is full. Under full cover B is switched in, then the blocks pop
 * off (a back-in wind-up, then shrink to nothing) in a second random order,
 * revealing B.
 *
 * Timing: the pops are spread so the last block lands before 47% and the first
 * leaves at 50%: the frame is fully covered when the matte switches at exactly
 * D/2 (ART_DIRECTION §4). At the reference's 0.5 s that is about 2 blocks per
 * frame; longer transitions slow the cadence toward the reference's 25 ms per
 * block. Grid lines are whole pixels and a settled block is exactly its cell, so
 * the full frame has no seams. Energy sets the pop length and overshoot. The seed
 * sets both orders and the checker phase. Not directional.
 */

const ID = "X10";
const REVISION = 1;
const SWITCH = 0.5;
/** Pop-ons finish by this fraction; pop-offs start at SWITCH and finish by SWITCH + the same span. */
const PHASE = 0.47;

interface PopTiming {
  /** One block's pop, fraction of the duration. */
  readonly pop: number;
  /** backOut / backIn overshoot parameter. */
  readonly overshoot: number;
}

const TIMING: Record<MotionEnergy, PopTiming> = {
  calm: { pop: 0.16, overshoot: 0.6 },
  standard: { pop: 0.13, overshoot: 1.4 },
  punchy: { pop: 0.12, overshoot: 1.8 },
  hype: { pop: 0.11, overshoot: 2.2 },
};

/** Columns and rows: 4 blocks across the short side, square-ish cells along the long side. */
export function blockGrid(size: MotionFrameSize): { readonly columns: number; readonly rows: number } {
  const cell = Math.min(size.width, size.height) / 4;
  return { columns: Math.max(1, Math.round(size.width / cell)), rows: Math.max(1, Math.round(size.height / cell)) };
}

function shuffled(count: number, seed: number, stream: string): number[] {
  const rng = createSeededRng(ID, seed, stream);
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

export const X10_blockWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { columns, rows } = blockGrid(size), count = columns * rows;
  const { pop, overshoot } = TIMING[params.energy];
  const step = count > 1 ? (PHASE - pop) / (count - 1) : 0;
  // rank[block] = its place in the pop-on (or pop-off) sequence.
  const rank = new Array<number>(count);
  shuffled(count, params.seed, p < SWITCH ? "on" : "off").forEach((block, place) => { rank[block] = place; });
  const checker = createSeededRng(ID, params.seed, "checker").int(0, 1);
  const paths = ["", ""];
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.round((row * size.height) / rows), y1 = Math.round(((row + 1) * size.height) / rows);
    for (let column = 0; column < columns; column += 1) {
      const block = row * columns + column;
      const x0 = Math.round((column * size.width) / columns), x1 = Math.round(((column + 1) * size.width) / columns);
      const local = p < SWITCH ? (p - rank[block] * step) / pop : (p - SWITCH - rank[block] * step) / pop;
      const scale = p < SWITCH ? (local <= 0 ? 0 : backOut(local, overshoot)) : 1 - backIn(local, overshoot * 0.6);
      if (!(scale > 0.002)) continue;
      const w = x1 - x0, h = y1 - y0;
      paths[(row + column + checker) % 2] += scale === 1 ? rectPathD(x0, y0, w, h, 2)
        : rectPathD(x0 + ((1 - scale) * w) / 2, y0 + ((1 - scale) * h) / 2, scale * w, scale * h, 2);
    }
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(path(paths[0], { fill: params.palette.accent2 }), path(paths[1], { fill: params.palette.ink })),
  };
}, { revision: REVISION });
