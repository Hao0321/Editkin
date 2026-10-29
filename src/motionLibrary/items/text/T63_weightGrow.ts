import { g, path, tf } from "../../svg/document";
import { cubicInOut, loopPhase } from "../../svg/easing";
import { layoutTextBlock, weightLadderAt, type GlyphBox, type MotionFontRole, type TextBlockLayout, type WeightLadderSample } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, heroTextBox, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T63 Weight Grow (字重漸粗), PHYSICS, shown on the paper plate in Noto Serif TC:
 * the word's weight ramps 200 → 900 in 0.75 s (cubicInOut), holds at 900 for
 * 0.3 s and ramps back 900 → 200 in 0.75 s, a seamless 1.8 s loop (catalog
 * loopSeconds). The ramp steps through the static weights the family really has,
 * 200, 300, … 900, with a 2-frame (1/15 s) crossfade at each step, centred where the
 * eased ramp crosses the step (weightLadderAt, DESIGN §8): the lighter weight is
 * drawn solid and the heavier one over it at the crossfade opacity, so there is no
 * see-through dip. Bold is never faked with a stroke, which would fill the counters.
 *
 * Every weight is set at one size (fitted at 900, the widest ink, to 86% of the
 * title-safe width: heroTextBox) and positioned on the same pen grid, so the word
 * thickens in place; nothing slides. One colour: ink on the cream card, the readable
 * text role elsewhere. A face with a single weight (hand, mono, latin) stays still.
 * Energy does not apply: the ramp is the effect.
 */

const ID = "T63";
const REVISION = 1;
export const T63_LOOP_SECONDS = 1.8;
/** Ramp and hold (s), light and heavy weight, rung step, crossfade (s: two frames at 30 fps). */
export const T63_RAMP = 0.75, T63_HOLD = 0.3, T63_LIGHT = 200, T63_HEAVY = 900, T63_STEP = 100, T63_CROSSFADE = 2 / 30;
const LINE_HEIGHT = 1.08;

export interface WeightGrowPlan {
  readonly role: MotionFontRole;
  readonly fontSize: number;
  readonly color: string;
  /** Ink box of the heaviest weight (frame px). */
  readonly box: GlyphBox;
  /** Frame position of a block laid out at `weight`. */
  readonly origin: (block: TextBlockLayout) => readonly [number, number];
  readonly lines: readonly string[];
  readonly tracking: number;
}

export function weightGrowPlan(params: TextMotionParams, size: MotionFrameSize): WeightGrowPlan {
  const safe = titleSafeBox(size), tracking = displayTracking(params.lines);
  const heavyFace = textFace(params.font, T63_HEAVY);
  const heavy = layoutFittedText(params.lines, heavyFace, { ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking });
  // The heavy word's ink centre relative to its block centre: every weight's block centre goes to the same place.
  const offsetX = heavy.inkCenter[0] - heavy.block.width / 2, inkY = heavy.inkCenter[1];
  const origin = (block: TextBlockLayout): readonly [number, number] => [safe.cx - offsetX - block.width / 2, safe.cy - inkY];
  const [hx, hy] = origin(heavy.block);
  return {
    role: heavyFace.font, fontSize: heavy.fontSize, color: textOnBackground(params.palette, textBackdrop(params)),
    box: { x0: heavy.ink.x0 + hx, y0: heavy.ink.y0 + hy, x1: heavy.ink.x1 + hx, y1: heavy.ink.y1 + hy },
    origin, lines: params.lines, tracking,
  };
}

/** The weight rung(s) at loop time u (seconds in 0..1.8): up-ramp, hold at 900, down-ramp. */
export function weightAt(role: MotionFontRole, u: number): WeightLadderSample {
  const options = { step: T63_STEP, crossfade: T63_CROSSFADE / T63_RAMP, ease: cubicInOut };
  if (u < T63_RAMP) return weightLadderAt(role, T63_LIGHT, T63_HEAVY, u / T63_RAMP, options);
  if (u < T63_RAMP + T63_HOLD) return weightLadderAt(role, T63_LIGHT, T63_HEAVY, 1, options);
  return weightLadderAt(role, T63_HEAVY, T63_LIGHT, (u - T63_RAMP - T63_HOLD) / T63_RAMP, options);
}

/** The word laid out at one real weight, on the shared pen grid. */
export function weightBlock(plan: WeightGrowPlan, weight: number): { readonly block: TextBlockLayout; readonly x: number; readonly y: number } {
  const block = layoutTextBlock(plan.lines, { font: plan.role, weight, size: plan.fontSize, lineHeight: LINE_HEIGHT, tracking: plan.tracking, align: "center" });
  const [x, y] = plan.origin(block);
  return { block, x, y };
}

export const T63_weightGrow = defineTextMotion(ID, (params, t, size) => {
  const plan = weightGrowPlan(params, size);
  const doc = createTextDocument(size, params);
  const rung = weightAt(plan.role, loopPhase(t, T63_LOOP_SECONDS) * T63_LOOP_SECONDS);
  const draw = (weight: number, opacity?: number) => {
    const { block, x, y } = weightBlock(plan, weight);
    return path(compactPathD(block.pathD), { fill: plan.color, opacity, transform: tf.translate(x, y) });
  };
  return doc.render(g(undefined, draw(rung.lighter), rung.heavier !== rung.lighter ? draw(rung.heavier, rung.heavierOpacity) : ""));
}, { revision: REVISION });
