import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X02 Diagonal Wipe: B arrives as a plane whose leading edge leans 20° off the
 * cross axis (a 70° line for a horizontal wipe, top corner first, like an italic),
 * pushing 3–4 parallel ink pinstripes ahead of it. The stripes thin out away from
 * the edge (about 66 / 36 / 16 px at 1080 short side) like a speed smear.
 *
 * Timing: the edge centre runs ease(t / D) across the frame, so the edge passes
 * the frame centre at exactly D/2 and B covers half the frame then (the slanted
 * half-plane is point-symmetric about the centre; ART_DIRECTION §4: switch at
 * 45–55%). The stripes ride ahead of the edge by offsets scaled with
 * sin(π t / D): they fan out while the edge is fastest and fold back onto it at
 * both ends, so t = 0 is pure A and t = D pure B with an empty overlay. Energy picks
 * the edge curve (calm sine … hype expo, as X01) and stretches the stripe fan
 * (√amplitude). The seed picks 3 or 4 stripes and jitters their widths ±15%.
 * Directions: all four (the travel axis is mapped; the lean follows it).
 */

const ID = "X02";
const REVISION = 1;
/** The leading edge leans this far off the cross axis (70° from horizontal for a left-to-right wipe). */
const LEAN_DEGREES = 20;
/** [gap before, width] of each stripe along the travel axis, at 1080 short side and full fan-out. */
const STRIPES_3: readonly (readonly [number, number])[] = [[24, 66], [22, 36], [20, 16]];
const STRIPES_4: readonly (readonly [number, number])[] = [[22, 58], [20, 34], [18, 18], [16, 9]];
const WIDTH_JITTER = 0.15;
/** Stripes thinner than this (px) are not drawn: they only occur in the first and last instants. */
const MIN_STRIPE = 0.05;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

interface TravelFrame {
  /** Extent along the travel direction. */
  readonly length: number;
  /** Extent across it. */
  readonly cross: number;
  /** Travel coordinates (u along the wipe, v across) to frame pixels. */
  readonly toFrame: (u: number, v: number) => Point2;
}

function travelFrame(direction: MotionTransitionDirection, size: MotionFrameSize): TravelFrame {
  const { width, height } = size;
  switch (direction) {
    case "left_to_right": return { length: width, cross: height, toFrame: (u, v) => [u, v] };
    case "right_to_left": return { length: width, cross: height, toFrame: (u, v) => [width - u, v] };
    case "top_to_bottom": return { length: height, cross: width, toFrame: (u, v) => [v, u] };
    case "bottom_to_top": return { length: height, cross: width, toFrame: (u, v) => [v, height - u] };
  }
}

/** Seeded stripe layout: [start, end] offsets ahead of the edge at full fan-out (px). */
function stripeOffsets(seed: number, unit: number): Array<readonly [number, number]> {
  const rng = createSeededRng(ID, seed, "stripes");
  const layout = rng.chance(0.5) ? STRIPES_3 : STRIPES_4;
  const offsets: Array<readonly [number, number]> = [];
  let cursor = 0;
  for (const [gap, width] of layout) {
    const start = cursor + gap * unit;
    const end = start + width * unit * (1 + WIDTH_JITTER * (2 * rng.next() - 1));
    offsets.push([start, end]);
    cursor = end;
  }
  return offsets;
}

export const X02_diagonalWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size);
  const { length, cross } = frame;
  // u-offset of the edge at the leading (v = 0) and trailing (v = cross) sides relative to its centre.
  const lean = (cross / 2) * Math.tan((LEAN_DEGREES * Math.PI) / 180);
  const edge = -lean + (length + 2 * lean) * EASING[params.energy](p);
  const quad = (back: number, front: number): string => polygonPathD([
    frame.toFrame(back + lean, 0), frame.toFrame(front + lean, 0), frame.toFrame(front - lean, cross), frame.toFrame(back - lean, cross),
  ], 2);

  // B: everything behind the leaning edge (the back side reaches the start edge of the frame).
  const matteSvg = matte.render(path(quad(Math.min(0, edge - lean) - lean, edge), { fill: MATTE_SHOW_B }));

  const fan = Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  let stripes = "";
  for (const [start, end] of stripeOffsets(params.seed, frameUnit(size))) {
    const back = edge + start * fan, front = edge + end * fan;
    if (front - back < MIN_STRIPE || back - lean >= length || front + lean <= 0) continue;
    stripes += quad(back, front);
  }
  return { matte: matteSvg, overlay: createSvgDocument(size).render(path(stripes, { fill: params.palette.ink })) };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
