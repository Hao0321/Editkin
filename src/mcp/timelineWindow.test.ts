import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import { editorCommandSchema } from "./schemas";
import { timelineWindow } from "./timelineWindow";

function fixture() {
  const project = createEmptyProject("Agent window", { id: "window", width: 640, height: 360, fps: 30 });
  project.assets = [{ id: "cam", name: "camera", kind: "video", uri: "D:/private/source.mp4", duration: 10, width: 640, height: 360 }];
  const clip: TimelineClip = { id: "clip", trackId: "video", assetId: "cam", timelineStart: 1, sourceStart: 0, duration: 3,
    volume: 1, transform: { ...DEFAULT_TRANSFORM, rotation: 90 }, color: { ...DEFAULT_COLOR }, keyframes: [],
    creative: { effectPresetIds: ["blur"] } };
  project.tracks = [{ id: "video", name: "Picture", kind: "video", locked: true, muted: true, hidden: true, clips: [clip] }];
  project.director.markers = [{ id: "marker", time: 2, title: "Cut", note: "note", kind: "note", status: "open", createdAt: "2026-10-11T00:00:00.000Z" }];
  return project;
}

describe("agent timeline window", () => {
  it("returns real marker, track flags, transform and effects without media paths", () => {
    const project = fixture(), before = structuredClone(project);
    const value = timelineWindow(project, 0, 5, 80);
    expect(value.tracks[0]).toMatchObject({ locked: true, muted: true, hidden: true, solo: false });
    expect(value.markers[0]).toMatchObject({ id: "marker", time: 2, title: "Cut" });
    expect(value.clips[0]).toMatchObject({ transform: { rotation: 90 }, effects: { effectPresetIds: ["blur"], nativeEffectCount: 0 } });
    expect(JSON.stringify(value)).not.toContain("private");
    expect(project).toEqual(before);
  });
  it("bounds markers and clips together and treats the right edge as exclusive", () => {
    expect(timelineWindow(fixture(), 0, 5, 1)).toMatchObject({ totalItems: 2, returnedItems: 1, hasMore: true, markers: [] });
    expect(timelineWindow(fixture(), 2, 4, 80).markers).toHaveLength(1);
    expect(timelineWindow(fixture(), 0, 2, 80).markers).toHaveLength(0);
    expect(timelineWindow(fixture(), 4, 5, 80).clips).toHaveLength(0);
  });
  it("uses false for old optional states and reads future solo without migration", () => {
    const project = fixture(); delete project.tracks[0].hidden;
    Object.assign(project.tracks[0], { solo: true });
    expect(timelineWindow(project, 0, 5, 80).tracks[0]).toMatchObject({ hidden: false, solo: true });
  });
  it("rejects malformed direct-call bounds and accepts the actual slip command schema", () => {
    for (const args of [[0, 0, 80], [0, 1, 201], [-1, 1, 80], [0, NaN, 80]]) {
      expect(() => timelineWindow(fixture(), args[0], args[1], args[2])).toThrow();
    }
    expect(editorCommandSchema.parse({ type: "slip_clip", clipId: "clip", sourceStart: 1 })).toEqual({ type: "slip_clip", clipId: "clip", sourceStart: 1 });
    expect(() => editorCommandSchema.parse({ type: "slip_clip", clipId: "clip", sourceStart: -1 })).toThrow();
  });
});
