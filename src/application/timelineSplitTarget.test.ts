import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { BLADE_TOO_CLOSE, findSplitTarget, planBladeCuts, playheadInsideClip, SPLIT_AT_EDGE, SPLIT_NOTHING_HERE } from "./timelineSplitTarget";

// Ctrl+B and 切開: picking a clip never moves the playhead, so the creator parks the playhead, picks a clip and cuts
// there; with nothing (cuttable) picked, the clip under the playhead is cut. The 剪刀 tool cuts where it is clicked.
function clip(id: string, trackId: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "cam", trackId, timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
}
function project(): EditProject {
  const value = createEmptyProject("Split", { id: "split", width: 1280, height: 720, fps: 30 });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 60, width: 1280, height: 720 }];
  value.tracks[0].clips = [clip("A", "video-main", 0, 4), clip("B", "video-main", 4, 4)];
  value.tracks[1].clips = [clip("VO", "audio-main", 0, 10)];
  value.tracks.push({ id: "pip", name: "畫中畫 1", kind: "video", locked: false, muted: false, clips: [clip("P", "pip", 5, 2)] });
  return validateProject(value);
}
const target = (value: EditProject, playhead: number, selected?: string) => {
  const found = findSplitTarget(value, playhead, selected);
  return "target" in found ? found.target.clip.id : found.refusal;
};

describe("which clip B cuts", () => {
  it("the selected clip when the playhead is inside it, wherever the playhead was parked", () => {
    expect(target(project(), 6, "B")).toBe("B");
    expect(target(project(), 6, "P")).toBe("P");
    expect(target(project(), 6, "VO")).toBe("VO");
  });
  it("with nothing selected: 主畫面 under the playhead first, then the topmost unlocked track", () => {
    expect(target(project(), 6)).toBe("B");
    const noMain = project();
    noMain.tracks[0].clips = [];
    expect(target(noMain, 6)).toBe("VO");
  });
  it("a selected clip the playhead is not inside: the clip under the playhead on the selected clip's track first", () => {
    expect(target(project(), 6, "A")).toBe("B");
    const twoPip = applyCommand(project(), { type: "add_clip", clip: clip("P0", "pip", 0, 2) });
    expect(target(twoPip, 6, "P0")).toBe("P");
  });
  it("never a locked track; says why when only a locked clip is under the playhead, or when nothing is", () => {
    const locked = project();
    locked.tracks[0].locked = true;
    expect(target(locked, 6)).toBe("VO");
    locked.tracks[1].locked = true;
    locked.tracks[3].locked = true;
    expect(target(locked, 6)).toBe(TRACK_LOCKED_MESSAGE);
    expect(target(project(), 20)).toBe(SPLIT_NOTHING_HERE);
    const empty = project();
    empty.tracks.forEach(track => { track.clips = track.id === "video-main" ? [clip("A", "video-main", 0, 4)] : []; });
    expect(target(empty, 4, "A")).toBe(SPLIT_AT_EDGE);
  });
  it("a cut needs the playhead strictly inside the clip, on the frame grid", () => {
    const a = clip("A", "video-main", 0, 4);
    expect([0, 1 / 30, 3.98, 4].map(time => playheadInsideClip(a, time, 30))).toEqual([false, true, true, false]);
    expect(playheadInsideClip(a, 0.01, 30)).toBe(false);
  });
});

describe("what the 剪刀 tool cuts", () => {
  it("the clicked clip at the click; with Shift every unlocked picture and sound track that has a clip there", () => {
    expect(planBladeCuts(project(), "B", 6)).toEqual({ cuts: [{ clipId: "B", at: 6 }] });
    expect(planBladeCuts(project(), "B", 6, true)).toEqual({ cuts: [{ clipId: "B", at: 6 }, { clipId: "VO", at: 6 }, { clipId: "P", at: 6 }] });
    // A clip whose edge is at the time has nothing to cut there and is left out of a Shift+click.
    expect(planBladeCuts(project(), "VO", 4, true)).toEqual({ cuts: [{ clipId: "VO", at: 4 }] });
  });
  it("nothing within a frame of the clip's start or end, and it says so", () => {
    expect(planBladeCuts(project(), "B", 4)).toEqual({ refusal: BLADE_TOO_CLOSE });
    expect(planBladeCuts(project(), "B", 8)).toEqual({ refusal: BLADE_TOO_CLOSE });
    expect(planBladeCuts(project(), "B", 4 + 1 / 30)).toEqual({ cuts: [{ clipId: "B", at: 4 + 1 / 30 }] });
    expect(planBladeCuts(project(), "missing", 6)).toEqual({ refusal: "找不到這個片段，請重新選取。" });
  });
  it("never a locked track: a click on one is refused in plain words; a Shift+click cuts the others", () => {
    const locked = project();
    locked.tracks[0].locked = true;
    expect(planBladeCuts(locked, "B", 6)).toEqual({ refusal: TRACK_LOCKED_MESSAGE });
    expect(planBladeCuts(locked, "B", 6, true)).toEqual({ cuts: [{ clipId: "VO", at: 6 }, { clipId: "P", at: 6 }] });
    locked.tracks[1].locked = true;
    locked.tracks[3].locked = true;
    expect(planBladeCuts(locked, "B", 6, true)).toEqual({ refusal: TRACK_LOCKED_MESSAGE });
  });
});
