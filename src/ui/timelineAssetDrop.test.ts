import { describe, expect, it } from "vitest";
import { resolveTimelineAssetDrop } from "./timelineAssetDrop";

describe("project asset placement on the timeline", () => {
  const base = { fps: 30, pixelsPerSecond: 80, duration: 2, occupied: [] as Array<{ timelineStart: number; duration: number }>, magnetEnabled: true };

  it("shows and commits one frame-aligned position even when the source duration is fractional", () => {
    const value = resolveTimelineAssetDrop({ ...base, duration: 2.017, rawTime: 1.014, snapCandidates: [] });
    expect(value.start).toBeCloseTo(1);
    expect(value.duration).toBeCloseTo(61 / 30);
    expect(value.allowed).toBe(true);
  });

  it("snaps an asset edge to an existing clip or playhead and bypasses with Alt", () => {
    const input = { ...base, rawTime: 1.96, snapCandidates: [4], occupied: [{ timelineStart: 4, duration: 2 }] };
    expect(resolveTimelineAssetDrop(input)).toMatchObject({ start: 2, snappedTo: 4, allowed: true });
    expect(resolveTimelineAssetDrop({ ...input, magnetEnabled: false })).toMatchObject({ start: 1.9666666666666666, allowed: true });
    expect(resolveTimelineAssetDrop({ ...base, rawTime: 4.04, snapCandidates: [4.033333333333333], occupied: [] })).toMatchObject({ start: 4.033333333333333, snappedTo: 4.033333333333333 });
  });

  it("rejects overlap and keeps fractional frame rates exact", () => {
    expect(resolveTimelineAssetDrop({ ...base, rawTime: 3, snapCandidates: [], occupied: [{ timelineStart: 4, duration: 2 }] }).allowed).toBe(false);
    const fps = 30000 / 1001;
    const result = resolveTimelineAssetDrop({ ...base, fps, rawTime: 1.52, snapCandidates: [] });
    expect(result.start * fps).toBeCloseTo(Math.round(result.start * fps), 8);
    expect(result.duration * fps).toBeCloseTo(Math.round(result.duration * fps), 8);
  });
});
