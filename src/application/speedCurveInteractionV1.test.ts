import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR, type TimelineClip } from "../domain/types";
import { encodeProjectBytes, decodeProjectBytes, parseProject } from "./projectCodec";
import { createSpeedCurvePresetV1 } from "./speedCurvePresetsV1";
import { createSpeedCurveInteractionV1, speedCurveInteractionErrorKindV1, type SpeedCurveInteractionContextV1 } from "./speedCurveInteractionV1";

function fixture() {
  const project = createEmptyProject("curve UI", { id: "curve-ui", fps: 30 }), clip: TimelineClip = { id: "clip", assetId: "video", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], timeRemap: createSpeedCurvePresetV1("montage") };
  project.assets = [{ id: "video", name: "original", kind: "video", uri: "generated.mp4", duration: 32, width: 64, height: 40 }]; project.tracks[0].clips = [clip];
  let history = createHistory(project);
  const context: SpeedCurveInteractionContextV1 = { project, clipId: clip.id, hostReady: true, sourceHasAudio: false };
  const errors: unknown[] = [], revisions: number[] = [], drafts: unknown[] = [], busy: boolean[] = [];
  const driver = createSpeedCurveInteractionV1({ read: () => context, onError: e => errors.push(e), onDraft: d => drafts.push(d), onBusy: b => busy.push(b),
    dispatch: (command, revision) => { if (context.project.revision !== revision) throw Error("HOST_REVISION_STALE"); revisions.push(revision); history = dispatchCommand(history, command); context.project = history.present; } });
  return { project, clip, context, errors, revisions, drafts, busy, driver, history: () => history };
}
describe("curve widget interaction driver with the real reducer/history", () => {
  it("many pointer moves write oneUndo, preserve input, and round-trip exact project bytes", async () => {
    const f = fixture(), before = JSON.stringify(f.project); expect(f.driver.begin({ kind: "anchor", index: 1 })).toBe(true);
    for (let i = 0; i < 30; i++) expect(f.driver.move({ time: .4 + i / 200, speed: .2 + i / 100 })).toBe(true);
    expect(f.history().past).toHaveLength(0); expect(JSON.stringify(f.project)).toBe(before);
    expect(await f.driver.commit()).toBe(true); expect(f.history().past).toHaveLength(1); expect(f.revisions).toEqual([f.project.revision]);
    expect(undo(f.history()).present).toEqual(f.project); expect(redo(undo(f.history())).present).toEqual(f.context.project);
    expect(decodeProjectBytes(encodeProjectBytes(f.context.project))).toEqual(parseProject(f.context.project)); expect(f.errors).toEqual([]);
  });
  it("cancelled, discarded, repeated-finish and no-op gestures dispatch nothing", async () => {
    const f = fixture(); f.driver.begin({ kind: "anchor", index: 1 }); f.driver.move({ time: .6, speed: .5 }); f.driver.cancel();
    expect(await f.driver.commit()).toBe(false); expect(f.driver.isDragging()).toBe(false); expect(f.history().past).toHaveLength(0);
    f.driver.begin({ kind: "anchor", index: 1 }); expect(await f.driver.commit()).toBe(true); expect(await f.driver.commit()).toBe(false);
    expect(f.history().past).toHaveLength(0); expect(f.drafts.at(-1)).toBeUndefined();
  });
  it("does not reject an unchanged normal clip merely because follow audio is unsupported", async () => {
    const f = fixture(); delete f.clip.timeRemap; f.context.sourceHasAudio = true;
    f.driver.begin({ kind: "anchor", index: 0 }); expect(await f.driver.commit()).toBe(true); expect(f.errors).toEqual([]); expect(f.history().past).toHaveLength(0);
  });
  it("declines unsupported follow audio without muting or dispatch, then accepts explicit mute", async () => {
    const f = fixture(); f.context.sourceHasAudio = true;
    expect(await f.driver.change(c => ({ ...c, audioMode: "follow_speed" }))).toBe(false);
    expect(String(f.errors.at(-1))).toContain("FOLLOW_AUDIO_UNAVAILABLE"); expect(f.history().past).toHaveLength(0);
    expect(await f.driver.change(() => createSpeedCurvePresetV1("impact"))).toBe(true); expect(f.context.project.tracks[0].clips[0].timeRemap?.audioMode).toBe("mute");
  });
  it.each(["revision", "source", "selection"] as const)("rejects stale %s before dispatch without overwriting intervening changes", async kind => {
    const f = fixture(); f.driver.begin({ kind: "anchor", index: 1 }); f.driver.move({ time: .6, speed: .5 });
    if (kind === "revision") f.context.project.revision++;
    if (kind === "source") f.context.project.assets[0].uri = "different.mp4";
    if (kind === "selection") f.context.clipId = "other";
    const current = JSON.stringify(f.context.project); expect(await f.driver.commit()).toBe(false); expect(f.history().past).toHaveLength(0); expect(JSON.stringify(f.context.project)).toBe(current);
  });
  it.each(["host", "disabled", "pending", "locked"] as const)("refuses %s state at pointer start", kind => {
    const f = fixture(); if (kind === "host") delete f.context.hostReady; if (kind === "disabled") f.context.disabled = true;
    if (kind === "pending") f.context.busy = true; if (kind === "locked") f.context.project.tracks[0].locked = true;
    expect(f.driver.begin({ kind: "anchor", index: 1 })).toBe(false); expect(f.history().past).toHaveLength(0); expect(f.driver.isDragging()).toBe(false);
  });
  it("checks changing host readiness again before the finished gesture can dispatch", async () => {
    const f = fixture(); f.driver.begin({ kind: "anchor", index: 1 }); f.driver.move({ time: .6, speed: .5 }); f.context.hostReady = false;
    expect(await f.driver.commit()).toBe(false); expect(f.history().past).toHaveLength(0);
  });
  it("does not create duplicate Undo while an async host dispatch is still pending", async () => {
    const f = fixture(); let done!: () => void, calls = 0;
    const driver = createSpeedCurveInteractionV1({ read: () => f.context, dispatch: async () => { calls++; await new Promise<void>(r => { done = r; }); } });
    const pending = driver.change(() => createSpeedCurvePresetV1("impact")); expect(driver.isBusy()).toBe(true);
    expect(await driver.change(() => createSpeedCurvePresetV1("jump"))).toBe(false); expect(driver.begin({ kind: "anchor", index: 1 })).toBe(false); expect(calls).toBe(1);
    done(); expect(await pending).toBe(true); expect(driver.isBusy()).toBe(false);
  });
  it("a rejected async dispatch restores idle state and retains the original project", async () => {
    const f = fixture(), before = JSON.stringify(f.context.project), errors: unknown[] = [];
    const driver = createSpeedCurveInteractionV1({ read: () => f.context, dispatch: async () => { throw Error("host stale"); }, onError: e => errors.push(e) });
    expect(await driver.change(() => createSpeedCurvePresetV1("impact"))).toBe(false); expect(driver.isBusy()).toBe(false); expect(JSON.stringify(f.context.project)).toBe(before); expect(errors).toHaveLength(1);
  });
  it("retains source-boundary refusal and cancels malformed pointer operations", async () => {
    const f = fixture(); f.context.project.assets[0].duration = 4;
    expect(await f.driver.change(() => createSpeedCurvePresetV1("impact"))).toBe(false); expect(f.history().past).toHaveLength(0);
    expect(f.driver.begin({ kind: "anchor", index: -1 })).toBe(false);
    f.driver.begin({ kind: "anchor", index: 1 }); expect(f.driver.move({ time: 1, speed: .5 })).toBe(false); expect(f.driver.isDragging()).toBe(false); expect(f.history().past).toHaveLength(0);
  });
  it("moves a real Bezier handle without dispatch until commit", async () => {
    const f = fixture(); expect(f.driver.begin({ kind: "handle", index: 0, handle: "control2" })).toBe(true); f.driver.move({ time: .4, speed: .6 });
    expect(f.history().past).toHaveLength(0); expect(await f.driver.commit()).toBe(true); expect(f.context.project.tracks[0].clips[0].timeRemap?.segments[0].control2).toEqual({ time: .4, speed: .6 });
  });
  it("B4 reset reuses original media and one Undo even before a source-clock host is mounted", async () => {
    const f = fixture(); delete f.clip.timeRemap; f.context.hostReady = false;
    const original = f.project.assets[0]; f.project.assets.push({ ...original, id: "b4", duration: 2, clipRetime: { schema: "editkin.clip-retime/v1", sourceAssetId: original.id, sourceStart: 2, sourceDuration: 4, rate: 2, reverse: true } });
    f.clip.assetId = "b4"; f.clip.duration = 2; expect(await f.driver.resetB4()).toBe(true);
    expect(f.context.project.tracks[0].clips[0]).toMatchObject({ assetId: original.id, sourceStart: 2, duration: 4 }); expect(f.history().past).toHaveLength(1); expect(f.context.project.assets).toHaveLength(2);
  });
  it("maps actual reducer/admission failures to host-localized messages without exposing raw technical errors", async () => {
    const short = fixture(); short.context.project.assets[0].duration = 4; await short.driver.change(() => createSpeedCurvePresetV1("impact"));
    expect(speedCurveInteractionErrorKindV1(short.errors.at(-1))).toBe("sourceShort");
    const locked = fixture(); locked.context.project.tracks[0].locked = true; locked.driver.begin({ kind: "anchor", index: 1 });
    expect(speedCurveInteractionErrorKindV1(locked.errors.at(-1))).toBe("locked");
    const linked = fixture(); linked.clip.linkGroupId = "linked"; await linked.driver.change(() => createSpeedCurvePresetV1("impact"));
    expect(speedCurveInteractionErrorKindV1(linked.errors.at(-1))).toBe("temporal");
    const unavailable = fixture(); unavailable.context.hostReady = false; unavailable.driver.begin({ kind: "anchor", index: 1 });
    expect(speedCurveInteractionErrorKindV1(unavailable.errors.at(-1))).toBe("unavailable");
  });
});
