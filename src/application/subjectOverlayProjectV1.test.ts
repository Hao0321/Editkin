import { describe, expect, it } from "vitest";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { rotoProjectFixture } from "./__fixtures__/rotoCutoutProject.fixture";
import { admitSubjectOverlaySourceV1, subjectOverlaySourceStageV1, planSubjectOverlayProjectV1, type SubjectOverlayMediaV1 } from "./subjectOverlayProjectV1";
import { encodeProjectBytes, decodeProjectBytes } from "./projectCodec";
function fixture() {
  const p = rotoProjectFixture(); p.width = 320; p.height = 200; p.fps = 24;
  const clip = p.tracks[0].clips[0]; clip.color.brightness = .1;
  clip.keyframes = [{ id: "pose-key", time: .5, transform: { ...clip.transform, x: 37, rotation: 5, opacity: .6 }, color: { ...clip.color, saturation: .8 }, easing: "linear" }];
  clip.gradeV2 = { schema: "editkin.color-grade/v2" };
  clip.layout = { crop: { x: .1, y: .1, width: .8, height: .8 }, viewport: { x: .1, y: .1, width: .4, height: .6 } };
  return p;
}
const ids = { assetId: "overlay-asset", clipId: "overlay-clip", trackId: "overlay-track", linkGroupId: "overlay-link", assetName: "Subject", trackName: "Subject" };
function media(kind: "sticker" | "sheen"): SubjectOverlayMediaV1 { return { kind, path: "D:/synthetic/subject-overlay.mkv", sha256: "a".repeat(64), sourceSha256: "a".repeat(64), confirmationSha256: "c".repeat(64),
  width: 320, height: 200, frames: 30, fps: 24, duration: 1.25, pixelFormat: kind === "sticker" ? "bgra" : "gbrap16le" }; }
describe("ordinary subject-overlay project data and one appearance owner", () => {
  it("neutralizes only a private source/mask stage, preserving every original appearance channel", () => {
    const p = fixture(), before = structuredClone(p), stage = subjectOverlaySourceStageV1(p, "selected", "sticker");
    expect(p).toEqual(before); expect(stage.clip.transform).toEqual(DEFAULT_TRANSFORM); expect(stage.clip.color).toEqual(DEFAULT_COLOR); expect(stage.clip.keyframes).toEqual([]);
    expect(stage.clip.masks).toEqual(p.tracks[0].clips[0].masks); expect(stage.clip.layout).toBeUndefined(); expect(stage.clip.gradeV2).toBeUndefined(); expect(stage.clip.creative).toBeUndefined();
    expect(stage.frames).toBe(30); expect(stage.clipStartFrame).toBe(48); expect(stage.clip.sourceStart).toBe(1);
  });
  it.each(["sticker", "sheen"] as const)("makes %s an editable ordinary clip in oneUndo with current codec persistence", kind => {
    const p = fixture(), before = structuredClone(p), original = p.tracks[0].clips[0], plan = planSubjectOverlayProjectV1(p, "selected", media(kind), ids);
    expect(p).toEqual(before); const h = dispatchCommand(createHistory(p), plan.command), saved = decodeProjectBytes(encodeProjectBytes(h.present));
    expect(h.past).toHaveLength(1); expect(undo(h).present.tracks).toEqual(p.tracks); expect(redo(undo(h)).present).toEqual(h.present);
    const added = saved.tracks.find(t => t.id === ids.trackId)!.clips[0], retained = saved.tracks[0].clips[0];
    expect(added.transform).toEqual(original.transform); expect(added.color).toEqual(original.color); expect(added.gradeV2).toEqual(original.gradeV2); expect(added.layout).toEqual(original.layout);
    expect(added.keyframes.map(k => ({ ...k, id: "" }))).toEqual(original.keyframes.map(k => ({ ...k, id: "" }))); expect(added.masks).toBeUndefined(); expect(added.chromaKey).toBeUndefined();
    expect(added.sourceStart).toBe(0); expect(added.volume).toBe(0); expect(retained.volume).toBe(original.volume); expect(retained.masks).toEqual(original.masks); expect(retained.color).toEqual(original.color);
    expect(retained.transform.opacity).toBe(kind === "sticker" ? 0 : original.transform.opacity); expect(retained.keyframes[0].transform.opacity).toBe(kind === "sticker" ? 0 : original.keyframes[0].transform.opacity);
    expect(saved.assets[0]).toEqual(p.assets[0]); expect(plan.asset.license).toBe(p.assets[0].license); expect(plan.asset.rightsBasis).toBe(p.assets[0].rightsBasis);
  });
  it.each(["locked", "hidden", "disabled", "parent", "retime", "hdr", "grid", "template"])("refuses %s without changing source", mode => {
    const p = fixture(), c = p.tracks[0].clips[0]; if (mode === "locked") p.tracks[0].locked = true; if (mode === "hidden") p.tracks[0].hidden = true;
    if (mode === "disabled") c.layer = { enabled: false, blendMode: "normal" }; if (mode === "parent") c.layer = { enabled: true, blendMode: "normal", parentClipId: c.id };
    if (mode === "retime") c.speed = 2; if (mode === "hdr") p.colorManagement!.outputTransform = "rec2100_hlg_1000"; if (mode === "grid") c.duration += .001;
    if (mode === "template") p.templateApplication = { generatedClips: [{ clipId: c.id, trackId: c.trackId }] } as never;
    const before = JSON.stringify(p); expect(() => admitSubjectOverlaySourceV1(p, "selected", "sticker")).toThrow(); expect(JSON.stringify(p)).toBe(before);
  });
  it.each(["duration", "fps", "frames", "raster", "kind", "format", "sha", "ids"])("refuses invalid %s media or ID data", mode => {
    const p = fixture(), m = media("sticker"); if (mode === "duration") m.duration = NaN; if (mode === "fps") m.fps = 25; if (mode === "frames") m.frames = 29;
    if (mode === "raster") m.width = 321; if (mode === "kind") m.kind = "unknown" as never; if (mode === "format") m.pixelFormat = "gbrap16le"; if (mode === "sha") m.sourceSha256 = "x";
    expect(() => planSubjectOverlayProjectV1(p, "selected", m, mode === "ids" ? { ...ids, assetId: "" } : ids)).toThrow();
  });
});
