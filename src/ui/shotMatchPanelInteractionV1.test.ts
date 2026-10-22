import { expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import type { PreparedShotGradeLocalV1 } from "../application/shotGradeLocalV1";
import { createShotMatchPanelInteractionV1 } from "./shotMatchPanelInteractionV1";
import type { ShotMatchFramesV1, ShotMatchHostV1, ShotMatchReviewV1, ShotMatchRuntimeV1 } from "./shotMatchPanelModelV1";

function fixture() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0]; clip.timelineStart = 1; clip.duration = .6;
  project.tracks[0].clips.unshift({ ...structuredClone(clip), id: "previous", timelineStart: 0 });
  project.tracks[0].clips.push({ ...structuredClone(clip), id: "alternate", timelineStart: 2 });
  const session = createProjectSession(project, "owned.editkin.json"), emitted = vi.fn(), owner = {};
  const frames = (id: string): ShotMatchFramesV1 => ({ clipId: id, assetId: clip.assetId, sourceSha256: "a".repeat(64), opaque: true,
    frames: [{ sampleId: "p", timeSeconds: .1, width: 2, height: 2, format: "rgb8", workingSpace: "rec709_display", stage: "clip_working_post_v2", pixels: new Uint8Array(12).fill(100) }] });
  const reviews: ShotMatchReviewV1[] = [];
  const makeReview = (request: Parameters<ShotMatchHostV1["prepare"]>[0]): ShotMatchReviewV1 => {
    const command = { type: "set_clip_grade_v2" as const, clipId: request.target.clipId, grade: { schema: "editkin.color-grade/v2" as const, nodes: [{ id: "matched", label: request.destination.label, offset: { r: .02 } }] } };
    const proposal = { state: "ready", mode: request.mode, projectId: project.id, expectedRevision: project.revision, clipId: clip.id,
      referenceClipId: request.mode === "shot_match" ? request.reference.clipId : null, command,
      sourceBindings: [frames(clip.id), ...(request.mode === "shot_match" ? [frames(request.reference.clipId)] : [])].map(f => ({ clipId: f.clipId, assetId: f.assetId, sourceSha256: f.sourceSha256 })),
      numericalEvaluation: { scope: "UNIT_HOST_DOUBLE_NOT_PIXEL_PROOF" } } as unknown as PreparedShotGradeLocalV1;
    const review = { proposal, before: frames(clip.id), after: frames(clip.id), discard: vi.fn(),
      apply: vi.fn(async (runtime: ShotMatchRuntimeV1) => {
        runtime.signal.throwIfAborted(); if (!runtime.isCurrent()) throw Error("stale actual host guard");
        const result = dispatchCommandSafely(session.getSnapshot().history, command); if (result.error) throw Error(result.error);
        session.setHistory(result.state); return { status: "applied" as const, undoSteps: 1 as const, clipId: clip.id };
      }) };
    reviews.push(review); return review;
  };
  const host: ShotMatchHostV1 = { projectOwner: owner, contentOwner: session.getSnapshot().contentOwner, sessionId: 1, projectPath: "owned.editkin.json", project, targetClipId: clip.id, editable: true,
    readFrames: vi.fn(async id => frames(id)), prepare: vi.fn(async request => makeReview(request)) };
  const read = () => ({ ...host, project: session.getSnapshot().history.present, contentOwner: session.getSnapshot().contentOwner });
  const control = createShotMatchPanelInteractionV1(read, "對色", emitted), writes = () => session.getSnapshot().history.journal.filter(j => j.command.type === "set_clip_grade_v2").length;
  return { project, clip, session, host, control, emitted, frames, makeReview, reviews, writes };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it("loads real-shaped stage data, defaults the reference, waits for explicit Apply, and makes one existing Undo/Redo", async () => {
  const f = fixture(); await f.control.refresh(); expect(f.control.state().draft.referenceClipId).toBe("previous");
  const before = structuredClone(f.session.getSnapshot().history.present); await f.control.run("shot_match"); expect(f.writes()).toBe(0); expect(f.control.state().status).toBe("ready");
  await Promise.all([f.control.apply(), f.control.apply()]); expect(f.writes()).toBe(1); expect(f.control.state().status).toBe("applied");
  const after = structuredClone(f.session.getSnapshot().history.present); f.session.setHistory(undo(f.session.getSnapshot().history)); expect(f.session.getSnapshot().history.present).toEqual(before);
  f.session.setHistory(redo(f.session.getSnapshot().history)); expect(f.session.getSnapshot().history.present).toEqual(after); expect(f.reviews[0].discard).toHaveBeenCalledTimes(1); f.control.dispose();
});
it.each(["selection", "same-id-project", "path", "provider", "locked"])("cannot apply a review after %s changed", async kind => {
  const f = fixture(); await f.control.refresh(); await f.control.run("shot_match");
  if (kind === "selection") f.host.targetClipId = "alternate"; if (kind === "same-id-project") f.project.name = "same id, new content";
  if (kind === "path") f.host.projectPath = "different.editkin.json"; if (kind === "provider") f.host.prepare = vi.fn(); if (kind === "locked") f.project.tracks[0].locked = true;
  await f.control.apply(); await f.control.settled(); expect(f.writes()).toBe(0); expect(f.reviews[0].apply).not.toHaveBeenCalled(); expect(f.reviews[0].discard).toHaveBeenCalledTimes(1); f.control.dispose();
});
it("invalidates a ready review on a draft mark or destination edit without auto-applying", async () => {
  const f = fixture(); await f.control.refresh(); await f.control.run("auto_balance");
  f.control.changeDraft({ ...f.control.state().draft, destination: { kind: "append", label: "Custom author label" } });
  expect(f.control.state().review).toBeUndefined(); expect(f.reviews[0].discard).toHaveBeenCalledTimes(1); await f.control.apply(); expect(f.writes()).toBe(0); f.control.dispose();
});
it("rejects a source SHA changed by the real-host boundary before presenting Apply", async () => {
  const f = fixture(); await f.control.refresh(); f.host.prepare = vi.fn(async request => { const r = f.makeReview(request); r.proposal.sourceBindings[0].sourceSha256 = "b".repeat(64); return r; });
  await f.control.refresh(); await f.control.run("auto_balance"); expect(f.control.state()).toMatchObject({ status: "held", code: "stale" }); expect(f.writes()).toBe(0); expect(f.reviews[0].discard).toHaveBeenCalledTimes(1); f.control.dispose();
});
it("discards late cancellation results and never writes after unmount", async () => {
  const f = fixture(), gate = deferred<ShotMatchReviewV1>(), entered = deferred<void>(); f.host.prepare = vi.fn(() => { entered.resolve(); return gate.promise; }); await f.control.refresh();
  const pending = f.control.run("shot_match"); await entered.promise; f.control.dispose(); const calls = f.emitted.mock.calls.length;
  const review = f.makeReview({ schema: "editkin.shot-grade-local-request/v1", mode: "auto_balance", expectedRevision: 0, target: { clipId: f.clip.id, samples: [{ id: "p", time: .1 }] }, destination: { kind: "append", label: "對色" }, roiBasis: "local-layer-raster-normalized", reason: "unit" });
  gate.resolve(review); await pending; expect(review.discard).toHaveBeenCalledTimes(1); expect(f.emitted.mock.calls.length).toBe(calls); expect(f.writes()).toBe(0);
});
it("serializes changed-reference frame reads until the cancelled provider closes", async () => {
  const f = fixture(), first = deferred<ShotMatchFramesV1>(); let calls = 0;
  f.host.readFrames = vi.fn(async (id, runtime) => { calls++; if (calls === 1) { const frame = await first.promise; expect(runtime.signal.aborted).toBe(true); return frame; } return f.frames(id); });
  const pending = f.control.refresh(); await Promise.resolve(); await Promise.resolve(); expect(calls).toBe(1);
  f.control.changeDraft({ ...f.control.state().draft, referenceClipId: "alternate" }); await Promise.resolve(); expect(calls).toBe(1);
  first.resolve(f.frames(f.clip.id)); await pending; await f.control.settled(); expect(calls).toBe(3); expect(f.control.state().reference?.clipId).toBe("alternate"); expect(f.writes()).toBe(0); f.control.dispose();
});
it.each(["unchanged", "not_applicable"] as const)("presents %s without enabling a write", async status => {
  const f = fixture(); f.host.prepare = vi.fn(async request => { const r = f.makeReview(request); r.proposal.state = status; r.proposal.command = null; return r; });
  await f.control.refresh(); await f.control.run("auto_balance"); expect(f.control.state().status).toBe(status); await f.control.apply(); expect(f.writes()).toBe(0); expect(f.reviews[0].apply).not.toHaveBeenCalled(); f.control.dispose();
});
it("a lost acknowledgement after a real commit is uncertain and never retried", async () => {
  const f = fixture(); f.host.prepare = vi.fn(async request => { const r = f.makeReview(request), apply = r.apply; r.apply = async runtime => { await apply(runtime); throw Error("ack lost"); }; return r; });
  await f.control.refresh(); await f.control.run("shot_match"); await f.control.apply(); expect(f.writes()).toBe(1); expect(f.control.state().status).toBe("uncertain");
  await f.control.run("shot_match"); await f.control.apply(); expect(f.writes()).toBe(1); f.control.dispose();
});
it("bounds a nonresponsive read, aborts it, and waits for closure before any replacement work", async () => {
  vi.useFakeTimers(); const f = fixture(), gate = deferred<ShotMatchFramesV1>(); let signal: AbortSignal | undefined;
  f.host.readFrames = vi.fn((_id, runtime) => { signal = runtime.signal; return gate.promise; });
  try {
    const pending = f.control.refresh(); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(20001);
    expect(signal?.aborted).toBe(true); expect(f.control.state().status).toBe("held"); expect(f.host.readFrames).toHaveBeenCalledTimes(1);
    gate.resolve(f.frames(f.clip.id)); await pending; expect(f.writes()).toBe(0);
  } finally { f.control.dispose(); vi.useRealTimers(); }
});
it("a throwing or missing host stays held without a render-feedback loop", async () => {
  const emit = vi.fn(), control = createShotMatchPanelInteractionV1(() => { throw Error("unavailable"); }, "對色", emit);
  await control.refresh(); await control.refresh(); expect(emit).toHaveBeenCalledTimes(1); expect(control.state()).toMatchObject({ status: "held", code: "unavailable" }); control.dispose();
});
it("clones display buffers and proposal data while retaining only backend Apply/Discard closures", async () => {
  const f = fixture(); await f.control.refresh(); await f.control.run("shot_match"); const shown = f.control.state().review!, original = f.reviews[0];
  expect(shown.before.frames[0].pixels).not.toBe(original.before.frames[0].pixels); expect(shown.proposal).not.toBe(original.proposal);
  original.before.frames[0].pixels[0] = 250; original.proposal.reason = "late external display mutation";
  expect(shown.before.frames[0].pixels[0]).toBe(100); expect(shown.proposal.reason).not.toBe(original.proposal.reason); f.control.cancel(); expect(original.discard).toHaveBeenCalledTimes(1); f.control.dispose();
});
it("refuses a JSON-only review with no backend action closures", async () => {
  const f = fixture(); f.host.prepare = vi.fn(async request => JSON.parse(JSON.stringify(f.makeReview(request))) as ShotMatchReviewV1);
  await f.control.refresh(); await f.control.run("shot_match"); expect(f.control.state()).toMatchObject({ status: "held", code: "stale" }); expect(f.writes()).toBe(0); f.control.dispose();
});
it("an invalid apply acknowledgement is uncertain and cannot enable another attempt", async () => {
  const f = fixture(); f.host.prepare = vi.fn(async request => { const r = f.makeReview(request); r.apply = vi.fn(async () => ({ status: "applied" as const, undoSteps: 0 as const, clipId: f.clip.id })); return r; });
  await f.control.refresh(); await f.control.run("shot_match"); await f.control.apply(); expect(f.control.state().status).toBe("uncertain");
  await f.control.run("shot_match"); await f.control.apply(); expect(f.reviews[0].apply).toHaveBeenCalledTimes(1); expect(f.writes()).toBe(0); f.control.dispose();
});
it("consumes action authority while retaining pure comparison frames throughout Apply", async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  f.host.prepare = vi.fn(async request => { const r = f.makeReview(request), apply = r.apply; r.apply = async runtime => { entered.resolve(); await release.promise; return apply(runtime); }; return r; });
  await f.control.refresh(); await f.control.run("shot_match"); const comparison = f.control.state().comparison;
  const pending = f.control.apply(); await entered.promise; expect(f.control.state().status).toBe("applying"); expect(f.control.state().review).toBeUndefined(); expect(f.control.state().comparison).toBe(comparison);
  expect(Object.keys(comparison!)).toEqual(["before", "after"]); release.resolve(); await pending; expect(f.writes()).toBe(1); expect(f.control.state().comparison).toBe(comparison); f.control.dispose();
});
