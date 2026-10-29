import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp, clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X07 Brush Wipe: thick capsule brush strokes (ink and accent2 alternating, the
 * reference's ink and accent) paint across the frame back and forth like a
 * roller: band 1 left to right, band 2 right to left, and so on (2–4 bands by
 * aspect: 3 across a landscape wipe, 4 down a portrait one), each a capsule
 * extending with a round head until the frame is covered. Under full cover B is
 * switched in, and B paints a second coat along the same back-and-forth path: a
 * round-headed B stroke eats each band's paint from the end it came in.
 *
 * Timing: strokes overlap (the next starts while the last is under way); the last
 * band is painted by 48% and the B coat starts at 50% and ends by 98%, so the frame
 * is fully covered when the matte switches at exactly D/2 (ART_DIRECTION §4). The matte is a clean switch; the overlay carries the round
 * B heads, so no matte edge is ever visible. Capsules are 1.5 px (at 1080) thicker
 * than their band on each side, so neighbouring strokes overlap without a seam.
 * Energy picks the stroke curve (calm sine … hype expo). The seed swaps the colour
 * order and which side the first stroke starts from. Directions: all four (the
 * first stroke travels that way; vertical wipes paint in columns).
 */

const ID = "X07";
const REVISION = 1;
const SWITCH = 0.5;
const TUCK = 1.5;
/** Points on each semicircular stroke head. */
const HEAD_SEGMENTS = 32;

interface StrokeTiming {
  /** Delay of the last stroke after the first. */
  readonly spread: number;
  /** One stroke (paint or B coat), fraction of the duration. */
  readonly stroke: number;
  readonly ease: EasingFunction;
}

const TIMING: Record<MotionEnergy, StrokeTiming> = {
  calm: { spread: 0.2, stroke: 0.28, ease: sineInOut },
  standard: { spread: 0.22, stroke: 0.26, ease: cubicInOut },
  punchy: { spread: 0.24, stroke: 0.24, ease: quartInOut },
  hype: { spread: 0.26, stroke: 0.22, ease: expoInOut },
};

interface TravelFrame {
  readonly length: number;
  readonly cross: number;
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

/** Bands across the travel axis: 3 for a landscape horizontal wipe, 4 for a portrait one. */
export function brushStrokeCount(length: number, cross: number): number {
  return clamp(Math.round(2.6 + (0.8 * cross) / length), 2, 4);
}

/** Head points (u, v) of a semicircle of radius r centred at (cu, cv), bulging toward +u, from the −v side to the +v side. */
function head(cu: number, cv: number, r: number): Point2[] {
  return Array.from({ length: HEAD_SEGMENTS + 1 }, (_, index) => {
    const angle = (Math.PI * index) / HEAD_SEGMENTS;
    return [cu + r * Math.sin(angle), cv - r * Math.cos(angle)] as const;
  });
}

export const X07_brushWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size);
  const { length, cross } = frame;
  const { spread, stroke, ease } = TIMING[params.energy];
  const count = brushStrokeCount(length, cross), pitch = cross / count;
  const radius = pitch / 2 + TUCK * frameUnit(size);
  const rng = createSeededRng(ID, params.seed, "layout");
  const sideFlip = rng.int(0, 1), colorFlip = rng.int(0, 1);
  const far = length + radius + 2;
  const paths = ["", ""];
  for (let band = 0; band < count; band += 1) {
    const centre = (band + 0.5) * pitch;
    const delay = count > 1 ? (spread * band) / (count - 1) : 0;
    const forward = (band + sideFlip) % 2 === 0;
    const toFrame = (u: number, v: number) => frame.toFrame(forward ? u : length - u, v);
    let outline: Point2[];
    if (p < SWITCH) {
      // Paint: a capsule from off-frame at its start side to a round head.
      const q = ease((p - delay) / stroke);
      if (!(q > 0)) continue;
      const tip = -radius + (length + 2 * radius) * q;
      outline = [[-radius - 2, centre - radius], ...head(tip, centre, radius), [-radius - 2, centre + radius]];
    } else {
      // B coat: the paint left over ahead of a round B head.
      const q = ease((p - SWITCH - delay) / stroke);
      const cut = -radius + (length + radius + TUCK * frameUnit(size)) * q;
      if (cut >= length) continue;
      outline = [...head(cut, centre, radius), [far, centre + radius], [far, centre - radius]];
    }
    paths[(band + colorFlip) % 2] += polygonPathD(outline.map(([u, v]) => toFrame(u, v)), 2);
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(path(paths[0], { fill: params.palette.ink }), path(paths[1], { fill: params.palette.accent2 })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
