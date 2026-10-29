import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { backOut, clamp01, cubicIn, quadIn, quartIn, sineIn, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X36 Bar Panels: a row of flat bars (accent and deep shade in alternation; the seed swaps them)
 * rises from the bottom like an equaliser. Each bar jumps to a seeded level, bounces, dips a
 * little and jumps again, every move a back-out bounce (Motion Language overshoot), until all
 * of them reach the top and cover A. Under that full cover the matte switches to B at exactly
 * D/2 (ART_DIRECTION §4). Then the bars fall the same way, a jump down to a seeded level, a
 * small bounce back up, and a drop out of the frame, revealing B from the top.
 *
 * Timing: each bar starts within the first 0.1 of the duration and reaches the top by 44%
 * (three moves of 0.12, 0.1 and 0.12); the falls start within 0.1 after D/2 and end by 96%. The
 * overshoot past the top is outside the frame, so the bars cover A from the moment each crosses
 * the top. Energy sets the bounce (back-out overshoot 0.8 … 2.4) and the final drop (calm sine
 * … hype quart in). Bars are whole pixels wide, so no seams. Every point changes at most a few
 * times, in narrow bands, well under 3 flashes per second over any large area. Directional: the
 * direction names the growth (bottom to top by default).
 */

const ID = "X36";
const REVISION = 1;
const SWITCH = 0.5;
/** Target bar width, as a fraction of the short side. */
const BAR = 0.14;

interface BarTiming { readonly overshoot: number; readonly drop: EasingFunction }
const TIMING: Record<MotionEnergy, BarTiming> = {
  calm: { overshoot: 0.8, drop: sineIn },
  standard: { overshoot: 1.4, drop: quadIn },
  punchy: { overshoot: 1.9, drop: cubicIn },
  hype: { overshoot: 2.4, drop: quartIn },
};

/** One key of a bar's level: at progress `at`, the level reached (fraction of the frame along the growth). */
interface LevelKey { readonly at: number; readonly level: number }

export interface BarLayout {
  /** Rising keys (from 0 to the top) and falling keys (from the top to 0) of each bar. */
  readonly rise: readonly (readonly LevelKey[])[];
  readonly fall: readonly (readonly LevelKey[])[];
  readonly tones: readonly ("accent" | "accent2")[];
}

/** Bar count: about 14% of the short side each. */
export function barCount(size: MotionFrameSize, direction: MotionTransitionDirection = "bottom_to_top"): number {
  return Math.max(3, Math.round(travelFrame(direction, size).cross / (BAR * Math.min(size.width, size.height))));
}

export function barLayout(seed: number, count: number): BarLayout {
  const rng = createSeededRng(ID, seed, `bars-${count}`), flip = rng.int(0, 1);
  const rise: LevelKey[][] = [], fall: LevelKey[][] = [];
  for (let bar = 0; bar < count; bar += 1) {
    const start = rng.range(0, 0.1), first = rng.range(0.3, 0.7), second = first - rng.range(0.05, 0.15);
    rise.push([{ at: start, level: 0 }, { at: start + 0.12, level: first }, { at: start + 0.22, level: second }, { at: start + 0.34, level: 1 }]);
    const out = SWITCH + rng.range(0, 0.1), low = rng.range(0.35, 0.65);
    fall.push([{ at: out, level: 1 }, { at: out + 0.12, level: low }, { at: out + 0.22, level: low + rng.range(0.05, 0.12) }, { at: out + 0.36, level: 0 }]);
  }
  return { rise, fall, tones: Array.from({ length: count }, (_, bar) => ((bar + flip) % 2 === 0 ? "accent" : "accent2")) };
}

/** A bar's level at progress p from its keys: back-out bounces between keys, the last falling key an accelerating drop. */
export function barLevel(keys: readonly LevelKey[], p: number, energy: MotionEnergy, falling: boolean): number {
  const { overshoot, drop } = TIMING[energy];
  if (p <= keys[0].at) return keys[0].level;
  for (let index = 1; index < keys.length; index += 1) {
    const from = keys[index - 1], to = keys[index];
    if (p < to.at) {
      const local = (p - from.at) / (to.at - from.at);
      const ease = falling && index === keys.length - 1 ? drop(local) : backOut(local, overshoot);
      return from.level + (to.level - from.level) * ease;
    }
  }
  return keys[keys.length - 1].level;
}

export const X36_barPanels = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const direction = params.direction ?? "bottom_to_top";
  const frame = travelFrame(direction, size), { length, cross } = frame;
  const count = barCount(size, direction), { rise, fall, tones } = barLayout(params.seed, count);
  const fills: Record<string, string> = {};
  for (let bar = 0; bar < count; bar += 1) {
    const level = p < SWITCH ? barLevel(rise[bar], p, params.energy, false) : barLevel(fall[bar], p, params.energy, true);
    const reach = Math.min(length, Math.max(0, level) * length);
    if (!(reach > 0.01)) continue;
    const v0 = Math.round((bar * cross) / count), v1 = Math.round(((bar + 1) * cross) / count);
    const corners: Point2[] = [frame.toFrame(0, v0), frame.toFrame(reach, v0), frame.toFrame(reach, v1), frame.toFrame(0, v1)];
    fills[tones[bar]] = (fills[tones[bar]] ?? "") + polygonPathD(corners, 2);
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(path(fills.accent ?? "", { fill: params.palette.accent }), path(fills.accent2 ?? "", { fill: params.palette.accent2 })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
