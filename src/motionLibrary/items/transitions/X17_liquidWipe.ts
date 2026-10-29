import { mixHex } from "../../svg/color";
import { createSvgDocument, emptySvg, fmt, path, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X17 Liquid Wipe: B is a liquid that rises from the bottom (the default; any edge
 * with `direction`). Its surface is two travelling sine waves, a long swell and a
 * shorter chop running the other way, drawn as smooth curves. A foam band in a
 * lighter tint of the accent (accent mixed 55% toward paper) rides the crest: its
 * underside is the surface itself and its top a slower wave of its own, so the band
 * swells on the peaks and thins in the troughs. One hue: the accent and its tint.
 *
 * Timing: the mean level runs ease(t / D) from just below the start edge (the
 * highest crest touching it) to just past the far edge, and both waves fit a whole
 * number of periods across the frame, so they add no area: B covers exactly
 * level / length of the frame, half at D/2 (ART_DIRECTION §4: switch at 45–55%). The
 * swell grows by a quarter mid-wipe (the slosh) and settles again; the foam scales
 * with sin(π t / D), so t = 0 is pure A and t = D pure B with an empty overlay. The
 * foam tucks 1.5 px (at 1080) under B. Energy picks the level curve (calm sine …
 * hype expo). The seed sets the wave phases. Directions: all four (the liquid comes
 * in from the side opposite the direction it travels; default bottom_to_top).
 */

const ID = "X17";
const REVISION = 1;
/** Swell and chop amplitudes at rest (px at 1080); the swell grows by SLOSH mid-wipe. */
const SWELL = 60, CHOP = 18, SLOSH = 0.25;
/** Foam band at its thickest (px at 1080, full bell); it thins to FOAM_MIN of that in the troughs. */
const FOAM = 48, FOAM_MIN = 0.4;
const FOAM_TINT = 0.55;
const TUCK = 1.5;
/** Phase travel over the wipe (whole turns): the swell runs one way, the chop the other. */
const SWELL_TRAVEL = 0.55, CHOP_TRAVEL = -1.2;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};


/** Whole periods of the swell and the chop across `cross` px (short side `short`). */
export function liquidPeriods(cross: number, short: number): readonly [number, number] {
  return [Math.max(1, Math.round(cross / (0.95 * short))), Math.max(2, Math.round(cross / (0.34 * short)))];
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

/** A closed region: the spline `curve` (frame points) closed through the frame points `rest`. */
function regionD(curve: readonly Point2[], rest: readonly Point2[]): string {
  const n = (value: number) => fmt(value, 2);
  return `M${n(curve[0][0])} ${n(curve[0][1])}${splineD(curve)}${rest.map(([x, y]) => `L${n(x)} ${n(y)}`).join("")}Z`;
}

/** A band between two splines across the frame: `lower` forwards, `upper` backwards. */
function bandD(lower: readonly Point2[], upper: readonly Point2[]): string {
  const n = (value: number) => fmt(value, 2);
  const back = [...upper].reverse();
  return `M${n(lower[0][0])} ${n(lower[0][1])}${splineD(lower)}L${n(back[0][0])} ${n(back[0][1])}${splineD(back)}Z`;
}

export const X17_liquidWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "bottom_to_top", size);
  const { length, cross } = frame;
  const unit = frameUnit(size), short = Math.min(size.width, size.height);
  const [swellPeriods, chopPeriods] = liquidPeriods(cross, short);
  const rng = createSeededRng(ID, params.seed, "phases");
  const phases = [rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI)];
  const bell = Math.sin(Math.PI * p);
  const swell = SWELL * unit * (1 + SLOSH * bell), chop = CHOP * unit;
  // The level starts and ends with the highest crest just off-frame (the slosh is zero at both ends).
  const reach = (SWELL + CHOP) * unit;
  const level = -reach + (length + 2 * reach) * EASING[params.energy](p);
  const swellPhase = phases[0] + 2 * Math.PI * SWELL_TRAVEL * p, chopPhase = phases[1] + 2 * Math.PI * CHOP_TRAVEL * p;
  const wave = (v: number) => swell * Math.sin((2 * Math.PI * swellPeriods * v) / cross + swellPhase)
    + chop * Math.sin((2 * Math.PI * chopPeriods * v) / cross + chopPhase);

  // Samples across the frame (a little past both sides), at least 12 per chop wavelength.
  const pad = 4 * unit;
  const steps = Math.ceil((cross + 2 * pad) / Math.min(24 * unit, cross / chopPeriods / 12));
  const vs = Array.from({ length: steps + 1 }, (_, index) => -pad + ((cross + 2 * pad) * index) / steps);
  const surface = vs.map(v => level + wave(v));
  const toFrame = (us: readonly number[]) => us.map((u, index) => frame.toFrame(u, vs[index]));
  // Close the liquid well behind the start edge, below the lowest trough.
  const below = -pad - 3 * reach;
  const matteD = regionD(toFrame(surface), [frame.toFrame(below, cross + pad), frame.toFrame(below, -pad)]);

  const tuck = TUCK * unit;
  let foamD = "";
  if (bell > 0.002) {
    // The foam's top: a slower wave of its own riding the surface, thick on the peaks and thin in the troughs.
    const foam = vs.map((v, index) => {
      const swellAt = Math.sin((2 * Math.PI * swellPeriods * v) / cross + swellPhase);
      const drift = Math.sin((2 * Math.PI * (swellPeriods + 1) * v) / cross + phases[2] + 2 * Math.PI * 0.35 * p);
      return surface[index] + FOAM * unit * bell * (FOAM_MIN + (1 - FOAM_MIN) * (0.5 + 0.3 * swellAt + 0.2 * drift));
    });
    foamD = bandD(toFrame(surface.map(u => u - tuck)), toFrame(foam));
  }
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(foamD, { fill: mixHex(params.palette.accent, params.palette.paper, FOAM_TINT) })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
