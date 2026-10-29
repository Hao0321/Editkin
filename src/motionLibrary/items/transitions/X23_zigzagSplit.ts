import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X23 Zigzag Split: a jagged zigzag boundary flows across the frame with B behind it,
 * and its teeth jitter like a crackling edge: every 1/12 s (a stepped "boil", in real
 * time) each tooth gets a new depth (55–100% of the tooth size) and its tip slides
 * up to a fifth of the pitch along the boundary. An ink band of the same jagged
 * profile rides just ahead of it, on A: the impact tone.
 *
 * Timing: the boundary's centre line runs ease(t / D) from just before the start edge
 * to just past the far edge. Every boil step the vertex offsets are re-centred so that
 * their exact (trapezoid) integral along the boundary is zero: the teeth add no area,
 * so B covers exactly the centre line's share of the frame, half at D/2
 * (ART_DIRECTION §4: switch at 45–55%), however the teeth jitter. Teeth are about 11%
 * of the short side apart (9 across 1080 px). The band is 4% of the travel length ×
 * sin(π t / D) × √amplitude, zero at both ends (t = 0 pure A, t = D pure B, empty
 * overlay), and tucks 1.5 px (at 1080) under B. Energy picks the curve (calm sine …
 * hype expo). The seed sets the teeth. Directions: all four (default left_to_right).
 */

const ID = "X23";
const REVISION = 1;
/** Tooth pitch as a fraction of the short side; tooth half-depth as a fraction of the pitch. */
const PITCH = 0.11, DEPTH = 0.42;
/** Boil steps per second of real time, and how far a tip may slide along the boundary (fraction of the pitch). */
const BOIL_HZ = 12, SLIDE = 0.2;
const BAND = 0.04;
const TUCK = 1.5;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};


/**
 * The zigzag at a boil step: vertices [u offset, v] from v = 0 to v = cross (valleys on even indices, tips on
 * odd ones), re-centred so that the trapezoid integral of the offsets over [0, cross] is exactly zero.
 */
export function zigzagProfile(seed: number, step: number, cross: number, short: number): Point2[] {
  const teeth = Math.max(3, Math.round(cross / (PITCH * short)));
  const pitch = cross / teeth, depth = DEPTH * pitch;
  const rng = createSeededRng(ID, seed, `boil:${step}`);
  const points: Point2[] = [];
  for (let index = 0; index <= 2 * teeth; index += 1) {
    const tip = index % 2 === 1;
    const v = (index * pitch) / 2 + (tip ? rng.range(-SLIDE, SLIDE) * pitch : 0);
    points.push([(tip ? 1 : -1) * depth * rng.range(0.55, 1), v]);
  }
  let integral = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    integral += ((points[index + 1][1] - points[index][1]) * (points[index][0] + points[index + 1][0])) / 2;
  }
  const shift = integral / cross;
  return points.map(([u, v]) => [u - shift, v] as const);
}

export const X23_zigzagSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size);
  const { length, cross } = frame;
  const unit = frameUnit(size), short = Math.min(size.width, size.height);
  const profile = zigzagProfile(params.seed, Math.floor(t * BOIL_HZ), cross, short);
  // A fixed bound on any vertex's offset (depth ≤ 1 × the half-depth, re-centring shift ≤ the same), so the centre
  // line's travel does not depend on the boil step: B only grows, and every tooth is off-frame at both ends.
  const reach = 2 * DEPTH * (cross / Math.max(3, Math.round(cross / (PITCH * short))));
  const centre = -reach + (length + 2 * reach) * EASING[params.energy](p);
  const pad = 4 * unit, back = -pad - 2 * reach;
  const line = (offset: number): Point2[] => [
    frame.toFrame(centre + offset + profile[0][0], -pad),
    ...profile.map(([u, v]) => frame.toFrame(centre + offset + u, v)),
    frame.toFrame(centre + offset + profile[profile.length - 1][0], cross + pad),
  ];

  const matteD = polygonPathD([...line(0), frame.toFrame(back, cross + pad), frame.toFrame(back, -pad)], 2);
  const band = BAND * length * Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  const bandD = band > 0.05 ? polygonPathD([...line(-TUCK * unit), ...line(band).reverse()], 2) : "";
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(bandD, { fill: params.palette.ink })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
