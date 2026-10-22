import { describe, expect, it } from "vitest";
import { pairFixtureV1 } from "./timelineTransitionV1.fixture";
import { compileTimelineTransitionHandleV1, compileTimelineTransitionHandlesV1, timelineTransitionProgressV1 } from "./timelineTransitionHandlesV1";
import { TIMELINE_TRANSITION_FAMILIES_V1, timelineTransitionSchemaV1 } from "./timelineTransitionV1";


describe("paired transition actual source-handle plan", () => {
  it("reads distinct source handles around one cut without modifying authored clips", () => {
    const { project, transition } = pairFixtureV1(), before = structuredClone(project), plan = compileTimelineTransitionHandleV1(project, transition);
    expect(plan).toMatchObject({ cutFrame: 60, startFrame: 48, endFrame: 72, durationFrames: 24 });
    expect(plan.from.sourceStartSeconds).toBeCloseTo(2.6, 12); expect(plan.to.sourceStartSeconds).toBeCloseTo(3.6, 12);
    expect(plan.from.sourceDurationSeconds).toBe(.8); expect(plan.from.clipLocalStartSeconds).toBeCloseTo(1.6, 12);
    expect(plan.to.clipLocalStartSeconds).toBeCloseTo(-.4, 12); expect(project).toEqual(before);
    const frames = Array.from({ length: plan.durationFrames }, (_, i) => plan.startFrame + i);
    expect(new Set(frames).size).toBe(24); expect(frames.at(-1)).toBe(71);
    expect(frames.map(f => timelineTransitionProgressV1(plan, f))).toEqual(frames.map((_, i) => i / 24));
    expect(timelineTransitionProgressV1(plan, 48.25)).toBe(.25 / 24);
    expect(timelineTransitionProgressV1(plan, 0)).toBe(0); expect(timelineTransitionProgressV1(plan, 72)).toBe(1);
  });
  it("supports asymmetric or one-sided windows without changing the cut", () => {
    const { project, transition } = pairFixtureV1();
    expect(compileTimelineTransitionHandleV1(project, { ...transition, beforeFrames: 6, afterFrames: 15 })).toMatchObject({ cutFrame: 60, startFrame: 54, endFrame: 75, durationFrames: 21 });
    expect(compileTimelineTransitionHandleV1(project, { ...transition, beforeFrames: 0 })).toMatchObject({ startFrame: 60, endFrame: 72 });
  });
  it("keeps rational NTSC frame positions exact", () => {
    const { project, transition } = pairFixtureV1(); project.fps = 30000 / 1001;
    project.tracks[0].clips[0].duration = 60 / project.fps;
    Object.assign(project.tracks[0].clips[1], { timelineStart: 60 / project.fps, duration: 60 / project.fps });
    const plan = compileTimelineTransitionHandleV1(project, transition); expect(plan.startFrame).toBe(48); expect(plan.endFrame).toBe(72);
    expect(plan.to.sourceStartSeconds).toBeCloseTo(4 - 12 / project.fps, 12);
  });
  it("preserves literal clip identities rather than trimming reference strings", () => {
    const { project, transition } = pairFixtureV1(); project.tracks[0].clips[1].id = " incoming "; transition.toClipId = " incoming ";
    expect(compileTimelineTransitionHandleV1(project, transition).to.clipId).toBe(" incoming ");
  });
  it.each(["missing-before", "missing-after", "gap", "other-track", "controller", "non-frame-cut", "outside-clips", "missing-asset"])("refuses %s rather than silently freezing source boundaries", kind => {
    const { project, transition } = pairFixtureV1(), [from, to] = project.tracks[0].clips;
    if (kind === "missing-before") to.sourceStart = 0;
    if (kind === "missing-after") project.assets[0].duration = from.sourceStart + from.duration;
    if (kind === "gap") to.timelineStart = 3;
    if (kind === "other-track") transition.trackId = "missing";
    if (kind === "controller") to.layer = { enabled: true, blendMode: "normal", role: "controller" };
    if (kind === "non-frame-cut") { from.duration = 2.001; to.timelineStart = 2.001; }
    if (kind === "outside-clips") transition.beforeFrames = 61;
    if (kind === "missing-asset") to.assetId = "missing";
    expect(() => compileTimelineTransitionHandleV1(project, transition)).toThrow(/TIMELINE_TRANSITION_/);
  });
  it("supports still images without claiming nonexistent temporal source frames", () => {
    const { project, transition } = pairFixtureV1(); Object.assign(project.assets[0], { kind: "image", duration: 0 });
    project.tracks[0].clips.forEach(c => c.sourceStart = 0);
    expect(compileTimelineTransitionHandleV1(project, transition).to.sourceStartSeconds).toBe(0);
  });
  it("rejects duplicate identifiers/cuts and overlapping three-clip windows", () => {
    const { project, transition } = pairFixtureV1();
    expect(() => compileTimelineTransitionHandlesV1({ ...project, timelineTransitions: [transition, transition] })).toThrow(/DUPLICATE_ID/);
    expect(() => compileTimelineTransitionHandlesV1({ ...project, timelineTransitions: [transition, { ...transition, id: "duplicate-cut" }] })).toThrow(/DUPLICATE_CUT/);
    project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[1]), id: "third", timelineStart: 4, sourceStart: 7 });
    const first = { ...transition, afterFrames: 40 }, second = { ...transition, id: "cut2", fromClipId: "incoming", toClipId: "third", beforeFrames: 40 };
    expect(() => compileTimelineTransitionHandlesV1({ ...project, timelineTransitions: [first, second] })).toThrow(/WINDOW_OVERLAP/);
  });
  it("rejects invalid frame counts, unimplemented kernels and forged certification fields", () => {
    const { transition } = pairFixtureV1();
    for (const patch of [{ beforeFrames: -1 }, { afterFrames: .5 }, { afterFrames: Infinity }, { beforeFrames: 0, afterFrames: 1 }, { kernel: "whip" }, { certification: "PASSED" }]) {
      expect(timelineTransitionSchemaV1.safeParse({ ...transition, ...patch }).success).toBe(false);
    }
    expect(TIMELINE_TRANSITION_FAMILIES_V1.every(t => !t.defaultEnabled && t.certification === "ART_PENDING_CLAUDE")).toBe(true);
  });
});
