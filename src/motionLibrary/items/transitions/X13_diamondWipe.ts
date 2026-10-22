import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, energyProfile } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X13 Diamond Wipe: three diamonds (45° squares, |dx| + |dy| ≤ r) burst out of the
 * frame centre one behind the other: an ink wave, a deep-shade (accent2) wave, then
 * B itself. The two colour waves read as concentric diamond bands riding ahead of
 * B's edge, a tonal ramp from ink through the deep shade into the accent (seeded:
 * the two colour waves can swap).
 *
 * Timing: B's radius eases in from a point, r = r½ · (2p)^a, until the diamond
 * covers exactly half the frame at D/2 (r½ is solved from the exact
 * diamond–rectangle area; ART_DIRECTION §4: switch at 45–55%), then carries on with
 * a matched slope and settles on the frame corners (r = W/2 + H/2) at D. The waves
 * run ahead of B in progress by 2·lead and lead × sin(π t / D) (lead 0.09 × √amplitude),
 * so they emerge from the centre with B, open into bands mid-wipe and fold back onto
 * B's edge at both ends: t = 0 pure A, t = D pure B with an empty overlay. Energy sets
 * the ease-in power a (calm 1.25 … hype 2.2) and the band spread. Each band tucks
 * 1.5 px (at 1080) under the shape behind it, so no sliver of A shows. Not
 * directional.
 */

const ID = "X13";
const REVISION = 1;
const EASE_IN_POWER: Record<MotionEnergy, number> = { calm: 1.25, standard: 1.6, punchy: 1.9, hype: 2.2 };
/** Lead of the inner colour wave ahead of B in progress units at full bell; the outer wave leads by twice this. */
const LEAD = 0.09;
const TUCK = 1.5;
/** Bands thinner than this (px) are not drawn. */
const MIN_BAND = 0.05;

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

function diamondPoints(cx: number, cy: number, r: number): Point2[] {
  return [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
}

/** Exact area of the centred diamond of radius r (|dx| + |dy| ≤ r) inside the frame. */
export function diamondAreaInFrame(r: number, size: MotionFrameSize): number {
  if (!(r > 0)) return 0;
  return polygonArea(clipToRect(diamondPoints(size.width / 2, size.height / 2, r), 0, 0, size.width, size.height));
}

const geometryCache = new Map<string, { readonly half: number; readonly full: number }>();
/** r½ (B covers half the frame) and the final radius (the diamond through the frame corners). */
function radii(size: MotionFrameSize): { readonly half: number; readonly full: number } {
  const key = `${size.width}x${size.height}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;
  const full = size.width / 2 + size.height / 2;
  const target = (size.width * size.height) / 2;
  let low = 0, high = full;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (diamondAreaInFrame(middle, size) < target) low = middle; else high = middle;
  }
  const result = Object.freeze({ half: (low + high) / 2, full });
  geometryCache.set(key, result);
  if (geometryCache.size > 32) geometryCache.delete(geometryCache.keys().next().value!);
  return result;
}

/** Radius at progress p: ease-in to r½ at p = ½, then a slope-matched ease-out to the full radius. */
export function diamondRadius(p: number, half: number, full: number, power: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return full;
  if (p <= 0.5) return half * (2 * p) ** power;
  const x = 2 * p - 1, slope = (power * half) / (full - half);
  const shaped = slope >= 1 ? 1 - (1 - x) ** slope : slope * x + (1 - slope) * x * x;
  return half + (full - half) * shaped;
}

/** The colour waves outer → inner: [ink, accent2] or the seeded swap. */
export function diamondWaveRoles(seed: number): readonly ["ink" | "accent2", "ink" | "accent2"] {
  return createSeededRng(ID, seed, "waves").int(0, 1) === 0 ? ["ink", "accent2"] : ["accent2", "ink"];
}

export const X13_diamondWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const cx = size.width / 2, cy = size.height / 2;
  const { half, full } = radii(size);
  const power = EASE_IN_POWER[params.energy];
  const radiusAt = (progress: number) => diamondRadius(clamp01(progress), half, full, power);
  const lead = LEAD * Math.sqrt(energyProfile(params.energy).amplitude) * Math.sin(Math.PI * p);
  // Radii outer wave, inner wave, B.
  const rB = radiusAt(p), rInner = radiusAt(p + lead), rOuter = radiusAt(p + 2 * lead);
  const tuck = TUCK * frameUnit(size);
  const diamond = (r: number) => (r > 0 ? polygonPathD(diamondPoints(cx, cy, r), 2) : "");
  const band = (outer: number, inner: number) => (outer - inner > MIN_BAND && inner - tuck < full ? diamond(outer) + diamond(inner - tuck) : "");

  const [outerRole, innerRole] = diamondWaveRoles(params.seed);
  return {
    matte: matte.render(path(diamond(rB), { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(
      path(band(rOuter, rInner), { fill: params.palette[outerRole], "fill-rule": "evenodd" }),
      path(band(rInner, rB), { fill: params.palette[innerRole], "fill-rule": "evenodd" }),
    ),
  };
}, { revision: REVISION });
