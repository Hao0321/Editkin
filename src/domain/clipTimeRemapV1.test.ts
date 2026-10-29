import { describe, expect, it } from "vitest";
import { createEmptyProject, migrateProject, validateProject } from "./editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "./types";
import { applyCommand } from "./commands";
import { editorCommandSchema, projectSchema } from "./schema";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { buildRenderPlan } from "../render/planner";
import { timeRemapCfrBlendSampleV1, timeRemapSourceBoundaryV1 } from "./timeRemapClockV1";
import { clipTimeRemapClockV1, clipTimeRemapExpectedV1, clipTimeRemapAudioPlanV1, clipTimeRemapRateV1, type ClipTimeRemapV1 } from "./clipTimeRemapV1";
const setting = (speed = 1, direction: "forward" | "reverse" = "forward"): ClipTimeRemapV1 => ({ schema: "editkin.clip-time-remap/v1", direction,
  interpolation: "frame_blending", audioMode: "mute", segments: [{ from: { time: 0, speed }, control1: { time: 1 / 3, speed }, control2: { time: 2 / 3, speed }, to: { time: 1, speed } }] });
function fixture() {
  const project = createEmptyProject("curve", { id: "curve-project", fps: 30 }), clip: TimelineClip = { id: "clip", assetId: "video", trackId: "video-main", timelineStart: 0, sourceStart: 1, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.assets = [{ id: "video", name: "video", kind: "video", uri: "original.mp4", duration: 16, width: 1920, height: 1080 }]; project.tracks[0].clips = [clip]; return { project, clip };
}
describe("optional fixed-timeline clip source clock", () => {
  it("old omitted fields retain exact clip shape through schema, migration, ordinary edit and render planning", () => {
    const { project, clip } = fixture(), before = JSON.stringify(clip); expect(clipTimeRemapClockV1(project, clip, project.assets[0])).toBeUndefined();
    const reopened = migrateProject(JSON.parse(JSON.stringify(project))); projectSchema.parse(reopened); expect(JSON.stringify(reopened.tracks[0].clips[0])).toBe(before);
    const plan = buildRenderPlan(reopened, uri => uri); expect(plan.videoLayers[0].segments[0]).toMatchObject({ kind: "clip", duration: 4 });
    const changed = applyCommand(project, { type: "set_clip_volume", clipId: clip.id, volume: .5 }); expect(changed.tracks[0].clips[0]).not.toHaveProperty("speed"); expect(changed.tracks[0].clips[0]).not.toHaveProperty("timeRemap");
  });
  it("speed updates are absolute, preserve timeline/source asset, and plan pitch-preserving constant audio", () => {
    const { project, clip } = fixture(), before = JSON.stringify(project), command = { type: "set_clip_speed" as const, clipId: clip.id, expected: clipTimeRemapExpectedV1(clip), speed: 2 };
    expect(() => editorCommandSchema.parse(command)).not.toThrow(); const updated = applyCommand(project, command), target = updated.tracks[0].clips[0];
    expect(target).toMatchObject({ speed: 2, duration: 4, sourceStart: 1, assetId: "video" }); expect(clipTimeRemapClockV1(updated, target, updated.assets[0])?.sourceEndSeconds).toBe(9);
    const same = applyCommand(updated, { ...command, expected: clipTimeRemapExpectedV1(target) }); expect(same.tracks[0].clips[0].speed).toBe(2);
    expect(clipTimeRemapAudioPlanV1(target)).toEqual({ mode: "pitch_preserving_constant", atempo: [2] }); expect(JSON.stringify(project)).toBe(before);
  });
  it("slow/held timelines validate their consumed source rather than the old 1x duration", () => {
    const { project, clip } = fixture(); clip.duration = 40; clip.speed = .25; project.assets[0].duration = 12;
    expect(() => validateProject(project)).not.toThrow(); expect(clipTimeRemapClockV1(project, clip, project.assets[0])?.sourceEndSeconds).toBe(11);
    clip.speed = 0; clip.duration = 43_200; const held = clipTimeRemapClockV1(project, clip, project.assets[0])!;
    expect(held.totalOutputFrames).toBe(1_296_000); expect(held.sourceEndSeconds).toBe(1);
    expect(timeRemapSourceBoundaryV1(held, 43_200)).toBe(1); expect(clipTimeRemapAudioPlanV1(clip).mode).toBe("mute");
    expect(JSON.stringify(held).length).toBeLessThan(1200); delete clip.speed; expect(() => validateProject(project)).toThrow(/超過素材/);
  });
  it("Bezier curve multipliers and reverse use the same authentic frame clock and preserve data on reopen", () => {
    const { project, clip } = fixture(); const s = setting(.5, "reverse");
    let changed = applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected: clipTimeRemapExpectedV1(clip), speed: 2 });
    changed = applyCommand(changed, { type: "set_clip_time_remap", clipId: clip.id, expected: clipTimeRemapExpectedV1(changed.tracks[0].clips[0]), timeRemap: s });
    const reopened = migrateProject(JSON.parse(JSON.stringify(changed))), c = reopened.tracks[0].clips[0], clock = clipTimeRemapClockV1(reopened, c, reopened.assets[0])!;
    expect(c.timeRemap).toEqual(s); expect(c.speed).toBe(2); expect(clock.consumedSourceSeconds).toBe(4); expect(clock.direction).toBe("reverse");
    expect(timeRemapCfrBlendSampleV1(clock, 0, { timing: "cfr", frameRate: { numerator: 30, denominator: 1 }, decodedFrameCount: 480 }).sourceTimeSeconds).toBeCloseTo(5 - 1 / 30, 12);
    expect(() => projectSchema.parse(reopened)).not.toThrow();
  });
  it("resetting both optional fields restores the old clip byte shape and old export path", () => {
    const { project, clip } = fixture(), before = JSON.stringify(clip);
    let changed = applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected: clipTimeRemapExpectedV1(clip), speed: 2 });
    changed = applyCommand(changed, { type: "set_clip_time_remap", clipId: clip.id, expected: clipTimeRemapExpectedV1(changed.tracks[0].clips[0]), timeRemap: setting(.5) });
    changed = applyCommand(changed, { type: "set_clip_speed", clipId: clip.id, expected: clipTimeRemapExpectedV1(changed.tracks[0].clips[0]), speed: null });
    changed = applyCommand(changed, { type: "set_clip_time_remap", clipId: clip.id, expected: clipTimeRemapExpectedV1(changed.tracks[0].clips[0]), timeRemap: null });
    expect(JSON.stringify(changed.tracks[0].clips[0])).toBe(before); expect(() => buildRenderPlan(changed, uri => uri)).not.toThrow();
  });
  it("source EOF, corrupt curves, unknown fields, tiny positive speed and derived sources refuse without mutation", () => {
    const { project, clip } = fixture(), before = JSON.stringify(project), expected = clipTimeRemapExpectedV1(clip);
    expect(() => applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected, speed: 64 })).toThrow("HANDLES_INSUFFICIENT");
    const bad = setting(); bad.segments[0].control1.time = .9; bad.segments[0].control2.time = .1;
    expect(() => applyCommand(project, { type: "set_clip_time_remap", clipId: clip.id, expected, timeRemap: bad })).toThrow("NON_MONOTONE");
    expect(() => editorCommandSchema.parse({ type: "set_clip_speed", clipId: clip.id, expected, speed: 1e-8 })).toThrow();
    expect(() => editorCommandSchema.parse({ type: "set_clip_time_remap", clipId: clip.id, expected, timeRemap: { ...setting(), force: true } })).toThrow(); expect(JSON.stringify(project)).toBe(before);
    project.assets[0].clipRetime = { schema: "editkin.clip-retime/v1", sourceAssetId: "base", sourceStart: 0, sourceDuration: 4, rate: 1, reverse: false };
    expect(() => applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected, speed: 1 })).toThrow("ORIGINAL_LINEAR_MEDIA");
  });
  it("stale source/settings, locked and temporal-bound clips cannot be overwritten", () => {
    const { project, clip } = fixture(), expected = clipTimeRemapExpectedV1(clip), changed = applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected, speed: 2 });
    expect(() => applyCommand(changed, { type: "set_clip_speed", clipId: clip.id, expected, speed: 1 })).toThrow("SOURCE_OR_SETTINGS_CHANGED");
    project.tracks[0].locked = true; expect(() => applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected, speed: 2 })).toThrow(TRACK_LOCKED_MESSAGE); project.tracks[0].locked = false;
    clip.linkGroupId = "linked"; expect(() => applyCommand(project, { type: "set_clip_speed", clipId: clip.id, expected, speed: 1 })).toThrow("TEMPORAL_BINDING");
  });
  it("old source/timing edits cannot silently corrupt a curve, including after a new setting in the same batch", () => {
    const { project, clip } = fixture(), command = { type: "set_clip_speed" as const, clipId: clip.id, expected: clipTimeRemapExpectedV1(clip), speed: 2 }, changed = applyCommand(project, command);
    for (const edit of [{ type: "split_clip" as const, clipId: clip.id, at: 2, newClipId: "right" }, { type: "trim_clip_start" as const, clipId: clip.id, seconds: 1 }, { type: "slip_clip" as const, clipId: clip.id, sourceStart: 2 }]) {
      const before = JSON.stringify(changed); expect(() => applyCommand(changed, edit)).toThrow("SOURCE_EDIT_CONSUMER"); expect(JSON.stringify(changed)).toBe(before);
    }
    const before = JSON.stringify(project); expect(() => applyCommand(project, { type: "batch", commands: [command, { type: "trim_clip_end", clipId: clip.id, seconds: 1 }] })).toThrow("SOURCE_EDIT_CONSUMER"); expect(JSON.stringify(project)).toBe(before);
  });
  it("legacy export refuses authored clocks until a shared consumer is integrated", () => {
    const { project, clip } = fixture(); clip.speed = 1; expect(() => buildRenderPlan(project, uri => uri)).toThrow("SHARED_FRAME_CONSUMER_REQUIRED");
  });
  it("represents actual project rational rates without conflating 29.97 and 30000/1001", () => {
    expect(clipTimeRemapRateV1(29.97)).toEqual({ numerator: 2997, denominator: 100 });
    expect(clipTimeRemapRateV1(30000 / 1001)).toEqual({ numerator: 30000, denominator: 1001 }); expect(clipTimeRemapRateV1(.5)).toEqual({ numerator: 1, denominator: 2 });
    expect(() => clipTimeRemapRateV1(NaN)).toThrow("RATE_INVALID");
  });
  it("a genuine varying Bezier multiplier integrates once, including the base speed, with an explicit follow-audio plan", () => {
    const { project, clip } = fixture(); clip.speed = 2; clip.timeRemap = setting(); clip.timeRemap.audioMode = "follow_speed";
    clip.timeRemap.segments[0].control1.speed = .25; clip.timeRemap.segments[0].control2.speed = .25;
    const clock = clipTimeRemapClockV1(project, clip, project.assets[0])!;
    expect(clock.consumedSourceSeconds).toBeCloseTo(5, 12); expect(timeRemapSourceBoundaryV1(clock, 2)).toBeCloseTo(3.5, 12);
    expect(clipTimeRemapAudioPlanV1(clip)).toMatchObject({ mode: "follow_speed", sharedClockConsumerRequired: true });
  });
});
