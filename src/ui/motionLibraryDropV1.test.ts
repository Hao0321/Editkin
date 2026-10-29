import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { motionLibraryFixtureProject } from "../domain/motionLibraryV1.fixture";
import { resolveMotionLibraryDropV1, type MotionLibraryDropGeometryV1 } from "./motionLibraryDropV1";

// Lanes start at x = 200 (time 0), 50 px per second; the visible area starts after the track names.
const geometry = (locked = false): MotionLibraryDropGeometryV1 => ({
  area: { left: 188, top: 40, right: 1000, bottom: 400 }, pixelsPerSecond: 50, fps: 30,
  lanes: [
    { trackId: "video-main", kind: "video", locked: false, left: 200, top: 40, right: 1000, bottom: 92 },
    { trackId: "audio-main", kind: "audio", locked: false, left: 200, top: 92, right: 1000, bottom: 144 },
    { trackId: "overlay", kind: "video", locked, left: 200, top: 144, right: 1000, bottom: 196 },
  ],
});

describe("Motion Library drag and drop onto the timeline", () => {
  const project = motionLibraryFixtureProject();
  it("puts text and backgrounds on the picture track under the pointer, at the frame under the pointer", () => {
    expect(resolveMotionLibraryDropV1({ clientX: 300, clientY: 170 }, geometry(), "text", project)).toMatchObject({ kind: "track", trackId: "overlay", startFrame: 60 });
    expect(resolveMotionLibraryDropV1({ clientX: 201, clientY: 60 }, geometry(), "background", project)).toMatchObject({ kind: "track", trackId: "video-main", startFrame: 1 });
  });

  it("refuses audio and locked tracks, and ignores drops outside the timeline", () => {
    expect(resolveMotionLibraryDropV1({ clientX: 300, clientY: 100 }, geometry(), "text", project)).toMatchObject({ kind: "invalid" });
    expect(resolveMotionLibraryDropV1({ clientX: 300, clientY: 170 }, geometry(true), "text", project)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("鎖定") });
    expect(resolveMotionLibraryDropV1({ clientX: 100, clientY: 60 }, geometry(), "text", project)).toBeUndefined();
    expect(resolveMotionLibraryDropV1({ clientX: 300, clientY: 60 }, undefined, "text", project)).toBeUndefined();
  });

  it("snaps a transition to the cut under the pointer and refuses one far from any cut", () => {
    // The a→b cut is at 3 s → x = 200 + 150.
    expect(resolveMotionLibraryDropV1({ clientX: 362, clientY: 60 }, geometry(), "transition", project)).toMatchObject({
      kind: "cut", x: 350, cut: { trackId: "video-main", fromClipId: "a", toClipId: "b" } });
    expect(resolveMotionLibraryDropV1({ clientX: 500, clientY: 60 }, geometry(), "transition", project)).toMatchObject({ kind: "invalid" });
    const noCuts = applyCommand(project, { type: "delete_clip", clipId: "b" });
    expect(resolveMotionLibraryDropV1({ clientX: 350, clientY: 60 }, geometry(), "transition", noCuts)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("剪刀") });
  });
});
