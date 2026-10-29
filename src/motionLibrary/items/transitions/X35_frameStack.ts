import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, expoIn, expoOut, quadIn, quadOut, quartIn, quartOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X35 Frame Stack: four rectangular frames (borders with the frame's own proportions, each an
 * eighth of the frame thick) slide in one after another from the four sides (seeded starting
 * side, then round the frame) and stack inward, accent and deep shade in alternation, each new
 * one landing inside the last, so the window in the centre shrinks until the fourth frame
 * closes it. Under that full cover the matte switches to B at exactly D/2 (ART_DIRECTION §4).
 * Then the frames slide on out through the far side, innermost first: B appears in the centre
 * window and fills the frame as each frame leaves.
 *
 * Timing: the frames start 0.105 of the duration apart and each slide takes 0.13 of it, so mostly
 * one frame moves at a time; they land by 47.5% (decelerating in) and leave from 50%
 * (accelerating out) in reverse order, gone by 94.5%.
 * Energy sets the curves (calm quad … hype expo out / in): a frame
 * settles sharply, so it is never seen creeping the last pixels into place. Frames are whole pixels; while
 * a frame and the next one inside it have both landed, the outer one reaches 1.5 px (at 1080)
 * under the inner one, so no seam opens between them. A later frame is drawn over an earlier
 * one, so a frame in flight passes over those already stacked. Not directional (frames come
 * from all four sides). Offsets are whole pixels, and a frame within 3 px (at 1080) of its place
 * snaps into it, so no sliver creeps by while a frame settles.
 */

const ID = "X35";
/** Art revision (part of the clip cache key): 1 = first render (frames overlapping in flight, creeping into place); 2 = mostly one frame moving at a time, whole-pixel offsets with a 3 px snap, sharper settling eases. */
const REVISION = 2;
const SWITCH = 0.5;
const FRAMES = 4;
const FIRST = 0.03, STEP = 0.105, SLIDE = 0.13;
const TUCK = 1.5;

interface StackTiming { readonly enter: EasingFunction; readonly exit: EasingFunction }
const TIMING: Record<MotionEnergy, StackTiming> = {
  calm: { enter: quadOut, exit: quadIn },
  standard: { enter: cubicOut, exit: cubicIn },
  punchy: { enter: quartOut, exit: quartIn },
  hype: { enter: expoOut, exit: expoIn },
};

/** Sides, round the frame: the unit direction a frame slides in along (it enters from the opposite side). */
const SIDES: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export interface FrameStackLayout {
  /** For each frame (outermost first), the index into SIDES of its slide direction. */
  readonly sides: readonly number[];
  /** Palette roles of the frames, outermost first. */
  readonly tones: readonly ("accent" | "accent2")[];
}

export function frameStackLayout(seed: number): FrameStackLayout {
  const rng = createSeededRng(ID, seed, "layout");
  const start = rng.int(0, 3), turn = rng.sign(), flip = rng.int(0, 1);
  return {
    sides: Array.from({ length: FRAMES }, (_, frame) => (((start + turn * frame) % 4) + 4) % 4),
    tones: Array.from({ length: FRAMES }, (_, frame) => ((frame + flip) % 2 === 0 ? "accent" : "accent2")),
  };
}

/**
 * Frame k's position at progress p as a fraction of the frame size along its slide: −1 … 0 while sliding in, 0 in place,
 * 0 … 1 while sliding out through the far side.
 */
export function frameStackShift(frame: number, p: number, energy: MotionEnergy): number {
  const { enter, exit } = TIMING[energy];
  if (p < SWITCH) return -(1 - enter(clamp01((p - FIRST - frame * STEP) / SLIDE)));
  return exit(clamp01((p - SWITCH - (FRAMES - 1 - frame) * STEP) / SLIDE));
}

/** Frame k's outer and inner rectangles (whole px), in place. */
export function frameStackRects(frame: number, size: MotionFrameSize): { readonly outer: readonly [number, number, number, number]; readonly inner: readonly [number, number, number, number] } {
  const inset = (k: number): readonly [number, number, number, number] => {
    const x = Math.round((k * size.width) / (2 * FRAMES)), y = Math.round((k * size.height) / (2 * FRAMES));
    return [x, y, size.width - x, size.height - y];
  };
  return { outer: inset(frame), inner: inset(frame + 1) };
}

export const X35_frameStack = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { sides, tones } = frameStackLayout(params.seed);
  const tuck = TUCK * frameUnit(size);
  // Offsets in whole pixels; a frame within 3 px (at 1080) of its place is in place, so no sliver of A or B creeps by.
  const snap = (px: number) => (Math.abs(px) < 3 * frameUnit(size) ? 0 : Math.round(px));
  const shifts = Array.from({ length: FRAMES }, (_, frame) => {
    const shift = frameStackShift(frame, p, params.energy);
    if (Math.abs(shift) >= 1) return shift;
    const span = SIDES[sides[frame]][0] !== 0 ? size.width : size.height;
    return snap(shift * span) / span;
  });
  const parts: string[] = [];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const shift = shifts[frame];
    if (Math.abs(shift) >= 1) continue;
    const [dx, dy] = SIDES[sides[frame]], ox = dx * shift * size.width, oy = dy * shift * size.height;
    const { outer, inner } = frameStackRects(frame, size);
    // Reach under the next frame in only while both have landed.
    const grow = shift === 0 && shifts[frame + 1] === 0 ? tuck : 0;
    const d = rectPathD(outer[0] + ox, outer[1] + oy, outer[2] - outer[0], outer[3] - outer[1], 2)
      + rectPathD(inner[0] + grow + ox, inner[1] + grow + oy, inner[2] - inner[0] - 2 * grow, inner[3] - inner[1] - 2 * grow, 2);
    parts.push(path(d, { fill: params.palette[tones[frame]], "fill-rule": "evenodd" }));
  }
  return { matte: p < SWITCH ? matte.render() : allB(), overlay: createSvgDocument(size).render(parts) };
}, { revision: REVISION });
