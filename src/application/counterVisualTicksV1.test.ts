import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { deriveCounterVisualTicksV1 } from "./counterVisualTicksV1";

function fixture() {
  const project = createEmptyProject("explicit counter states", { id: "counter", fps: 30 });
  project.motionGraphics = [0, 2, 4, 6, 15].map((frame, i) => createMotionGraphic(`g${i}`, "counter", String(i + 1), frame / 30, 1 / 30));
  const request = { enabled: true, durationFrames: 60, trackId: "audio-main", idPrefix: "ticks",
    bindings: [{ source: "editorial_states", role: "challenge_ledger", graphicIds: project.motionGraphics.map(g => g.id) }], sound: { variant: 1, gain: .4 } };
  return { project, request };
}
describe("frame-bound counter/state tick extraction", () => {
  it("uses actual graphic frames, keeps full sources and reports dense suppressed hits without moving them", () => {
    const { project, request } = fixture(), before = JSON.stringify(project), plan = deriveCounterVisualTicksV1(project, request);
    expect(plan.hooks.map(h => h.frame)).toEqual([0, 2, 4, 6, 15]);
    expect(plan.selected.map(h => h.frame)).toEqual([0, 4, 15]);
    expect(plan.suppressed.map(h => [h.hook.frame, h.reason])).toEqual([[2, "sound_overlap"], [6, "sound_overlap"]]);
    expect(plan.durationSamples).toBe(4800); expect(plan.defaultEnabled).toBe(false); expect(JSON.stringify(project)).toBe(before);
  });
  it("rejects absent/duplicate/non-frame graphics and ambiguous ids instead of partial success", () => {
    const { project, request } = fixture();
    request.bindings[0].graphicIds.push("missing"); expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("MISSING_OR_DUPLICATE");
    request.bindings[0].graphicIds.pop(); request.bindings[0].graphicIds.push("g0"); expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("MISSING_OR_DUPLICATE");
    request.bindings[0].graphicIds.pop(); project.motionGraphics[0].timelineStart = .01; expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("CLOCK_INVALID");
    project.motionGraphics[0].timelineStart = 0; project.motionGraphics.push(project.motionGraphics[0]); expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("AMBIGUOUS");
  });
  it("validates full duration and suppresses only the sound tail, never a graphic outside the requested timeline", () => {
    const { project, request } = fixture(); request.durationFrames = 16;
    expect(deriveCounterVisualTicksV1(project, request).suppressed).toContainEqual(expect.objectContaining({ hook: expect.objectContaining({ frame: 15 }), reason: "full_sound_tail" }));
    request.durationFrames = 15; expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("OUTSIDE_TIMELINE");
  });
  it("requires explicit opt-in, original tick choice and supported clock; no v3 onset is claimed as dynamic count evidence", () => {
    const { project, request } = fixture();
    for (const patch of [{ enabled: false }, { sound: { variant: 6, gain: .4 } }, { surprise: true }]) expect(() => deriveCounterVisualTicksV1(project, { ...request, ...patch })).toThrow();
    project.motionGraphics[0].schema = "hao.motion-composition/v3"; expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("V3_TICKS_UNSUPPORTED");
    project.motionGraphics[0].schema = "hao.motion-composition/v1"; project.fps = 0; expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("CLOCK_BUDGET");
  });
  it("handles a 20-hour numeric clock without signed-int32 wrap; this is not endurance validation", () => {
    const { project, request } = fixture(); project.motionGraphics = [createMotionGraphic("late", "counter", "4/4", 72_000, .1)];
    request.bindings[0].graphicIds = ["late"]; request.durationFrames = 2_160_030;
    const plan = deriveCounterVisualTicksV1(project, request); expect(plan.selected[0].frame).toBe(2_160_000);
    expect(Math.round(plan.selected[0].frame * 48_000 / project.fps)).toBe(3_456_000_000);
    request.durationFrames = 2_592_001; expect(() => deriveCounterVisualTicksV1(project, request)).toThrow("CLOCK_BUDGET");
  });
  it("keeps both second-based editable clips and rounded sample-based DSP nonoverlapping at fractional fps", () => {
    const { project, request } = fixture(); project.fps = 30.0005;
    project.motionGraphics = [0, 3, 6].map((f, i) => createMotionGraphic(`g${i}`, "counter", String(i), f / project.fps, 1 / project.fps));
    request.bindings[0].graphicIds = project.motionGraphics.map(g => g.id);
    expect(deriveCounterVisualTicksV1(project, request).selected.map(h => h.frame)).toEqual([0, 6]);
  });
  it("value ladder bindings use actual authored state onsets; simultaneous hits are explicitly suppressed", () => {
    const { project, request } = fixture(); project.motionGraphics[1].timelineStart = 0;
    const plan = deriveCounterVisualTicksV1(project, { ...request, bindings: [{ source: "editorial_states", role: "scale_ladder", graphicIds: ["g1", "g0", "g4"] }] });
    expect(plan.selected.map(h => h.graphicId)).toEqual(["g0", "g4"]); expect(plan.suppressed[0].hook.graphicId).toBe("g1");
    expect(plan.hooks.every(h => h.role === "scale_ladder")).toBe(true);
  });
  it("caps whole WAV placements at 32 and reports remaining state hits; no unbounded sampling of a long timeline", () => {
    const { project, request } = fixture();
    project.motionGraphics = Array.from({ length: 64 }, (_, i) => createMotionGraphic(`state-${i}`, "counter", String(i), i * .2, .1));
    const bindings = [0, 32].map(start => ({ source: "editorial_states", role: "challenge_ledger", graphicIds: project.motionGraphics.slice(start, start + 32).map(g => g.id) }));
    const plan = deriveCounterVisualTicksV1(project, { ...request, durationFrames: 400, bindings });
    expect(plan.selected).toHaveLength(32); expect(plan.suppressed).toHaveLength(32); expect(plan.suppressed.every(h => h.reason === "hit_budget")).toBe(true);
  });
});
