import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, expoOut, quadIn, quadOut, quartIn, sineIn, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X29 Sliding Panels: five (portrait) or six (landscape) tall leaning panels (a slot boundary
 * shifts by 1.2 slot widths from top to bottom: about 20° in landscape, 8° in portrait) slide
 * in across the frame one after another, in alternating tones (accent and ink; the seed swaps
 * them), and fill it from the far side: the panel bound for the far slot leaves first and
 * crosses the whole frame, the next follows into the slot beside it, and so on, so the
 * panels fan out from under each other like a dealt deck. Under full cover B is switched
 * in, and the panels slide on out of the far side in the same order, revealing B.
 *
 * Timing: the panels start 0.034–0.043 of the duration apart (0.17 from first to last),
 * each slide takes 0.25–0.29 of it, and the last one settles into its slot by 48%, so the
 * frame is fully covered when the matte switches at exactly D/2 (ART_DIRECTION §4); the
 * exits start at 50% and end by 96%. Slides in decelerate into their slots and slides out
 * accelerate away (calm sine … hype expo out / quart in). A nearer panel is drawn under a
 * farther one, so while they overlap in flight it slides out from under it; in their slots
 * each panel reaches 1.5 px (at 1080) under its neighbour, so no seam opens between them.
 * The end panels extend past the frame edges so the slanted slots cover the corners.
 * Directional: the direction names the panels' travel (left to right by default; for
 * top_to_bottom and bottom_to_top the panels lie across the frame).
 */

const ID = "X29";
/** Art revision (part of the clip cache key): 1 = first render (ink in the first slot: ink-heavy, three of five panels in portrait); 2 = the accent leads (first slot accent by default). */
const REVISION = 2;
const SWITCH = 0.5;
/** Lean: a slot boundary shifts by this many slot widths from one side of the frame to the other. */
const SHIFT = 1.2;
/** Start of the first slide in, and the span from the first panel's start to the last's. */
const FIRST = 0.04, SPREAD = 0.17;
const TUCK = 1.5;

interface SlideTiming { readonly slide: number; readonly enter: EasingFunction; readonly exit: EasingFunction }
const TIMING: Record<MotionEnergy, SlideTiming> = {
  calm: { slide: 0.27, enter: sineOut, exit: sineIn },
  standard: { slide: 0.27, enter: quadOut, exit: quadIn },
  punchy: { slide: 0.26, enter: cubicOut, exit: cubicIn },
  hype: { slide: 0.25, enter: expoOut, exit: quartIn },
};

/** Panel count: six when the panels lie along the longer side of the frame, else five. */
export function slidingPanelCount(size: MotionFrameSize, direction: MotionTransitionDirection = "left_to_right"): number {
  const { length, cross } = travelFrame(direction, size);
  return length > cross ? 6 : 5;
}

/**
 * The panels' lean as the tangent of their angle off the cross axis: across the whole frame a slot boundary shifts by
 * SHIFT slot widths (about 19° in landscape, 8° in portrait), so the panels read as tall leaning panels in both formats.
 */
export function slidingPanelSlant(size: MotionFrameSize, direction: MotionTransitionDirection = "left_to_right"): number {
  const { length, cross } = travelFrame(direction, size);
  return (SHIFT * length) / slidingPanelCount(size, direction) / cross;
}

/** Palette roles by slot (from the start edge): accent and ink in alternation. */
export function slidingPanelTones(seed: number, count: number): readonly ("accent" | "ink")[] {
  const flip = createSeededRng(ID, seed, "layout").int(0, 1);
  return Array.from({ length: count }, (_, slot) => ((slot + flip) % 2 === 1 ? "accent" : "ink"));
}

/**
 * Offset (px along the travel) of the panel in `slot` at progress p: negative while it slides in from the start
 * side (−distanceIn … 0), 0 in its slot, positive while it slides out of the far side (0 … distanceOut). The far
 * slot moves first in both phases.
 */
export function slidingPanelOffset(slot: number, count: number, p: number, energy: MotionEnergy,
  distanceIn: number, distanceOut: number): number {
  const { slide, enter, exit } = TIMING[energy];
  const delay = count > 1 ? (SPREAD * (count - 1 - slot)) / (count - 1) : 0;
  if (p < SWITCH) return -distanceIn * (1 - enter(clamp01((p - FIRST - delay) / slide)));
  return distanceOut * exit(clamp01((p - SWITCH - delay) / slide));
}

export const X29_slidingPanels = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const direction = params.direction ?? "left_to_right";
  const frame = travelFrame(direction, size), { length, cross } = frame;
  const count = slidingPanelCount(size, direction);
  const slant = slidingPanelSlant(size, direction), lean = (cross / 2) * slant;
  const tuck = TUCK * frameUnit(size), margin = 2;
  const tones = slidingPanelTones(params.seed, count);
  // Slot boundary k at cross position v; the end panels extend past the frame so the slanted slots cover its corners.
  const boundary = (k: number, v: number) => (k * length) / count + (v - cross / 2) * slant
    + (k === 0 ? -(lean + margin) : k === count ? lean + margin : 0);
  const offsets = Array.from({ length: count }, (_, slot) => slidingPanelOffset(slot, count, p, params.energy,
    boundary(slot + 1, cross) + margin, length - boundary(slot, 0) + margin));
  const panel = (slot: number, offset: number, grow = 0): Point2[] =>
    [[boundary(slot, 0), 0], [boundary(slot + 1, 0) + grow, 0], [boundary(slot + 1, cross) + grow, cross], [boundary(slot, cross), cross]]
      .map(([u, v]) => frame.toFrame(u + offset, v));
  const parts: string[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const offset = offsets[slot];
    // Fully outside the frame: skip.
    if (boundary(slot + 1, cross) + offset <= 0 || boundary(slot, 0) + offset >= length) continue;
    const settled = offset === 0 && offsets[slot + 1] === 0;
    parts.push(path(polygonPathD(panel(slot, offset, settled ? tuck : 0), 2), { fill: params.palette[tones[slot]] }));
  }
  return { matte: p < SWITCH ? matte.render() : allB(), overlay: createSvgDocument(size).render(parts) };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
