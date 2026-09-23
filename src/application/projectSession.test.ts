import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, redo, undo } from "../domain/history";
import type { EditProject } from "../domain/types";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "./nativeAutopilot";
import { planSemanticAutoEdit } from "./semanticAutoEdit";
import { applyCommand } from "../domain/commands";
import { createProjectSession } from "./projectSession";
import { ProjectRevisionConflictError, readProjectFile, writeProjectFileAtomic } from "./projectFiles";

type Session = ReturnType<typeof createProjectSession>;
type Request = NonNullable<ReturnType<Session["beginSave"]>>;
const pathA = "D:/fixture-only/project.editkin.json";
const pathB = "D:/fixture-only/another.editkin.json";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function begin(session: Session, saveAs = false): Request {
  const request = session.beginSave(saveAs);
  expect(request).toBeDefined();
  if (!request) throw new Error("Expected a new owned save request");
  return request;
}
function edit(session: Session, name: string) {
  session.setHistory(current => dispatchCommand(current, { type: "rename_project", name }));
}
function saved(request: Request, path = request.projectPath ?? pathA, revision = request.project.revision + 1) {
  return { canceled: false, path, project: { ...structuredClone(request.project), revision, updatedAt: "2026-09-01T01:00:00.000Z" } };
}
function settle(session: Session, request: Request, result = saved(request)) {
  try { return session.completeSave(request, result); } finally { session.finishSave(request); }
}
async function saveToDisk(session: Session, gate: Promise<void> = Promise.resolve()) {
  const request = begin(session);
  if (!request.projectPath) throw new Error("Disk fixture requires an explicit owned path");
  try {
    await gate;
    const project = await writeProjectFileAtomic(request.projectPath, request.project, request.project.revision);
    expect(session.completeSave(request, { canceled: false, path: request.projectPath, project })).toBe(true);
    return project;
  } finally { session.finishSave(request); }
}

describe("window-local project session (store controls, not native UI acceptance)", () => {
  it("keeps snapshots stable and subscriptions scoped to actual synchronous changes", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    expect(session.getSnapshot()).toBe(session.getSnapshot());
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    edit(session, "Changed synchronously");
    expect(session.getSnapshot().history.present.name).toBe("Changed synchronously");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toBe(session.getSnapshot());
    unsubscribe();
    edit(session, "After unsubscribe");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("adopts a successful unchanged save while preserving undo/redo history", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "First");
    edit(session, "Second");
    session.setHistory(undo);
    const before = session.getSnapshot();
    const request = begin(session);
    const result = saved(request);
    expect(settle(session, request, result)).toBe(true);
    const after = session.getSnapshot();
    expect(after.history.present).toEqual(result.project);
    expect(after.history.past).toEqual(before.history.past);
    expect(after.history.future).toEqual(before.history.future);
    expect(after.history.journal).toEqual(before.history.journal);
    expect(after).toMatchObject({ dirty: false, diskRevision: 1, projectPath: pathA, savePending: false });
  });

  it("freezes the submitted payload and keeps newer content and its history on late success", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "Submitted A");
    const original = session.getSnapshot().history.present;
    const request = begin(session);
    expect(request.submittedProject).toBe(original);
    expect(request.project).not.toBe(original);
    expect(request.project.assets).not.toBe(original.assets);
    edit(session, "Newer B");
    const newer = session.getSnapshot();
    expect(request.project.name).toBe("Submitted A");
    const result = saved(request);
    expect(settle(session, request, result)).toBe(true);
    const after = session.getSnapshot();
    expect(after.history.present).toEqual({ ...newer.history.present, revision: result.project.revision });
    expect(after.history.past).toEqual(newer.history.past);
    expect(after.history.future).toEqual(newer.history.future);
    expect(after.history.journal).toEqual(newer.history.journal);
    expect(after).toMatchObject({ dirty: true, diskRevision: 1, projectPath: pathA });
    expect(session.isRecoveryOwnerCurrent(newer.recoveryOwner)).toBe(false);
  });

  it.each(["new", "open", "batch-open", "restore"] as const)("does not apply an old save to %s, even with the same ID and path", replacement => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "Old submitted");
    const request = begin(session);
    const oldOwner = session.getSnapshot().recoveryOwner;
    const replacementProject = { ...createDemoProject(), name: replacement, revision: 9 };
    session.replaceProject(replacementProject, pathA, { dirty: replacement === "restore", cleanUpdatedAt: "2026-08-01T00:00:00.000Z" });
    const replaced = session.getSnapshot();
    expect(replaced.sessionId).not.toBe(request.sessionId);
    expect(session.isCurrentSession(request.sessionId)).toBe(false);
    expect(session.isRecoveryOwnerCurrent(oldOwner)).toBe(false);
    expect(session.completeSave(request, saved(request))).toBe(false);
    session.finishSave(request);
    const after = session.getSnapshot();
    expect(after.history).toEqual(replaced.history);
    expect(after.projectPath).toBe(replaced.projectPath);
    expect(after.diskRevision).toBe(replaced.diskRevision);
    expect(after.dirty).toBe(replaced.dirty);
    expect(after.cleanUpdatedAt).toBe(replaced.cleanUpdatedAt);
  });

  it.each([false, true])("adopts the saved path but retains newer content for saveAs=%s", saveAs => {
    const session = createProjectSession(createDemoProject(), saveAs ? pathA : undefined);
    edit(session, "A");
    const request = begin(session, saveAs);
    expect(request.saveAs).toBe(saveAs);
    edit(session, "B during picker");
    expect(settle(session, request, saved(request, pathB, 7))).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ dirty: true, projectPath: pathB, diskRevision: 7 });
    expect(session.getSnapshot().history.present.name).toBe("B during picker");
    const next = begin(session);
    expect(next.projectPath).toBe(pathB);
    expect(next.project.revision).toBe(7);
    session.finishSave(next);
  });

  it("admits one save across duplicate commands without blocking editing and ignores old release tokens", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    const first = begin(session);
    expect(session.beginSave()).toBeUndefined();
    expect(session.beginSave(true)).toBeUndefined();
    edit(session, "Editing is still available");
    expect(session.getSnapshot().history.present.name).toBe("Editing is still available");
    settle(session, first);
    const second = begin(session);
    session.finishSave(first);
    expect(session.getSnapshot().savePending).toBe(true);
    expect(session.beginSave()).toBeUndefined();
    expect(session.completeSave(first, saved(first))).toBe(false);
    session.finishSave(second);
    expect(session.getSnapshot().savePending).toBe(false);
  });

  it("does not advance or clean on cancel or malformed success", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "Unsaved");
    const before = session.getSnapshot();
    let request = begin(session);
    expect(session.completeSave(request, { canceled: true })).toBe(false);
    session.finishSave(request);
    for (const malformed of [{}, { path: pathA }, { project: createDemoProject() }]) {
      request = begin(session);
      expect(() => session.completeSave(request, malformed)).toThrow();
      session.finishSave(request);
    }
    expect(session.getSnapshot().history).toEqual(before.history);
    expect(session.getSnapshot()).toMatchObject({ dirty: true, diskRevision: before.diskRevision, projectPath: pathA, savePending: false });
  });

  it("rejects mismatched or non-incrementing save responses before changing any state", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "Retain this content");
    const request = begin(session);
    const before = session.getSnapshot();
    const valid = saved(request);
    const invalid = [
      { ...valid, path: "   " },
      { ...valid, project: { ...valid.project, id: "unrelated-project" } },
      ...[request.project.revision, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]
        .map(revision => ({ ...valid, project: { ...valid.project, revision } })),
    ];
    for (const result of invalid) {
      expect(() => session.completeSave(request, result)).toThrow();
      expect(session.getSnapshot()).toBe(before);
    }
    expect(session.completeSave(request, valid)).toBe(true);
    session.finishSave(request);
    expect(session.getSnapshot()).toMatchObject({ dirty: false, diskRevision: valid.project.revision });
  });

  it("settles an owning request exactly once even before its finally releases the pending state", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "Submitted once");
    const request = begin(session);
    expect(session.completeSave(request, saved(request))).toBe(true);
    const after = session.getSnapshot();
    expect(after.savePending).toBe(true);
    expect(session.completeSave(request, saved(request, pathB, 6))).toBe(false);
    expect(session.getSnapshot()).toBe(after);
    expect(session.beginSave()).toBeUndefined();
    session.finishSave(request);
    expect(session.getSnapshot().savePending).toBe(false);
  });

  it("keeps recovery ownership across busy-only changes but invalidates it for content and accepted saves", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    const initialOwner = session.getSnapshot().recoveryOwner;
    const canceled = begin(session);
    expect(session.isRecoveryOwnerCurrent(initialOwner)).toBe(true);
    expect(session.completeSave(canceled, { canceled: true })).toBe(false);
    session.finishSave(canceled);
    expect(session.isRecoveryOwnerCurrent(initialOwner)).toBe(true);
    edit(session, "Changed content");
    expect(session.isRecoveryOwnerCurrent(initialOwner)).toBe(false);
    const dirtyOwner = session.getSnapshot().recoveryOwner;
    const request = begin(session);
    expect(session.isRecoveryOwnerCurrent(dirtyOwner)).toBe(true);
    expect(session.completeSave(request, saved(request))).toBe(true);
    expect(session.isRecoveryOwnerCurrent(dirtyOwner)).toBe(false);
    const cleanOwner = session.getSnapshot().recoveryOwner;
    session.finishSave(request);
    expect(session.isRecoveryOwnerCurrent(cleanOwner)).toBe(true);
  });

  it.each([new Error("disk failed"), "Tauri string failure"])("keeps dirty state on deferred service rejection: %s", async error => {
    const session = createProjectSession(createDemoProject(), pathA);
    edit(session, "Unsaved");
    const pending = deferred<ReturnType<typeof saved>>();
    const request = begin(session);
    const flow = pending.promise.then(result => session.completeSave(request, result)).finally(() => session.finishSave(request));
    pending.reject(error);
    await expect(flow).rejects.toBe(error);
    expect(session.getSnapshot()).toMatchObject({ dirty: true, diskRevision: 0, savePending: false });
    expect(session.getSnapshot().history.present.name).toBe("Unsaved");
  });

  it("does not confuse prior clean content or equal timestamps with the newly saved content", () => {
    const initial = createDemoProject();
    const session = createProjectSession(initial, pathA);
    edit(session, "Saved A");
    const request = begin(session);
    session.setHistory(undo);
    expect(session.getSnapshot().history.present.name).toBe(initial.name);
    settle(session, request);
    expect(session.getSnapshot().dirty).toBe(true);
    const next = begin(session);
    edit(session, "B with identical timestamp");
    const currentTimestamp = session.getSnapshot().history.present.updatedAt;
    const result = saved(next);
    result.project.updatedAt = currentTimestamp;
    settle(session, next, result);
    expect(session.getSnapshot().history.present.name).toBe("B with identical timestamp");
    expect(session.getSnapshot().dirty).toBe(true);
  });

  it("only the current token may settle once and a pending save remains window-local across replacement", () => {
    const session = createProjectSession(createDemoProject(), pathA);
    const first = begin(session);
    session.replaceProject(createDemoProject(), pathA);
    expect(session.beginSave()).toBeUndefined();
    session.finishSave(first);
    const next = begin(session);
    expect(session.completeSave(first, saved(first))).toBe(false);
    session.finishSave(first);
    expect(session.getSnapshot().savePending).toBe(true);
    settle(session, next);
    const after = session.getSnapshot();
    expect(session.completeSave(next, saved(next))).toBe(false);
    expect(session.getSnapshot()).toBe(after);
  });
});

describe("project session with actual project-file CAS/readback in owned fixtures", () => {
  it("persists A then newer B then Undo/Redo with consecutive revisions, not stale request metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-session-cas-"));
    const path = join(directory, "project.editkin.json");
    try {
      const initial = await writeProjectFileAtomic(path, createDemoProject(), null);
      const session = createProjectSession(initial, path);
      edit(session, "Submitted A");
      const gate = deferred<void>();
      const firstSave = saveToDisk(session, gate.promise);
      edit(session, "Newer B");
      gate.resolve();
      const first = await firstSave;
      expect(first.revision).toBe(2);
      expect(await readProjectFile(path)).toMatchObject({ name: "Submitted A", revision: 2 });
      expect(session.getSnapshot().history.present).toMatchObject({ name: "Newer B", revision: 2 });
      expect(session.getSnapshot().dirty).toBe(true);
      const second = await saveToDisk(session);
      expect(second.revision).toBe(3);
      expect(await readProjectFile(path)).toMatchObject({ name: "Newer B", revision: 3 });
      session.setHistory(undo);
      expect(session.getSnapshot().history.present.revision).toBe(3);
      const undoneName = session.getSnapshot().history.present.name;
      expect((await saveToDisk(session)).revision).toBe(4);
      expect(await readProjectFile(path)).toMatchObject({ name: undoneName, revision: 4 });
      session.setHistory(redo);
      expect(session.getSnapshot().history.present.revision).toBe(4);
      expect((await saveToDisk(session)).revision).toBe(5);
      expect(await readProjectFile(path)).toMatchObject({ name: "Newer B", revision: 5 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("retains genuine external-writer CAS protection without advancing the failed local baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-session-external-cas-"));
    const path = join(directory, "project.editkin.json");
    try {
      const initial = await writeProjectFileAtomic(path, createDemoProject(), null);
      const session = createProjectSession(initial, path);
      edit(session, "Local unsaved");
      const request = begin(session);
      const external = await writeProjectFileAtomic(path, { ...initial, name: "External saved" }, initial.revision);
      try {
        await expect(writeProjectFileAtomic(path, request.project, request.project.revision)).rejects.toBeInstanceOf(ProjectRevisionConflictError);
      } finally { session.finishSave(request); }
      expect(session.getSnapshot()).toMatchObject({ dirty: true, diskRevision: 1, savePending: false });
      expect(session.getSnapshot().history.present.name).toBe("Local unsaved");
      expect(await readProjectFile(path)).toEqual(external);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("round-trips an actual native-autopilot graph with captions, graphics and dimensionless BGM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-session-autopilot-"));
    try {
      const path = join(directory, "autopilot.editkin.json");
      const initial = createDemoProject();
      const clip = initial.tracks[0].clips[0];
      const cues = [{ start: 0, end: 3, text: "第一段測試內容" }, { start: 5, end: 8, text: "第二段重點" }];
      const semantic = planSemanticAutoEdit({ duration: clip.duration, fps: initial.fps, cues, targetRatio: 1 });
      const creative = planNativeAutopilotCreative({ duration: clip.duration, width: initial.width, height: initial.height, cues, video: true });
      const built = buildNativeAutopilotCommand({ project: initial, clip, transcript: { cues }, semantic, creative, musicAsset: { id: "bgm", name: "fixture.wav", kind: "audio", uri: "creative://music", duration: 124.76 }, idFactory: (kind, index) => kind + "-" + index });
      const project = applyCommand(initial, built.command);
      const session = createProjectSession(project);
      const request = begin(session);
      const persisted = await writeProjectFileAtomic(path, request.project, null);
      expect(settle(session, request, { canceled: false, path, project: persisted })).toBe(true);
      const reopened = await readProjectFile(path);
      expect(reopened.captions).toEqual(project.captions);
      expect(reopened.motionGraphics).toEqual(project.motionGraphics);
      expect(reopened.tracks).toEqual(project.tracks);
      const serialized = JSON.parse(await readFile(path, "utf8")) as EditProject;
      const audio = serialized.assets.find(asset => asset.id === "bgm")!;
      expect(audio.kind).toBe("audio");
      expect(Object.hasOwn(audio, "width")).toBe(false);
      expect(Object.hasOwn(audio, "height")).toBe(false);
      expect(session.getSnapshot().dirty).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
