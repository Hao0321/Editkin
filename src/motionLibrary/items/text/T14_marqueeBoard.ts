import { g, line } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { marqueeRepeatStarts, marqueeStrip, marqueeUnit, marqueeUnitText, type MarqueeUnit } from "./T09_hugeTextScroll";

/**
 * T14 Marquee Board (電光掲示板): five stacked ticker rows on the accent plate,
 * each with its own weight (900 / 300 / 700 / 400 / 800), size, speed and
 * direction (alternating), the rows cycling through the lines (four lines by
 * default, so the fifth row repeats line 1; PHASE1_REVIEW ruling 1). Each row
 * repeats its text with bullets (・) drawn in the second readable colour (paper
 * on the accent plate). Thin rules in the text colour frame the rows like a
 * board. The rows fill the 5% title-safe box vertically and run edge to edge by
 * definition; big rows are at least 9% of the short side, small rows at least 4.5%.
 *
 * A seamless 4 s loop (catalog loopSeconds): every row advances a whole number of
 * repeats per loop. Energy scales the speeds (whole repeats only).
 */

const ID = "T14";
const REVISION = 1;
export const T14_LOOP_SECONDS = 4;
export const T14_ROWS = 5;
const ROW_SIZES: readonly number[] = [1, 0.6, 0.86, 0.56, 0.78];
const ROW_WEIGHTS: readonly number[] = [900, 300, 700, 400, 800];
/** Target speeds (short sides per second), alternating direction. */
const ROW_SPEEDS: readonly number[] = [0.22, 0.34, 0.16, 0.4, 0.26];
/** Row ink height cap (× row pitch), width cap (frame width per em), tracking (em), rule stroke (× short side). */
const INK_SHARE = 0.72, EMS_ACROSS = 5.2, TRACKING = -0.03, RULE = 0.0035;

export interface MarqueeRow {
  readonly unit: MarqueeUnit;
  readonly baseline: number;
  readonly weight: number;
  /** Whole repeats per loop, signed (positive moves toward −x). */
  readonly repeatsPerLoop: number;
  /** Ink box vertical extent (frame px). */
  readonly y0: number;
  readonly y1: number;
}

export interface MarqueeBoardPlan {
  readonly rows: readonly MarqueeRow[];
  /** Rule y positions (frame px). */
  readonly rules: readonly number[];
  readonly ruleWidth: number;
  readonly textColor: string;
  readonly bulletColor: string;
}

export function marqueeBoardPlan(params: TextMotionParams, size: MotionFrameSize): MarqueeBoardPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const pitch = safe.height / T14_ROWS;
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  const speedScale = energyProfile(params.energy).amplitude;
  const rows: MarqueeRow[] = [];
  for (let index = 0; index < T14_ROWS; index += 1) {
    const face = textFace(params.font, ROW_WEIGHTS[index]);
    const text = marqueeUnitText(params.lines[index % params.lines.length], face);
    const probe = marqueeUnit(text, face, 100, TRACKING);
    const probeInk = Math.max(1, probe.ink.y1 - probe.ink.y0);
    const largest = Math.min((INK_SHARE * pitch / probeInk) * 100, size.width / EMS_ACROSS);
    const unit = marqueeUnit(text, face, largest * ROW_SIZES[index], TRACKING);
    const centre = safe.y0 + (index + 0.5) * pitch;
    const baseline = centre - (unit.ink.y0 + unit.ink.y1) / 2;
    const target = ROW_SPEEDS[index] * short * speedScale * T14_LOOP_SECONDS;
    rows.push({
      unit, baseline, weight: ROW_WEIGHTS[index], repeatsPerLoop: (index % 2 === 0 ? 1 : -1) * Math.max(1, Math.round(target / unit.period)),
      y0: baseline + unit.ink.y0, y1: baseline + unit.ink.y1,
    });
  }
  return {
    rows, rules: Array.from({ length: T14_ROWS + 1 }, (_, index) => safe.y0 + index * pitch), ruleWidth: Math.max(1.5, RULE * short),
    textColor, bulletColor: secondaryTone(params.palette, backdrop),
  };
}

export const T14_marqueeBoard = defineTextMotion(ID, (params, t, size) => {
  const plan = marqueeBoardPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T14_LOOP_SECONDS);
  const rules = plan.rules.map(y => line(-1, y, size.width + 1, y, { stroke: plan.textColor, "stroke-width": plan.ruleWidth }));
  const rows = plan.rows.map(row => {
    const starts = marqueeRepeatStarts(row.unit, 0, row.repeatsPerLoop * u, 0, size.width);
    return g(undefined, marqueeStrip(row.unit, starts, row.baseline, plan.textColor, plan.bulletColor));
  });
  return doc.render(g(undefined, rules), rows);
}, { revision: REVISION });
