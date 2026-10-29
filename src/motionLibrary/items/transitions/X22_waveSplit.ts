import { createSvgDocument, emptySvg, fmt, path, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X22 Wave Split: a soft sine boundary travels slowly across the frame with B
 * behind it, A ahead. The wave's amplitude is 6% of the boundary's length (the frame
 * height for a horizontal wipe), it fits a whole number of long periods across the
 * frame (one or two), and it drifts half a period along the boundary as it goes. A
 * thin deep-shade (accent2) band rides just ahead of it, on A, the item's second tone.
 *
 * Timing: the boundary's centre line runs ease(t / D) from just before the start edge
 * (the crests touching it) to just past the far edge; a whole number of periods adds
 * no area, so B covers exactly the centre line's share of the frame, half at D/2
 * (ART_DIRECTION §4: switch at 45–55%). The curves are calm by design (calm and
 * standard sine, punchy cubic, hype quart in-out). The band is 2.6% of the travel
 * length × sin(π t / D) × √amplitude, zero at both ends (t = 0 pure A, t = D pure B,
 * empty overlay), and tucks 1.5 px (at 1080) under B. The seed sets the wave's phase.
 * Directions: all four (default left_to_right).
 */

const ID = "X22";
const REVISION = 1;
const AMPLITUDE = 0.06;
const BAND = 0.026;
const TUCK = 1.5;
/** Phase drift along the boundary over the wipe (whole periods). */
const DRIFT = 0.5;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: sineInOut,
  punchy: cubicInOut,
  hype: quartInOut,
};


/** Whole periods of the wave along a boundary `cross` px long (short side `short`): one per short side, at least one. */
export function waveSplitPeriods(cross: number, short: number): number {
  return Math.max(1, Math.round(cross / short));
}

/** Catmull–Rom spline through the points as cubic Béziers, continuing the current path (no leading move). */
function splineD(points: readonly Point2[]): string {
  const n = (value: number) => fmt(value, 2);
  let d = "";
  for (let index = 0; index + 1 < points.length; index += 1) {
    const p0 = points[Math.max(0, index - 1)], p1 = points[index], p2 = points[index + 1], p3 = points[Math.min(points.length - 1, index + 2)];
    d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
  }
  return d;
}

export const X22_waveSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size);
  const { length, cross } = frame;
  const unit = frameUnit(size), n = (value: number) => fmt(value, 2);
  const amplitude = AMPLITUDE * cross, periods = waveSplitPeriods(cross, Math.min(size.width, size.height));
  const phase = createSeededRng(ID, params.seed, "phase").range(0, 2 * Math.PI) + 2 * Math.PI * DRIFT * p;
  const centre = -amplitude + (length + 2 * amplitude) * EASING[params.energy](p);
  // Samples along the boundary (a little past both ends), 16 per period at least.
  const pad = 4 * unit, steps = Math.max(16 * periods, Math.ceil((cross + 2 * pad) / (40 * unit)));
  const vs = Array.from({ length: steps + 1 }, (_, index) => -pad + ((cross + 2 * pad) * index) / steps);
  const edge = vs.map(v => centre + amplitude * Math.sin((2 * Math.PI * periods * v) / cross + phase));
  const curve = (offset: number) => edge.map((u, index) => frame.toFrame(u + offset, vs[index]));

  const boundary = curve(0), back = -pad - 2 * amplitude;
  const [b0, b1] = [frame.toFrame(back, cross + pad), frame.toFrame(back, -pad)];
  const matteD = `M${n(boundary[0][0])} ${n(boundary[0][1])}${splineD(boundary)}L${n(b0[0])} ${n(b0[1])}L${n(b1[0])} ${n(b1[1])}Z`;

  const band = BAND * length * Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  let bandD = "";
  if (band > 0.05) {
    const lower = curve(-TUCK * unit), upper = curve(band).reverse();
    bandD = `M${n(lower[0][0])} ${n(lower[0][1])}${splineD(lower)}L${n(upper[0][0])} ${n(upper[0][1])}${splineD(upper)}Z`;
  }
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(bandD, { fill: params.palette.accent2 })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
