import { createSvgDocument, emptySvg, path, polygonPathD, rect } from "../../svg/document";
import { clamp01, cubicOut, expoOut, quadOut, quartOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X05 Slice Wipe: the frame is cut into an even number of parallelogram slices
 * leaning 20° (about 0.27 × the short side wide; 8 landscape, 6 portrait). Left to
 * right, each slice stabs in alternately from the top and the bottom as a blade in
 * one of the item's two tones, the deep shade (accent2) and paper (the reference's
 * accent and cream; accent is B itself in the demo), until the blades cover the
 * frame. Under full cover B
 * is switched in, and B floods in by the same stabs: each slice is taken over from
 * the end its blade came in, in the same left-to-right order. Slice ends are
 * horizontal, so a blade is a sharp-cornered parallelogram.
 *
 * Timing: blades land by 48% and the B stabs start at 50% (spread + stab = 0.48),
 * so the frame is fully covered when the matte switches at exactly D/2
 * (ART_DIRECTION §4); the B stabs end by 98%. Both phases use the same fast-attack
 * stab (calm quad … hype expo out). The matte is a clean switch and the overlay
 * carries the B fronts, so no matte edge is ever visible. Blades keep exact edges;
 * wherever two neighbouring blades sit side by side, a 3 px strip (at 1080) under
 * both hides the antialiased seam between them without a step where one ends. The seed
 * swaps which end the first slice enters from and the blade colours. Not
 * directional. In the A/B demo the paper blades are invisible over the paper A
 * until the switch; over footage both tones read.
 */

const ID = "X05";
/** Art revision (part of the clip cache key): 1 = first render (accent2 and a neutral grey, tucked blades); 2 = reference-palette pass: accent2 and paper blades, exact edges over seam strips. */
const REVISION = 2;
const SWITCH = 0.5;
const LEAN_DEGREES = 20;
/** Target slice width (at the frame's centre row) as a fraction of the short side. */
const SLICE_WIDTH = 0.27;
const TUCK = 1.5;

interface SliceTiming {
  /** Delay of the last slice after the first. */
  readonly spread: number;
  /** One stab (blade in, or B in), fraction of the duration. */
  readonly stab: number;
  readonly ease: EasingFunction;
}

const TIMING: Record<MotionEnergy, SliceTiming> = {
  calm: { spread: 0.2, stab: 0.28, ease: quadOut },
  standard: { spread: 0.22, stab: 0.26, ease: cubicOut },
  punchy: { spread: 0.24, stab: 0.24, ease: quartOut },
  hype: { spread: 0.26, stab: 0.22, ease: expoOut },
};

/** An even slice count (6 portrait, 8 landscape at 1080): the layout is symmetric under a half turn. */
export function sliceCount(size: MotionFrameSize): number {
  const lean = (size.height / 2) * Math.tan((LEAN_DEGREES * Math.PI) / 180);
  return Math.max(2, 2 * Math.round((size.width + 2 * lean) / (2 * SLICE_WIDTH * Math.min(size.width, size.height))));
}

export const X05_sliceWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { width, height } = size;
  const { spread, stab, ease } = TIMING[params.energy];
  const slant = Math.tan((LEAN_DEGREES * Math.PI) / 180), lean = (height / 2) * slant;
  const count = sliceCount(size), pitch = (width + 2 * lean) / count;
  const tuck = TUCK * frameUnit(size);
  const rng = createSeededRng(ID, params.seed, "layout");
  const endFlip = rng.int(0, 1), colorFlip = rng.int(0, 1);
  /** The band between boundary lines `left` and `right` (centre-row x) from y0 to y1. */
  const band = (left: number, right: number, y0: number, y1: number) => {
    const x = (base: number, y: number) => base + (height / 2 - y) * slant;
    return polygonPathD([[x(left, y0), y0], [x(right, y0), y0], [x(right, y1), y1], [x(left, y1), y1]], 2);
  };
  const boundary = (k: number) => -lean + k * pitch;

  // Each slice's blade as a [top, bottom] span (undefined when it has no blade this frame).
  const spans = Array.from({ length: count }, (_, k): readonly [number, number] | undefined => {
    const delay = (spread * k) / (count - 1);
    // Phase 1: the blade reaches `front` from its entry end. Phase 2: B has taken `front` from the same end; the blade keeps the rest.
    const front = height * ease((p - (p < SWITCH ? 0 : SWITCH) - delay) / stab);
    const [from, to] = p < SWITCH ? [0, front] : [front, height];
    if (!(to - from > 0.01)) return undefined;
    return (k + endFlip) % 2 === 0 ? [from, to] : [height - to, height - from];
  });
  const blades = ["", ""], seams = ["", ""];
  spans.forEach((span, k) => {
    if (!span) return;
    blades[(k + colorFlip) % 2] += band(boundary(k), boundary(k + 1), span[0], span[1]);
    // Where the next slice's blade sits beside this one, a strip under both hides the antialiased seam between them
    // (blades keep exact edges, so no step shows where a neighbour ends).
    const next = spans[k + 1];
    if (!next) return;
    const top = Math.max(span[0], next[0]), bottom = Math.min(span[1], next[1]);
    if (bottom - top > 0.01) seams[(k + colorFlip) % 2] += band(boundary(k + 1) - tuck, boundary(k + 1) + tuck, top, bottom);
  });
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(
      path(seams[0], { fill: params.palette.accent2 }), path(seams[1], { fill: params.palette.paper }),
      path(blades[0], { fill: params.palette.accent2 }), path(blades[1], { fill: params.palette.paper })),
  };
}, { revision: REVISION });
