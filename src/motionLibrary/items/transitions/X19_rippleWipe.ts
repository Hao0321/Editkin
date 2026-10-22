import { circleBezierPathD, createSvgDocument, emptySvg, path, rect } from "../../svg/document";
import { clamp01, energyProfile } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X19 Ripple Wipe: ripple rings spread from the frame centre like a drop hitting
 * water: one or two thin deep-shade (accent2) rings (seeded; two by default) run out
 * ahead, and the last ring is the one that floods: B fills it, edged by the same
 * deep-shade ring, so the rings read as outlines first and the last one as filled.
 * Each ring thins as it spreads (to 55% of its width at the frame corners), the
 * outer ones thinner than the inner, as ripples lose energy.
 *
 * Timing: B's radius eases in from a point, r = r½ · (2p)^a, until the disc covers
 * exactly half the frame at D/2 (r½ is solved from the exact circle–rectangle area;
 * ART_DIRECTION §4: switch at 45–55%), then carries on with a matched slope to the
 * frame corners at D. The leading rings run ahead of B in progress by lead and 2·lead
 * × sin(π t / D) (lead 0.1 × √amplitude), so they emerge with B, spread apart mid-wipe
 * and fold back onto B's edge at both ends; every ring's width also carries
 * sin(π t / D), so t = 0 is pure A and t = D pure B with an empty overlay. B's rim
 * tucks 1.5 px (at 1080) under B. Energy sets the ease-in power a (calm 1.25 … hype
 * 2.2) and the spread. Circles are four cubic Béziers. Not directional.
 */

const ID = "X19";
const REVISION = 1;
const EASE_IN_POWER: Record<MotionEnergy, number> = { calm: 1.25, standard: 1.6, punchy: 1.9, hype: 2.2 };
const LEAD = 0.1;
/** Ring widths at full bell (px at 1080): B's rim, then the leading rings outward. */
const RIM = 30, RINGS: readonly number[] = [20, 12];
/** A ring is this share of its width at the frame corners (it thins as it spreads). */
const THIN = 0.55;
const TUCK = 1.5;

/** Exact area of the circle (cx, cy, r) inside the frame (Simpson's rule on x = cx + r sin φ, which removes the end singularities). */
export function circleAreaInFrame(cx: number, cy: number, r: number, size: MotionFrameSize): number {
  if (!(r > 0)) return 0;
  const from = Math.asin(Math.max(-1, Math.min(1, (0 - cx) / r))), to = Math.asin(Math.max(-1, Math.min(1, (size.width - cx) / r)));
  if (!(to > from)) return 0;
  const steps = 256, h = (to - from) / steps;
  const f = (phi: number) => {
    const half = r * Math.cos(phi);
    return Math.max(0, Math.min(size.height, cy + half) - Math.max(0, cy - half)) * half;
  };
  let sum = f(from) + f(to);
  for (let index = 1; index < steps; index += 1) sum += f(from + index * h) * (index % 2 === 1 ? 4 : 2);
  return Math.max(0, (sum * h) / 3);
}

const geometryCache = new Map<string, { readonly half: number; readonly full: number }>();
/** r½ (B covers half the frame) and the final radius (the frame corners) for the centred disc. */
function radii(size: MotionFrameSize): { readonly half: number; readonly full: number } {
  const key = `${size.width}x${size.height}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;
  const cx = size.width / 2, cy = size.height / 2, full = Math.hypot(cx, cy);
  const target = (size.width * size.height) / 2;
  let low = 0, high = full;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (circleAreaInFrame(cx, cy, middle, size) < target) low = middle; else high = middle;
  }
  const result = Object.freeze({ half: (low + high) / 2, full });
  geometryCache.set(key, result);
  if (geometryCache.size > 32) geometryCache.delete(geometryCache.keys().next().value!);
  return result;
}

/** Radius at progress p: ease-in to r½ at p = ½, then a slope-matched ease-out to the full radius. */
export function rippleRadius(p: number, half: number, full: number, power: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return full;
  if (p <= 0.5) return half * (2 * p) ** power;
  const x = 2 * p - 1, slope = (power * half) / (full - half);
  const shaped = slope >= 1 ? 1 - (1 - x) ** slope : slope * x + (1 - slope) * x * x;
  return half + (full - half) * shaped;
}

/** Leading rings ahead of B: 2 or 1 (seeded; seed 1 gives 2). */
export function rippleRingCount(seed: number): number {
  return seed === 1 ? 2 : createSeededRng(ID, seed, "rings").int(1, 2);
}


export const X19_rippleWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const cx = size.width / 2, cy = size.height / 2;
  const { half, full } = radii(size);
  const power = EASE_IN_POWER[params.energy], amplitude = Math.sqrt(energyProfile(params.energy).amplitude);
  const radiusAt = (progress: number) => rippleRadius(clamp01(progress), half, full, power);
  const bell = Math.sin(Math.PI * p);
  const unit = frameUnit(size), tuck = TUCK * unit;
  const rB = radiusAt(p);
  /** A ring of nominal width `width` (px at 1080) on radius r: thinner as it spreads, never wider than its own radius. */
  const ringWidth = (width: number, r: number) => Math.min(r, width * unit * bell * (1 - (1 - THIN) * Math.min(1, r / full)));

  let rings = "";
  const rim = ringWidth(RIM, rB);
  if (rim > 0.05 && rB - tuck < full) rings += circleBezierPathD(cx, cy, rB + rim, 2) + circleBezierPathD(cx, cy, Math.max(0, rB - tuck), 2);
  for (let ring = 0; ring < rippleRingCount(params.seed); ring += 1) {
    const r = radiusAt(p + (ring + 1) * LEAD * amplitude * bell), width = ringWidth(RINGS[ring], r);
    if (width > 0.05 && r - width / 2 < full) rings += circleBezierPathD(cx, cy, r + width / 2, 2) + circleBezierPathD(cx, cy, Math.max(0, r - width / 2), 2);
  }
  return {
    matte: matte.render(path(circleBezierPathD(cx, cy, rB, 2), { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(rings, { fill: params.palette.accent2, "fill-rule": "evenodd" })),
  };
}, { revision: REVISION });
