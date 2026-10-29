import { describe, expect, it } from "vitest";
import { admitSourcePreservingProjectV1, admitSourcePreservingMp4V1, SOURCE_PRESERVING_POLICY_V1 } from "./sourcePreservingAdmissionV1";
import { sourcePreservingFixtureV1, sourcePreservingProbeFixtureV1 } from "./sourcePreservingV1.fixture";
describe("LV-03 explicit original-container admission; metadata is not decode proof", () => {
  it("admits only explicit whole-source original audio/clock and leaves project bytes unchanged", () => {
    const project = sourcePreservingFixtureV1(), before = JSON.stringify(project);
    const admission = admitSourcePreservingProjectV1(project, SOURCE_PRESERVING_POLICY_V1);
    expect(admission.audioPolicy).toBe("original_streams_without_normalization");
    expect(admission.videoClockPolicy).toBe("original_pts_dts_and_rate");
    expect(admitSourcePreservingMp4V1(sourcePreservingProbeFixtureV1(), admission).sourceDecodeVerificationRequired).toBe(true);
    expect(JSON.stringify(project)).toBe(before);
    expect(() => admitSourcePreservingProjectV1(project, "auto" as never)).toThrow("EXPLICIT_POLICY");
  });
  it("rejects trims, multiple clips, audio edits and every rendering surface", () => {
    const modifiers = [
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].sourceStart = .1; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].duration = 1.9; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].timelineStart = .1; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].volume = .9; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].muted = true; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].hidden = true; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips.push({ ...p.tracks[0].clips[0], id: "another" }); },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[1].clips.push({ ...p.tracks[0].clips[0], trackId: p.tracks[1].id }); },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].transform.scale = .99; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].transform.flipX = true; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].color.exposure = .1; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].gradeV2 = { schema: "editkin.color-grade/v2" }; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].creative = { effectPresetIds: [] }; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].audioEnvelope = { fadeIn: .1 } as never; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.scene25d = { enabled: false } as never; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.captions.push({} as never); },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.motionGraphics.push({} as never); },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.timelineTransitions = [{} as never]; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.colorManagement!.mode = "aces2"; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { Object.assign(p.tracks[0].clips[0], { futureWarp: 1 }); },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.tracks[0].clips[0].transform.scale = null as never; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.colorManagement = null as never; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.assets[0].clipRetime = {} as never; },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { Object.assign(p.assets[0], { futureWarp: 1 }); },
      (p: ReturnType<typeof sourcePreservingFixtureV1>) => { p.assets[0].color = { interpretation: "rec709", transfer: "smpte2084" }; },
    ];
    for (const modify of modifiers) { const project = sourcePreservingFixtureV1(); modify(project); expect(() => admitSourcePreservingProjectV1(project, SOURCE_PRESERVING_POLICY_V1)).toThrow(); }
  });
  it("checks any explicit source range against the actual copied container instead of silently changing it", () => {
    const p = sourcePreservingFixtureV1(); p.assets[0].color = { interpretation: "rec709", range: "pc" };
    const admission = admitSourcePreservingProjectV1(p, SOURCE_PRESERVING_POLICY_V1), metadata = sourcePreservingProbeFixtureV1();
    expect(() => admitSourcePreservingMp4V1(metadata, admission)).toThrow("MEDIA_COLOR_UNKNOWN_OR_CHANGED");
    metadata.streams[0].color_range = "pc";
    expect(admitSourcePreservingMp4V1(metadata, admission).sourceVideoCodec).toBe("h264");
  });
  it("rejects unknown/different codec, HDR, geometry, SAR, stream layout and long-audio video EOF", () => {
    const admission = admitSourcePreservingProjectV1(sourcePreservingFixtureV1(), SOURCE_PRESERVING_POLICY_V1);
    const modifications = [
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].width = 128; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].sample_aspect_ratio = "2:1"; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].color_transfer = "smpte2084"; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].color_primaries = "unknown"; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].duration = ".5"; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].time_base = "0/0"; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[0].codec_name = "unknown"; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams[1].channels = 0; },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.streams.push({ codec_type: "subtitle" } as never); },
      (p: ReturnType<typeof sourcePreservingProbeFixtureV1>) => { p.format.tags.major_brand = "qt  "; },
    ];
    for (const modify of modifications) { const probe = sourcePreservingProbeFixtureV1(); modify(probe); expect(() => admitSourcePreservingMp4V1(probe, admission)).toThrow(); }
  });
});
