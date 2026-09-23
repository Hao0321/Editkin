import { describe, expect, it, vi } from "vitest";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, undo } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "./types";
import { useAutomaticEditing } from "./useAutomaticEditing";
import { useAutomaticCaptions } from "./useAutomaticCaptions";
import { useSemanticAutoEdit } from "./useSemanticAutoEdit";
import { useSmartCut } from "./useSmartCut";
import { useSceneDetection } from "./useSceneDetection";

// Actual hook bodies and real session/commands, but deliberately not a React renderer
// or browser claim. One hook invocation preserves the real closure across deferred I/O.
vi.mock("react", () => ({
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
}));
type Kind = "captions" | "semantic" | "smartCut" | "scenes";
const kinds: Kind[] = ["captions", "semantic", "smartCut", "scenes"];
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(kind: Kind, music = false) {
  const project = applyCommand(createDemoProject(), {
    type: "add_caption", caption: { id: "existing", text: "Original caption", start: 0, duration: 3 },
  });
  const projectSession = createProjectSession(project, "D:/fixture-only/project.editkin.json");
  const primary = deferred();
  const musicAsset = { id: "music-fixture", name: "Music", kind: "audio", uri: "creative://fixture", duration: 124.76 };
  const results = {
    automaticCaptionMedia: { cues: [{ start: 0, end: 3, text: "New transcript" }, { start: 6, end: 9, text: "Another point" }], engine: "fixture", modelId: "fixture", modelSha256: "a".repeat(64), language: "zh", analyzedSeconds: 12, elapsedMs: 1, acceleration: "cpu", modelDownloaded: false, cacheHit: false },
    detectScenes: { cuts: [{ time: 5, score: 1, frame: 150 }], engine: "ffmpeg-scdet-8", threshold: 10, minSceneDuration: 1, analyzedSeconds: 12, elapsedMs: 1, cacheHit: false },
    smartCutMedia: { ranges: [{ startFrame: 0, endFrame: 150 }, { startFrame: 210, endFrame: 360 }], fps: 30, sourceFrames: 360, removedFrames: 60, cutCount: 1, silenceCount: 1, thresholdDb: -30, analyzedSeconds: 12, engine: "fixture", cacheHit: false },
    listCreativeLibrary: { assets: music ? [{ id: "music:fixture", name: "Fixture", mediaKind: "audio", role: "background-music", category: "music", domains: [], duration: 124.76, bpm: 88, bytes: 1, license: "CC0-1.0", provenance: "test", redistributable: true }] : [] },
    importCreativeAsset: { asset: musicAsset, previewUrl: "preview://fixture" },
    prepareMedia: { assetId: musicAsset.id, runtimeUrls: { [musicAsset.id]: "proxy://fixture" }, cacheHit: false },
    analyzeMotionTrack: { engine: "fixture", analysisFps: 1, width: 960, height: 540, points: [], lostRatio: 1, analyzedSeconds: 12, elapsedMs: 1, cacheHit: false },
  };
  const api = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, vi.fn(async (): Promise<unknown> => result)])) as Record<keyof typeof results, ReturnType<typeof vi.fn<() => Promise<unknown>>>>;
  const primaryName: "smartCutMedia" | "detectScenes" | "automaticCaptionMedia" = kind === "smartCut" ? "smartCutMedia" : kind === "scenes" ? "detectScenes" : "automaticCaptionMedia";
  api[primaryName].mockImplementation(() => primary.promise);
  const onStatus = vi.fn();
  const onRuntimeUrls = vi.fn();
  const onCommand = vi.fn((command: EditorCommand) => {
    projectSession.setHistory(current => dispatchCommand(current, command));
  });
  const options = { api: api as unknown as HaoDesktopApi, project, projectSession, selectedClip: project.tracks[0].clips[0], onCommand, onStatus, onRuntimeUrls };
  const hook = ({ captions: useAutomaticCaptions, semantic: useSemanticAutoEdit, smartCut: useSmartCut, scenes: useSceneDetection }[kind])(options);
  return { project, projectSession, api, results, primary, primaryName, hook, options, onStatus, onRuntimeUrls, onCommand,
    release: () => primary.resolve(results[primaryName]),
  };
}
function edit(f: ReturnType<typeof fixture>) {
  f.projectSession.setHistory(current => dispatchCommand(current, { type: "update_caption", captionId: "existing", patch: { text: "KEEP NEW EDIT" } }));
}
function replace(f: ReturnType<typeof fixture>) {
  const replacement = structuredClone(f.project);
  replacement.captions[0].text = "KEEP NEW SESSION";
  f.projectSession.replaceProject(replacement, "D:/fixture-only/project.editkin.json");
}
function acknowledgeSave(f: ReturnType<typeof fixture>) {
  const request = f.projectSession.beginSave()!;
  const saved = { path: request.projectPath, project: { ...request.project, revision: request.project.revision + 1 } };
  expect(f.projectSession.completeSave(request, saved)).toBe(true);
  f.projectSession.finishSave(request);
}

describe.each(kinds)("%s actual hook + controlled deferred API", kind => {
  it("commits exactly once as one undoable history entry", async () => {
    const f = fixture(kind);
    const work = f.hook.run();
    f.release();
    await work;
    expect(f.onCommand).toHaveBeenCalledTimes(1);
    expect(f.projectSession.getSnapshot().history.past).toHaveLength(1);
    f.projectSession.setHistory(undo);
    expect(f.projectSession.getSnapshot().history.present).toEqual(f.project);
  });

  it("preserves edits made while the analysis is pending", async () => {
    const f = fixture(kind);
    const work = f.hook.run();
    edit(f);
    const before = f.projectSession.getSnapshot().history;
    f.release();
    await work;
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onRuntimeUrls).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history).toBe(before);
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("重新執行"));
  });

  it("rejects results from the previous session even when every project/clip/caption ID matches", async () => {
    const f = fixture(kind);
    const work = f.hook.run();
    replace(f);
    const before = f.projectSession.getSnapshot().history;
    f.onStatus.mockClear();
    f.release();
    await work;
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onRuntimeUrls).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history).toBe(before);
    expect(f.onStatus).not.toHaveBeenCalled();
  });

  it("coalesces synchronous duplicate invocations before React can rerender", async () => {
    const f = fixture(kind);
    const first = f.hook.run();
    const second = f.hook.run();
    expect(f.api[f.primaryName]).toHaveBeenCalledTimes(1);
    f.release();
    await Promise.all([first, second]);
    expect(f.onCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight analysis valid through metadata-only save acknowledgement", async () => {
    const f = fixture(kind);
    const work = f.hook.run();
    acknowledgeSave(f);
    f.release();
    await work;
    expect(f.onCommand).toHaveBeenCalledTimes(1);
    expect(f.projectSession.getSnapshot().history.present.revision).toBe(1);
    expect(f.projectSession.getSnapshot().dirty).toBe(true);
  });

  it("does not start from an already stale render snapshot", async () => {
    const f = fixture(kind);
    edit(f);
    await f.hook.run();
    expect(f.api[f.primaryName]).not.toHaveBeenCalled();
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("重新執行"));
  });

  it("reports a current error and releases the synchronous gate for retry", async () => {
    const f = fixture(kind);
    const first = f.hook.run();
    f.primary.reject(new Error("controlled analysis failed"));
    await first;
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("controlled analysis failed"));
    f.api[f.primaryName].mockResolvedValue(f.results[f.primaryName]);
    await f.hook.run();
    expect(f.api[f.primaryName]).toHaveBeenCalledTimes(2);
    expect(f.onCommand).toHaveBeenCalledTimes(1);
  });

  it("does not publish an old-session error into a replacement project", async () => {
    const f = fixture(kind);
    const work = f.hook.run();
    replace(f);
    f.onStatus.mockClear();
    f.primary.reject(new Error("old session failure"));
    await work;
    expect(f.onStatus).not.toHaveBeenCalled();
    expect(f.onCommand).not.toHaveBeenCalled();
  });
});

describe("semantic work staged through every asynchronous media boundary", () => {
  it.each(["listCreativeLibrary", "importCreativeAsset", "prepareMedia"] as const)("rejects a content change while %s is pending without leaking staged URLs", async stage => {
    const f = fixture("semantic", true);
    const started = deferred<void>();
    const gate = deferred();
    f.api[stage].mockImplementation(() => { started.resolve(); return gate.promise; });
    const work = f.hook.run();
    f.release();
    await started.promise;
    expect(f.onRuntimeUrls).not.toHaveBeenCalled();
    edit(f);
    gate.resolve(f.results[stage]);
    await work;
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onRuntimeUrls).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history.present.captions[0].text).toBe("KEEP NEW EDIT");
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("重新執行"));
    const laterStages = { listCreativeLibrary: ["importCreativeAsset", "prepareMedia", "analyzeMotionTrack"], importCreativeAsset: ["prepareMedia", "analyzeMotionTrack"], prepareMedia: ["analyzeMotionTrack"] } as const;
    for (const later of laterStages[stage]) expect(f.api[later]).not.toHaveBeenCalled();
  });

  it("commits music URLs only with the final accepted batch and preserves one-step Undo", async () => {
    const f = fixture("semantic", true);
    const started = deferred<void>();
    const preparation = deferred();
    f.api.prepareMedia.mockImplementation(() => { started.resolve(); return preparation.promise; });
    const work = f.hook.run();
    f.release();
    await started.promise;
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onRuntimeUrls).not.toHaveBeenCalled();
    acknowledgeSave(f);
    preparation.resolve(f.results.prepareMedia);
    await work;
    expect(f.onCommand).toHaveBeenCalledTimes(1);
    expect(f.onRuntimeUrls).toHaveBeenCalledTimes(1);
    expect(f.onRuntimeUrls).toHaveBeenCalledWith({ "music-fixture": "preview://fixture" });
    expect(f.api.analyzeMotionTrack).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history.present.assets.some(asset => asset.id === "music-fixture")).toBe(true);
    expect(f.projectSession.getSnapshot().history.past).toHaveLength(1);
    f.projectSession.setHistory(undo);
    expect(f.projectSession.getSnapshot().history.present.assets).toEqual(f.project.assets);
  });

  it("suppresses an old-session media preparation error without applying the fallback batch or staged URLs", async () => {
    const f = fixture("semantic", true);
    const started = deferred<void>();
    const preparation = deferred();
    f.api.prepareMedia.mockImplementation(() => { started.resolve(); return preparation.promise; });
    const work = f.hook.run();
    f.release();
    await started.promise;
    replace(f);
    f.onStatus.mockClear();
    preparation.reject(new Error("stale media preparation failure"));
    await work;
    expect(f.onStatus).not.toHaveBeenCalled();
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onRuntimeUrls).not.toHaveBeenCalled();
    expect(f.api.analyzeMotionTrack).not.toHaveBeenCalled();
  });

  it("never starts ungrounded automatic tracking or generates rejected title/card artwork", async () => {
    const f = fixture("semantic");
    const work = f.hook.run(); f.release(); await work;
    expect(f.onCommand).toHaveBeenCalledTimes(1);
    expect(f.api.analyzeMotionTrack).not.toHaveBeenCalled();
    expect(f.projectSession.getSnapshot().history.present.motionGraphics).toEqual(f.project.motionGraphics);
    expect(f.projectSession.getSnapshot().history.present.director.markers.some(marker => marker.note.includes("blocked-pending-art-review"))).toBe(true);
  });

  it("forwards the required shared session through the aggregate hook", async () => {
    const f = fixture("captions");
    const all = useAutomaticEditing(f.options);
    const work = all.captions.run();
    edit(f);
    f.release();
    await work;
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("重新執行"));
  });
});
