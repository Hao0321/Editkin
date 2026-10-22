import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicInOut, quadInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X38 Grid Flip: the frame is a 3 × 3 grid of panels that flip over one after another in a seeded
 * order, rotateY drawn as scaleX = cos θ about each panel's vertical centre line. A panel's
 * front face is A (matte 0, left untouched) and its back face is B (matte 1), which carries a
 * crisp deep-shade (accent2) edge round it while it turns (22 px at 1080 × sin θ, narrowing to
 * nothing as it lands); the board behind the turning panel is the deep shade too. Two flat tones
 * only, no shading, and no thin lines: a face under 20 px wide is drawn as board, and edges
 * under 4 px and board slivers under 8 px (at 1080) are not drawn.
 *
 * Timing: the nine flips are centred evenly over the middle of the duration (the wave spans
 * 0.86–0.92 of it, calm … hype; the curves run sine … quart in-out) and each lasts 2.2 steps of
 * the order, so two or three panels are turning at once. A panel switches from A to B in the
 * matte on its own clock at the instant it is edge-on (the whole cell is board), and the fifth
 * panel in the order switches at exactly D/2, so B crosses half the frame there (4/9 → 5/9;
 * ART_DIRECTION §4). Cells are whole pixels; every panel flips once (no flashing). Not
 * directional (the seed sets the order).
 */

const ID = "X38";
const REVISION = 1;
const SIDE = 3;
const EDGE = 22, MIN_SLIVER = 8, MIN_FACE = 10, MIN_EDGE = 4;
/** A flip lasts this many steps of the order. */
const DEPTH = 2.2;

interface FlipTiming { readonly wave: number; readonly ease: EasingFunction }
const TIMING: Record<MotionEnergy, FlipTiming> = {
  calm: { wave: 0.92, ease: sineInOut },
  standard: { wave: 0.9, ease: quadInOut },
  punchy: { wave: 0.88, ease: cubicInOut },
  hype: { wave: 0.86, ease: quartInOut },
};

/** The seeded flip order: order[step] is the cell index (row-major) that flips at that step. */
export function gridFlipOrder(seed: number): number[] {
  const rng = createSeededRng(ID, seed, "order"), order = Array.from({ length: SIDE * SIDE }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

/** The flip at `step` of the order at progress p: its own progress (edge-on at exactly 0.5) and angle θ (degrees). */
export function gridFlip(step: number, p: number, energy: MotionEnergy): { readonly local: number; readonly theta: number } {
  const { wave, ease } = TIMING[energy], last = SIDE * SIDE - 1;
  const spread = wave / (1 + DEPTH / last), flip = wave - spread;
  const local = clamp01(0.5 + (p - (0.5 + (step / last - 0.5) * spread)) / flip);
  return { local, theta: 180 * ease(local) };
}

export const X38_gridFlip = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const unit = frameUnit(size), order = gridFlipOrder(params.seed);
  let matteD = "", deep = "";
  order.forEach((cell, step) => {
    const column = cell % SIDE, row = Math.floor(cell / SIDE);
    const x0 = Math.round((column * size.width) / SIDE), x1 = Math.round(((column + 1) * size.width) / SIDE);
    const y0 = Math.round((row * size.height) / SIDE), y1 = Math.round(((row + 1) * size.height) / SIDE);
    const { local, theta } = gridFlip(step, p, params.energy);
    if (local >= 0.5) matteD += rectPathD(x0, y0, x1 - x0, y1 - y0, 0);
    if (theta <= 0 || theta >= 180) return;
    const radians = (theta * Math.PI) / 180, half = ((x1 - x0) / 2) * Math.abs(Math.cos(radians)), mid = (x0 + x1) / 2;
    // Edge-on (a face under 20 px wide): the whole cell is board.
    if (half < MIN_FACE * unit) {
      deep += rectPathD(x0, y0, x1 - x0, y1 - y0, 0);
      return;
    }
    if (mid - half - x0 >= MIN_SLIVER * unit) deep += rectPathD(x0, y0, mid - half - x0, y1 - y0, 2) + rectPathD(mid + half, y0, x1 - mid - half, y1 - y0, 2);
    // B's face gets a crisp deep edge round it while it turns; a face whose interior would be under 20 px is all edge.
    const band = Math.min(EDGE * unit * Math.sin(radians), half), edge = half - band < MIN_FACE * unit ? half : band;
    if (theta > 90 && edge >= MIN_EDGE * unit) {
      const left = mid - half, width = 2 * half, height = y1 - y0, bar = Math.min(edge, height / 2);
      deep += rectPathD(left, y0, edge, height, 2) + rectPathD(left + width - edge, y0, edge, height, 2)
        + rectPathD(left + edge, y0, width - 2 * edge, bar, 2) + rectPathD(left + edge, y1 - bar, width - 2 * edge, bar, 2);
    }
  });
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(deep, { fill: params.palette.accent2 })),
  };
}, { revision: REVISION });
