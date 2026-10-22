import { describe, expect, it } from "vitest";
import { resolveTimelineTrim } from "./timelineInteraction";

// Clip at 2 s, 4 s long, 80 px per second at 30 fps.
const common = { originStart: 2, duration: 4, originClientX: 400, pixelsPerSecond: 80, fps: 30 };

describe("trim handles that also extend outward", () => {
  it("keeps shrink-only behaviour when no outward room is given", () => {
    expect(resolveTimelineTrim({ ...common, edge: "end", currentClientX: 480 })).toMatchObject({ trimSeconds: 0, extendSeconds: 0, moved: false, extendLimited: true });
    expect(resolveTimelineTrim({ ...common, edge: "start", currentClientX: 320 })).toMatchObject({ trimSeconds: 0, extendSeconds: 0, moved: false });
  });

  it("extends the end and the start by whole frames up to the outward room", () => {
    expect(resolveTimelineTrim({ ...common, edge: "end", currentClientX: 480, maxExtendFrames: 90, magnetEnabled: false }))
      .toMatchObject({ trimSeconds: 0, extendSeconds: 1, start: 2, duration: 5, moved: true, extendLimited: false });
    expect(resolveTimelineTrim({ ...common, edge: "start", currentClientX: 360, maxExtendFrames: 90, magnetEnabled: false }))
      .toMatchObject({ extendSeconds: 0.5, start: 1.5, duration: 4.5, moved: true });
  });

  it("stops exactly at the limit and reports that the pointer asked for more", () => {
    const result = resolveTimelineTrim({ ...common, edge: "end", currentClientX: 800, maxExtendFrames: 45, magnetEnabled: false });
    expect(result).toMatchObject({ extendSeconds: 1.5, duration: 5.5, extendLimited: true });
  });

  it("snaps an outward edge to a nearby clip edge or playhead inside the room", () => {
    const result = resolveTimelineTrim({ ...common, edge: "end", currentClientX: 478, maxExtendFrames: 90, snapCandidates: [7] });
    expect(result).toMatchObject({ extendSeconds: 1, duration: 5, snappedTo: 7 });
    // A magnet beyond the media limit is never offered.
    expect(resolveTimelineTrim({ ...common, edge: "end", currentClientX: 478, maxExtendFrames: 20, snapCandidates: [7] }).snappedTo).toBeUndefined();
  });

  it.each([24, 30000 / 1001, 60])("lands extensions on the %s fps grid", fps => {
    const result = resolveTimelineTrim({ edge: "end", originStart: 0, duration: 4, originClientX: 100, currentClientX: 173, pixelsPerSecond: 83, fps, maxExtendFrames: 500, magnetEnabled: false });
    expect(result.extendSeconds * fps).toBeCloseTo(Math.round(result.extendSeconds * fps), 8);
    expect(result.duration * fps).toBeCloseTo(Math.round(result.duration * fps), 8);
  });
});
