import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject } from "./editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "./types";

function fixture() {
  const project = createEmptyProject("Smart Cut", { id: "smart-cut", width: 1920, height: 1080, fps: 30 });
  project.assets.push({ id: "talk", name: "Talk", kind: "video", uri: "talk.mp4", duration: 10 });
  project.tracks[0].clips.push({
    id: "talk-clip", assetId: "talk", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 10,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  project.captions.push(
    { id: "before", text: "A", start: 1, duration: 0.5 },
    { id: "after-cut", text: "B", start: 5, duration: 1 },
    { id: "removed", text: "pause", start: 3, duration: 0.5 },
  );
  return project;
}

describe("smart_cut_clip command", () => {
  it("replaces one clip with compact kept ranges and ripple-adjusts captions", () => {
    const result = applyCommand(fixture(), {
      type: "smart_cut_clip",
      clipId: "talk-clip",
      keepRanges: [{ start: 0, end: 2 }, { start: 4, end: 10 }],
      segmentIds: ["talk-clip", "talk-smart-1"],
    });
    expect(result.tracks[0].clips.map((clip) => ({ id: clip.id, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration }))).toEqual([
      { id: "talk-clip", timelineStart: 0, sourceStart: 0, duration: 2 },
      { id: "talk-smart-1", timelineStart: 2, sourceStart: 4, duration: 6 },
    ]);
    expect(result.captions.find((caption) => caption.id === "after-cut")?.start).toBe(3);
    expect(result.captions.some((caption) => caption.id === "removed")).toBe(false);
  });

  it("rejects ambiguous edits when another layer overlaps the source clip", () => {
    const project = fixture();
    project.tracks.splice(1, 0, {
      id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false,
      clips: [{
        id: "overlay-clip", assetId: "talk", trackId: "overlay", timelineStart: 1, sourceStart: 0, duration: 1,
        volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      }],
    });
    expect(() => applyCommand(project, {
      type: "smart_cut_clip", clipId: "talk-clip", keepRanges: [{ start: 0, end: 2 }, { start: 4, end: 10 }],
      segmentIds: ["talk-clip", "talk-smart-1"],
    })).toThrow(/重疊/);
  });
});
