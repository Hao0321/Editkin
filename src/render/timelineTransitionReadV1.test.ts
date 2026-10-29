import { describe, expect, it } from "vitest";
import { pairFixtureV1 } from "../domain/timelineTransitionV1.fixture";
import { compileTimelineTransitionHandlesV1 } from "../domain/timelineTransitionHandlesV1";
import { assertTimelineTransitionProbeV1, timelineTransitionFloatingClockV1, timelineTransitionLocalTimeV1, timelineTransitionMattePaddingV1, timelineTransitionReadViewsV1 } from "./timelineTransitionReadV1";

function fixture() { const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition]; const before = structuredClone(project); return { project, before, views: timelineTransitionReadViewsV1(project, compileTimelineTransitionHandlesV1(project)) }; }
describe("private paired source reads and authored clocks", () => {
  it("expands source transport without changing authored timing, duration, effects or project", () => {
    const { project, before, views } = fixture(), [from, to] = project.tracks[0].clips;
    expect(views.get(from.id)?.readClip).toMatchObject({ timelineStart: 0, sourceStart: 1, duration: 2.4 });
    expect(views.get(to.id)?.readClip).toMatchObject({ timelineStart: 1.6, sourceStart: 3.6, duration: 2.4 });
    expect(views.get(to.id)?.clip).toBe(to); expect(project).toEqual(before);
  });
  it("rejects stale caller handle plans before reading media", () => {
    const { project } = fixture(), plans = compileTimelineTransitionHandlesV1(project); plans[0].to.sourceStartSeconds = 0;
    expect(() => timelineTransitionReadViewsV1(project, plans)).toThrow("TIMELINE_TRANSITION_STALE_RENDER_PLAN");
  });
  it("uses the probed current duration rather than the declared asset duration", () => {
    const { views } = fixture(), view = [...views.values()][1];
    expect(() => assertTimelineTransitionProbeV1(view, "video", { duration: 5.9, hasVideo: true, hasAudio: false })).toThrow("ACTUAL_HANDLE_MISSING");
    expect(() => assertTimelineTransitionProbeV1(view, "video", { duration: 6, hasVideo: true, hasAudio: false })).not.toThrow();
  });
  it("accepts repeated images but requires their real video stream", () => {
    const { views } = fixture(), view = [...views.values()][1];
    expect(() => assertTimelineTransitionProbeV1(view, "image", { duration: 0, hasVideo: true, hasAudio: false })).not.toThrow();
    expect(() => assertTimelineTransitionProbeV1(view, "image", { duration: 0, hasVideo: false, hasAudio: false })).toThrow("VIDEO_STREAM_MISSING");
  });
  it("keeps original local colour/effect time and clamps borrowed boundary ticks", () => {
    const { views } = fixture(); expect(timelineTransitionLocalTimeV1([...views.values()][1], "t")).toBe("min(2,max(0,t+(-0.4)))");
    expect(timelineTransitionLocalTimeV1(undefined, "T")).toBe("T");
  });
  it("pads authored matte coverage only, with exact prefix, suffix and frame count", () => {
    const { views } = fixture(), [from, to] = [...views.values()];
    expect(timelineTransitionMattePaddingV1(from)[0]).toContain("start=0:stop=12:");
    expect(timelineTransitionMattePaddingV1(to)[0]).toContain("start=12:stop=0:");
    expect(timelineTransitionMattePaddingV1(to)[1]).toBe("trim=end_frame=72");
    expect(timelineTransitionMattePaddingV1(undefined)).toEqual([]);
  });
  it("adapts floating integer clocks privately without touching frozen generators", () => {
    const { views } = fixture(), original = ["perspective=x0='on':y0='on'", "geq=a='N'"];
    const adapted = timelineTransitionFloatingClockV1(original, [...views.values()][1], 30);
    expect(adapted[0]).toContain("min(59\\,max(0\\,on-12))"); expect(adapted[1]).toContain("N-12");
    expect(original).toEqual(["perspective=x0='on':y0='on'", "geq=a='N'"]);
    expect(timelineTransitionFloatingClockV1(original, undefined, 30)).toBe(original);
  });
});
