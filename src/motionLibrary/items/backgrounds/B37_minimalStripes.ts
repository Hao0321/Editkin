import { createSvgDocument, path, pathData } from "../../svg/document";
import { cubicInOut, lerp, loopPhase, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type MotionEnergy } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B37 Minimal Stripes (ART_DIRECTION §10, base D): three thick horizontal bands on
 * the dark card, accent, cream and the accent's deep shade from the top, as in the
 * reference. Each band is a row of long bars with wide gaps; the bands slide slowly
 * past one another, the accent and deep-shade rows one way and the cream row the
 * other, so the bars line up into one stacked block, drift into a staggered
 * brickwork and line up again. The bands sit as one group across the middle of the
 * frame, with open card above and below for a title.
 *
 * Loop: every band slides exactly one bar period per cycle (the bars repeat each
 * period), so the stack returns; two cycles per loop at speed 1 (backgroundLoop).
 * density sets the bar period (more, shorter bars at high density). Energy sets the
 * glide (calm steady, standard with a gentle settle, punchy and hype slide-and-hold);
 * the seed sets where the deep-shade row sits within its period.
 */

const ID = "B37";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B37_LOOP_SECONDS = 8;
/** Slide cycles per loop at speed 1 (each band moves one bar period per cycle). */
export const B37_LOOP_CYCLES = 2;
/** Bar period (× the frame's long side) at density 1, and the bar's share of it. */
const PERIOD = 0.62, BAR = 0.56;
/** Band thickness and the gap between bands (authored px at a 1080 short side), from the top. */
const BANDS = [
  { role: "accent", thickness: 128, direction: -1 },
  { role: "paper", thickness: 100, direction: 1 },
  { role: "accent2", thickness: 144, direction: -1 },
] as const;
const GAP = 46;
/** Band scale against the frame height: 1 in landscape, up to 1.5 in a tall frame (the bars stay long stripes). */
const TALL_SCALE = 1.5;
/** How much of the glide is eased toward a slide-and-hold (0 = steady). */
const SETTLE: Record<MotionEnergy, { mix: number; ease: EasingFunction }> = {
  calm: { mix: 0, ease: sineInOut },
  standard: { mix: 0.45, ease: sineInOut },
  punchy: { mix: 1, ease: sineInOut },
  hype: { mix: 1, ease: cubicInOut },
};

/** Band offset in periods at cycle phase p: whole periods plus the glide's eased fraction (0 … 1). */
export function stripeSlide(p: number, energy: MotionEnergy): number {
  const whole = Math.floor(p), local = p - whole, { mix, ease } = SETTLE[energy];
  return whole + lerp(local, ease(local), mix);
}

export const B37_minimalStripes = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size) * Math.min(TALL_SCALE, size.height / Math.min(size.width, size.height));
  const { loopSeconds, cycles } = backgroundLoop(B37_LOOP_SECONDS, B37_LOOP_CYCLES, params.speed);
  const slide = stripeSlide(cycles * loopPhase(t, loopSeconds), params.energy);
  const shift = createSeededRng(ID, params.seed).next();
  const period = (PERIOD * Math.max(size.width, size.height)) / params.density, bar = BAR * period;
  const total = BANDS.reduce((sum, band) => sum + band.thickness, 0) * unit + GAP * unit * (BANDS.length - 1);
  let top = (size.height - total) / 2;
  const parts: string[] = [];

  BANDS.forEach((band, index) => {
    const height = band.thickness * unit;
    // Offset in periods, wrapped to [0, 1): whole periods never change the numbers. The deep row is shifted by the seed.
    const offset = loopPhase(band.direction * slide + (index === 2 ? 0.5 + shift : 0), 1) * period;
    const builder = pathData(2);
    // Bars at offset + k·period; draw only those that touch the frame (strictly), so the count is stable across the seam.
    for (let k = -2; offset + k * period < size.width; k += 1) {
      const x = offset + k * period;
      if (x + bar <= 0) continue;
      builder.M(x, top).H(x + bar).V(top + height).H(x).Z();
    }
    parts.push(path(builder.toString(), { fill: params.palette[band.role] }));
    top += height + GAP * unit;
  });

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(parts);
}, { revision: REVISION, loopSeconds: B37_LOOP_SECONDS, loopCycles: B37_LOOP_CYCLES });
