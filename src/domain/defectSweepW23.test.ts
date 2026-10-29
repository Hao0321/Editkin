import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import { prepareCaptionOverlapRepair, exportCaptionDelivery, inspectCaptionDelivery } from "./captionDelivery";
import { animatedClipState } from "./editGraph";
import { planAudioDetach } from "../application/audioDetach";
import { planClipRetime } from "../application/clipRetime";
import { captionStyleFromPreset } from "../creative/corePack";
import type { EditProject, TimelineClip } from "./types";

/** Wave 2 defect sweep (W2-3), domain regressions: each case failed before its fix. */

function detachedPair() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  clip.timelineStart = 0; clip.sourceStart = 2; clip.duration = 4;
  const detached = planAudioDetach(project, clip.id, { clipId: "sound", trackId: "sound-track" });
  return applyCommand(project, detached.command);
}
const clipOf = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!;

describe("B5: linked clips keep their source offset", () => {
  it("slipping the picture slips the separated sound by the same amount", () => {
    const project = detachedPair();
    const next = applyCommand(project, { type: "slip_clip", clipId: "clip-demo", sourceStart: 3.5 });
    expect(clipOf(next, "clip-demo").sourceStart).toBe(3.5);
    expect(clipOf(next, "sound").sourceStart).toBe(3.5);
    // Slipping from the sound side moves the picture too.
    const back = applyCommand(next, { type: "slip_clip", clipId: "sound", sourceStart: 1 });
    expect([clipOf(back, "clip-demo").sourceStart, clipOf(back, "sound").sourceStart]).toEqual([1, 1]);
  });

  it("keeps a different in-sync offset and refuses when a peer has no media for it", () => {
    const project = detachedPair();
    clipOf(project, "sound").sourceStart = 2.5; // a deliberately offset (re-synced) sound
    const next = applyCommand(project, { type: "slip_clip", clipId: "clip-demo", sourceStart: 3 });
    expect(clipOf(next, "sound").sourceStart).toBe(3.5);
    const before = JSON.stringify(project);
    // The picture can start at 7.9 s (7.9 + 4 <= 12) but the sound would need 8.4 + 4 > 12.
    expect(() => applyCommand(project, { type: "slip_clip", clipId: "clip-demo", sourceStart: 7.9 })).toThrow("無法跟著換入點");
    expect(JSON.stringify(project)).toBe(before);
  });

  it("a multi-selection batch that slips both members is applied once, not twice", () => {
    const project = detachedPair();
    const next = applyCommand(project, { type: "batch", commands: [
      { type: "slip_clip", clipId: "clip-demo", sourceStart: 3 }, { type: "slip_clip", clipId: "sound", sourceStart: 3 }] });
    expect([clipOf(next, "clip-demo").sourceStart, clipOf(next, "sound").sourceStart]).toEqual([3, 3]);
  });

  it("replacing the picture's source carries the sound that came from it; independent linked media keep theirs", () => {
    const project = detachedPair();
    project.assets.push({ ...structuredClone(project.assets[0]), id: "asset-new", name: "new.mp4", uri: "new.mp4", duration: 10 });
    project.assets.push({ id: "asset-music", name: "bed.wav", kind: "audio", uri: "bed.wav", duration: 30 });
    const music = { ...structuredClone(clipOf(project, "sound")), id: "music", assetId: "asset-music", sourceStart: 5, trackId: "music-track" } as TimelineClip;
    project.tracks.push({ id: "music-track", name: "music", kind: "audio", locked: false, muted: false, clips: [music] });
    const linked = applyCommand(project, { type: "set_clip_links", clipIds: ["clip-demo", "sound", "music"], groupId: "group-1" });
    const next = applyCommand(linked, { type: "replace_clip_source", clipId: "clip-demo", expectedAssetId: "asset-demo", assetId: "asset-new", sourceStart: 1 });
    expect(clipOf(next, "clip-demo")).toMatchObject({ assetId: "asset-new", sourceStart: 1 });
    expect(clipOf(next, "sound")).toMatchObject({ assetId: "asset-new", sourceStart: 1, timelineStart: 0, duration: 4 });
    expect(clipOf(next, "music")).toMatchObject({ assetId: "asset-music", sourceStart: 5 });
    // The sound would run past the end of the new media: the whole replace is refused.
    expect(() => applyCommand(linked, { type: "replace_clip_source", clipId: "clip-demo", expectedAssetId: "asset-demo", assetId: "asset-new", sourceStart: 6.5 }))
      .toThrow(/長度不足|無法跟著換成新素材/);
  });

  it("retiming a linked pair is refused plainly before any derivative is made, never desyncing it", () => {
    const project = detachedPair();
    const placeholder = { ...structuredClone(project.assets[0]), id: "asset-retime", uri: "pending.mp4", duration: 2 };
    const before = JSON.stringify(project);
    expect(() => planClipRetime(project, "clip-demo", "asset-demo", placeholder, 2)).toThrow("取消連結");
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe("A4 captions", () => {
  it("B12: add_caption snaps to frames, so overlap repair and the SRT sidecar work on agent cues", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "batch", commands: [
      { type: "add_caption", caption: { id: "a", text: "第一句", start: 0.21, duration: 1.0 } },
      { type: "add_caption", caption: { id: "b", text: "第二句", start: 1.17, duration: 1.3 } },
    ] });
    for (const cue of project.captions) {
      expect(Math.abs(cue.start * 30 - Math.round(cue.start * 30))).toBeLessThan(1e-6);
      expect(Math.abs((cue.start + cue.duration) * 30 - Math.round((cue.start + cue.duration) * 30))).toBeLessThan(1e-6);
    }
    expect(inspectCaptionDelivery(project).counts.off_frame).toBeUndefined();
    const repaired = applyCommand(project, prepareCaptionOverlapRepair(project, ["a"]).command);
    expect(exportCaptionDelivery(repaired, "srt", "original").cueCount).toBe(2);
  });

  it("B12: a cue shorter than half a frame still lasts one frame", () => {
    const project = applyCommand(createDemoProject(), { type: "add_caption", caption: { id: "tiny", text: "嗯", start: 2, duration: 0.004 } });
    expect(project.captions[0]).toMatchObject({ start: 2, duration: 1 / 30 });
  });

  it("B8: set_caption_style with only a presetId applies the preset's look; partial patches merge as before", () => {
    const project = createDemoProject();
    const styled = applyCommand(project, { type: "set_caption_style", patch: { presetId: "neon_signal" } });
    const expected = captionStyleFromPreset("neon_signal");
    expect(styled.captionStyle).toMatchObject({ presetId: "neon_signal", fontFamily: expected.fontFamily, color: expected.color, fontSize: expected.fontSize });
    expect(styled.captionStyle.color === project.captionStyle.color && styled.captionStyle.fontFamily === project.captionStyle.fontFamily).toBe(false);
    const partial = applyCommand(project, { type: "set_caption_style", patch: { presetId: "clean_caption", color: "#FFFFFF" } });
    expect(partial.captionStyle).toEqual({ ...project.captionStyle, presetId: "clean_caption", color: "#FFFFFF" });
    expect(() => applyCommand(project, { type: "set_caption_style", patch: { presetId: "no-such-style" } })).toThrow("no-such-style");
  });
});

describe("expressions are not stored into base values (applied twice)", () => {
  function expressive() {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    clip.transform = { ...clip.transform, opacity: 1 };
    clip.expressions = { opacity: "hao.expression/v1:value*0.5" };
    return project;
  }
  const authoredOpacity = (clip: TimelineClip, time: number) => animatedClipState({ ...clip, expressions: {} }, time).transform.opacity;

  it("split_clip keeps the right half's authored opacity", () => {
    const next = applyCommand(expressive(), { type: "split_clip", clipId: "clip-demo", at: 4, newClipId: "right" });
    expect(clipOf(next, "right").transform.opacity).toBe(1);
    expect(animatedClipState(clipOf(next, "right"), 0).transform.opacity).toBe(0.5);
  });

  it("trim_clip_start (full and fast path) keeps the authored opacity", () => {
    const masked = expressive();
    const fast = applyCommand(masked, { type: "trim_clip_start", clipId: "clip-demo", seconds: 1 });
    expect(clipOf(fast, "clip-demo").transform.opacity).toBe(1);
    const full = expressive();
    clipOf(full, "clip-demo").audioEnvelope = undefined;
    const viaBatch = applyCommand(full, { type: "batch", commands: [{ type: "trim_clip_start", clipId: "clip-demo", seconds: 1 }, { type: "set_clip_volume", clipId: "clip-demo", volume: 1 }] });
    expect(clipOf(viaBatch, "clip-demo").transform.opacity).toBe(1);
  });

  it("smart_cut_clip segments keep the authored opacity", () => {
    const project = expressive(), clip = clipOf(project, "clip-demo");
    clip.keyframes = [
      { id: "k0", time: 0, transform: { ...clip.transform, opacity: 1 }, color: { ...clip.color }, easing: "linear" },
      { id: "k1", time: 10, transform: { ...clip.transform, opacity: 0.8 }, color: { ...clip.color }, easing: "linear" },
    ];
    const next = applyCommand(project, { type: "smart_cut_clip", clipId: clip.id, keepRanges: [{ start: 0, end: 2 }, { start: 5, end: 8 }], segmentIds: ["clip-demo", "seg-2"] });
    const second = clipOf(next, "seg-2");
    expect(second.transform.opacity).toBeCloseTo(authoredOpacity(clip, 5), 9);
    expect(second.transform.opacity).toBeGreaterThan(0.85);
  });
});
