import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicOut, expoOut, quadOut, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X30 Diagonal Panels: eight 45° bands, stacked from the top-left corner of the frame to the
 * bottom-right, slide in one after another in fast succession, each shooting along its own
 * length from its lower-left end, in alternating tones of the accent and its deep shade
 * (accent2; the seed swaps them), until they cover A. Under full cover B is switched in and
 * takes the bands over by the same slides, band after band from the same corner, so B opens
 * as a diagonal staircase and the last ribbons leave from the far corner.
 *
 * Timing: the bands start 0.035 of the duration apart and each slide takes 0.2 of it with a
 * fast attack (calm sine … hype expo out), so the last band lands at 48.5% and the frame is
 * fully covered when the matte switches at exactly D/2 (ART_DIRECTION §4); the B slides
 * start at 50% and end by 94.5%. The matte is a clean switch and the overlay carries the B
 * fronts, so no matte edge is ever visible. Every band slides the length it has inside the
 * frame, so the short corner bands take as long as the long middle ones. Bands share exact
 * edges; wherever two neighbouring bands are both drawn, the earlier one reaches 1.5 px (at
 * 1080) under the later, so no seam opens. Directional: the direction names the succession
 * (from the left, starting at the top-left corner, by default).
 */

const ID = "X30";
const REVISION = 1;
const SWITCH = 0.5;
const BANDS = 8;
/** Start of the first slide, and the delay between neighbouring bands, fractions of the duration. */
const FIRST = 0.04, STEP = 0.035, SLIDE = 0.2;
const TUCK = 1.5;

const EASE: Record<MotionEnergy, EasingFunction> = {
  calm: sineOut,
  standard: quadOut,
  punchy: cubicOut,
  hype: expoOut,
};

/** Palette roles of the bands, from the start corner: the accent and its deep shade in alternation. */
export function diagonalPanelTones(seed: number): readonly ("accent" | "accent2")[] {
  const flip = createSeededRng(ID, seed, "layout").int(0, 1);
  return Array.from({ length: BANDS }, (_, band) => ((band + flip) % 2 === 0 ? "accent" : "accent2"));
}

/** Fraction of band i's own length taken by its slide at progress p: the colour slide before D/2, B's slide after. */
export function diagonalPanelSlide(band: number, p: number, energy: MotionEnergy): number {
  return EASE[energy](clamp01((p - (p < SWITCH ? FIRST : SWITCH) - band * STEP) / SLIDE));
}

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

interface BandGeometry {
  /** Band boundaries on the diagonal coordinate s = u + v (travel space). */
  readonly s0: number;
  readonly s1: number;
  /** The band's extent along its length, t = u − v, inside the frame. */
  readonly lo: number;
  readonly hi: number;
}

function bandGeometry(band: number, length: number, cross: number): BandGeometry {
  const step = (length + cross) / BANDS, s0 = band * step, s1 = (band + 1) * step;
  const strip = clip([[0, 0], [length, 0], [length, cross], [0, cross]], [[-1, -1, -s0], [1, 1, s1]]);
  const along = strip.map(([u, v]) => u - v);
  return { s0, s1, lo: Math.min(...along), hi: Math.max(...along) };
}

/** The part of the frame (travel space) with s = u + v in [s0, s1] and t = u − v in [t0, t1]. */
function region(s0: number, s1: number, t0: number, t1: number, length: number, cross: number): Point2[] {
  if (!(s1 > s0) || !(t1 > t0)) return [];
  return clip([[0, 0], [length, 0], [length, cross], [0, cross]], [[-1, -1, -s0], [1, 1, s1], [-1, 1, -t0], [1, -1, t1]]);
}

/** Band i between `from` and `to` of its own length inside the frame (0 = its lower-left end), in frame px. */
export function diagonalPanelPart(band: number, from: number, to: number, size: MotionFrameSize,
  direction: MotionTransitionDirection = "left_to_right"): Point2[] {
  const frame = travelFrame(direction, size), { s0, s1, lo, hi } = bandGeometry(band, frame.length, frame.cross);
  return region(s0, s1, lo + (hi - lo) * from, lo + (hi - lo) * to, frame.length, frame.cross).map(([u, v]) => frame.toFrame(u, v));
}

export const X30_diagonalPanels = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size), { length, cross } = frame;
  const tones = diagonalPanelTones(params.seed), widen = TUCK * frameUnit(size) * Math.SQRT2;
  // Each band shows colour over [t0, t1] along its length: the head slides in before D/2, B's front slides after it.
  const bands = Array.from({ length: BANDS }, (_, band) => {
    const geometry = bandGeometry(band, length, cross), slide = diagonalPanelSlide(band, p, params.energy);
    const [from, to] = p < SWITCH ? [0, slide] : [slide, 1];
    return { ...geometry, t0: geometry.lo + (geometry.hi - geometry.lo) * from, t1: geometry.lo + (geometry.hi - geometry.lo) * to };
  });
  const fills: Record<string, string> = {};
  const add = (role: string, points: readonly Point2[]) => {
    fills[role] = (fills[role] ?? "") + polygonPathD(points.map(([u, v]) => frame.toFrame(u, v)), 2);
  };
  bands.forEach(({ s0, s1, t0, t1 }, band) => {
    add(tones[band], region(s0, s1, t0, t1, length, cross));
    const next = bands[band + 1];
    if (!next) return;
    // Where both neighbours are drawn, the accent band (painted first) reaches under the deep one, so no seam opens.
    const from = Math.max(t0, next.t0), to = Math.min(t1, next.t1);
    add("accent", tones[band] === "accent" ? region(s1, s1 + widen, from, to, length, cross) : region(s1 - widen, s1, from, to, length, cross));
  });
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(
      path(fills.accent ?? "", { fill: params.palette.accent }),
      path(fills.accent2 ?? "", { fill: params.palette.accent2 })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
