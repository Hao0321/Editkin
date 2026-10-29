import { describe, expect, it } from "vitest";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { planRotoCutoutProjectV1 } from "./rotoCutoutProjectV1";
import { rotoProjectFixture as fixture, rotoBakeFixture as bake } from "./__fixtures__/rotoCutoutProject.fixture";
const ids = { assetId: "cutout-asset", clipId: "cutout-clip", trackId: "cutout-track", linkGroupId: "cutout-link", assetName: "Subject", trackName: "Subject" };
describe("ordinary baked foreground clip admission", () => {
  it("commits one Undo, preserving original sound/source/analysis and foreground pose, with save/reopen", () => {
    const before = fixture(), untouched = structuredClone(before), plan = planRotoCutoutProjectV1(before, "selected", bake(), ids);
    expect(before).toEqual(untouched);
    const history = dispatchCommand(createHistory(before), plan.command, "cutout-command");
    expect(history.past).toHaveLength(1);
    const old = history.present.tracks[0].clips[0], created = history.present.tracks.find(t => t.id === ids.trackId)!;
    expect(old.transform.opacity).toBe(0); expect(old.volume).toBe(.7); expect(old.assetId).toBe("source"); expect(old.masks).toEqual(before.tracks[0].clips[0].masks);
    expect(created).toMatchObject({ muted: true, hidden: false, locked: false });
    expect(created.clips[0]).toMatchObject({ sourceStart: 0, duration: 1.25, timelineStart: 2, volume: 0, masks: [], transform: before.tracks[0].clips[0].transform });
    expect(created.clips[0].linkGroupId).toBe(old.linkGroupId);
    expect(history.present.assets.find(a => a.id === ids.assetId)).toMatchObject({ alphaMode: "straight", width: 64, height: 40, rightsBasis: "creator_owned" });
    expect(undo(history).present).toEqual(before); expect(redo(undo(history)).present).toEqual(history.present);
    const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(reopened).toEqual(parseProject(history.present));
    expect(reopened.tracks).toEqual(history.present.tracks); expect(reopened.assets).toEqual(history.present.assets);
  });
  it.each(["locked", "wrong-source", "changed-bytes", "wrong-window", "duration", "fps", "speed", "expression", "aces"])("refuses %s without changing original", kind => {
    const p = fixture(), r = bake();
    if (kind === "locked") p.tracks[0].locked = true;
    if (kind === "wrong-source") r.sourcePath = "D:/control/other.mkv";
    if (kind === "changed-bytes") p.assets[0].derivatives!.sourceSha256 = "f".repeat(64);
    if (kind === "wrong-window") r.matteIdentity.sourceStart = 2;
    if (kind === "duration") r.duration = 1;
    if (kind === "fps") r.fps = 30;
    if (kind === "speed") p.tracks[0].clips[0].speed = 2;
    if (kind === "expression") p.tracks[0].clips[0].expressions = { opacity: "hao.expression/v1:1" };
    if (kind === "aces") p.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    const unchanged = structuredClone(p); expect(() => planRotoCutoutProjectV1(p, "selected", r, ids)).toThrow(); expect(p).toEqual(unchanged);
  });
  it("binds file URI to the same local source without granting source hash drift", () => {
    const p = fixture(); p.assets[0].uri = "file:///D:/control/source.mkv";
    expect(planRotoCutoutProjectV1(p, "selected", bake(), ids).command.type).toBe("batch");
  });
  it("keeps animated pose/color/opacity on the foreground and hides every original opacity key in one Undo", () => {
    const p = fixture(); p.tracks[0].clips[0].keyframes = [
      { id: "pose-a", time: 0, transform: { ...DEFAULT_TRANSFORM, x: 12, opacity: .6 }, color: { ...DEFAULT_COLOR }, easing: "linear" },
      { id: "pose-b", time: 1, transform: { ...DEFAULT_TRANSFORM, x: 25, opacity: .9 }, color: { ...DEFAULT_COLOR }, easing: "ease_in_out" }];
    const before = structuredClone(p), plan = planRotoCutoutProjectV1(p, "selected", bake(), ids);
    const h = dispatchCommand(createHistory(p), plan.command); const foreground = h.present.tracks.find(t => t.id === ids.trackId)!.clips[0];
    expect(foreground.keyframes.map(k => ({ ...k, id: "" }))).toEqual(before.tracks[0].clips[0].keyframes.map(k => ({ ...k, id: "" })));
    expect(h.present.tracks[0].clips[0].keyframes.every(k => k.transform.opacity === 0)).toBe(true);
    expect(h.present.tracks[0].clips[0].volume).toBe(.7); expect(undo(h).present).toEqual(before);
  });
});
