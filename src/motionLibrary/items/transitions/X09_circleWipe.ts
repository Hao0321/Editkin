import { createSvgDocument, emptySvg, fmt, path, rect } from "../../svg/document";
import { clamp01, energyProfile, lerp } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X09 Circle Wipe: B is a circle that grows from an off-centre point to cover the
 * frame, led by a thin accent2 ring (a slightly larger circle running ahead of B),
 * so the iris reads in two tones over footage.
 *
 * Centre: the seed picks a zone in rotation (seed 1 the lower-left third, then
 * upper right, lower right, upper left) and a seeded point inside it, so the circle
 * starts somewhere different each time.
 *
 * Timing: the radius eases in from a point, r = r½ · (2p)^a, until B covers exactly
 * half the frame at D/2 (r½ is solved from the exact circle–rectangle area;
 * ART_DIRECTION §4: switch at 45–55%), then carries on with a matched slope and
 * settles on the farthest corner at D. Energy sets the ease-in power a (calm 1.25
 * … hype 2.2) and the ring's width (5.5% of the final radius × sin(π t / D) ×
 * √amplitude, zero at both ends: t = 0 pure A, t = D pure B, empty overlay). The
 * ring tucks 1.5 px (at 1080) under B so no sliver of A shows. Circles are four
 * cubic Béziers (0.03% radial error). Not directional.
 */

const ID = "X09";
const REVISION = 1;
/** Seeded start zones as [x0, x1, y0, y1] fractions of the frame; seed 1 → lower-left third. */
const ZONES: readonly (readonly [number, number, number, number])[] = [
  [0.2, 0.34, 0.66, 0.82],
  [0.66, 0.8, 0.18, 0.34],
  [0.66, 0.8, 0.66, 0.82],
  [0.2, 0.34, 0.18, 0.34],
];
const EASE_IN_POWER: Record<MotionEnergy, number> = { calm: 1.25, standard: 1.6, punchy: 1.9, hype: 2.2 };
const RING = 0.055;
const TUCK = 1.5;
/** Cubic Bézier quarter-circle handle. */
const KAPPA = 0.5522847498307936;

/** Circle centre for a seed (frame px). */
export function circleWipeCentre(seed: number, size: MotionFrameSize): readonly [number, number] {
  const [x0, x1, y0, y1] = ZONES[(((seed - 1) % ZONES.length) + ZONES.length) % ZONES.length];
  const rng = createSeededRng(ID, seed, "centre");
  return [size.width * lerp(x0, x1, rng.next()), size.height * lerp(y0, y1, rng.next())];
}

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
/** r½ (B covers half the frame) and the final radius (the farthest corner) for a centre. */
function radii(cx: number, cy: number, size: MotionFrameSize): { readonly half: number; readonly full: number } {
  const key = `${size.width}x${size.height}@${fmt(cx)},${fmt(cy)}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;
  const full = Math.max(Math.hypot(cx, cy), Math.hypot(size.width - cx, cy), Math.hypot(cx, size.height - cy), Math.hypot(size.width - cx, size.height - cy));
  const target = (size.width * size.height) / 2;
  let low = 0, high = full;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (circleAreaInFrame(cx, cy, middle, size) < target) low = middle; else high = middle;
  }
  const result = Object.freeze({ half: (low + high) / 2, full });
  geometryCache.set(key, result);
  if (geometryCache.size > 64) geometryCache.delete(geometryCache.keys().next().value!);
  return result;
}

/** Radius at progress p: ease-in to r½ at p = ½, then a slope-matched ease-out to the full radius. */
export function circleWipeRadius(p: number, half: number, full: number, power: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return full;
  if (p <= 0.5) return half * (2 * p) ** power;
  const x = 2 * p - 1, slope = (power * half) / (full - half);
  const shaped = slope >= 1 ? 1 - (1 - x) ** slope : slope * x + (1 - slope) * x * x;
  return half + (full - half) * shaped;
}

/** Circle as four absolute cubic Béziers, clockwise in screen space. */
function circleD(cx: number, cy: number, r: number): string {
  const k = KAPPA * r, n = (value: number) => fmt(value, 2);
  return `M${n(cx + r)} ${n(cy)}C${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)}`
    + `C${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)}`
    + `C${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)}`
    + `C${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)}Z`;
}

export const X09_circleWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const [cx, cy] = circleWipeCentre(params.seed, size);
  const { half, full } = radii(cx, cy, size);
  const radius = circleWipeRadius(p, half, full, EASE_IN_POWER[params.energy]);
  const ring = RING * full * Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  const tuck = TUCK * frameUnit(size);
  const matteSvg = matte.render(path(circleD(cx, cy, radius), { fill: MATTE_SHOW_B }));
  const ringPath = ring > 0.05 ? circleD(cx, cy, radius + ring) + circleD(cx, cy, Math.max(0, radius - tuck)) : "";
  return { matte: matteSvg, overlay: createSvgDocument(size).render(path(ringPath, { fill: params.palette.accent2, "fill-rule": "evenodd" })) };
}, { revision: REVISION });
