import { primaryExposureFilter, primaryToneFilters } from "../color/primaryGrade";
import { clipAnimationPoints } from "../domain/clipAnimation";
import { animatedClipState } from "../domain/editGraph";
import type { ColorAdjustments, TimelineClip } from "../domain/types";
import { escapeExpression, hasPrimaryToneAdjustment } from "./ffmpegExpressions";

/**
 * Animated exposure / temperature / tint / tone (pivot, shadows, highlights, blacks, whites) on export.
 *
 * Before this module the export animated only brightness, contrast, saturation and hue (eq/hue per-frame
 * expressions) and rendered every other primary field from the static clip.color, so keyframed exposure, white
 * temperature/tint and tone animated in the preview but not in the video.
 *
 * curves, colorbalance and exposure have no per-frame expression options, and sending them commands (sendcmd) is not
 * frame-accurate: frames can queue between the command filter and its target. Instead the clip's frames are split
 * into runs whose primary parameters are equal, and each run gets its own instance of the static filters, enabled on
 * that run only through the timeline `enable` option. A frame therefore passes through exactly the filters, with
 * exactly the parameter strings, the static export would use for the colour the preview evaluates at that frame
 * (animatedClipState). Clips whose keyframes keep these fields equal to clip.color keep the static chain byte for byte.
 */
export const PRIMARY_ANIMATED_FIELDS_V1 = ["exposure", "temperature", "tint", "pivot", "shadows", "highlights", "blacks", "whites"] as const;
export type PrimaryAnimatedFieldV1 = typeof PRIMARY_ANIMATED_FIELDS_V1[number];

/** Most filter instances one group (curves, colorbalance or exposure) may use for one clip. */
export const PRIMARY_ANIMATION_RUN_LIMIT_V1 = 1800;
/** 16-bit curves allocate a 65536-entry table per channel (512 KiB an instance). */
export const PRIMARY_ANIMATION_RUN_LIMIT_16BIT_CURVES_V1 = 300;

/** Fields whose keyframed value differs from clip.color somewhere (export would otherwise render clip.color). */
export function animatedPrimaryFieldsV1(clip: TimelineClip): PrimaryAnimatedFieldV1[] {
  if (!clip.keyframes.length) return [];
  const points = clipAnimationPoints(clip);
  return PRIMARY_ANIMATED_FIELDS_V1.filter(field => points.some(point => point.color[field] !== clip.color[field]));
}

/** zh-TW names for refusal messages (interface message keys). */
export const PRIMARY_FIELD_LABELS_V1: Readonly<Record<PrimaryAnimatedFieldV1, string>> = {
  exposure: "曝光", temperature: "色溫", tint: "色調", pivot: "對比支點", shadows: "陰影", highlights: "亮部", blacks: "黑色", whites: "白色",
};

export interface PrimaryAnimationRunV1 { firstFrame: number; lastFrame: number; filter?: string }
export interface PrimaryAnimationPlanV1 {
  fields: PrimaryAnimatedFieldV1[];
  curves: PrimaryAnimationRunV1[];
  colorBalance: PrimaryAnimationRunV1[];
  exposure: PrimaryAnimationRunV1[];
  /** Frames read by the clip's chain (the last run extends to the end of the stream). */
  frameCount: number;
}

function runsOf(values: readonly (string | undefined)[]): PrimaryAnimationRunV1[] {
  const runs: PrimaryAnimationRunV1[] = [];
  for (const [frame, filter] of values.entries()) {
    const last = runs.at(-1);
    if (last && last.filter === filter) last.lastFrame = frame;
    else runs.push({ firstFrame: frame, lastFrame: frame, ...(filter === undefined ? {} : { filter }) });
  }
  return runs;
}

/**
 * Per-frame primary filters, evaluated with the preview's evaluator at each read frame's clip-local time.
 * `localTimeOffset` maps read time to clip time for timeline-transition handles (the eq clock does the same).
 */
export function primaryAnimationPlanV1(clip: TimelineClip, fps: number, frameCount: number, localTimeOffset = 0): PrimaryAnimationPlanV1 | undefined {
  const fields = animatedPrimaryFieldsV1(clip);
  if (!fields.length) return undefined;
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(frameCount) || frameCount < 1 || !Number.isFinite(localTimeOffset)) throw new Error("Invalid primary animation clock");
  const curves: (string | undefined)[] = [], balance: (string | undefined)[] = [], exposure: (string | undefined)[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const local = Math.min(clip.duration, Math.max(0, frame / fps + localTimeOffset));
    const color: ColorAdjustments = animatedClipState(clip, local, fps).color;
    // Exactly the static chain's strings for this colour (compositorVideoFilters, primaryGrade).
    const tone = hasPrimaryToneAdjustment(color) ? primaryToneFilters(color) : [];
    curves.push(tone.find(filter => filter.startsWith("curves=")));
    balance.push(tone.find(filter => filter.startsWith("colorbalance=")));
    exposure.push(color.exposure !== 0 ? primaryExposureFilter(color.exposure) : undefined);
  }
  return { fields, curves: runsOf(curves), colorBalance: runsOf(balance), exposure: runsOf(exposure), frameCount };
}

/** Largest group, for the run limits. */
export function primaryAnimationRunCountsV1(plan: PrimaryAnimationPlanV1): { curves: number; colorBalance: number; exposure: number } {
  const count = (runs: readonly PrimaryAnimationRunV1[]) => runs.filter(run => run.filter !== undefined).length;
  return { curves: count(plan.curves), colorBalance: count(plan.colorBalance), exposure: count(plan.exposure) };
}

export function primaryAnimationExceedsLimitV1(plan: PrimaryAnimationPlanV1, highBitDepth: boolean): { frames: number; limit: number } | undefined {
  const counts = primaryAnimationRunCountsV1(plan);
  const curvesLimit = highBitDepth ? PRIMARY_ANIMATION_RUN_LIMIT_16BIT_CURVES_V1 : PRIMARY_ANIMATION_RUN_LIMIT_V1;
  if (counts.curves > curvesLimit) return { frames: counts.curves, limit: curvesLimit };
  const other = Math.max(counts.colorBalance, counts.exposure);
  return other > PRIMARY_ANIMATION_RUN_LIMIT_V1 ? { frames: other, limit: PRIMARY_ANIMATION_RUN_LIMIT_V1 } : undefined;
}

/**
 * The filter list replacing the static `primary` + `exposure` entries of preImage: every curves run, then every
 * colorbalance run, then every exposure run (the static order), each enabled on its frames only. Windows sit on half
 * frames of the chain clock `t` (the clock the eq expressions read), the first opens at -infinity and the last never
 * closes, so no frame can fall between two runs.
 */
export function primaryAnimationFiltersV1(plan: PrimaryAnimationPlanV1, fps: number): string[] {
  const window = (run: PrimaryAnimationRunV1, last: boolean) => {
    const from = run.firstFrame === 0 ? undefined : (run.firstFrame - .5) / fps;
    const to = last ? undefined : (run.lastFrame + .5) / fps;
    const terms = [...(from === undefined ? [] : [`gte(t,${String(from)})`]), ...(to === undefined ? [] : [`lt(t,${String(to)})`])];
    return terms.length ? terms.join("*") : "1";
  };
  const group = (runs: readonly PrimaryAnimationRunV1[]) => runs.flatMap((run, index) => run.filter === undefined ? []
    : [`${run.filter}:enable='${escapeExpression(window(run, index === runs.length - 1))}'`]);
  return [...group(plan.curves), ...group(plan.colorBalance), ...group(plan.exposure)];
}

/** zh-TW field names joined for a refusal message. */
export function primaryAnimatedFieldLabelsV1(fields: readonly PrimaryAnimatedFieldV1[]): string {
  return fields.map(field => PRIMARY_FIELD_LABELS_V1[field]).join("、");
}
