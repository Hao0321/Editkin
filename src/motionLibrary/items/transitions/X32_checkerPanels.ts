import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicInOut, quadInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X32 Checker Panels: the frame is a grid of big square tiles (four across the short side:
 * 7 × 4 in landscape, 4 × 7 in portrait) that flip over about their vertical axes, rotateY
 * drawn as scaleX = cos θ, in a diagonal wave from a seeded corner. A tile's front face is A
 * (matte 0) and its back face is B (matte 1): as a tile turns, its face narrows to its centre
 * line and widens again as the other face, and the board behind it, in the deep shade
 * (accent2), shows at its sides. The back face carries a crisp deep-shade edge band round it
 * while it turns (16 px at 1080 × sin θ, so it narrows to nothing as the tile lands flat on
 * B); A's face is left untouched. The look is two flat tones, the accent card (B in the demo)
 * and its deep shade; there is no partial shading. Board slivers under 8 px and edge bands
 * under 4 px (at 1080) are not drawn, and a face under 20 px wide is drawn as board, so a tile
 * starting, finishing or passing edge-on leaves no thin line.
 *
 * Timing: the wave spans 0.86–0.92 of the duration (hype … calm; the curves run quart … sine
 * in-out), centred on D/2, and a flip lasts 1.9 diagonal steps, so at most two diagonals are
 * mid-flip at any instant. A tile switches from A to B in the matte on its own clock at the
 * instant it is edge-on, when the board covers its whole cell, so the switch is never visible.
 * The flips are centred symmetrically on D/2 over a symmetric grid, so B crosses half the frame
 * at D/2 (ART_DIRECTION §4): with an odd number of diagonal steps (both 16:9 formats) the two
 * middle diagonals switch just before and just after D/2 and B covers exactly half in between;
 * with an even number the middle diagonal switches at exactly D/2. Cells are whole pixels, so
 * neighbouring tiles meet without seams; every tile flips once (no flashing). Not directional
 * (the seed picks the wave's corner).
 */

const ID = "X32";
/**
 * Art revision (part of the clip cache key): 1 = first render (a wide, slow wave: many half-shaded tiles and hairline
 * slivers); 2 = a tight wave of quick flips, no slivers under 3 px; 3 = tiles switch on their own clock; 4 = Claude's
 * review (busy, thin slivers in dull mixed lavenders): four big tiles across the short side, a deep-shade board and a
 * crisp deep-shade edge on the back face instead of ink shading, and a wave at most two diagonals deep.
 */
const REVISION = 4;
/** Tiles across the frame's short side. */
const ACROSS = 4;
/** The back face's deep-shade edge band at its widest (px at 1080), scaled by sin θ. */
const EDGE = 16;
/** Board slivers narrower than this (px at 1080) are not drawn: they would read as stray hairlines. */
const MIN_SLIVER = 8;
/** A face narrower than twice this (px at 1080) is edge-on: the cell is all board. An edge band under MIN_EDGE is not drawn. */
const MIN_FACE = 10, MIN_EDGE = 4;
/** A flip lasts this many diagonal steps, so at most two diagonals are mid-flip at once. */
const DEPTH = 1.9;

interface FlipTiming { readonly wave: number; readonly ease: EasingFunction }
const TIMING: Record<MotionEnergy, FlipTiming> = {
  calm: { wave: 0.92, ease: sineInOut },
  standard: { wave: 0.9, ease: quadInOut },
  punchy: { wave: 0.88, ease: cubicInOut },
  hype: { wave: 0.86, ease: quartInOut },
};

/** Columns and rows of square-ish tiles, ACROSS along the short side. */
export function checkerGrid(size: MotionFrameSize): { readonly columns: number; readonly rows: number } {
  const cell = Math.min(size.width, size.height) / ACROSS;
  return { columns: Math.max(1, Math.round(size.width / cell)), rows: Math.max(1, Math.round(size.height / cell)) };
}

/** The wave's start corner (0 top left, 1 top right, 2 bottom right, 3 bottom left). */
export function checkerLayout(seed: number): { readonly corner: number } {
  return { corner: createSeededRng(ID, seed, "layout").int(0, 3) };
}

/** The wave over `last` diagonal steps: the spread of the flips' centres and one flip's length (fractions of the duration). */
export function checkerWave(last: number, energy: MotionEnergy): { readonly spread: number; readonly flip: number } {
  const { wave } = TIMING[energy];
  const spread = last > 0 ? wave / (1 + DEPTH / last) : 0;
  return { spread, flip: wave - spread };
}

/**
 * The flip of the tile on diagonal k of `last` at progress p: its own progress (0 … 1, edge-on at exactly 0.5; the
 * tile shows B from then on) and its angle θ (degrees, 0 = front face, 180 = back face). The flips are centred on
 * 0.5 + (k / last − 1/2) · spread.
 */
export function checkerFlip(k: number, last: number, p: number, energy: MotionEnergy): { readonly local: number; readonly theta: number } {
  const { spread, flip } = checkerWave(last, energy);
  const local = clamp01(0.5 + (p - (0.5 + (last > 0 ? k / last - 0.5 : 0) * spread)) / flip);
  return { local, theta: 180 * TIMING[energy].ease(local) };
}

export const X32_checkerPanels = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { columns, rows } = checkerGrid(size), last = columns + rows - 2;
  const { corner } = checkerLayout(params.seed), unit = frameUnit(size), minSliver = MIN_SLIVER * unit;
  let matteD = "", deep = "";
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.round((row * size.height) / rows), y1 = Math.round(((row + 1) * size.height) / rows);
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.round((column * size.width) / columns), x1 = Math.round(((column + 1) * size.width) / columns);
      // Diagonal index from the start corner.
      const k = (corner === 1 || corner === 2 ? columns - 1 - column : column) + (corner >= 2 ? rows - 1 - row : row);
      const { local, theta } = checkerFlip(k, last, p, params.energy);
      // Switched on the tile's own clock, not on θ, so a symmetric ease's rounding cannot move the edge-on instant.
      if (local >= 0.5) matteD += rectPathD(x0, y0, x1 - x0, y1 - y0, 0);
      if (theta <= 0 || theta >= 180) continue;
      // The face's half-width: the board shows on both sides of it.
      const radians = (theta * Math.PI) / 180, half = ((x1 - x0) / 2) * Math.abs(Math.cos(radians)), mid = (x0 + x1) / 2;
      // Edge-on (a face under 20 px wide): the whole cell is board, so no thin line of either face shows.
      if (half < MIN_FACE * unit) {
        deep += rectPathD(x0, y0, x1 - x0, y1 - y0, 0);
        continue;
      }
      if (mid - half - x0 >= minSliver) deep += rectPathD(x0, y0, mid - half - x0, y1 - y0, 2) + rectPathD(mid + half, y0, x1 - mid - half, y1 - y0, 2);
      // The back face (B) gets a crisp deep-shade edge round it while it turns; the front face (A) is left as it is.
      // A face whose interior between the two side edges would be under 20 px is all edge (no thin line of B between them).
      const band = Math.min(EDGE * unit * Math.sin(radians), half), edge = half - band < MIN_FACE * unit ? half : band;
      if (theta > 90 && edge >= MIN_EDGE * unit) {
        const left = mid - half, width = 2 * half, height = y1 - y0;
        deep += rectPathD(left, y0, edge, height, 2) + rectPathD(left + width - edge, y0, edge, height, 2)
          + rectPathD(left + edge, y0, width - 2 * edge, Math.min(edge, height / 2), 2)
          + rectPathD(left + edge, y1 - Math.min(edge, height / 2), width - 2 * edge, Math.min(edge, height / 2), 2);
      }
    }
  }
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(deep, { fill: params.palette.accent2 })),
  };
}, { revision: REVISION });
