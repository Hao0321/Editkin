import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp, clamp01, cubicIn, cubicOut, quadIn, quadOut, quartOut, sineIn, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X06 Bars Wipe: 10–12 vertical bars (paper and ink alternating, the reference's
 * cream and ink) grow up and down out of the frame's horizontal centre line until
 * they fill the frame. The stagger runs from the centre bars outward, so the
 * growing bars draw a widening diamond. Under full cover B is switched in, then
 * every bar splits at the centre line and retracts to the top and bottom edges,
 * again centre bars first, so B opens as a diamond from the middle.
 *
 * Timing: the outermost bars land at 49% and the centre bars split at 50% (spread
 * + grow = 0.49), so the frame is fully covered when the matte switches at exactly
 * D/2 (ART_DIRECTION §4) for about one frame at 0.5 s. Growth eases out, the split
 * eases in (in → beat → out); energy sets the stagger and curves (calm sine,
 * standard quad, punchy cubic, hype quart). Bar edges are whole pixels, so
 * neighbouring bars meet without a seam. The seed swaps the colours.
 * Not directional. In the A/B demo the paper bars are invisible over the paper A
 * until the switch; over footage both colours read.
 */

const ID = "X06";
const REVISION = 1;
const SWITCH = 0.5;

interface BarTiming {
  /** Delay of the outermost bars after the centre ones. */
  readonly spread: number;
  /** One bar's growth (and split), fraction of the duration. */
  readonly grow: number;
  readonly enter: EasingFunction;
  readonly exit: EasingFunction;
}

const quartIn: EasingFunction = p => clamp01(p) ** 4;
const TIMING: Record<MotionEnergy, BarTiming> = {
  calm: { spread: 0.2, grow: 0.29, enter: sineOut, exit: sineIn },
  standard: { spread: 0.22, grow: 0.27, enter: quadOut, exit: quadIn },
  punchy: { spread: 0.24, grow: 0.25, enter: cubicOut, exit: cubicIn },
  hype: { spread: 0.26, grow: 0.23, enter: quartOut, exit: quartIn },
};

/** 12 bars in landscape, 11 square, 10 portrait. */
export function barCount(size: MotionFrameSize): number {
  return clamp(Math.round(10 + (2 * (size.width / size.height - 9 / 16)) / (16 / 9 - 9 / 16)), 10, 12);
}

export const X06_barsWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { spread, grow, enter, exit } = TIMING[params.energy];
  const count = barCount(size), half = size.height / 2, middle = (count - 1) / 2;
  const innermost = count % 2 === 0 ? 0.5 : 0;
  const colorFlip = createSeededRng(ID, params.seed, "layout").int(0, 1);
  const paths = ["", ""];
  for (let bar = 0; bar < count; bar += 1) {
    const x0 = Math.round((bar * size.width) / count), x1 = Math.round(((bar + 1) * size.width) / count);
    const delay = middle > innermost ? (spread * (Math.abs(bar - middle) - innermost)) / (middle - innermost) : 0;
    const color = (bar + colorFlip) % 2;
    if (p < SWITCH) {
      const reach = half * enter((p - delay) / grow);
      if (reach > 0.01) paths[color] += rectPathD(x0, half - reach, x1 - x0, 2 * reach, 2);
    } else {
      const open = half * exit((p - SWITCH - delay) / grow);
      if (half - open > 0.01) paths[color] += rectPathD(x0, 0, x1 - x0, half - open, 2) + rectPathD(x0, half + open, x1 - x0, half - open, 2);
    }
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(path(paths[0], { fill: params.palette.paper }), path(paths[1], { fill: params.palette.ink })),
  };
}, { revision: REVISION });
