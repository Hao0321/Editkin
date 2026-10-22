import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp, clamp01, cubicIn, cubicOut, quadIn, quadOut, quartOut, sineIn, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X03 Multi Stripe Wipe: 10–12 full-width horizontal stripes slide in alternately
 * from the left and the right (accent2 from one side, ink from the other; the
 * reference's accent is B in the demo convention), staggered top to bottom, until
 * they cover A. Under full cover B is switched in, and the stripes carry on
 * through and leave by the far side in the same top-to-bottom order, so B opens
 * in the mirrored zipper.
 *
 * Timing: the last stripe lands at 49% and the first leaves at 50% (spread + slide
 * = 0.49), so the frame is fully covered when the matte switches at exactly D/2
 * (ART_DIRECTION §4: full coverage, switch at 45–55%) and the full-cover beat
 * lasts about one frame at 0.5 s. Stripes enter with an ease-out and leave with
 * the matching ease-in (in → beat → out); energy sets the stagger and the curves
 * (calm sine, standard quad, punchy cubic, hype quart). Rows are whole pixels, so
 * neighbouring stripes meet without an antialiased seam. The seed swaps the sides
 * and the colours. Not directional (stripes come from both sides by design).
 */

const ID = "X03";
const REVISION = 1;
const SWITCH = 0.5;

interface StripeTiming {
  /** Delay of the last stripe after the first (fraction of the duration). */
  readonly spread: number;
  /** One stripe's slide in (and out), fraction of the duration. */
  readonly slide: number;
  readonly enter: EasingFunction;
  readonly exit: EasingFunction;
}

const quartIn: EasingFunction = p => clamp01(p) ** 4;
const TIMING: Record<MotionEnergy, StripeTiming> = {
  calm: { spread: 0.22, slide: 0.27, enter: sineOut, exit: sineIn },
  standard: { spread: 0.24, slide: 0.25, enter: quadOut, exit: quadIn },
  punchy: { spread: 0.27, slide: 0.22, enter: cubicOut, exit: cubicIn },
  hype: { spread: 0.3, slide: 0.19, enter: quartOut, exit: quartIn },
};

/** 10 stripes in landscape, 11 square, 12 portrait (thicker rows on wide frames would read as bars). */
export function multiStripeCount(size: MotionFrameSize): number {
  return clamp(Math.round(10 + (2 * (size.height / size.width - 9 / 16)) / (16 / 9 - 9 / 16)), 10, 12);
}

export const X03_multiStripeWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { spread, slide, enter, exit } = TIMING[params.energy];
  const count = multiStripeCount(size), width = size.width;
  const rng = createSeededRng(ID, params.seed, "layout");
  const sideFlip = rng.int(0, 1), colorFlip = rng.int(0, 1);
  const paths = ["", ""];
  for (let row = 0; row < count; row += 1) {
    const y0 = Math.round((row * size.height) / count), y1 = Math.round(((row + 1) * size.height) / count);
    const delay = (spread * row) / (count - 1);
    // Covered span measured from the stripe's entry side: [from, to].
    const from = p < SWITCH ? 0 : width * exit((p - SWITCH - delay) / slide);
    const to = p < SWITCH ? width * enter((p - delay) / slide) : width;
    if (!(to - from > 0.01)) continue;
    const fromLeft = (row + sideFlip) % 2 === 0;
    paths[(row + colorFlip) % 2] += rectPathD(fromLeft ? from : width - to, y0, to - from, y1 - y0, 2);
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(path(paths[0], { fill: params.palette.accent2 }), path(paths[1], { fill: params.palette.ink })),
  };
}, { revision: REVISION });
