import { describe, expect, it } from "vitest";
import { nudgeTimelineTime, timelineFrameLabel, resolveTimelineDrag, resolveTimelineDropTarget, resolveTimelineTrim, timelineAutoScrollDelta, timelineTimeAtPointer, visibleTimelineDropLanes } from "./timelineInteraction";

describe("timeline direct manipulation", () => {
  it("coalesces pointer and scroll deltas onto the project frame grid", () => {
    const result = resolveTimelineDrag({
      originStart: 1,
      duration: 2,
      originClientX: 100,
      currentClientX: 145,
      originScrollLeft: 20,
      currentScrollLeft: 35,
      pixelsPerSecond: 80,
      fps: 30,
      magnetEnabled: false,
    });
    expect(result.start).toBe(1.7666666666666666);
    expect(result.deltaPixels).toBe(60);
    expect(result.moved).toBe(true);
  });

  it("magnetically snaps either clip edge and can be bypassed", () => {
    const common = {
      originStart: 0,
      duration: 2,
      originClientX: 0,
      currentClientX: 157,
      originScrollLeft: 0,
      currentScrollLeft: 0,
      pixelsPerSecond: 80,
      fps: 30,
      snapCandidates: [4],
    };
    expect(resolveTimelineDrag(common)).toMatchObject({ start: 2, snappedTo: 4 });
    expect(resolveTimelineDrag({ ...common, magnetEnabled: false }).start).toBe(1.9666666666666666);
  });

  it("does not let an origin magnet swallow an intentional one-frame drag", () => {
    const result = resolveTimelineDrag({ originStart: 0, duration: 2, originClientX: 100, currentClientX: 108,
      originScrollLeft: 0, currentScrollLeft: 0, pixelsPerSecond: 240, fps: 30, snapCandidates: [0] });
    expect(result.start).toBeCloseTo(1 / 30);
    expect(result.moved).toBe(true);
    expect(result.snappedTo).toBeUndefined();
  });

  it("distinguishes a click from an intentional drag", () => {
    const result = resolveTimelineDrag({
      originStart: 0,
      duration: 1,
      originClientX: 10,
      currentClientX: 11,
      originScrollLeft: 0,
      currentScrollLeft: 0,
      pixelsPerSecond: 80,
      fps: 30,
    });
    expect(result.moved).toBe(false);
  });

  it("aligns continuous scrubbing and reports edge auto-scroll", () => {
    expect(timelineTimeAtPointer(183, 100, 80, 12, 30)).toBe(1.0333333333333334);
    expect(timelineAutoScrollDelta(105, 100, 900)).toBeLessThan(0);
    expect(timelineAutoScrollDelta(895, 100, 900)).toBeGreaterThan(0);
    expect(timelineAutoScrollDelta(500, 100, 900)).toBe(0);
  });

  it("keeps horizontal edge traversal independent of display refresh rate", () => {
    const expected = -(1 - 10 / 52) * 360;
    for (const refreshRate of [24, 60, 144]) {
      let distance = 0;
      for (let frame = 0; frame < refreshRate; frame += 1) {
        distance += timelineAutoScrollDelta(110, 100, 900, 1000 / refreshRate);
      }
      expect(distance).toBeCloseTo(expected, 8);
    }
    expect(timelineAutoScrollDelta(890, 100, 900, 20))
      .toBeCloseTo(-timelineAutoScrollDelta(110, 100, 900, 20), 8);
  });

  it("bounds horizontal velocity and stalled frames without forcing pixel jumps", () => {
    expect(timelineAutoScrollDelta(100, 100, 900, 10)).toBe(-3.6);
    expect(timelineAutoScrollDelta(100, 100, 900, 50)).toBe(-18);
    expect(timelineAutoScrollDelta(100, 100, 900, 2000)).toBe(-18);
    expect(Math.abs(timelineAutoScrollDelta(151.9, 100, 900, 1000 / 144))).toBeLessThan(1);
    expect(timelineAutoScrollDelta(100.001, 100, 102, 10)).toBeCloseTo(-3.5964, 8);
    expect(timelineAutoScrollDelta(101, 100, 102, 10)).toBe(0);
  });

  it("stops horizontal traversal outside content or on invalid geometry and time", () => {
    for (const x of [99, 900, 950, NaN, Infinity]) {
      expect(timelineAutoScrollDelta(x, 100, 900, 16)).toBe(0);
    }
    for (const elapsed of [0, -1, NaN, Infinity]) {
      expect(timelineAutoScrollDelta(110, 100, 900, elapsed)).toBe(0);
    }
    expect(timelineAutoScrollDelta(100, 100, 100, 16)).toBe(0);
    expect(timelineAutoScrollDelta(100, 900, 100, 16)).toBe(0);
    expect(timelineAutoScrollDelta(100, NaN, 900, 16)).toBe(0);
    expect(timelineAutoScrollDelta(100, 0, Infinity, 16)).toBe(0);
  });

  it("accepts only the content rectangle of an unlocked compatible lane", () => {
    const lanes = [
      { trackId: "video-main", trackKind: "video" as const, locked: false, left: 236, right: 1200, top: 100, bottom: 148 },
      { trackId: "audio-main", trackKind: "audio" as const, locked: false, left: 236, right: 1200, top: 148, bottom: 196 },
      { trackId: "video-locked", trackKind: "video" as const, locked: true, left: 236, right: 1200, top: 196, bottom: 244 },
    ];
    expect(resolveTimelineDropTarget(400, 120, "video", lanes)?.trackId).toBe("video-main");
    expect(resolveTimelineDropTarget(120, 120, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 170, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 210, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 280, "video", lanes)).toBeUndefined();
  });

  it("trims either edge inward on the frame grid and preserves one frame", () => {
    expect(resolveTimelineTrim({ edge: "start", duration: 4, originClientX: 100, currentClientX: 180, pixelsPerSecond: 80, fps: 30 }))
      .toMatchObject({ trimSeconds: 1, duration: 3, moved: true });
    expect(resolveTimelineTrim({ edge: "end", duration: 4, originClientX: 180, currentClientX: 100, pixelsPerSecond: 80, fps: 30 }))
      .toMatchObject({ trimSeconds: 1, duration: 3, moved: true });
    expect(resolveTimelineTrim({ edge: "end", duration: 1, originClientX: 100, currentClientX: -500, pixelsPerSecond: 80, fps: 30 }).duration)
      .toBeCloseTo(1 / 30);
  });

  it("does not mutate the range when the handle is dragged outward", () => {
    expect(resolveTimelineTrim({ edge: "start", duration: 4, originClientX: 100, currentClientX: 70, pixelsPerSecond: 80, fps: 30 }).trimSeconds).toBe(0);
    expect(resolveTimelineTrim({ edge: "end", duration: 4, originClientX: 100, currentClientX: 130, pixelsPerSecond: 80, fps: 30 }).trimSeconds).toBe(0);
  });

  it("snaps both trim handles to timeline time rather than just rounding their delta", () => {
    const common = { originStart: 2, duration: 4, originClientX: 100, pixelsPerSecond: 80, fps: 30, snapCandidates: [3, 5] };
    expect(resolveTimelineTrim({ ...common, edge: "start", currentClientX: 176 })).toMatchObject({ trimSeconds: 1, duration: 3, snappedTo: 3 });
    expect(resolveTimelineTrim({ ...common, edge: "end", currentClientX: 24 })).toMatchObject({ trimSeconds: 1, duration: 3, snappedTo: 5 });
    expect(resolveTimelineTrim({ ...common, edge: "start", currentClientX: 176, magnetEnabled: false }).trimSeconds).toBeCloseTo(29 / 30);
  });

  it("does not advertise an impossible magnet beyond zero or the one-frame trim limit", () => {
    expect(resolveTimelineDrag({ originStart: 0, duration: 2, originClientX: 0, currentClientX: 5, originScrollLeft: 0, currentScrollLeft: 0, pixelsPerSecond: 80, fps: 30, snapCandidates: [1.98] }).snappedTo).toBeUndefined();
    expect(resolveTimelineTrim({ edge: "end", originStart: 2, duration: 1, originClientX: 100, currentClientX: 24, pixelsPerSecond: 80, fps: 30, snapCandidates: [2] }).snappedTo).toBeUndefined();
  });

  it.each([24, 30, 60, 24000 / 1001, 30000 / 1001])("keeps drag and trim on the %s fps grid with magnet bypassed", (fps) => {
    const move = resolveTimelineDrag({ originStart: 0.013, duration: 4, originClientX: 100, currentClientX: 167, originScrollLeft: 0, currentScrollLeft: 41, pixelsPerSecond: 83, fps, magnetEnabled: false });
    expect(move.start * fps).toBeCloseTo(Math.round(move.start * fps), 8);
    const trim = resolveTimelineTrim({ edge: "end", originStart: 0, duration: 4.013, originClientX: 100, currentClientX: 24, pixelsPerSecond: 83, fps, magnetEnabled: false });
    expect(trim.duration * fps).toBeCloseTo(Math.round(trim.duration * fps), 8);
    expect(trim.trimSeconds * fps).toBeCloseTo(Math.round(trim.trimSeconds * fps), 8);
  });

  it("nudges imported off-frame captions to an exact frame and displays frame rollover", () => {
    expect(nudgeTimelineTime(0.013, 1, 30)).toBeCloseTo(1 / 30);
    expect(nudgeTimelineTime(0.013, -1, 30)).toBe(0);
    expect(nudgeTimelineTime(1, 10, 30)).toBeCloseTo(40 / 30);
    expect(timelineFrameLabel(59 / 30, 30)).toBe("00:01:29");
    expect(timelineFrameLabel(60 / 30, 30)).toBe("00:02:00");
    expect(timelineFrameLabel(60 / (30000 / 1001), 30000 / 1001)).toBe("00:02:00");
  });

  it("selects the nearest trim target without walking along a chain of magnets", () => {
    const result = resolveTimelineTrim({ edge: "start", originStart: 0, duration: 4, originClientX: 0, currentClientX: 79, pixelsPerSecond: 80, fps: 30, snapCandidates: [1, 1.0333333333333334, 1.0666666666666667] });
    expect(result.snappedTo).toBe(1);
  });

  it("skips a closer magnet that would overlap another clip", () => {
    const result = resolveTimelineDrag({ originStart: 0, duration: 2, originClientX: 0, currentClientX: 156, originScrollLeft: 0, currentScrollLeft: 0, pixelsPerSecond: 80, fps: 30, snapCandidates: [1.9666666666666666, 2], isStartAllowed: start => start >= 2 });
    expect(result).toMatchObject({ start: 2, snappedTo: 2 });
  });

  it("activates an actual 30fps frame below the former three-pixel threshold", () => {
    const result = resolveTimelineDrag({ originStart: 1, duration: 2, originClientX: 100, currentClientX: 100 + 80 / 30,
      originScrollLeft: 0, currentScrollLeft: 0, pixelsPerSecond: 80, fps: 30, snapCandidates: [1] });
    expect(result.start).toBe(31 / 30);
    expect(result.moved).toBe(true);
    expect(result.snappedTo).toBeUndefined();
  });

  it("activates an actual 60fps frame below the former three-pixel threshold", () => {
    const result = resolveTimelineDrag({ originStart: 1, duration: 2, originClientX: 100, currentClientX: 100 + 80 / 60,
      originScrollLeft: 0, currentScrollLeft: 0, pixelsPerSecond: 80, fps: 60, snapCandidates: [1] });
    expect(result.start).toBe(61 / 60);
    expect(result.moved).toBe(true);
    expect(result.snappedTo).toBeUndefined();
  });

  it("activates one fractional-fps frame with current scroll included", () => {
    const fps = 30000 / 1001, origin = 30 / fps;
    const result = resolveTimelineDrag({ originStart: origin, duration: 2, originClientX: 100, currentClientX: 100,
      originScrollLeft: 10, currentScrollLeft: 10 + 80 / fps, pixelsPerSecond: 80, fps, snapCandidates: [origin] });
    expect(result.start).toBe(31 / fps);
    expect(result.moved).toBe(true);
  });

  it("keeps stationary and same-frame pointer jitter free of magnets", () => {
    const common = { originStart: 1, duration: 2, originClientX: 100, originScrollLeft: 0, currentScrollLeft: 0,
      pixelsPerSecond: 80, fps: 30, snapCandidates: [1 + 1 / 30, 3 + 1 / 30] };
    expect(resolveTimelineDrag({ ...common, currentClientX: 100 })).toMatchObject({ start: 1, moved: false });
    const jitter = resolveTimelineDrag({ ...common, currentClientX: 101 });
    expect(jitter).toMatchObject({ start: 1, moved: false });
    expect(jitter.snappedTo).toBeUndefined();
  });

  it("does not let an origin magnet undo a half-frame crossing", () => {
    const result = resolveTimelineDrag({ originStart: 1, duration: 2, originClientX: 100, currentClientX: 101.6,
      originScrollLeft: 0, currentScrollLeft: 0, pixelsPerSecond: 80, fps: 30, snapCandidates: [1] });
    expect(result).toMatchObject({ start: 31 / 30, moved: true });
    expect(result.snappedTo).toBeUndefined();
  });

  it("returns to a no-change result when the final pointer returns to its origin", () => {
    const common = { originStart: 1, duration: 2, originClientX: 100, originScrollLeft: 0, currentScrollLeft: 0,
      pixelsPerSecond: 80, fps: 30, magnetEnabled: false };
    expect(resolveTimelineDrag({ ...common, currentClientX: 180 }).moved).toBe(true);
    expect(resolveTimelineDrag({ ...common, currentClientX: 100 })).toMatchObject({ start: 1, moved: false });
  });

  it("clips real lane rectangles to the viewport and excludes labels, ruler and hidden rows", () => {
    const lanes = visibleTimelineDropLanes([
      { trackId: "hidden", trackKind: "video" as const, locked: false, left: -400, right: 1800, top: 40, bottom: 150 },
      { trackId: "partly-visible", trackKind: "video" as const, locked: false, left: -400, right: 1800, top: 140, bottom: 204 },
      { trackId: "locked", trackKind: "video" as const, locked: true, left: -400, right: 1800, top: 204, bottom: 256 },
      { trackId: "audio", trackKind: "audio" as const, locked: false, left: -400, right: 1800, top: 256, bottom: 308 },
    ], { left: 288, right: 1100, top: 152, bottom: 300 });
    expect(lanes.map(lane => lane.trackId)).toEqual(["partly-visible", "locked", "audio"]);
    expect(lanes[0]).toMatchObject({ left: 288, right: 1100, top: 152, bottom: 204 });
    expect(resolveTimelineDropTarget(400, 170, "video", lanes)?.trackId).toBe("partly-visible");
    expect(resolveTimelineDropTarget(200, 170, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 150, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 220, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 275, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(1100, 170, "video", lanes)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 300, "audio", lanes)).toBeUndefined();
  });

  it("uses newly measured lane positions after vertical scroll or resize", () => {
    const viewport = { left: 288, right: 1100, top: 152, bottom: 300 };
    const lane = { trackId: "video", trackKind: "video" as const, locked: false, left: 288, right: 1500, top: 204, bottom: 256 };
    expect(resolveTimelineDropTarget(400, 220, "video", visibleTimelineDropLanes([lane], viewport))?.trackId).toBe("video");
    const current = visibleTimelineDropLanes([{ ...lane, top: 152, bottom: 204 }], { ...viewport, right: 700 });
    expect(resolveTimelineDropTarget(400, 220, "video", current)).toBeUndefined();
    expect(resolveTimelineDropTarget(400, 170, "video", current)?.trackId).toBe("video");
    expect(resolveTimelineDropTarget(800, 170, "video", current)).toBeUndefined();
  });

  it("accepts a one-frame trim at low zoom while leaving same-frame jitter unchanged", () => {
    const common = { edge: "start" as const, originStart: 1, duration: 2, originClientX: 100,
      pixelsPerSecond: 80, fps: 60, snapCandidates: [1, 1 + 1 / 60] };
    expect(resolveTimelineTrim({ ...common, currentClientX: 100 + 80 / 60 })).toMatchObject({ trimSeconds: 1 / 60, moved: true });
    expect(resolveTimelineTrim({ ...common, currentClientX: 100.5 })).toMatchObject({ trimSeconds: 0, moved: false });
  });
});
