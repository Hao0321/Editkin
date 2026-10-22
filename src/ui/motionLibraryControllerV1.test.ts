import { describe, expect, it, vi } from "vitest";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommandSafely, undo, type EditorHistory } from "../domain/history";
import { motionLibraryFixtureProject, plainClip } from "../domain/motionLibraryV1.fixture";
import { applyCommand } from "../domain/commands";
import type { EditProject, TimelineClip } from "../domain/types";
import { createMotionLibraryControllerV1 } from "./motionLibraryControllerV1";
import { MOTION_LIBRARY_CANCELLED_V1, MOTION_LIBRARY_NATIVE_REQUIRED_V1, type MotionLibraryRenderHostV1 } from "./motionLibraryRenderHostV1";
import { createSimulatedMotionLibraryRenderHostV1 } from "./motionLibrarySimulatedHostV1";
import { createMotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";

function harness(options: { project?: EditProject; host?: MotionLibraryRenderHostV1 | null } = {}) {
  let history: EditorHistory = createHistory(options.project ?? motionLibraryFixtureProject());
  const statuses: string[] = [], store = createMotionLibraryUiStoreV1();
  const state = { selected: undefined as string | undefined, playhead: 0, session: 1, urls: {} as Record<string, string>, revealed: 0 };
  let ids = 0;
  const host = options.host === null ? undefined : options.host ?? createSimulatedMotionLibraryRenderHostV1({ wait: async () => undefined });
  const controller = createMotionLibraryControllerV1({
    getProject: () => history.present,
    runCommand: (command, message) => {
      const result = dispatchCommandSafely(history, command, `cmd-${++ids}`);
      history = result.state; statuses.push(result.error ?? message ?? "");
      return !result.error;
    },
    setStatus: message => statuses.push(message), getPlayhead: () => state.playhead, getSelectedClipId: () => state.selected,
    selectClip: clipId => { state.selected = clipId; }, clearClipSelection: () => { state.selected = undefined; }, revealSelection: () => { state.revealed += 1; },
    mergeRuntimeUrls: urls => { state.urls = { ...state.urls, ...urls }; },
    store, host: () => host, makeId: prefix => `${prefix}-${++ids}`, sessionToken: () => state.session,
  });
  return { controller, store, state, statuses, get history() { return history; }, set history(next: EditorHistory) { history = next; } };
}
const clips = (project: EditProject) => project.tracks.flatMap(track => track.clips);
const motionClips = (project: EditProject) => clips(project).filter(clip => clip.motionLibrary);
const cutRef = { trackId: "video-main", fromClipId: "a", toClipId: "b" };

describe("Motion Library GUI actions: render before dispatch, one Undo each", () => {
  it("keyboard add (Enter / double-click): at the playhead on the selected track, moved to a free layer when that span is taken", async () => {
    const h = harness();
    h.state.playhead = 1; h.state.selected = "a";
    expect(await h.controller.addItem("T01")).toBe(true);
    const [clip] = motionClips(h.history.present);
    // a covers 0–3 s on video-main, so the text lands on the free overlay track above it, at frame 30.
    expect(clip).toMatchObject({ trackId: "overlay", timelineStart: 1, sourceStart: 0, duration: 3 });
    expect(clip.motionLibrary).toMatchObject({ itemId: "T01", kind: "text" });
    expect(h.state.selected).toBe(clip.id);
    expect(h.history.past).toHaveLength(1);
    expect(() => validateProject(h.history.present)).not.toThrow();
    expect(motionClips(undo(h.history).present)).toEqual([]);
  });

  it("drag add: at the drop frame on the drop track; a taken span gets a new layer inside the same command", async () => {
    const h = harness();
    expect(await h.controller.addItem("B02", { trackId: "overlay", startFrame: 45, strictTrack: true })).toBe(true);
    const background = motionClips(h.history.present)[0];
    expect(background).toMatchObject({ trackId: "overlay", timelineStart: 1.5 });
    expect(background.motionLibrary?.kind).toBe("background");
    expect(await h.controller.addItem("T41", { trackId: "video-main", startFrame: 30, strictTrack: true })).toBe(true);
    const text = motionClips(h.history.present).find(clip => clip.motionLibrary?.itemId === "T41")!;
    const track = h.history.present.tracks.find(candidate => candidate.id === text.trackId)!;
    expect(track.name).toBe("動態文字 1");
    expect(h.history.past).toHaveLength(2);
    // One Undo removes the clip and its new layer together.
    const undone = undo(h.history).present;
    expect(undone.tracks.some(candidate => candidate.id === track.id)).toBe(false);
    expect(motionClips(undone)).toHaveLength(1);
  });

  it("refuses a drop on a locked or non-picture track before rendering", async () => {
    const project = applyCommand(motionLibraryFixtureProject(), { type: "toggle_track_lock", trackId: "overlay" });
    const host = createSimulatedMotionLibraryRenderHostV1({ wait: async () => undefined });
    const h = harness({ project, host });
    expect(await h.controller.addItem("T01", { trackId: "overlay", startFrame: 0, strictTrack: true })).toBe(false);
    expect(host.calls).toBe(0);
    expect(h.statuses.at(-1)).toContain("鎖定");
  });

  it("inspector edit: re-renders and swaps the clip as one Undo; an unchanged duration keeps the trim", async () => {
    const h = harness();
    await h.controller.addItem("T01", { trackId: "overlay", startFrame: 0 });
    const before = motionClips(h.history.present)[0] as TimelineClip;
    const trim = dispatchCommandSafely(h.history, { type: "trim_clip_end", clipId: before.id, seconds: 1 }, "trim");
    expect(trim.error).toBeUndefined();
    h.history = trim.state;
    const trimmed = motionClips(h.history.present)[0];
    const pastBefore = h.history.past.length;
    expect(await h.controller.updateClipParams(trimmed.id, { ...trimmed.motionLibrary!.params, lines: ["新字"] })).toBe(true);
    const after = motionClips(h.history.present)[0];
    expect(after.motionLibrary?.params.lines).toEqual(["新字"]);
    expect(after.assetId).not.toBe(trimmed.assetId);
    expect(trimmed.duration).toBe(2);
    expect(after.duration).toBe(trimmed.duration);
    expect(h.history.past).toHaveLength(pastBefore + 1);
    expect(motionClips(undo(h.history).present)[0].motionLibrary?.params.lines).toEqual(trimmed.motionLibrary!.params.lines);
    // A new duration refits the clip to the new render.
    expect(await h.controller.updateClipParams(after.id, { ...after.motionLibrary!.params, durationSeconds: 1 })).toBe(true);
    expect(motionClips(h.history.present)[0].duration).toBe(1);
  });

  it("Ctrl+T applies the last transition (dissolve by default) to the cut nearest the playhead, then a remembered matte; Delete removes the selection", async () => {
    const h = harness();
    h.state.playhead = 2.9;
    h.controller.keyboard.applyLastTransition();
    await vi.waitFor(() => expect(h.history.present.timelineTransitions).toHaveLength(1));
    const dissolve = h.history.present.timelineTransitions![0];
    expect(dissolve).toMatchObject({ ...cutRef, kernel: "dissolve", beforeFrames: 7, afterFrames: 8 });
    expect(h.store.getSnapshot().selectedTransitionId).toBe(dissolve.id);
    expect(h.history.past).toHaveLength(1);

    h.store.rememberTransition({ kind: "matte", itemId: "X01" });
    expect(await h.controller.applyTransitionNearPlayhead(h.store.getSnapshot().lastTransition)).toBe(true);
    const matte = h.history.present.timelineTransitions![0];
    // The same cut keeps its transition id and its window; the matte and overlay assets come in the same command.
    expect(matte).toMatchObject({ id: dissolve.id, kernel: "matte", beforeFrames: 7, afterFrames: 8, motionLibrary: { itemId: "X01" } });
    expect(h.history.present.assets.some(asset => asset.id === matte.motionLibrary!.matteAssetId)).toBe(true);
    expect(h.history.past).toHaveLength(2);
    expect(() => validateProject(h.history.present)).not.toThrow();
    expect(undo(h.history).present.timelineTransitions![0].kernel).toBe("dissolve");

    expect(h.controller.keyboard.deleteSelectedTransition()).toBe(true);
    expect(h.history.present.timelineTransitions).toEqual([]);
    expect(h.history.past).toHaveLength(3);
    expect(h.controller.keyboard.deleteSelectedTransition()).toBe(false);
  });

  it("cut-point menu: 溶接 / 黑場 at 0.5 s, resizing the window, and 移除, one Undo each", async () => {
    const h = harness();
    expect(await h.controller.applyTransition({ kind: "dip" }, cutRef, { frames: 15 })).toBe(true);
    const id = h.history.present.timelineTransitions![0].id;
    expect(h.history.present.timelineTransitions![0].kernel).toBe("dip");
    expect(await h.controller.resizeTransition(id, { before: 10, after: 12 })).toBe(true);
    expect(h.history.present.timelineTransitions![0]).toMatchObject({ beforeFrames: 10, afterFrames: 12 });
    expect(h.controller.removeTransition(id)).toBe(true);
    expect(h.history.present.timelineTransitions).toEqual([]);
    expect(h.history.past).toHaveLength(3);
  });

  it("a matte transition dropped on a cut renders at the window length; resizing re-renders it", async () => {
    const h = harness();
    expect(await h.controller.applyTransition({ kind: "matte", itemId: "X09" }, cutRef)).toBe(true);
    const transition = h.history.present.timelineTransitions![0];
    expect(transition.beforeFrames + transition.afterFrames).toBe(15);
    expect(Number(transition.motionLibrary!.params.durationSeconds)).toBeCloseTo(0.5);
    expect(await h.controller.resizeTransition(transition.id, { before: 10, after: 10 })).toBe(true);
    const resized = h.history.present.timelineTransitions![0];
    expect(resized.motionLibrary!.cacheKey).not.toBe(transition.motionLibrary!.cacheKey);
    expect(Number(resized.motionLibrary!.params.durationSeconds)).toBeCloseTo(20 / 30);
    expect(h.history.past).toHaveLength(2);
    expect(() => validateProject(h.history.present)).not.toThrow();
  });

  it("cancel: nothing is dispatched and the status says the timeline is unchanged", async () => {
    let release!: () => void;
    const host = createSimulatedMotionLibraryRenderHostV1({ wait: (_ms, signal) => new Promise<void>((resolve, reject) => {
      release = resolve; signal.addEventListener("abort", () => reject(new Error(MOTION_LIBRARY_CANCELLED_V1)), { once: true });
    }) });
    const h = harness({ host });
    const pending = h.controller.addItem("T05", { trackId: "overlay", startFrame: 0 });
    await vi.waitFor(() => expect(h.store.getSnapshot().jobs).toHaveLength(1));
    expect(h.store.getSnapshot().jobs[0]).toMatchObject({ itemId: "T05", target: { kind: "card", itemId: "T05" } });
    h.store.getSnapshot().jobs[0].cancel();
    expect(await pending).toBe(false);
    void release;
    expect(h.history.past).toHaveLength(0);
    expect(h.store.getSnapshot().jobs).toEqual([]);
    expect(h.statuses.at(-1)).toContain("已取消");
  });

  it("a render that outlives its project is dropped", async () => {
    let release!: () => void;
    const host = createSimulatedMotionLibraryRenderHostV1({ wait: () => new Promise<void>(resolve => { release = resolve; }) });
    const h = harness({ host });
    const pending = h.controller.addItem("T01", { trackId: "overlay", startFrame: 0 });
    await vi.waitFor(() => expect(h.store.getSnapshot().jobs).toHaveLength(1));
    h.state.session = 2;
    for (let step = 0; step < 8; step += 1) { release(); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(await pending).toBe(false);
    expect(h.history.past).toHaveLength(0);
  });

  it("a browser (no native host) says plainly that adding needs the desktop app; 溶接 still works", async () => {
    const h = harness({ host: null });
    expect(await h.controller.addItem("T01")).toBe(false);
    expect(h.statuses.at(-1)).toBe(MOTION_LIBRARY_NATIVE_REQUIRED_V1);
    expect(await h.controller.applyTransition({ kind: "dissolve" }, cutRef)).toBe(true);
  });

  it("save and reopen keep every Motion Library field and the project validates", async () => {
    const h = harness();
    await h.controller.addItem("T27", { trackId: "overlay", startFrame: 0 });
    await h.controller.addItem("B09", { trackId: "overlay", startFrame: 120 });
    await h.controller.applyTransition({ kind: "matte", itemId: "X17" }, cutRef);
    const reopened = decodeProjectBytes(encodeProjectBytes(h.history.present));
    expect(motionClips(reopened).map(clip => clip.motionLibrary)).toEqual(motionClips(h.history.present).map(clip => clip.motionLibrary));
    expect(reopened.timelineTransitions).toEqual(h.history.present.timelineTransitions);
    expect(() => validateProject(reopened)).not.toThrow();
  });

  it("refuses a transition at a cut without handles, without rendering", async () => {
    let project = motionLibraryFixtureProject();
    project = applyCommand(project, { type: "add_clip", clip: plainClip("x", "footage", "overlay", 0, 0, 2) });
    project = applyCommand(project, { type: "add_clip", clip: plainClip("y", "footage", "overlay", 2, 8, 2) });
    const host = createSimulatedMotionLibraryRenderHostV1({ wait: async () => undefined });
    const h = harness({ project, host });
    // x ends at source 2 s (8 s of footage left after it) and y starts at source 8 s (8 s before it): the window fits.
    expect(await h.controller.applyTransition({ kind: "matte", itemId: "X01" }, { trackId: "overlay", fromClipId: "x", toClipId: "y" })).toBe(true);
    let tight = motionLibraryFixtureProject();
    tight = applyCommand(tight, { type: "add_clip", clip: plainClip("x", "footage", "overlay", 0, 8, 2) });
    tight = applyCommand(tight, { type: "add_clip", clip: plainClip("y", "footage", "overlay", 2, 0, 2) });
    const t = harness({ project: tight, host });
    const calls = host.calls;
    expect(await t.controller.applyTransition({ kind: "matte", itemId: "X01" }, { trackId: "overlay", fromClipId: "x", toClipId: "y" })).toBe(false);
    expect(host.calls).toBe(calls);
    expect(t.statuses.at(-1)).toContain("太短");
  });
});
