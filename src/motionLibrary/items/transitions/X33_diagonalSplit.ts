import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X33 Diagonal Split: one straight split line sweeps across the frame while it turns, from 60°
 * to 75° off the travel axis (it stands up as it goes); B is on the side it has passed. A flat
 * accent band rides ahead of the line with a thin leading edge of the deep shade (accent2), so
 * the cut meets A as a crisp two-tone edge. The seed picks which way the line leans.
 *
 * Timing: the line's position is solved every frame (bisection on the exact clipped area) so
 * B covers ease(t / D) of the frame, exactly half at D/2 (ART_DIRECTION §4), and only grows.
 * The angle turns with a sine ease over the whole transition. The bands' widths swell as
 * sin(π t / D) (up to 16% and 2.2% of the short side), so they are gone at both ends: pure A
 * at t = 0, pure B at t = D. The accent band reaches 1.5 px (at 1080) behind the split, under
 * which the matte's antialiased edge is hidden, and 1.5 px under the deep edge. Energy sets the curve (calm sine … hype expo
 * in-out). Directional: the direction names the sweep (left to right by default).
 */

const ID = "X33";
const REVISION = 1;
const FROM_DEGREES = 60, TO_DEGREES = 75;
/** Band widths at full swell, as fractions of the short side (measured across the band). */
const ACCENT = 0.16, DEEP = 0.022;
const TUCK = 1.5;

const EASE: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

type HalfPlane = readonly [number, number, number];

/** Sutherland–Hodgman clip of a convex polygon by half-planes a·u + b·v ≤ c. */
function clip(points: readonly Point2[], planes: readonly HalfPlane[]): Point2[] {
  let output: Point2[] = [...points];
  for (const [a, b, c] of planes) {
    const input = output, side = ([u, v]: Point2) => c - a * u - b * v;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index], previous = input[(index + input.length - 1) % input.length];
      const sc = side(current), sp = side(previous);
      const cut = (): Point2 => {
        const k = sp / (sp - sc);
        return [previous[0] + k * (current[0] - previous[0]), previous[1] + k * (current[1] - previous[1])];
      };
      if (sc >= 0) {
        if (sp < 0) output.push(cut());
        output.push(current);
      } else if (sp >= 0) output.push(cut());
    }
    if (output.length < 3) return [];
  }
  return output;
}

function area(points: readonly Point2[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x0, y0] = points[index], [x1, y1] = points[(index + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/** The seeded lean of the line: +1 or −1. */
export function diagonalSplitLean(seed: number): 1 | -1 {
  return createSeededRng(ID, seed, "layout").sign() as 1 | -1;
}

/** The line's angle off the travel axis (degrees) at progress p: 60° → 75°. */
export function diagonalSplitAngle(p: number): number {
  return FROM_DEGREES + (TO_DEGREES - FROM_DEGREES) * sineInOut(clamp01(p));
}

/**
 * The split line at progress p in travel space: u = offset + (v − cross/2) · slope. The part of the frame with u below
 * the line is B; the offset is solved so that part is `share` of the frame.
 */
export function diagonalSplitLine(share: number, angleDegrees: number, lean: 1 | -1, length: number, cross: number): { readonly offset: number; readonly slope: number } {
  const slope = lean / Math.tan((angleDegrees * Math.PI) / 180), reach = (Math.abs(slope) * cross) / 2;
  const frame: Point2[] = [[0, 0], [length, 0], [length, cross], [0, cross]];
  const covered = (offset: number) => area(clip(frame, [[1, -slope, offset - (slope * cross) / 2]])) / (length * cross);
  let low = -reach, high = length + reach;
  if (share <= 0) return { offset: low, slope };
  if (share >= 1) return { offset: high, slope };
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (covered(middle) < share) low = middle; else high = middle;
  }
  return { offset: (low + high) / 2, slope };
}

/** The part of the frame (travel space, mapped to frame px) between the lines at offsets `from` and `to` (to > from). */
function strip(from: number, to: number, slope: number, size: MotionFrameSize, direction: MotionTransitionDirection): Point2[] {
  const frame = travelFrame(direction, size), { length, cross } = frame;
  const box: Point2[] = [[0, 0], [length, 0], [length, cross], [0, cross]];
  return clip(box, [[1, -slope, to - (slope * cross) / 2], [-1, slope, -(from - (slope * cross) / 2)]]).map(([u, v]) => frame.toFrame(u, v));
}

export const X33_diagonalSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const direction = params.direction ?? "left_to_right";
  const { length, cross } = travelFrame(direction, size);
  const angle = diagonalSplitAngle(p), sine = Math.sin((angle * Math.PI) / 180);
  const { offset, slope } = diagonalSplitLine(EASE[params.energy](p), angle, diagonalSplitLean(params.seed), length, cross);
  // Band widths across the band, converted to offsets along the travel axis.
  const swell = Math.sin(Math.PI * p) * Math.min(size.width, size.height);
  const deep = (DEEP * swell) / sine, accent = (ACCENT * swell) / sine, tuck = (TUCK * frameUnit(size)) / sine;
  const reach = Math.abs(slope) * cross;
  const b = strip(-reach - 1, offset, slope, size, direction);
  return {
    matte: matte.render(b.length ? path(polygonPathD(b, 2), { fill: MATTE_SHOW_B }) : ""),
    overlay: createSvgDocument(size).render(
      path(polygonPathD(strip(offset - tuck, offset + accent + tuck, slope, size, direction), 2), { fill: params.palette.accent }),
      path(polygonPathD(strip(offset + accent, offset + accent + deep, slope, size, direction), 2), { fill: params.palette.accent2 })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
