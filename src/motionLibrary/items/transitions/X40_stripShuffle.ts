import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicIn, cubicInOut, cubicOut, expoOut, quadIn, quadInOut, quadOut, quartIn, quartInOut, sineIn, sineInOut, sineOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X40 Strip Shuffle: the frame is cut into equal vertical strips, each a flat panel in the accent
 * or the deep shade so that in their final order they alternate. They drop in from the top into
 * shuffled slots (a seeded single-cycle derangement, so every strip starts out of place) until
 * they cover A; under that full cover the matte switches to B at exactly D/2 (ART_DIRECTION §4).
 * Then the strips shuffle, all sliding sideways at once into their final order, B showing in the
 * gaps as they pass each other, and settle exactly into their slots as an even two-tone pattern
 * that tiles the frame; finally they lift away left to right, settling into B.
 *
 * Timing: the drops start 0.035 apart and take 0.18 of the duration each (the last lands by
 * about 46%); the shuffle runs over 50–78%; the lifts start from 72% at a small stagger and take
 * 0.14, gone by 98%. Energy sets the curves (calm sine … hype expo out for the drops, quart for
 * the shuffle and the lifts). Strips are whole pixels wide and their final slots tile the frame
 * exactly. Not directional (the seed sets the shuffle).
 */

const ID = "X40";
const REVISION = 1;
const SWITCH = 0.5;
const DROP_FIRST = 0.03, DROP_STEP = 0.035, DROP = 0.18;
const SHUFFLE_START = 0.5, SHUFFLE_END = 0.78;
const LIFT_FIRST = 0.72, LIFT_SPREAD = 0.12, LIFT = 0.14;

interface ShuffleTiming { readonly drop: EasingFunction; readonly shuffle: EasingFunction; readonly lift: EasingFunction }
const TIMING: Record<MotionEnergy, ShuffleTiming> = {
  calm: { drop: sineOut, shuffle: sineInOut, lift: sineIn },
  standard: { drop: quadOut, shuffle: quadInOut, lift: quadIn },
  punchy: { drop: cubicOut, shuffle: cubicInOut, lift: cubicIn },
  hype: { drop: expoOut, shuffle: quartInOut, lift: quartIn },
};

/** Strip count: eight on wide frames, six otherwise. */
export function stripCount(size: MotionFrameSize): number {
  return size.width > size.height ? 8 : 6;
}

export interface ShuffleLayout {
  /** start[i]: the slot strip i drops into (a single-cycle derangement of the final order). */
  readonly start: readonly number[];
  /** The order (by final index) in which the strips drop in. */
  readonly dropOrder: readonly number[];
  readonly tones: readonly ("accent" | "accent2")[];
}

export function shuffleLayout(seed: number, count: number): ShuffleLayout {
  const rng = createSeededRng(ID, seed, `strips-${count}`);
  // Sattolo's algorithm: a uniformly random single cycle, so no strip starts in its own slot.
  const start = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index - 1);
    [start[index], start[swap]] = [start[swap], start[index]];
  }
  const dropOrder = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [dropOrder[index], dropOrder[swap]] = [dropOrder[swap], dropOrder[index]];
  }
  const flip = rng.int(0, 1);
  return { start, dropOrder, tones: Array.from({ length: count }, (_, strip) => ((strip + flip) % 2 === 0 ? "accent" : "accent2")) };
}

/** Strip i's state at progress p: its horizontal position in slots (fractional while shuffling) and how far down from the top it reaches (0 … 1). */
export function stripState(strip: number, p: number, energy: MotionEnergy, layout: ShuffleLayout): { readonly slot: number; readonly bottom: number } {
  const { drop, shuffle, lift } = TIMING[energy], count = layout.start.length;
  const dropAt = DROP_FIRST + layout.dropOrder.indexOf(strip) * DROP_STEP;
  const bottom = drop(clamp01((p - dropAt) / DROP));
  const move = shuffle(clamp01((p - SHUFFLE_START) / (SHUFFLE_END - SHUFFLE_START)));
  const slot = layout.start[strip] + (strip - layout.start[strip]) * move;
  const liftAt = LIFT_FIRST + (count > 1 ? (strip / (count - 1)) * LIFT_SPREAD : 0);
  // Lifting: the strip's bottom edge rises back to the top of the frame.
  const rise = lift(clamp01((p - liftAt) / LIFT));
  return { slot, bottom: p < SWITCH ? bottom : 1 - rise };
}

export const X40_stripShuffle = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const count = stripCount(size), layout = shuffleLayout(params.seed, count);
  const fills: Record<string, string> = {};
  for (let strip = 0; strip < count; strip += 1) {
    const { slot, bottom } = stripState(strip, p, params.energy, layout);
    const height = Math.min(size.height, bottom * size.height);
    if (!(height > 0.01)) continue;
    // In a whole slot the strip is exactly the slot (whole pixels); in flight it keeps its width.
    const whole = Number.isInteger(slot);
    const x0 = whole ? Math.round((slot * size.width) / count) : (slot * size.width) / count;
    const x1 = whole ? Math.round(((slot + 1) * size.width) / count) : x0 + size.width / count;
    fills[layout.tones[strip]] = (fills[layout.tones[strip]] ?? "") + rectPathD(x0, 0, x1 - x0, height, 2);
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(path(fills.accent ?? "", { fill: params.palette.accent }), path(fills.accent2 ?? "", { fill: params.palette.accent2 })),
  };
}, { revision: REVISION });
