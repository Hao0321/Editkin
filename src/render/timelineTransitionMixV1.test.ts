import { describe, expect, it } from "vitest";
import { linearToAcescct, linearToDisplay } from "../color/gradeV2Color";
import { timelineTransitionMixGraphV1, timelineTransitionMixV1, type TransitionRgbaV1 } from "./timelineTransitionMixV1";

describe("working-linear paired-source transition contract", () => {
  it.each(["dissolve", "dip"] as const)("has exact %s endpoints, including HDR and transparent coverage", kernel => {
    const a: TransitionRgbaV1 = [4, -.01, .3, .25], b: TransitionRgbaV1 = [.2, 12, .7, .75];
    expect(timelineTransitionMixV1(a, b, 0, kernel)).toEqual(a); expect(timelineTransitionMixV1(a, b, 1, kernel)).toEqual(b);
    expect(timelineTransitionMixV1([1, 1, 1, 0], b, 0, kernel)).toEqual([0, 0, 0, 0]);
  });
  it("retains dip black coverage at tiny positive progress without cancellation", () => {
    const u = 1e-16, colourWeight = (1 - 2 * u) * 1e-16, alpha = colourWeight + 2 * u;
    const actual = timelineTransitionMixV1([1, 3, 5, 1e-16], [8, 4, 2, 0], u, "dip");
    expect(actual[3]).toBe(alpha);
    for (const [c, value] of [1, 3, 5].entries()) expect(actual[c]).toBeCloseTo(value * colourWeight / alpha, 12);
  });
  it("mixes transparent inputs by premultiplied coverage rather than performing a double over", () => {
    const result = timelineTransitionMixV1([1, 0, 0, .25], [0, 0, 1, .75], .5, "dissolve");
    expect(result).toEqual([.25, 0, .75, .5]);
    expect(timelineTransitionMixV1([1, 0, 0, 0], [0, 1, 0, 0], .5, "dissolve")).toEqual([0, 0, 0, 0]);
  });
  it("dip goes through opaque scene-linear black with continuous alpha", () => {
    const a: TransitionRgbaV1 = [1, .3, .2, .25], b: TransitionRgbaV1 = [.2, .4, .8, .75];
    expect(timelineTransitionMixV1(a, b, .5, "dip")).toEqual([0, 0, 0, 1]);
    expect(timelineTransitionMixV1(a, b, .25, "dip")).toEqual([.2, .06, .04, .625]);
    const afterBlack = timelineTransitionMixV1(a, b, .75, "dip");
    expect(afterBlack[3]).toBe(.875);
    for (const [index, value] of [3 / 35, 6 / 35, 12 / 35].entries()) expect(afterBlack[index]).toBeCloseTo(value, 12);
  });
  it.each(["acescct", "rec709_display"] as const)("decodes %s before mixing and encodes only once", space => {
    const encode = space === "acescct" ? linearToAcescct : linearToDisplay;
    const a: TransitionRgbaV1 = [encode(.1), encode(.2), encode(.3), 1], b: TransitionRgbaV1 = [encode(.9), encode(.8), encode(.7), 1];
    const result = timelineTransitionMixV1(a, b, .5, "dissolve", space);
    for (const value of result.slice(0, 3)) expect(value).toBeCloseTo(encode(.5), 12);
    if (space === "acescct") expect(timelineTransitionMixV1(a, b, .5, "dip", space)).toEqual([encode(0), encode(0), encode(0), 1]);
  });
  it("refuses malformed pixels, windows, graph selectors and unavailable kernels", () => {
    expect(() => timelineTransitionMixV1([0, 0, 0, -1], [0, 0, 0, 1], .5, "dissolve")).toThrow(/PIXEL_INVALID/);
    expect(() => timelineTransitionMixV1([0, 0, 0, 1], [0, 0, 0, 1], NaN, "dissolve")).toThrow(/PIXEL_INVALID/);
    expect(() => timelineTransitionMixGraphV1("a[evil]", "b", "out", { startFrame: 0, durationFrames: 30 }, "dissolve", "linear")).toThrow(/GRAPH_LABEL/);
    expect(() => timelineTransitionMixGraphV1("a", "b", "out", { startFrame: 0, durationFrames: 0 }, "dissolve", "linear")).toThrow(/FRAME_WINDOW/);
  });
});
