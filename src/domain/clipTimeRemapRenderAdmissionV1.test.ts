import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./editGraph";
import { applyCommand } from "./commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "./types";
import { clipTimeRemapExpectedV1, clipTimeRemapMuteReasonV1, clipTimeRemapRenderRefusalV1, type ClipTimeRemapV1 } from "./clipTimeRemapV1";
import { clipTimeRemapRenderBlockersV1 } from "./clipTimeRemapCommandsV1";

/** W2-4 speed render: the commands accept exactly what the export renders, validate_project agrees, and the sound rule is named. */
const curve = (audioMode: "mute" | "follow_speed"): ClipTimeRemapV1 => ({ schema: "editkin.clip-time-remap/v1", direction: "forward", interpolation: "frame_blending", audioMode,
  segments: [{ from: { time: 0, speed: 1 }, control1: { time: 1 / 3, speed: 2 }, control2: { time: 2 / 3, speed: 2 }, to: { time: 1, speed: 1 } }] });
function fixture(): { project: EditProject; clip: TimelineClip } {
  const project = createEmptyProject("speed", { id: "speed", fps: 30 });
  const clip: TimelineClip = { id: "clip", assetId: "video", trackId: "video-main", timelineStart: 0, sourceStart: 1, duration: 4, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.assets = [{ id: "video", name: "video", kind: "video", uri: "original.mp4", duration: 30, width: 1920, height: 1080,
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } }];
  project.tracks[0].clips = [clip];
  return { project, clip };
}
const speed = (project: EditProject, value: number | null) => applyCommand(project, { type: "set_clip_speed", clipId: "clip", expected: clipTimeRemapExpectedV1(project.tracks[0].clips[0]), speed: value });
const remap = (project: EditProject, value: ClipTimeRemapV1) => applyCommand(project, { type: "set_clip_time_remap", clipId: "clip", expected: clipTimeRemapExpectedV1(project.tracks[0].clips[0]), timeRemap: value });

describe("speed admission shared by the commands, validate_project and the export", () => {
  it("accepts constant speeds, freezes and muted curves on an ordinary Rec.709 video", () => {
    for (const value of [0.25, 0.5, 2, 4, 6, 0]) expect(speed(fixture().project, value).tracks[0].clips[0].speed).toBe(value);
    expect(remap(fixture().project, curve("mute")).tracks[0].clips[0].timeRemap?.audioMode).toBe("mute");
    expect(clipTimeRemapRenderBlockersV1(speed(fixture().project, 2))).toEqual([]);
  });

  it("refuses, with a named reason, what the export cannot render", () => {
    const aces = fixture().project; aces.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" } as EditProject["colorManagement"];
    expect(() => speed(aces, 2)).toThrow("CLIP_SPEED_ACES2_UNSUPPORTED");
    const hdr = fixture().project; hdr.assets[0].color = { interpretation: "hlg", transfer: "arib-std-b67", primaries: "bt2020" };
    expect(() => speed(hdr, 2)).toThrow("CLIP_SPEED_REC709_SDR_SOURCE_REQUIRED");
    const rotated = fixture().project; rotated.assets[0].displayAspectRatio = 9 / 16;
    expect(() => speed(rotated, 2)).toThrow("CLIP_SPEED_ROTATED_OR_ANAMORPHIC_SOURCE_UNSUPPORTED");
    const unknown = fixture().project; delete unknown.assets[0].width;
    expect(() => speed(unknown, 2)).toThrow("CLIP_SPEED_SOURCE_RASTER_UNSUPPORTED");
    const audio = fixture().project; audio.assets[0].kind = "audio";
    expect(() => speed(audio, 2)).toThrow("CLIP_SPEED_ORIGINAL_VIDEO_REQUIRED");
    expect(() => remap(fixture().project, curve("follow_speed"))).toThrow("CLIP_TIME_REMAP_FOLLOW_AUDIO_UNAVAILABLE");
    // Clearing always works, and a silent clip may let its (absent) sound "follow".
    expect(speed(speed(fixture().project, 2), null).tracks[0].clips[0].speed).toBeUndefined();
    const silent = fixture().project; silent.tracks[0].clips[0].volume = 0;
    expect(remap(silent, curve("follow_speed")).tracks[0].clips[0].timeRemap?.audioMode).toBe("follow_speed");
  });

  it("validate_project's blockers name each stored clip the export would refuse, including inside compositions", () => {
    const { project } = fixture(); project.tracks[0].clips[0].timeRemap = curve("follow_speed");
    project.compositions = [{ id: "comp", name: "comp", width: 1920, height: 1080, fps: 30, duration: 4,
      tracks: [{ id: "comp-video", name: "v", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(project.tracks[0].clips[0]), id: "inner", trackId: "comp-video", timeRemap: undefined, speed: 2 }] }] }] as EditProject["compositions"];
    expect(clipTimeRemapRenderBlockersV1(project).map(row => [row.clipId, row.code])).toEqual([
      ["clip", "CLIP_TIME_REMAP_FOLLOW_AUDIO_UNAVAILABLE"], ["inner", "CLIP_SPEED_NESTED_UNSUPPORTED"]]);
    expect(clipTimeRemapRenderRefusalV1(project, { ...project.tracks[0].clips[0], timeRemap: undefined, speed: 2 })).toBeUndefined();
  });

  it("names why an exported speed carries no sound of its own", () => {
    const clip = fixture().clip;
    expect(clipTimeRemapMuteReasonV1({ ...clip, speed: 2 })).toBeUndefined();
    expect(clipTimeRemapMuteReasonV1({ ...clip, speed: 0.5 })).toBeUndefined();
    expect(clipTimeRemapMuteReasonV1({ ...clip, speed: 8 })).toBe("speed_outside_pitch_range");
    expect(clipTimeRemapMuteReasonV1({ ...clip, speed: 0.25 })).toBe("speed_outside_pitch_range");
    expect(clipTimeRemapMuteReasonV1({ ...clip, speed: 0 })).toBe("freeze");
    expect(clipTimeRemapMuteReasonV1({ ...clip, speed: 2, volume: 0 })).toBe("clip_volume_zero");
    expect(clipTimeRemapMuteReasonV1({ ...clip, timeRemap: curve("mute") })).toBe("curve_audio_muted");
  });
});
