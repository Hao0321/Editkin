import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X14 Star Wipe: B is a five-point star window that grows out of the frame centre
 * while it turns a quarter turn (0 → 90°), led by a deep-shade (accent2) band of
 * even width that follows the star's outline, mitred into its points.
 *
 * Timing: the star's outer radius eases in from a point, R = R½ · (2p)^a, until the
 * star covers exactly half the frame at D/2 (R½ is solved from the exact
 * star–rectangle area at the D/2 angle, 45°; ART_DIRECTION §4: switch at 45–55%),
 * then carries on with a matched slope until the inner corners clear the frame
 * corners at D (inner radius 0.42 R ≥ half the diagonal). The turn follows an in-out
 * curve (calm sine … hype expo), so it is exactly 45° at D/2 for every energy. The
 * band is 6% of the half-diagonal × sin(π t / D) × √amplitude: zero at both ends
 * (t = 0 pure A, t = D pure B, empty overlay). It tucks 1.5 px (at 1080) under B,
 * so no sliver of A shows. The seed picks the turning direction. Not directional.
 */

const ID = "X14";
const REVISION = 1;
const POINTS = 5;
/** Inner radius as a fraction of the outer: a little fuller than a pentagram (0.382). */
const INNER = 0.42;
const TURN_DEGREES = 90;
const EASE_IN_POWER: Record<MotionEnergy, number> = { calm: 1.25, standard: 1.6, punchy: 1.9, hype: 2.2 };
const TURN_EASE: Record<MotionEnergy, EasingFunction> = { calm: sineInOut, standard: cubicInOut, punchy: quartInOut, hype: expoInOut };
/** Band width at full bell, as a fraction of the half-diagonal. */
const BAND = 0.06;
const TUCK = 1.5;

/** Star vertices (outer, inner, …), the first outer point at 12 o'clock turned by `degrees` (clockwise on screen). */
export function starPoints(cx: number, cy: number, outer: number, degrees: number): Point2[] {
  return Array.from({ length: 2 * POINTS }, (_, index) => {
    const radius = index % 2 === 0 ? outer : outer * INNER;
    const angle = ((degrees - 90 + (180 / POINTS) * index) * Math.PI) / 180;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  });
}

/** Mitred offset of a simple polygon: every edge moves `distance` px outward (negative: inward). */
export function offsetPolygon(points: readonly Point2[], distance: number): Point2[] {
  const count = points.length;
  let signed = 0;
  for (let index = 0; index < count; index += 1) {
    const [ax, ay] = points[index], [bx, by] = points[(index + 1) % count];
    signed += ax * by - bx * ay;
  }
  const side = signed > 0 ? 1 : -1;
  // Each edge i (point i → i + 1) as an offset line: a point on it and its direction.
  const lines = points.map((point, index) => {
    const next = points[(index + 1) % count];
    const dx = next[0] - point[0], dy = next[1] - point[1], length = Math.hypot(dx, dy) || 1;
    const nx = (side * dy) / length, ny = (-side * dx) / length;
    return { x: point[0] + nx * distance, y: point[1] + ny * distance, dx, dy, nx, ny };
  });
  return points.map((point, index) => {
    const a = lines[(index + count - 1) % count], b = lines[index];
    const cross = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(cross) < 1e-9) return [point[0] + b.nx * distance, point[1] + b.ny * distance] as const;
    const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / cross;
    return [a.x + a.dx * t, a.y + a.dy * t] as const;
  });
}

/** Sutherland–Hodgman clip of a polygon against the rectangle [x0, x1] × [y0, y1]. */
function clipToRect(points: readonly Point2[], x0: number, y0: number, x1: number, y1: number): Point2[] {
  const planes: Array<[(p: Point2) => boolean, (a: Point2, b: Point2) => Point2]> = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + ((x0 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + ((x1 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + ((y0 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + ((y1 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y1]],
  ];
  let output: Point2[] = [...points];
  for (const [inside, cut] of planes) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index], previous = input[(index + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(cut(previous, current));
        output.push(current);
      } else if (inside(previous)) output.push(cut(previous, current));
    }
    if (!output.length) break;
  }
  return output;
}

function polygonArea(points: readonly Point2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index], [bx, by] = points[(index + 1) % points.length];
    twice += ax * by - bx * ay;
  }
  return Math.abs(twice) / 2;
}

/** Exact area of the centred star (outer radius R, turned `degrees`) inside the frame. */
export function starAreaInFrame(outer: number, degrees: number, size: MotionFrameSize): number {
  if (!(outer > 0)) return 0;
  return polygonArea(clipToRect(starPoints(size.width / 2, size.height / 2, outer, degrees), 0, 0, size.width, size.height));
}

const geometryCache = new Map<string, { readonly half: number; readonly full: number }>();
/** R½ (half the frame covered at the D/2 angle of 45°) and the final R (inner corners clear the frame corners). */
function radii(size: MotionFrameSize): { readonly half: number; readonly full: number } {
  const key = `${size.width}x${size.height}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;
  const full = (Math.hypot(size.width, size.height) / 2 + 2) / INNER;
  const target = (size.width * size.height) / 2;
  let low = 0, high = full;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (starAreaInFrame(middle, TURN_DEGREES / 2, size) < target) low = middle; else high = middle;
  }
  const result = Object.freeze({ half: (low + high) / 2, full });
  geometryCache.set(key, result);
  if (geometryCache.size > 32) geometryCache.delete(geometryCache.keys().next().value!);
  return result;
}

/** Outer radius at progress p: ease-in to R½ at p = ½, then a slope-matched ease-out to the full radius. */
export function starRadius(p: number, half: number, full: number, power: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return full;
  if (p <= 0.5) return half * (2 * p) ** power;
  const x = 2 * p - 1, slope = (power * half) / (full - half);
  const shaped = slope >= 1 ? 1 - (1 - x) ** slope : slope * x + (1 - slope) * x * x;
  return half + (full - half) * shaped;
}

/** +1 turns clockwise, −1 counter-clockwise (seeded). */
export function starTurnSign(seed: number): 1 | -1 {
  return createSeededRng(ID, seed, "turn").sign();
}

export const X14_starWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const cx = size.width / 2, cy = size.height / 2;
  const { half, full } = radii(size);
  const outer = starRadius(p, half, full, EASE_IN_POWER[params.energy]);
  // Turned 45° at D/2 whichever way it spins: the half-cover radius was solved at 45°, and the star is symmetric about its axis.
  const degrees = starTurnSign(params.seed) * TURN_DEGREES * TURN_EASE[params.energy](p);
  const star = starPoints(cx, cy, outer, degrees);
  const band = BAND * (Math.hypot(size.width, size.height) / 2) * Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  const tuck = TUCK * frameUnit(size);
  const bandPath = band > 0.05 && outer * INNER - tuck < Math.hypot(size.width, size.height) / 2
    ? polygonPathD(offsetPolygon(star, band), 2) + (outer * INNER > 8 * tuck ? polygonPathD(offsetPolygon(star, -tuck), 2) : "")
    : "";
  return {
    matte: matte.render(path(polygonPathD(star, 2), { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(bandPath, { fill: params.palette.accent2, "fill-rule": "evenodd" })),
  };
}, { revision: REVISION });
