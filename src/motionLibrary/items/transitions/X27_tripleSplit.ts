import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, expoOut, quadIn, quadOut, quartIn, sineIn, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X27 Triple Split: the frame is cut into three diagonal panels of equal area by two parallel
 * lines leaning 18°, and the panels switch from A to B one after another, domino-style. In
 * each panel a flat plate (accent, ink, accent; the seed swaps the tones) drops in from the
 * top and covers it, the panel switches to B under the plate, and the plate drops on out of
 * the bottom, revealing B from the top with a paper line riding its tail.
 *
 * Timing: the panels switch 0.16 of the duration apart (the reference's 0.08 s at 0.5 s; it
 * scales with the duration), the middle one at exactly D/2, so B covers 1/3 of the frame
 * just before D/2 and 2/3 from D/2 on (ART_DIRECTION §4: the switch lands at 50%). A plate
 * takes 0.26–0.32 of the duration to drop in (fast attack, settling onto the bottom edge)
 * and the same to drop out (accelerating away). Energy sets that and the curves (calm sine …
 * hype expo out / quart in). The dividing lines pass through the thirds of the frame at
 * mid-height, so the panels have equal areas. Where two plates are side by side, the earlier
 * one reaches 1.5 px (at 1080) under the later, so no seam opens between them. Directional:
 * the direction names the cascade (left to right by default; top_to_bottom and bottom_to_top
 * turn the panels into diagonal bands stacked down or up, their plates sliding in from the left).
 */

const ID = "X27";
const REVISION = 1;
const LEAN_DEGREES = 18;
/** Delay between neighbouring panels' switches, fraction of the duration (0.08 s at 0.5 s). */
const STAGGER = 0.16;
const TUCK = 1.5;
/** Paper line on each plate's tail (px at 1080). */
const LINE = 12;

interface DominoTiming { readonly drop: number; readonly enter: EasingFunction; readonly exit: EasingFunction }
const TIMING: Record<MotionEnergy, DominoTiming> = {
  calm: { drop: 0.32, enter: sineOut, exit: sineIn },
  standard: { drop: 0.3, enter: quadOut, exit: quadIn },
  punchy: { drop: 0.28, enter: cubicOut, exit: cubicIn },
  hype: { drop: 0.26, enter: expoOut, exit: quartIn },
};

/** Palette roles of the three plates. */
export function tripleSplitTones(seed: number): readonly ("accent" | "ink")[] {
  return createSeededRng(ID, seed, "layout").int(0, 1) === 1 ? ["accent", "ink", "accent"] : ["ink", "accent", "ink"];
}

/** Progress at which panel i (0, 1, 2 in cascade order) switches to B. */
export function tripleSplitSwitch(index: number): number {
  return 0.5 + (index - 1) * STAGGER;
}

/** Plate head and tail of panel i at progress p, as fractions of the panel's height (0 = top edge). */
export function tripleSplitPlate(index: number, p: number, energy: MotionEnergy): { readonly head: number; readonly tail: number } {
  const { drop, enter, exit } = TIMING[energy], at = tripleSplitSwitch(index);
  return { head: p >= at ? 1 : enter(clamp01((p - (at - drop)) / drop)), tail: p < at ? 0 : exit(clamp01((p - at) / drop)) };
}

/** The dividing line k (1 or 2) in travel space: u at cross position v. */
function divider(k: number, v: number, length: number, cross: number): number {
  return (k * length) / 3 + (v - cross / 2) * Math.tan((LEAN_DEGREES * Math.PI) / 180);
}

/** Panel i's polygon between v0 and v1 (travel space), optionally widened by `grow` px past its far divider. */
export function tripleSplitPanel(index: number, v0: number, v1: number, size: MotionFrameSize,
  direction: MotionTransitionDirection = "left_to_right", grow = 0): Point2[] {
  const frame = travelFrame(direction, size), { length, cross } = frame;
  const left = (v: number) => (index === 0 ? 0 : divider(index, v, length, cross));
  const right = (v: number) => (index === 2 ? length : divider(index + 1, v, length, cross) + grow);
  return [[left(v0), v0], [right(v0), v0], [right(v1), v1], [left(v1), v1]].map(([u, v]) => frame.toFrame(u, v));
}

export const X27_tripleSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const direction = params.direction ?? "left_to_right";
  const cross = travelFrame(direction, size).cross;
  const unit = frameUnit(size), tuck = TUCK * unit, line = LINE * unit;
  const tones = tripleSplitTones(params.seed);
  const plates = [0, 1, 2].map(index => {
    const { head, tail } = tripleSplitPlate(index, p, params.energy);
    return { head: Math.round(head * cross), tail: Math.round(tail * cross) };
  });
  let matteD = "";
  const parts: string[] = [];
  const lines: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    if (p >= tripleSplitSwitch(index)) matteD += polygonPathD(tripleSplitPanel(index, 0, cross, size, direction), 2);
    const { head, tail } = plates[index];
    if (!(head > tail)) continue;
    // Under the next plate where the two overlap, so their shared edge never shows a seam.
    const next = plates[index + 1];
    const overlapFrom = next ? Math.max(tail, next.tail) : 0, overlapTo = next ? Math.min(head, next.head) : 0;
    const d = polygonPathD(tripleSplitPanel(index, tail, head, size, direction), 2)
      + (next && overlapTo > overlapFrom ? polygonPathD(tripleSplitPanel(index, overlapFrom, overlapTo, size, direction, tuck)
        .slice(1, 3).concat(tripleSplitPanel(index, overlapFrom, overlapTo, size, direction).slice(1, 3).reverse()), 2) : "");
    parts.push(path(d, { fill: params.palette[tones[index]] }));
    if (tail > 0) lines.push(polygonPathD(tripleSplitPanel(index, tail, Math.min(head, tail + line), size, direction), 2));
  }
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(parts, path(lines.join(""), { fill: params.palette.paper })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
