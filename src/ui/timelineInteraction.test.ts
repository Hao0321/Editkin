import { describe, expect, it } from "vitest";
import { nudgeTimelineTime, timelineFrameLabel, resolveTimelineDrag, resolveTimelineDropTarget, resolveTimelineTrim, timelineAutoScrollDelta, timelineTimeAtPointer } from "./timelineInteraction";

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

  it("distinguishes a click from an intentional drag", () => {
    const result = resolveTimelineDrag({
      originStart: 0,
      duration: 1,
      originClientX: 10,
      currentClientX: 12,
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
});
