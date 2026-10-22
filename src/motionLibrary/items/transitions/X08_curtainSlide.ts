import { createSvgDocument, emptySvg, rect } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, quadIn, quadOut, quartOut, sineIn, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X08 Curtain Slide: two full-height curtain panels (accent2 and ink) slide in from
 * the left and right edges, accelerating, and slam together in the middle. The
 * front panel overshoots past the centre line (one hump, about 5% of a panel at
 * standard energy) and settles back; B is switched in while they are shut, then
 * the panels spring apart to the sides, decelerating, and reveal B from the centre.
 *
 * Timing: the panels accelerate in over 0–36% and meet, overshoot and settle over
 * 36–47%, sit shut until 50% where the matte switches under full cover
 * (ART_DIRECTION §4), and part over 50–96%. Energy sets the curves and the
 * overshoot (calm sine and 2% … hype quart and 12%). The back panel tucks 1.5 px (at
 * 1080) under the front one while they touch, so no antialiased seam opens on the
 * meeting line. The seed swaps the panel colours. Not directional (both sides move).
 */

const ID = "X08";
const REVISION = 1;
const SWITCH = 0.5;
const CONTACT = 0.36, SETTLE = 0.47, OPEN_END = 0.96;
const TUCK = 1.5;

const quartIn: EasingFunction = p => clamp01(p) ** 4;
interface CurtainTiming {
  readonly approach: EasingFunction;
  /** Peak overshoot of the front panel, as a fraction of a panel's width. */
  readonly overshoot: number;
  readonly part: EasingFunction;
}
const TIMING: Record<MotionEnergy, CurtainTiming> = {
  calm: { approach: sineIn, overshoot: 0.02, part: sineOut },
  standard: { approach: quadIn, overshoot: 0.05, part: quadOut },
  punchy: { approach: cubicIn, overshoot: 0.08, part: cubicOut },
  hype: { approach: quartIn, overshoot: 0.12, part: quartOut },
};

/** How far each panel reaches from its own edge, as a fraction of half the frame width (1 = shut). */
export function curtainReach(p: number, energy: MotionEnergy): number {
  const { approach, overshoot, part } = TIMING[energy];
  if (p <= 0) return 0;
  if (p < CONTACT) return approach(p / CONTACT);
  if (p < SETTLE) return 1 + overshoot * Math.sin((Math.PI * (p - CONTACT)) / (SETTLE - CONTACT));
  if (p < SWITCH) return 1;
  return 1 - part((p - SWITCH) / (OPEN_END - SWITCH));
}

export const X08_curtainSlide = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { width, height } = size, half = width / 2;
  const reach = half * curtainReach(p, params.energy);
  const backReach = reach >= half ? reach + TUCK * frameUnit(size) : reach;
  const [front, back] = createSeededRng(ID, params.seed, "layout").int(0, 1) === 0
    ? [params.palette.accent2, params.palette.ink] : [params.palette.ink, params.palette.accent2];
  const overlay = reach > 0.01
    ? createSvgDocument(size).render(rect(width - backReach, 0, backReach, height, { fill: back }), rect(0, 0, reach, height, { fill: front }))
    : emptySvg(size);
  return { matte: p < SWITCH ? matte.render() : allB(), overlay };
}, { revision: REVISION });
