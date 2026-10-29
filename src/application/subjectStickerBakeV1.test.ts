import { describe, expect, it, vi } from "vitest";
import { createProjectSession } from "./projectSession";
import { rotoProjectFixture } from "./__fixtures__/rotoCutoutProject.fixture";
import { prepareSubjectOverlayBakeV1, prepareSubjectStickerBakeV1, prepareSubjectSheenOverlayBakeV1, applyPreparedSubjectOverlayBakeV1, subjectOverlayBakeRequestV1Schema, type SubjectOverlayBakeHostV1 } from "./subjectStickerBakeV1";
const ids = { assetId: "new-asset", clipId: "new-clip", trackId: "new-track", linkGroupId: "new-link", assetName: "Subject", trackName: "Subject" };
function fixture() { const p = rotoProjectFixture(); p.width = 320; p.height = 200; p.fps = 24; return createProjectSession(p, "D:\\synthetic\\project.editkin.json"); }
function request() { return { schema: "editkin.subject-overlay-request/v1", expectedRevision: 0, clipId: "selected", ids, effect: { kind: "sticker", style: { schema: "editkin.subject-sticker-style/v1", borderPixels: 0, shadowSigma: 0, shadowOpacity: 0, shadowOffsetX: 0, shadowOffsetY: 0, popStartFrame: 0, popFrames: 12, popStartScale: 1, popOvershoot: 0, anchorX: .5, anchorY: .5 } } }; }
function host(resolveConfirmed?: SubjectOverlayBakeHostV1["resolveConfirmed"]): SubjectOverlayBakeHostV1 { return { assetBase: "D:\\synthetic", cacheRoot: "D:\\synthetic\\cache", ffmpegPath: "D:\\missing-ffmpeg.exe", ffprobePath: "D:\\missing-ffprobe.exe", resolveConfirmed }; }
describe("subject overlay Node admission and asynchronous lifetime", () => {
  it("holds without tools, files or project writes when canonical confirmed matte is unavailable", async () => {
    const s = fixture(), before = s.getSnapshot(); const r = await prepareSubjectOverlayBakeV1(s, request(), host());
    expect(r).toMatchObject({ state: "clean_hold", nativeProcesses: 0, filesWritten: 0, mutated: false }); expect(s.getSnapshot()).toBe(before);
  });
  it.each(["revision", "locked", "hidden", "retime", "grid", "relative"])("refuses %s before calling host resolver", async mode => {
    const s = fixture(), req = request(), resolve = vi.fn(async () => undefined), h = host(resolve), p = s.getSnapshot().history.present;
    if (mode === "revision") req.expectedRevision = 3; if (mode === "locked") p.tracks[0].locked = true; if (mode === "hidden") p.tracks[0].hidden = true;
    if (mode === "retime") p.tracks[0].clips[0].speed = 2; if (mode === "grid") p.tracks[0].clips[0].duration += .001; if (mode === "relative") h.assetBase = "relative";
    await expect(prepareSubjectOverlayBakeV1(s, req, h)).rejects.toThrow(); expect(resolve).not.toHaveBeenCalled(); expect(s.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["identical-reopen", "in-place-edit", "save-as"])("rejects %s while resolver is pending with zero Undo", async mode => {
    const s = fixture(); let finish!: () => void; const waiting = new Promise<void>(r => { finish = r; });
    const pending = prepareSubjectOverlayBakeV1(s, request(), host(async () => { await waiting; return undefined; }));
    await Promise.resolve(); const p = s.getSnapshot().history.present;
    if (mode === "identical-reopen") s.replaceProject(structuredClone(p), s.getSnapshot().projectPath);
    if (mode === "in-place-edit") p.name += " changed";
    if (mode === "save-as") s.getSnapshot().projectPath = "D:\\synthetic\\other.editkin.json";
    finish(); await expect(pending).rejects.toThrow(); expect(s.getSnapshot().history.past).toHaveLength(0);
  });
  it("preserves exact parent abort reason and settles a stalled resolver", async () => {
    const s = fixture(), controller = new AbortController(), reason = { kind: "user-cancel", id: 9 };
    const pending = prepareSubjectOverlayBakeV1(s, request(), host(() => new Promise(() => {})), { signal: controller.signal });
    controller.abort(reason); await expect(pending).rejects.toBe(reason); expect(s.getSnapshot().history.past).toHaveLength(0);
  });
  it("bounds a stalled resolver by the total deadline", async () => {
    await expect(prepareSubjectOverlayBakeV1(fixture(), request(), host(() => new Promise(() => {})), { timeoutMs: 100 })).rejects.toThrow(/DEADLINE/);
  });
  it("snapshots the request and bound host method before awaiting", async () => {
    const s = fixture(), req = request(); let finish!: () => void; const gate = new Promise<void>(r => { finish = r; }), h = host(async function () { await gate; return undefined; });
    const pending = prepareSubjectOverlayBakeV1(s, req, h); req.clipId = "changed"; h.resolveConfirmed = async () => { throw Error("replacement must not run"); };
    finish(); expect(await pending).toMatchObject({ state: "clean_hold" });
  });
  it.each(["sticker", "sheen"])("checks %s wrapper effect kind before host I/O", async kind => {
    const resolve = vi.fn(async () => undefined), s = fixture(), r = request();
    if (kind === "sticker") r.effect = { kind: "sheen", style: { schema: "editkin.subject-sheen-style/v1", angleDegrees: 0, bandWidthRatio: .3, intensity: .7 }, range: { startFrame: 1, endFrame: 4 } } as never;
    await expect((kind === "sticker" ? prepareSubjectStickerBakeV1 : prepareSubjectSheenOverlayBakeV1)(s, r, host(resolve))).rejects.toThrow(/KIND_REQUIRED/); expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects serialized/copy plans without any physical file or project I/O", async () => {
    const s = fixture(); await expect(applyPreparedSubjectOverlayBakeV1(s, { schema: "editkin.subject-overlay-plan/v1", expectedRevision: 0 } as never)).rejects.toThrow(/INVALID_OR_USED/);
    expect(s.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["extra", "invalid-style", "missing-id", "negative-revision"])("strictly refuses %s request", mode => {
    const r = request(); if (mode === "extra") Object.assign(r, { bypass: true }); if (mode === "invalid-style") r.effect.style.borderPixels = -1;
    if (mode === "missing-id") r.ids = { ...ids, clipId: "" }; if (mode === "negative-revision") r.expectedRevision = -1;
    expect(subjectOverlayBakeRequestV1Schema.safeParse(r).success).toBe(false);
  });
});
