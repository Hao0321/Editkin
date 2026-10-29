import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import { clipTimeRemapClockV1, clipTimeRemapSchemaV1 } from "../domain/clipTimeRemapV1";
import { timeRemapSourceBoundaryV1 } from "../domain/timeRemapClockV1";
import { shotGradeFramePlanV1 } from "./shotGradeFramesV1";

function fixture() {
  const project = createEmptyProject("Static grade source admission", { width: 16, height: 16, fps: 10 });
  const asset = { id: "a", name: "Frame-coded source", uri: "owned.mp4", kind: "video" as const,
    duration: 100, width: 16, height: 16, color: { interpretation: "rec709" as const } };
  const clip: TimelineClip = { id: "c", assetId: asset.id, trackId: project.tracks[0].id, timelineStart: 0,
    sourceStart: 0, duration: .6, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.assets.push(asset); project.tracks[0].clips.push(clip);
  const probe = { hasVideo: true, hasAudio: false, duration: 100, width: 16, height: 16,
    encodedWidth: 16, encodedHeight: 16, sampleAspectRatio: 1, colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" };
  const plan = () => shotGradeFramePlanV1(project, clip, asset, probe);
  return { project, asset, clip, probe, plan };
}
const curve = (direction: "forward" | "reverse", speed = 1) => clipTimeRemapSchemaV1.parse({
  schema: "editkin.clip-time-remap/v1", direction, interpolation: "frame_blending", audioMode: "mute",
  segments: [{ from: { time: 0, speed }, control1: { time: 1 / 3, speed }, control2: { time: 2 / 3, speed }, to: { time: 1, speed } }],
});

describe("shot-grade static source clock admission", () => {
  it.each([0, 1 / 64, .5, 1, 2, 64])("does not silently sample authored speed %s as 1x", speed => {
    const f = fixture(); f.clip.speed = speed;
    expect(() => clipTimeRemapClockV1(f.project, f.clip, f.asset)).not.toThrow();
    expect(f.plan).toThrow("SHOT_GRADE_FRAME_INVALID: Authored speed/time remap needs its shared source-clock adapter");
  });
  it.each(["forward", "reverse"] as const)("refuses an authored %s curve even when its speed is one", direction => {
    const f = fixture(); f.clip.timeRemap = curve(direction);
    expect(() => clipTimeRemapClockV1(f.project, f.clip, f.asset)).not.toThrow();
    expect(f.plan).toThrow(/Authored speed\/time remap/);
  });
  it("does not treat a held curve as an ordinary advancing source", () => {
    const f = fixture(); f.clip.timeRemap = curve("forward", 0);
    const clock = clipTimeRemapClockV1(f.project, f.clip, f.asset)!;
    expect(timeRemapSourceBoundaryV1(clock, .2)).toBe(0); expect(f.plan).toThrow(/shared source-clock adapter/);
  });
  it("distinguishes the current timeline sample from its canonical doubled source time", () => {
    const f = fixture(); f.clip.speed = 2;
    const clock = clipTimeRemapClockV1(f.project, f.clip, f.asset)!;
    expect(timeRemapSourceBoundaryV1(clock, .2)).toBe(.4); expect(f.plan).toThrow(/shared source-clock adapter/);
  });
  it.each(["fromClipId", "toClipId"] as const)("does not ignore pair-transition ownership via %s", endpoint => {
    const f = fixture(); f.project.timelineTransitions = [{ schema: "editkin.timeline-transition/v1", id: "pair",
      trackId: f.clip.trackId, fromClipId: "left", toClipId: "right", beforeFrames: 1, afterFrames: 1, kernel: "dissolve", [endpoint]: f.clip.id }];
    expect(f.plan).toThrow("SHOT_GRADE_FRAME_INVALID: Pair transition needs its transition-read source-clock adapter");
  });
  it("keeps an unrelated pair from blocking a static source", () => {
    const f = fixture(), before = f.plan(); f.project.timelineTransitions = [{ schema: "editkin.timeline-transition/v1", id: "other-pair",
      trackId: "other-track", fromClipId: "left", toClipId: "right", beforeFrames: 1, afterFrames: 1, kernel: "dip" }];
    expect(f.plan()).toEqual(before);
  });
  it("retains the omitted-field plan after the ordinary reset path removes authored settings", () => {
    const f = fixture(), before = f.plan(); f.clip.speed = 2; f.clip.timeRemap = curve("forward");
    expect(f.plan).toThrow(); delete f.clip.speed; delete f.clip.timeRemap;
    expect(f.plan()).toEqual(before); expect(f.clip).not.toHaveProperty("speed"); expect(f.clip).not.toHaveProperty("timeRemap");
  });
  it("leaves caller data intact on both refusal and accepted planning", () => {
    const f = fixture(); f.clip.speed = .5; const before = structuredClone(f.project);
    expect(f.plan).toThrow(); expect(f.project).toEqual(before);
    delete f.clip.speed; const plain = structuredClone(f.project); f.plan(); expect(f.project).toEqual(plain);
  });
});
