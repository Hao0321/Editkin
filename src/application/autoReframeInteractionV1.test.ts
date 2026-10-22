import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../shared/canonicalJson";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { createAutoReframeInteractionV1, type AutoReframeContextV1 } from "./autoReframeInteractionV1";
import { autoReframeTargetV1, type AutoReframeReplyV1, type AutoReframeRequestV1 } from "./autoReframeEditV1";
import { createAutoReframeSparseV2 } from "./autoReframeSparseV2";
import { autoReframeWorkflowFixtureV1, instrumentOnlyWorkflowReplyV1, workflowIdentityV1 } from "./__fixtures__/autoReframeWorkflowV1.fixture";
function fixture(portrait = true) {
  const project = autoReframeWorkflowFixtureV1(portrait), session = createProjectSession(project, "original.editkin.json");
  let context: AutoReframeContextV1 = { project, projectSession: session, clipId: "selected", subject: { kind: "saliency" }, outputWidth: 90, outputHeight: 160, hostReady: true, currentProjectHostReady: true, newProjectHostReady: true };
  const reply = (request: AutoReframeRequestV1) => { const target = autoReframeTargetV1(context.project, request).project;
    const sink = createAutoReframeSparseV2(target, { clipId: request.clipId, outputWidth: request.outputWidth, outputHeight: request.outputHeight, expectedSourceSha256: request.expectedSourceSha256 }); sink.initialize(64, 40);
    for (let frame = 0; frame < 5; frame++) sink.consume({ frame, time: frame / 4, sceneCut: frame === 0, pixelSha256: "c".repeat(64) });
    return instrumentOnlyWorkflowReplyV1(request, sink.finish()); };
  const analyze = vi.fn(async (_project, request, _runtime) => reply(request)), onError = vi.fn(), onState = vi.fn();
  const apply = vi.fn(async (application: Parameters<Parameters<typeof createAutoReframeInteractionV1>[0]["apply"]>[0]) => {
    if (application.kind === "command") { session.setHistory(h => dispatchCommand(h, application.command)); context = { ...context, project: session.getSnapshot().history.present }; return { status: "applied" as const }; }
    return { status: "created" as const };
  });
  const options = { read: () => context, analyze, apply, makeIdentity: workflowIdentityV1, onState, onError };
  return { project, session, reply, options, analyze, apply, onError, onState, read: () => context, change: (value: Partial<AutoReframeContextV1>) => { context = { ...context, ...value }; } };
}
describe("async analysis and explicit apply with editor-session ownership", () => {
  it("analysis never edits and explicit apply is exactly one Undo even after its own content-owner change", async () => {
    const f = fixture(), before = canonicalJson(f.project), d = createAutoReframeInteractionV1(f.options);
    const unsubscribe = f.session.subscribe(() => d.invalidate()); expect(await d.start("current_portrait")).toBe(true);
    expect(d.getState().status).toBe("ready"); expect(canonicalJson(f.project)).toBe(before); expect(f.apply).not.toHaveBeenCalled();
    expect(await d.apply()).toBe(true); expect(d.getState().status).toBe("done"); expect(f.session.getSnapshot().history.past).toHaveLength(1);
    expect(undo(f.session.getSnapshot().history).present).toEqual(f.project); expect(f.onError).not.toHaveBeenCalled(); expect(await d.apply()).toBe(false); unsubscribe();
  });
  it("creates a separate document without replacing or cleaning the dirty original", async () => {
    const f = fixture(false); f.session.setHistory(h => dispatchCommand(h, { type: "rename_project", name: "Dirty original" })); f.change({ project: f.session.getSnapshot().history.present });
    const before = f.session.getSnapshot(), original = canonicalJson(before.history.present); let separate: ReturnType<typeof createHistory> | undefined;
    f.apply.mockImplementationOnce(async a => { if (a.kind !== "new_project") throw Error("wrong mode"); separate = dispatchCommand(createHistory(a.baseProject), a.command); return { status: "created" }; });
    const d = createAutoReframeInteractionV1(f.options); expect(await d.start("new_portrait_project")).toBe(true); expect(await d.apply()).toBe(true);
    expect(f.session.getSnapshot()).toBe(before); expect(f.session.getSnapshot().dirty).toBe(true); expect(canonicalJson(before.history.present)).toBe(original);
    expect(separate!.present.id).toBe("separate-portrait"); expect(separate!.past).toHaveLength(1); expect(undo(separate!).present.tracks[0].clips[0].keyframes).toHaveLength(0);
  });
  it("a host file-dialog cancellation leaves the unchanged draft ready for an explicit second apply", async () => {
    const f = fixture(false), apply = vi.fn().mockResolvedValueOnce({ status: "cancelled" }).mockResolvedValueOnce({ status: "created" });
    const d = createAutoReframeInteractionV1({ ...f.options, apply }); await d.start("new_portrait_project"); expect(await d.apply()).toBe(false); expect(d.getState().status).toBe("ready");
    expect(await d.apply()).toBe(true); expect(apply).toHaveBeenCalledTimes(2); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["selection", "subject", "size", "source-content", "new-session", "host-unavailable"])("drops a late reply after %s changes", async reason => {
    const f = fixture(), gate = Promise.withResolvers<AutoReframeReplyV1>(); let started!: () => void; const entered = new Promise<void>(r => { started = r; }); let reply!: AutoReframeReplyV1;
    f.analyze.mockImplementationOnce(async (_p, request, runtime) => { reply = f.reply(request); started(); const r = await gate.promise; expect(runtime.signal.aborted).toBe(true); return r; });
    const d = createAutoReframeInteractionV1(f.options), pending = d.start("current_portrait"); await entered;
    if (reason === "selection") f.change({ clipId: "outside" }); if (reason === "subject") f.change({ subject: { kind: "confirmed-matte-v2", confirmationSha256: "b".repeat(64) } });
    if (reason === "size") f.change({ outputWidth: 180, outputHeight: 320 }); if (reason === "host-unavailable") f.change({ hostReady: false });
    if (reason === "source-content") f.project.captions[0].text = "same revision but changed"; if (reason === "new-session") f.session.replaceProject(structuredClone(f.project));
    d.invalidate(); gate.resolve(reply); expect(await pending).toBe(false); expect(d.getState().status).toBe("idle"); expect(f.apply).not.toHaveBeenCalled();
  });
  it("cancelled analysis ignores late success, prevents double start, and can start a new operation", async () => {
    const f = fixture(), gate = Promise.withResolvers<AutoReframeReplyV1>(); let started!: () => void, reply!: AutoReframeReplyV1;
    const entered = new Promise<void>(r => { started = r; }); f.analyze.mockImplementationOnce(async (_p, request) => { reply = f.reply(request); started(); return gate.promise; });
    const d = createAutoReframeInteractionV1(f.options), p = d.start("current_portrait"); await entered; expect(await d.start("current_portrait")).toBe(false); d.cancel(); gate.resolve(reply);
    expect(await p).toBe(false); expect(d.getState().status).toBe("idle"); expect(await d.start("current_portrait")).toBe(true);
  });
  it("accepts only bounded monotonic progress while ignoring malformed or older updates", async () => {
    const f = fixture(); f.analyze.mockImplementationOnce(async (_p, request, runtime) => {
      for (const p of [{ stage: "verify", completed: 1, total: 1 }, { stage: "source", completed: 2, total: 5 }, { stage: "source", completed: 1, total: 5 },
        { stage: "source", completed: 3, total: 6 }, { stage: "matte", completed: 1, total: 5 }, { stage: "source", completed: 6, total: 5 }, { stage: "source", completed: 5, total: 5 }]) runtime.onProgress(p);
      return f.reply(request);
    });
    const d = createAutoReframeInteractionV1(f.options); expect(await d.start("current_portrait")).toBe(true);
    const reported = f.onState.mock.calls.map(([s]) => s.progress).filter(Boolean); expect(reported).toEqual([{ stage: "verify", completed: 1, total: 1 }, { stage: "source", completed: 2, total: 5 }, { stage: "source", completed: 5, total: 5 }]);
  });
  it("never replays an uncertain host write and ignores cancel while the host is committing", async () => {
    const f = fixture(), gate = Promise.withResolvers<{ status: "applied" }>(), apply = vi.fn(() => gate.promise), d = createAutoReframeInteractionV1({ ...f.options, apply });
    await d.start("current_portrait"); const pending = d.apply(); d.cancel(); expect(d.getState().status).toBe("applying"); expect(await d.apply()).toBe(false);
    gate.reject(Error("host-write-uncertain")); expect(await pending).toBe(false); expect(d.getState().status).toBe("failed"); expect(await d.apply()).toBe(false); expect(apply).toHaveBeenCalledOnce();
  });
  it("ignores a late progress event after the completed plan is ready for confirmation", async () => {
    const f = fixture(); let late!: () => void;
    f.analyze.mockImplementationOnce(async (_p, request, runtime) => { late = () => runtime.onProgress({ stage: "source", completed: 5, total: 5 }); return f.reply(request); });
    const d = createAutoReframeInteractionV1(f.options); expect(await d.start("current_portrait")).toBe(true);
    const plan = d.getState().plan; late(); expect(d.getState().status).toBe("ready"); expect(d.getState().plan).toBe(plan);
  });
  it("does not turn a successful commit into failure when a presentation callback throws", async () => {
    const f = fixture(), d = createAutoReframeInteractionV1({ ...f.options, onState: () => { throw Error("presentation"); } });
    expect(await d.start("current_portrait")).toBe(true); expect(await d.apply()).toBe(true); expect(f.onError).not.toHaveBeenCalled();
  });
  it("reports locked/unavailable preflight without invoking a backend and drops disposed results", async () => {
    const f = fixture(); f.project.tracks[0].locked = true; const d = createAutoReframeInteractionV1(f.options);
    expect(await d.start("current_portrait")).toBe(false); expect(f.analyze).not.toHaveBeenCalled(); expect(d.getState().status).toBe("failed");
    f.project.tracks[0].locked = false; f.change({ hostReady: false }); expect(await d.start("current_portrait")).toBe(false); expect(f.analyze).not.toHaveBeenCalled();
    d.dispose(); expect(await d.start("current_portrait")).toBe(false); d.resume(); f.change({ hostReady: true }); expect(await d.start("current_portrait")).toBe(true);
  });
});
