import { describe, expect, it } from "vitest";
import { dispatchCommandSafely } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { rotoProjectFixture } from "./__fixtures__/rotoCutoutProject.fixture";
import { createSubjectOverlayInteractionV1, type SubjectOverlayKindV1, type SubjectOverlayUiApplicationV1, type SubjectOverlayUiContextV1, type SubjectOverlayUiAckV1 } from "./subjectOverlayInteractionV1";
import { prepareSubjectOverlayBakeV1, type SubjectOverlayBakeHostV1 } from "./subjectStickerBakeV1";
function fixture(kind: SubjectOverlayKindV1 = "sticker") {
  const p = rotoProjectFixture(); p.width = 320; p.height = 200; p.fps = 24;
  const session = createProjectSession(p, "D:\\synthetic\\project.editkin.json"), style = { schema: "editkin.subject-sticker-style/v1" as const, borderPixels: 0, shadowSigma: 0, shadowOpacity: 0, shadowOffsetX: 0, shadowOffsetY: 0, popStartFrame: 0, popFrames: 12, popStartScale: 1, popOvershoot: 0, anchorX: .5, anchorY: .5 };
  const c: SubjectOverlayUiContextV1 = { project: p, projectSession: session, selectionRange: { startFrame: 55, endFrame: 73 }, hostOwner: {}, request: { schema: "editkin.subject-overlay-request/v1", expectedRevision: p.revision, clipId: "selected",
    ids: { assetId: "new-a", clipId: "new-c", trackId: "new-t", linkGroupId: "new-l", assetName: "Subject", trackName: "Subject" },
    effect: kind === "sticker" ? { kind, style } : { kind, style: { schema: "editkin.subject-sheen-style/v1", angleDegrees: 35, bandWidthRatio: .28, intensity: .7 }, range: { startFrame: 55, endFrame: 73 } } } };
  return { p, session, c, read: () => c };
}
describe("subject overlay browser request and host guard lifetime", () => {
  it.each(["sticker", "sheen"] as const)("accepts own %s commit exactly once and permits a new explicit operation identity", async kind => {
    const f = fixture(kind); let calls = 0;
    const driver = createSubjectOverlayInteractionV1({ read: f.read, apply: async a => { calls++; expect(a.guard.isCurrent()).toBe(true); expect(a.request.effect.kind).toBe(kind);
      const r = dispatchCommandSafely(f.session.getSnapshot().history, { type: "rename_project", name: "Own commit " + calls }); f.session.setHistory(r.state); f.c.project = r.state.present; driver.synchronize(); return { status: "applied" }; } });
    const pending = driver.apply(kind); expect(await driver.apply(kind)).toBe(false); expect(await pending).toBe(true); expect(driver.getState().status).toBe("done"); expect(calls).toBe(1);
    expect(await driver.apply(kind)).toBe(false); f.c.request.ids = { ...f.c.request.ids, clipId: "next-c", assetId: "next-a" }; driver.synchronize(); expect(driver.getState().status).toBe("idle");
    expect(await driver.apply(kind)).toBe(true); expect(calls).toBe(2); expect(f.session.getSnapshot().history.past).toHaveLength(2);
  });
  it.each(["same-id-reopen", "in-place", "selection", "request", "forwarded-request", "style", "disabled", "owner", "document-path", "session", "cancel", "dispose"])("invalidates %s after a host await with zero writes", async mode => {
    const f = fixture(); let entered!: () => void, release!: () => void, forwarded!: SubjectOverlayUiApplicationV1, writes = 0;
    const inHost = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const driver = createSubjectOverlayInteractionV1({ read: f.read, apply: async a => { forwarded = a; entered(); await gate; if (!a.guard.isCurrent()) return { status: "cancelled" }; writes++; return { status: "applied" }; } });
    const pending = driver.apply("sticker"); await inHost;
    if (mode === "same-id-reopen") f.session.replaceProject(structuredClone(f.p), f.session.getSnapshot().projectPath);
    if (mode === "in-place") f.p.name += " changed"; if (mode === "selection") f.c.selectionRange.endFrame--;
    if (mode === "request") f.c.request.ids.clipId = "changed"; if (mode === "forwarded-request") forwarded.request.ids.clipId = "changed-copy";
    if (mode === "style" && f.c.request.effect.kind === "sticker") f.c.request.effect.style.borderPixels++;
    if (mode === "disabled") f.c.disabled = true; if (mode === "owner") f.c.hostOwner = {};
    if (mode === "document-path") f.session.getSnapshot().projectPath = "D:\\synthetic\\other.editkin.json";
    if (mode === "session") f.c.projectSession = createProjectSession(f.p); if (mode === "cancel") driver.cancel(); if (mode === "dispose") driver.dispose();
    driver.synchronize(); expect(forwarded.guard.signal.aborted).toBe(true); release(); expect(await pending).toBe(false); expect(writes).toBe(0); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["disabled", "missing-owner", "wrong-project", "locked", "hidden", "retime", "wrong-kind", "wrong-revision"])("refuses %s before host dispatch", async mode => {
    const f = fixture(); let calls = 0;
    if (mode === "disabled") f.c.disabled = true; if (mode === "missing-owner") f.c.hostOwner = undefined;
    if (mode === "wrong-project") f.c.project = structuredClone(f.p); if (mode === "locked") f.p.tracks[0].locked = true; if (mode === "hidden") f.p.tracks[0].hidden = true;
    if (mode === "retime") f.p.tracks[0].clips[0].speed = 2; if (mode === "wrong-kind") f.c.request.effect.kind = "sheen" as never; if (mode === "wrong-revision") f.c.request.expectedRevision++;
    const driver = createSubjectOverlayInteractionV1({ read: f.read, apply: async () => { calls++; return { status: "applied" }; } }); expect(await driver.apply("sticker")).toBe(false); expect(calls).toBe(0); expect(driver.getState().status).toBe("failed");
  });
  it("allows an explicit retry only after a known clean hold or cancelled no-write ack", async () => {
    const f = fixture(); let ack: SubjectOverlayUiAckV1 = { status: "clean_hold" }, calls = 0;
    const driver = createSubjectOverlayInteractionV1({ read: f.read, apply: async () => { calls++; return ack; } }); expect(await driver.apply("sticker")).toBe(false); expect(driver.getState().status).toBe("clean_hold");
    ack = { status: "cancelled" }; expect(await driver.apply("sticker")).toBe(false); expect(driver.getState().status).toBe("cancelled"); ack = { status: "applied" }; expect(await driver.apply("sticker")).toBe(true); expect(calls).toBe(3);
  });
  it("captures session identity even if a new session has byte-identical content and the same path", async () => {
    const f = fixture(); let enter!: () => void, release!: () => void, writes = 0;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const driver = createSubjectOverlayInteractionV1({ read: f.read, apply: async a => { enter(); await gate; if (!a.guard.isCurrent()) return { status: "cancelled" }; writes++; return { status: "applied" }; } });
    const pending = driver.apply("sticker"); await entered; f.c.projectSession = createProjectSession(f.p, f.session.getSnapshot().projectPath); driver.synchronize(); release(); expect(await pending).toBe(false); expect(writes).toBe(0);
  });
  it("owns the pending slot before a reentrant pause callback", async () => {
    const f = fixture(); let calls = 0, reentrant: Promise<boolean> | undefined;
    const driver = createSubjectOverlayInteractionV1({ read: f.read, onPause: () => { reentrant = driver.apply("sticker"); }, apply: async () => { calls++; return { status: "cancelled" }; } });
    expect(await driver.apply("sticker")).toBe(false); expect(await reentrant).toBe(false); expect(calls).toBe(1);
  });
  it.each(["throw", "invalid-ack", "timeout"])("quarantines an uncertain %s outcome and never replays the same IDs", async mode => {
    const f = fixture(); let calls = 0, signal: AbortSignal | undefined;
    const driver = createSubjectOverlayInteractionV1({ read: f.read, timeoutMs: 100, apply: async a => { calls++; signal = a.guard.signal;
      if (mode === "throw") throw Error("Host result unavailable"); if (mode === "invalid-ack") return { status: "unknown" } as never; return new Promise(() => {}); } });
    expect(await driver.apply("sticker")).toBe(false); expect(driver.getState().status).toBe("uncertain"); expect(signal?.aborted).toBe(true); expect(await driver.apply("sticker")).toBe(false); expect(calls).toBe(1);
  });
  it("copies bounded progress and ignores late or malformed observations", async () => {
    const f = fixture(); let enter!: () => void, release!: () => void, app!: SubjectOverlayUiApplicationV1;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const driver = createSubjectOverlayInteractionV1({ read: f.read, apply: async a => { app = a; enter(); await gate; return { status: "cancelled" }; } }); const pending = driver.apply("sticker"); await entered;
    app.onProgress({ stage: "render", frames: 4, total: 30 }); const copy = driver.getState(); copy.progress!.frames = 999; expect(driver.getState().progress?.frames).toBe(4);
    app.onProgress({ stage: "render", frames: 31, total: 30 }); expect(driver.getState().progress?.frames).toBe(4); driver.cancel(); app.onProgress({ stage: "ready", frames: 30, total: 30 }); expect(driver.getState().progress?.frames).toBe(4);
    release(); await pending; app.onProgress({ stage: "ready", frames: 30, total: 30 }); expect(driver.getState().status).toBe("cancelled");
  });
  it.each([0, 99, 60001, NaN])("rejects timeout budget %s", timeoutMs => { expect(() => createSubjectOverlayInteractionV1({ read: fixture().read, apply: async () => ({ status: "cancelled" }), timeoutMs })).toThrow("TIMEOUT_BUDGET"); });
});
describe("Node producer live host guard admission", () => {
  const host: SubjectOverlayBakeHostV1 = { assetBase: "D:\\synthetic", cacheRoot: "D:\\synthetic\\missing-cache", ffmpegPath: "D:\\missing-ffmpeg.exe", ffprobePath: "D:\\missing-ffprobe.exe" };
  it.each(["false", "non-boolean"])("rejects %s guard before invoking resolver or file APIs", async mode => {
    const f = fixture(); let calls = 0; const isCurrent = mode === "false" ? () => false : () => Promise.resolve(false) as never;
    await expect(prepareSubjectOverlayBakeV1(f.session, f.c.request, { ...host, resolveConfirmed: async () => { calls++; return undefined; } }, { isCurrent })).rejects.toThrow("HOST_CHANGED"); expect(calls).toBe(0); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("rejects a changed host after a pending resolver before clean-hold acceptance", async () => {
    const f = fixture(); let allow = true, release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const pending = prepareSubjectOverlayBakeV1(f.session, f.c.request, { ...host, resolveConfirmed: async () => { await gate; return undefined; } }, { isCurrent: () => allow });
    await Promise.resolve(); allow = false; release(); await expect(pending).rejects.toThrow("HOST_CHANGED"); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("captures the original guard function rather than a mutable runtime property", async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(r => { release = r; }), runtime = { isCurrent: () => true };
    const pending = prepareSubjectOverlayBakeV1(f.session, f.c.request, { ...host, resolveConfirmed: async () => { await gate; return undefined; } }, runtime);
    runtime.isCurrent = () => false; release(); expect(await pending).toMatchObject({ state: "clean_hold" });
  });
  it("preserves a throwing guard's exact failure before dispatch", async () => {
    const f = fixture(), reason = Error("Task-shaped synchronous owner failure");
    await expect(prepareSubjectOverlayBakeV1(f.session, f.c.request, host, { isCurrent: () => { throw reason; } })).rejects.toBe(reason);
  });
});
