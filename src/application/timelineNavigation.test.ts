import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { DirectorMarker } from "../domain/types";
import { setTimelineMark, timelineEditPoint, timelineMarkerPoint, validTimelineMarkRange } from "./timelineNavigation";

describe("timeline navigation and transient marks", () => {
  it("visits unique edges on every unlocked track, strictly beyond the current frame", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].duration = 4;
    project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[0]), id: "later", timelineStart: 6 });
    project.tracks.push({ id: "locked", name: "Locked", kind: "video", locked: true, muted: false,
      clips: [{ ...structuredClone(project.tracks[0].clips[0]), id: "locked-clip", trackId: "locked", timelineStart: 5 }] });
    expect(timelineEditPoint(project, 4, 1)).toBe(6);
    expect(timelineEditPoint(project, 6, -1)).toBe(4);
    expect(timelineEditPoint(project, 0, -1)).toBeUndefined();
    expect(timelineEditPoint(project, 10, 1)).toBeUndefined();
    expect(timelineEditPoint(project, 4 + 0.001, 1)).toBe(6);
  });

  it("jumps to next/previous markers without looping at an endpoint", () => {
    const marker = (time: number): DirectorMarker => ({ id: `m${time}`, time, title: "標記", note: "", kind: "note", status: "open", createdAt: "2026-10-11" });
    const markers = [marker(6), marker(2), marker(4), marker(4)];
    expect(timelineMarkerPoint(markers, 4, 1, 30)).toBe(6);
    expect(timelineMarkerPoint(markers, 4, -1, 30)).toBe(2);
    expect(timelineMarkerPoint(markers, 6, 1, 30)).toBeUndefined();
  });

  it("frame-aligns endpoints and keeps invalid/partial ranges from starting playback", () => {
    const initial = setTimelineMark({}, "in", 1.02, 30);
    expect(initial).toEqual({ in: 31 / 30 });
    const range = setTimelineMark(initial, "out", 3, 30);
    expect(validTimelineMarkRange(range)).toBe(true);
    expect(setTimelineMark(range, "in", 4, 30)).toEqual({ in: 4 });
    expect(setTimelineMark(range, "out", 0, 30)).toEqual({ out: 0 });
    expect(validTimelineMarkRange({ in: 1, out: 1 })).toBe(false);
    expect(validTimelineMarkRange({ out: 3 })).toBe(false);
  });
});
