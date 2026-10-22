import { createSvgDocument, path, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B22 Stripe Twist (ART_DIRECTION §10, base A): vertical ribbons on the accent card,
 * as in the reference's yellow-and-black stripes. Each ribbon twists about its own
 * axis: its visible width is the ribbon width × |cos θ|, with θ running down the
 * frame and along time (θ = 2π(y / λ − t + phase)), so it pinches to a point,
 * opens out, and shows its other side. The front of a ribbon is ink, the back the
 * accent's deep shade. Neighbouring ribbons are slightly out of phase, so the twists
 * ripple across the frame in a diagonal wave.
 *
 * The ribbons are few and wide (9 across the frame at density 1, never more than 12),
 * so the pattern holds up after H.264 compression at phone size instead of shimmering.
 *
 * Loop: every twist travels one twist-length per cycle, one cycle per loop at speed 1
 * (backgroundLoop). density sets the ribbon count (6–12 across the frame width). Energy
 * scales the ribbon width; the seed sets the phases and the twist direction.
 */

const ID = "B22";
/** Art revision: 1 = first implementation (p2n-bg2); 2 = at most 12 wide ribbons across the frame (H.264-safe). */
const REVISION = 2;
export const B22_LOOP_SECONDS = 4;
/** Twist cycles per loop at speed 1. */
export const B22_LOOP_CYCLES = 1;
/** Ribbons across the frame width at density 1, the allowed range, and the full ribbon width (× spacing). */
const BASE_RIBBONS = 9, MIN_RIBBONS = 6, MAX_RIBBONS = 12, RIBBON = 0.62;
/** Twist length (× frame height) and the phase step between neighbouring ribbons (cycles). */
const TWIST = 1.6, STEP = 0.08;
/** Sampling step down a ribbon (authored px). */
const SAMPLE = 8;

/** Ribbons across the frame width for a density: 9 at density 1, between 6 and 12. */
export function ribbonCount(density: number): number {
  return Math.min(MAX_RIBBONS, Math.max(MIN_RIBBONS, Math.round(BASE_RIBBONS * density)));
}

/** Twist angle θ (radians) at height y01 (fraction of the frame), cycle phase p and ribbon phase φ; direction ±1. */
export function twistAngle(y01: number, p: number, phi: number, direction: 1 | -1): number {
  return 2 * Math.PI * (y01 / TWIST - direction * p + phi);
}

export const B22_stripeTwist = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const ribbons = ribbonCount(params.density);
  const spacing = size.width / ribbons;
  const { loopSeconds, cycles } = backgroundLoop(B22_LOOP_SECONDS, B22_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const half = (RIBBON * spacing * clamp(energyProfile(params.energy).amplitude, 0.85, 1.15)) / 2;
  const rng = createSeededRng(ID, params.seed);
  const direction = rng.sign(), phase = rng.next();
  const step = SAMPLE * unit, samples = Math.ceil(size.height / step);
  const front: string[] = [], back: string[] = [];

  for (let column = 0; column < ribbons; column += 1) {
    const x = (column + 0.5) * spacing;
    const phi = phase + column * STEP;
    // Walk down the ribbon; close a lens-shaped polygon each time cos θ changes sign (the ribbon pinches to a point).
    let left: Point2[] = [], right: Point2[] = [], sign = 0;
    const flush = () => {
      if (left.length > 1) (sign > 0 ? front : back).push(polygonPathD([...left, ...right.reverse()], 1));
      left = []; right = [];
    };
    for (let sample = 0; sample <= samples; sample += 1) {
      const y = Math.min(size.height, sample * step);
      const c = Math.cos(twistAngle(y / size.height, p, phi, direction));
      const s = c >= 0 ? 1 : -1;
      if (sign !== 0 && s !== sign) {
        // The pinch point between this sample and the last: where cos θ crosses zero (linear estimate).
        const prevY = y - step, prevC = Math.cos(twistAngle(prevY / size.height, p, phi, direction));
        const yz = prevY + (step * prevC) / (prevC - c);
        left.push([x, yz]); right.push([x, yz]);
        flush();
        left.push([x, yz]); right.push([x, yz]);
      }
      sign = s;
      left.push([x - half * Math.abs(c), y]);
      right.push([x + half * Math.abs(c), y]);
    }
    flush();
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(path(back.join(""), { fill: params.palette.accent2 }), path(front.join(""), { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B22_LOOP_SECONDS, loopCycles: B22_LOOP_CYCLES });
