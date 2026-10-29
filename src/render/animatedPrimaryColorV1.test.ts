import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ClipKeyframe, type ColorAdjustments, type TimelineClip } from "../domain/types";
import { animatedPrimaryFieldsV1, primaryAnimationExceedsLimitV1, primaryAnimationFiltersV1, primaryAnimationPlanV1, PRIMARY_ANIMATION_RUN_LIMIT_16BIT_CURVES_V1 } from "./animatedPrimaryColorV1";

const key = (time: number, color: Partial<ColorAdjustments>, easing: ClipKeyframe["easing"] = "linear"): ClipKeyframe =>
  ({ id: `k${time}`, time, easing, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, ...color } });
function clip(keyframes: ClipKeyframe[], color: Partial<ColorAdjustments> = {}): TimelineClip {
  return { id: "c", assetId: "a", trackId: "t", timelineStart: 0, sourceStart: 0, duration: 1, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, ...color }, keyframes };
}

describe("animated primary colour (exposure / temperature / tint / tone) on export", () => {
  it("keeps the static chain when keyframes leave these fields at clip.color", () => {
    expect(primaryAnimationPlanV1(clip([]), 30, 30)).toBeUndefined();
    expect(primaryAnimationPlanV1(clip([key(.5, { brightness: .2, contrast: 1.3 })]), 30, 30)).toBeUndefined();
    expect(primaryAnimationPlanV1(clip([key(.5, { exposure: .4 })], { exposure: .4 }), 30, 30)).toBeUndefined();
  });

  it("detects a keyframed field that differs from clip.color, including a constant one (the preview uses the keyframes)", () => {
    expect(animatedPrimaryFieldsV1(clip([key(0, { shadows: .3 }), key(.5, { shadows: .3 })]))).toEqual(["shadows"]);
    expect(animatedPrimaryFieldsV1(clip([key(.5, { exposure: 1, tint: -.2 })]))).toEqual(["exposure", "tint"]);
  });

  it("compiles runs of equal frames with half-frame windows, open at both ends, in the static filter order", () => {
    // Exposure ramps over frames 0..15, then holds; temperature jumps at the hold keyframe.
    const plan = primaryAnimationPlanV1(clip([key(0, {}), key(.5, { exposure: 1.5 }, "hold"), key(.8, { exposure: 1.5, temperature: .5 })]), 30, 30)!;
    expect(plan.fields).toEqual(["exposure", "temperature"]);
    expect(plan.exposure[0]).toEqual({ firstFrame: 0, lastFrame: 0 });
    expect(plan.exposure.at(-1)).toMatchObject({ firstFrame: 15, lastFrame: 29, filter: "exposure=exposure=1.5:black=0" });
    expect(plan.colorBalance.map(run => [run.firstFrame, run.lastFrame, Boolean(run.filter)])).toEqual([[0, 23, false], [24, 29, true]]);
    const filters = primaryAnimationFiltersV1(plan, 30);
    expect(filters.findIndex(filter => filter.startsWith("curves="))).toBeLessThan(filters.findIndex(filter => filter.startsWith("colorbalance=")));
    expect(filters.findIndex(filter => filter.startsWith("colorbalance="))).toBeLessThan(filters.findIndex(filter => filter.startsWith("exposure=")));
    expect(filters.at(-1)).toBe("exposure=exposure=1.5:black=0:enable='gte(t\\,0.48333333333333334)'");
    expect(filters.find(filter => filter.startsWith("exposure="))).toMatch(/enable='gte\(t\\,0\.016666666666666666\)\*lt\(t\\,0\.05\)'$/);
    // A run that starts at frame 0 has no lower bound and is never left without a filter between two runs.
    const first = primaryAnimationFiltersV1(primaryAnimationPlanV1(clip([key(0, { exposure: 1 }), key(.5, { exposure: -1 })]), 30, 30)!, 30)[0];
    expect(first).toBe("exposure=exposure=1:black=0:enable='lt(t\\,0.016666666666666666)'");
  });

  it("follows timeline-transition read clocks and bounds 16-bit curves runs", () => {
    const ramp = clip([key(0, { shadows: -.5 }), key(1, { shadows: .5 })]);
    const shifted = primaryAnimationPlanV1(ramp, 30, 40, -.2)!;
    // Read frames before the clip start hold the first colour (clamped clip-local time).
    expect(shifted.curves[0]).toMatchObject({ firstFrame: 0, lastFrame: 6 });
    const plan = primaryAnimationPlanV1({ ...ramp, duration: 20, keyframes: [key(0, { shadows: -.5 }), key(20, { shadows: .5 })] }, 30, 600)!;
    expect(primaryAnimationExceedsLimitV1(plan, false)).toBeUndefined();
    expect(primaryAnimationExceedsLimitV1(plan, true)).toEqual({ frames: expect.any(Number), limit: PRIMARY_ANIMATION_RUN_LIMIT_16BIT_CURVES_V1 });
  });
});
