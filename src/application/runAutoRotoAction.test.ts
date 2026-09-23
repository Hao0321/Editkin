import { describe, expect, it, vi } from "vitest";
import type { AutoRotoDesktopRequest, AutoRotoDesktopResult } from "../desktop/types";
import type { EditorCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { dispatchCommand } from "../domain/history";
import { autoRotoRuntimeStatusFromReceipt } from "../ui/autoRotoRuntimeStatus";
import { createProductAutoRotoRouteReceipt } from "./autoRotoProductContract";
import { createProjectSession } from "./projectSession";
import { runAutoRotoAction } from "./runAutoRotoAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Schema-valid synthetic metadata; no files or alpha image quality are claimed.
function result(): AutoRotoDesktopResult {
  const root = `C:/fixture-memory/auto-roto-product/${"d".repeat(64)}`;
  return {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
    width: 16, height: 16, analysisFps: 1, initialFrame: 0, sequencePath: `${root}/matte-sequence.alpha8`,
    sequenceSha256: "a".repeat(64), sequenceBytes: 256, meanBoundaryChatter: 0,
    correctionStrokesApplied: 0, correctedFrames: [], frozen: true, manifestPath: `${root}/matte-manifest.json`,
    frames: [{ frame: 0, time: 0, alphaPath: `${root}/frame-000000.png`, confidence: 1, foregroundRatio: .5, boundaryChatter: 0, previewSha256: "b".repeat(64), alphaFrameSha256: "c".repeat(64) }],
    regionMemoryRouting: { schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline", candidateAttempted: false, deterministicFallback: false },
    alphaRefinement: { schema: "editkin.optical-alpha-refinement-aggregate/v1", engine: "editkin-self-authored-optical-alpha-refiner/v1", appliedFrames: 1, radius: 2, backgroundThreshold: .1, foregroundThreshold: .9, coarseWeight: .4, temporalStability: .5, temporalGate: .15, changedPixels: 0, fractionalPixels: 256, solvedPixels: 256, meanSolveConfidence: 1 },
    analyzedSeconds: 1, elapsedMs: 1, cacheHit: false, qualityState: "diagnostic", routeReceipt: createProductAutoRotoRouteReceipt(),
  };
}

function harness() {
  const initial = createDemoProject();
  initial.tracks[0].clips[0].masks = [createClipMask("subject-mask", "subject")];
  const session = createProjectSession(initial, "C:/fixture-memory/same.editkin.json");
  const pending = deferred<AutoRotoDesktopResult>();
  const analyze = vi.fn((_request: AutoRotoDesktopRequest) => pending.promise);
  const busy = { current: false };
  const onBusy = vi.fn(); const onPlaying = vi.fn(); const onStatus = vi.fn();
  const validateResult = vi.fn(autoRotoRuntimeStatusFromReceipt);
  const onRuntimeStatus = vi.fn();
  const onCommand = vi.fn((command: EditorCommand, message: string) => {
    session.setHistory((history) => dispatchCommand(history, command)); onStatus(message);
  });
  const options = () => ({
    projectSession: session, project: session.getSnapshot().history.present, clipId: "clip-demo", maskId: "subject-mask", playhead: 0,
    analyze, busy, onBusy, onPlaying, onStatus, validateResult, onRuntimeStatus, onCommand,
  });
  return {
    session, pending, analyze, busy, onBusy, onPlaying, onStatus, validateResult, onRuntimeStatus, onCommand, options,
    run: () => runAutoRotoAction(options()),
    edit: (command: EditorCommand) => session.setHistory((history) => dispatchCommand(history, command)),
    mask: () => session.getSnapshot().history.present.tracks[0].clips[0].masks?.[0],
  };
}

describe("Auto Roto action generation ownership (deferred API, real receipt validator and domain reducer)", () => {
  it("applies one valid current matte once, retaining diagnostic-only status and frozen range", async () => {
    const h = harness(); const work = h.run();
    expect(h.busy.current).toBe(true);
    expect(h.onPlaying).toHaveBeenCalledWith(false);
    expect(h.analyze).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "demo-source.mp4", feather: .035, duration: 12, fps: 30 }));
    h.pending.resolve(result());
    expect(await work).toBe("applied");
    expect(h.onCommand).toHaveBeenCalledTimes(1);
    expect(h.onRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(h.mask()).toMatchObject({ matteSequence: { frozen: true, qualityState: "diagnostic" }, frozenRange: { fromFrame: 0, toFrame: 360 } });
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("人工檢查"));
    expect(h.busy.current).toBe(false);
    expect(h.onBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("rejects a matte analyzed before an intervening feather edit without promoting runtime or freezing", async () => {
    const h = harness(); const work = h.run();
    h.edit({ type: "update_clip_mask", clipId: "clip-demo", maskId: "subject-mask", patch: { feather: .15 } });
    h.pending.resolve(result());
    expect(await work).toBe("stale");
    expect(h.mask()?.feather).toBe(.15);
    expect(h.mask()?.matteSequence).toBeUndefined();
    expect(h.mask()?.frozenRange).toBeUndefined();
    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.validateResult).not.toHaveBeenCalled();
    expect(h.onRuntimeStatus).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("未套用舊結果"));
  });

  it("ignores same-ID/same-path replacement session results and never writes an old status there", async () => {
    const h = harness(); const work = h.run();
    const next = structuredClone(h.session.getSnapshot().history.present);
    next.name = "Reopened same ID";
    next.tracks[0].clips[0].masks![0].feather = .2;
    h.session.replaceProject(next, "C:/fixture-memory/same.editkin.json");
    const statusCount = h.onStatus.mock.calls.length;
    h.pending.resolve(result());
    expect(await work).toBe("stale");
    expect(h.session.getSnapshot().history.present).toBe(next);
    expect(h.onStatus).toHaveBeenCalledTimes(statusCount);
    expect(h.onRuntimeStatus).not.toHaveBeenCalled();
    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.busy.current).toBe(false);
  });

  it("discards the result after the target mask is deleted", async () => {
    const h = harness(); const work = h.run();
    h.edit({ type: "delete_clip_mask", clipId: "clip-demo", maskId: "subject-mask" });
    h.pending.resolve(result());
    expect(await work).toBe("stale");
    expect(h.mask()).toBeUndefined();
    expect(h.onCommand).not.toHaveBeenCalled();
  });

  it("uses the synchronous busy ref to stop same-tick duplicate backend requests", async () => {
    const h = harness(); const first = h.run(); const second = h.run();
    expect(await second).toBe("busy");
    expect(h.analyze).toHaveBeenCalledTimes(1);
    expect(h.onBusy.mock.calls).toEqual([[true]]);
    h.pending.resolve(result());
    expect(await first).toBe("applied");
    expect(h.onCommand).toHaveBeenCalledTimes(1);
    expect(h.onBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("does not invalidate useful analysis merely because a save acknowledgment updates revision", async () => {
    const h = harness(); const work = h.run();
    const request = h.session.beginSave()!;
    expect(h.session.completeSave(request, { path: request.projectPath, project: { ...structuredClone(request.project), revision: 1, updatedAt: "2026-08-31T07:00:00.000Z" } })).toBe(true);
    h.session.finishSave(request);
    h.pending.resolve(result());
    expect(await work).toBe("applied");
    expect(h.onCommand).toHaveBeenCalledTimes(1);
    expect(h.session.getSnapshot().history.present.revision).toBe(1);
    expect(h.mask()?.matteSequence?.frozen).toBe(true);
    expect(h.session.getSnapshot().dirty).toBe(true);
  });

  it("does not start analysis from an already-stale render snapshot", async () => {
    const h = harness(); const stale = h.options();
    h.edit({ type: "rename_project", name: "New content" });
    expect(await runAutoRotoAction(stale)).toBe("stale");
    expect(h.analyze).not.toHaveBeenCalled();
    expect(h.onBusy).not.toHaveBeenCalled();
  });

  it("accepts quick-add masks only from the post-command current project", async () => {
    const h = harness();
    const before = h.session.getSnapshot().history.present;
    h.edit({ type: "add_clip_mask", clipId: "clip-demo", mask: createClipMask("quick-new-mask", "subject") });
    expect(await runAutoRotoAction({ ...h.options(), project: before, maskId: "quick-new-mask" })).toBe("stale");
    const work = runAutoRotoAction({ ...h.options(), maskId: "quick-new-mask" });
    h.pending.resolve(result());
    expect(await work).toBe("applied");
    expect(h.onCommand).toHaveBeenCalledWith(expect.objectContaining({ maskId: "quick-new-mask" }), expect.any(String));
  });

  it("keeps current string errors visible and releases the busy gate", async () => {
    const h = harness(); const work = h.run();
    h.pending.reject("native roto fixture failure");
    expect(await work).toBe("failed");
    expect(h.onStatus).toHaveBeenLastCalledWith("native roto fixture failure");
    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.busy.current).toBe(false);
    expect(h.onBusy).toHaveBeenLastCalledWith(false);
  });

  it("suppresses late backend error details after an edit and asks to retry current content", async () => {
    const h = harness(); const work = h.run();
    h.edit({ type: "update_clip_mask", clipId: "clip-demo", maskId: "subject-mask", patch: { expansion: .05 } });
    h.pending.reject("old native error");
    expect(await work).toBe("stale");
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("未套用舊結果"));
    expect(h.onStatus.mock.calls.flat().join(" ")).not.toContain("old native error");
    expect(h.onCommand).not.toHaveBeenCalled();
  });

  it("suppresses late backend errors entirely after same-ID session replacement", async () => {
    const h = harness(); const work = h.run();
    h.session.replaceProject(structuredClone(h.session.getSnapshot().history.present), "C:/fixture-memory/same.editkin.json");
    const before = h.onStatus.mock.calls.length;
    h.pending.reject(new Error("old session native error"));
    expect(await work).toBe("stale");
    expect(h.onStatus).toHaveBeenCalledTimes(before);
    expect(h.onRuntimeStatus).not.toHaveBeenCalled();
  });

  const rejectedReceipts: Array<[string, (value: AutoRotoDesktopResult) => void]> = [
    ["forged route hash", (value) => { value.routeReceipt.receiptSha256 = "f".repeat(64) as typeof value.routeReceipt.receiptSha256; }],
    ["fallback claim", (value) => { value.regionMemoryRouting.deterministicFallback = true as false; }],
    ["unmeasured quality promotion", (value) => { value.qualityState = "verified" as "diagnostic"; }],
    ["unfrozen runtime output", (value) => { value.frozen = false as true; }],
  ];
  it.each(rejectedReceipts)("preserves existing rejection of %s", async (_label, mutate) => {
    const h = harness(); const work = h.run(); const invalid = result(); mutate(invalid);
    h.pending.resolve(invalid);
    expect(await work).toBe("failed");
    expect(h.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("receipt 不完整"));
    expect(h.onRuntimeStatus).not.toHaveBeenCalled();
    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.mask()?.matteSequence).toBeUndefined();
  });

  it("does not let a backend mutate the editor's correction stroke array", async () => {
    const h = harness();
    h.edit({ type: "update_clip_mask", clipId: "clip-demo", maskId: "subject-mask", patch: {
      rotoCorrections: [{ id: "stroke-1", frame: 0, mode: "foreground", radius: .1, points: [{ x: .5, y: .5 }] }],
    } });
    const work = h.run();
    h.analyze.mock.calls[0][0].corrections![0].points[0].x = .99;
    expect(h.mask()?.rotoCorrections?.[0].points[0].x).toBe(.5);
    h.pending.resolve(result()); expect(await work).toBe("applied");
  });
});
