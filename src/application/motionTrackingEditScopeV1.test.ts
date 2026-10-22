import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { TrackingMode } from "../ui/editorShellTypes";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createMotionTrackingEditScopeV1, MOTION_TRACKING_EDIT_STALE_V1 } from "./motionTrackingEditScopeV1";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";

function fixture() {
  let project = createDemoProject();
  project = applyCommand(project, { type: "add_clip", clip: { ...structuredClone(project.tracks[0].clips[0]), id: "second", timelineStart: 12 } });
  project = applyCommand(project, { type: "add_motion_track", track: { id: "subject", clipId: "clip-demo", name: "Subject", engine: "source-fixture", analysisFps: 5,
    initialRect: { x: .2, y: .2, width: .2, height: .2 }, points: [], lostRatio: 0, createdAt: "2026-10-20T00:00:00.000Z", role: "host" } });
  const session = createProjectSession(project), timeline = createTimelineEditingState(session,
    { clipIds: ["clip-demo"], captionIds: [], primaryClipId: "clip-demo" }), messages: string[] = [];
  const scope = createMotionTrackingEditScopeV1({ session, getSelection: timeline.getSelection,
    subscribeSelection: timeline.subscribe, onStatus: message => messages.push(message) });
  let mode: TrackingMode | undefined, invalidations = 0;
  const onInvalidate = () => { invalidations += 1; scope.retire(mode); mode = undefined; };
  const attach = () => scope.attach(() => mode, onInvalidate);
  let detach = attach();
  const set = (next?: TrackingMode) => { scope.retire(mode); mode = next ? scope.captureMode(next) : undefined; return mode; };
  return { project, session, timeline, scope, messages, set, mode: () => mode, invalidations: () => invalidations,
    context: () => scope.read(mode), guard: () => scope.renderGuard(session.getSnapshot().history.present, timeline.getSelection().primaryClipId),
    close: () => detach(), attach, onInvalidate, reattach: () => { detach(); detach = attach(); } };
}

describe("tracking interaction belongs to a live clip, selection occurrence and project content owner", () => {
  it("binds ordinary new/correction modes to the real canonical selected video", () => {
    const f = fixture();
    for (const mode of [{ kind: "new" }, { kind: "correct", trackId: "subject" }] as const) {
      const bound = f.set(mode); assert(bound); assert(Object.isFrozen(bound)); assert.notEqual(bound, mode);
      assert.equal(f.context()!.clip.id, "clip-demo"); assert.equal(f.context()!.project, f.session.getSnapshot().history.present);
      assert.equal(f.guard()(mode.kind === "correct" ? "subject" : undefined), true);
    }
    f.close();
  });
  it("rejects foreign, serialized and retired modes instead of trusting their visible fields", () => {
    const f = fixture(), mode = f.set({ kind: "new" })!;
    assert.equal(f.scope.read({ kind: "new" }), undefined); assert.equal(f.scope.read(JSON.parse(JSON.stringify(mode))), undefined);
    f.scope.retire(mode); assert.equal(f.scope.read(mode), undefined); f.close();
  });
  it("rejects missing and wrong-clip correction track IDs", () => {
    const f = fixture();
    assert.equal(f.set({ kind: "correct" }), undefined); assert.equal(f.set({ kind: "correct", trackId: "missing" }), undefined);
    f.timeline.setSelectedClipId("second"); assert.equal(f.set({ kind: "correct", trackId: "subject" }), undefined);
    assert.equal(f.guard()("subject"), false); assert.equal(f.messages.at(-1), MOTION_TRACKING_EDIT_STALE_V1); f.close();
  });
  it("invalidates a drawing mode synchronously when the selection changes", () => {
    const f = fixture(); const mode = f.set({ kind: "new" })!; f.timeline.setSelectedClipId("second");
    assert.equal(f.mode(), undefined); assert.equal(f.scope.read(mode), undefined); assert.equal(f.invalidations(), 1); f.close();
  });
  it("does not revive an earlier mode or rendered callback after A-to-B-to-A", () => {
    const f = fixture(), guard = f.guard(), mode = f.set({ kind: "correct", trackId: "subject" })!;
    f.timeline.setSelectedClipId("second"); f.timeline.setSelectedClipId("clip-demo");
    assert.equal(guard("subject"), false); assert.equal(f.scope.read(mode), undefined); assert(f.set({ kind: "correct", trackId: "subject" })); f.close();
  });
  it("does not revive same-ID project controls after reopening", () => {
    const f = fixture(), guard = f.guard(), mode = f.set({ kind: "new" })!;
    f.session.replaceProject(structuredClone(f.project)); f.timeline.setSelectedClipId("clip-demo");
    assert.equal(f.scope.read(mode), undefined); assert.equal(guard(), false); assert.equal(f.guard()(), true); f.close();
  });
  it("invalidates source edits through the canonical content owner even if IDs stay identical", () => {
    const f = fixture(), mode = f.set({ kind: "new" })!, guard = f.guard();
    f.session.setHistory(state => ({ ...state, present: applyCommand(state.present, { type: "set_clip_volume", clipId: "clip-demo", volume: .5 }) }));
    assert.equal(f.mode(), undefined); assert.equal(f.scope.read(mode), undefined); assert.equal(guard(), false); f.close();
  });
  it("does not cancel a current mode for save bookkeeping or unrelated selection clipboard metadata", () => {
    const f = fixture(), mode = f.set({ kind: "new" })!, selection = f.timeline.getSelection();
    const save = f.session.beginSave(); assert(save); f.session.finishSave(save);
    f.timeline.setMarkRange({ in: 1, out: 2 });
    assert.equal(f.timeline.getSelection(), selection); assert.equal(f.mode(), mode); assert(f.scope.read(mode)); f.close();
  });
  it("rejects modes and rendered actions on a locked source video", () => {
    const f = fixture(); f.session.setHistory(state => ({ ...state, present: applyCommand(state.present, { type: "toggle_track_lock", trackId: "video-main" }) }));
    assert.equal(f.set({ kind: "new" }), undefined); assert.equal(f.guard()(), false); assert.equal(f.messages.at(-1), TRACK_LOCKED_MESSAGE); f.close();
  });
  it("keeps no-selection actions unavailable instead of using another active clip", () => {
    const f = fixture(); f.timeline.setSelectedClipId(undefined);
    assert.equal(f.set({ kind: "new" }), undefined); assert.equal(f.guard()(), false); assert.equal(f.scope.read(), undefined); f.close();
  });
  it("does not let a stale rendered project capture current content authority", () => {
    const f = fixture(); f.session.setHistory(state => ({ ...state, present: applyCommand(state.present, { type: "set_clip_volume", clipId: "clip-demo", volume: .5 }) }));
    assert.equal(f.scope.renderGuard(f.project, "clip-demo")(), false); assert.equal(f.guard()(), true); f.close();
  });
  it("canonicalizes the Podcast host from the committed graph, not caller-supplied points", () => {
    const f = fixture(), host = f.project.motionTracks[0];
    const supplied = { ...host, name: "Wrong copied host" }, mode = f.set({ kind: "podcast", role: "guest", hostTrack: supplied });
    assert(mode?.kind === "podcast"); assert.equal(mode.hostTrack, f.session.getSnapshot().history.present.motionTracks[0]);
    assert.equal(mode.hostTrack.name, "Subject"); assert.equal(supplied.name, "Wrong copied host"); f.close();
  });
  it("refuses Podcast guest modes with a missing or foreign host", () => {
    const f = fixture(); assert.equal(f.set({ kind: "podcast", role: "guest" }), undefined);
    assert.equal(f.set({ kind: "podcast", role: "guest", hostTrack: { ...f.project.motionTracks[0], id: "missing" } }), undefined);
    f.timeline.setSelectedClipId("second"); assert.equal(f.set({ kind: "podcast", role: "guest", hostTrack: f.project.motionTracks[0] }), undefined); f.close();
  });
  it("retires a mode on detach and never revives it after reattach", () => {
    const f = fixture(), mode = f.set({ kind: "new" })!; f.reattach();
    assert.equal(f.scope.read(mode), undefined); assert.equal(f.mode(), undefined); assert(f.set({ kind: "new" })); f.close();
  });
  it("reattaching without an old cleanup retires the previous attachment's mode", () => {
    const f = fixture(), mode = f.set({ kind: "new" })!, currentDetach = f.attach();
    assert.equal(f.scope.read(mode), undefined); assert.equal(f.mode(), undefined);
    assert(f.set({ kind: "new" })); currentDetach(); f.close();
  });
  it("an old cleanup does not disable or clear a newer attachment", () => {
    const f = fixture(), currentDetach = f.attach(); f.close();
    const mode = f.set({ kind: "new" }); assert(mode); assert(f.scope.read(mode)); currentDetach(); assert.equal(f.scope.read(mode), undefined);
  });
  it("creating rendered guards does not mutate the project, selection or history", () => {
    const f = fixture(), project = JSON.stringify(f.project), snapshot = f.session.getSnapshot(), selection = f.timeline.getSelection();
    for (let index = 0; index < 20; index += 1) assert(f.guard()());
    assert.equal(f.session.getSnapshot(), snapshot); assert.equal(f.timeline.getSelection(), selection); assert.equal(JSON.stringify(f.project), project); f.close();
  });
});
