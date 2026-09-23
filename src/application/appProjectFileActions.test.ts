import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import type { HaoDesktopApi, OpenProjectResult, SaveProjectResult } from "../desktop/types";
import { createAppProjectFileActions } from "./appProjectFileActions";
import { createProjectSession } from "./projectSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const session = createProjectSession(createDemoProject(), "D:/fixture-only/original.editkin.json");
  const save = deferred<SaveProjectResult>();
  const open = deferred<OpenProjectResult>();
  const api = {
    saveProject: vi.fn<HaoDesktopApi["saveProject"]>(() => save.promise),
    openProject: vi.fn<HaoDesktopApi["openProject"]>(() => open.promise),
    clearRecovery: vi.fn(),
  };
  const confirm = vi.fn(() => true);
  vi.stubGlobal("window", { confirm });
  const status = vi.fn();
  const loadOpenedProject = vi.fn((result: OpenProjectResult) => {
    if (result.project) session.replaceProject(result.project, result.path);
  });
  const actions = createAppProjectFileActions({
    api: api as unknown as HaoDesktopApi, session, loadOpenedProject,
    setStatus: status, setRuntimeUrls: vi.fn(), setSelectedClipId: vi.fn(),
    setSelectedCaptionId: vi.fn(), setPlayhead: vi.fn(), setPlaying: vi.fn(),
    setTrackingMode: vi.fn(), setTrackingSelection: vi.fn(),
  });
  const edit = (name: string) => session.setHistory(state => dispatchCommand(state, { type: "rename_project", name }));
  const success = () => ({
    canceled: false, path: "D:/fixture-only/saved-as.editkin.json",
    project: { ...structuredClone(api.saveProject.mock.calls[0][0]), revision: 1 },
  });
  return { session, save, open, api, confirm, status, loadOpenedProject, actions, edit, success };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("manual file actions with actual project session (desktop I/O is deferred test double)", () => {
  it("persists only the submitted snapshot and keeps later edits dirty at the Save As path", async () => {
    const f = fixture();
    f.edit("Submitted A");
    const task = f.actions.saveProject(true);
    expect(f.api.saveProject).toHaveBeenCalledTimes(1);
    expect(f.api.saveProject.mock.calls[0][2]).toBe(true);
    f.edit("Newer B");
    expect(f.api.saveProject.mock.calls[0][0].name).toBe("Submitted A");
    f.save.resolve(f.success());
    await task;
    expect(f.session.getSnapshot()).toMatchObject({ dirty: true, savePending: false, diskRevision: 1, projectPath: "D:/fixture-only/saved-as.editkin.json" });
    expect(f.session.getSnapshot().history.present.name).toBe("Newer B");
    expect(f.status).toHaveBeenLastCalledWith(expect.stringContaining("後續修改已保留"));
    expect(f.api.clearRecovery).not.toHaveBeenCalled();
  });

  it("ordinary save advances the clean baseline and preserves undo history", async () => {
    const f = fixture();
    f.edit("Ready to save");
    const before = f.session.getSnapshot().history;
    const task = f.actions.saveProject();
    f.save.resolve(f.success());
    await task;
    expect(f.session.getSnapshot()).toMatchObject({ dirty: false, savePending: false, diskRevision: 1 });
    expect(f.session.getSnapshot().history.past).toEqual(before.past);
    expect(f.status).toHaveBeenLastCalledWith(expect.stringContaining("專案已儲存"));
    expect(f.api.clearRecovery).not.toHaveBeenCalled();
  });

  it("a repeated save request invokes no second dialog or write while editing remains available", async () => {
    const f = fixture();
    f.edit("A");
    const first = f.actions.saveProject();
    await f.actions.saveProject(true);
    f.edit("B");
    expect(f.api.saveProject).toHaveBeenCalledTimes(1);
    expect(f.session.getSnapshot().history.present.name).toBe("B");
    f.save.resolve({ canceled: true });
    await first;
    expect(f.session.getSnapshot()).toMatchObject({ dirty: true, savePending: false, diskRevision: 0 });
  });

  it.each(["success", "cancel", "error"])("ignores old-session %s even when the replacement has identical id/path", async result => {
    const f = fixture();
    f.edit("Old A");
    const task = f.actions.saveProject();
    const old = f.session.getSnapshot();
    f.session.replaceProject({ ...old.history.present, name: "New session", revision: 8 }, old.projectPath, { dirty: true });
    const replacement = f.session.getSnapshot();
    f.status.mockClear();
    if (result === "error") f.save.reject("native string failure");
    else f.save.resolve(result === "cancel" ? { canceled: true } : f.success());
    await task;
    expect(f.session.getSnapshot()).toEqual({ ...replacement, savePending: false });
    expect(f.status).not.toHaveBeenCalled();
    expect(f.api.clearRecovery).not.toHaveBeenCalled();
  });

  it.each(["cancel", "string error", "invalid response"])("keeps content, dirty and disk baseline intact on %s", async result => {
    const f = fixture();
    f.edit("Unsaved");
    const before = f.session.getSnapshot();
    const task = f.actions.saveProject();
    if (result === "string error") f.save.reject("Project revision conflict: expected 0, found 2");
    else f.save.resolve(result === "cancel" ? { canceled: true } : { canceled: false, path: "" });
    await task;
    expect(f.session.getSnapshot()).toEqual(before);
    expect(f.api.clearRecovery).not.toHaveBeenCalled();
    if (result === "string error") expect(f.status).toHaveBeenLastCalledWith("Project revision conflict: expected 0, found 2");
  });

  it("New confirms against live dirty state and never directly deletes recovery", () => {
    const f = fixture();
    f.edit("Edit after action binding");
    const before = f.session.getSnapshot();
    f.confirm.mockReturnValueOnce(false);
    f.actions.newProject();
    expect(f.session.getSnapshot()).toBe(before);
    f.actions.newProject();
    expect(f.session.getSnapshot().sessionId).toBe(before.sessionId + 1);
    expect(f.session.getSnapshot().dirty).toBe(false);
    expect(f.api.clearRecovery).not.toHaveBeenCalled();
  });

  it("does not open a file if the user declines discarding edits made while the picker was pending", async () => {
    const f = fixture();
    const task = f.actions.openProject();
    f.edit("Edited during picker");
    f.confirm.mockReturnValueOnce(false);
    f.open.resolve({ canceled: false, path: "D:/fixture-only/opened.editkin.json", project: createDemoProject() });
    await task;
    expect(f.loadOpenedProject).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().history.present.name).toBe("Edited during picker");
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "error"])("ignores a delayed open %s after New", async result => {
    const f = fixture();
    const task = f.actions.openProject();
    f.actions.newProject();
    const afterNew = f.session.getSnapshot();
    f.status.mockClear();
    if (result === "error") f.open.reject("old open failed");
    else f.open.resolve({ canceled: false, path: "D:/fixture-only/stale.editkin.json", project: createDemoProject() });
    await task;
    expect(f.session.getSnapshot()).toBe(afterNew);
    expect(f.loadOpenedProject).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  });

  it("opens a chosen project normally through the shared replacement boundary", async () => {
    const f = fixture();
    const oldId = f.session.getSnapshot().sessionId;
    const task = f.actions.openProject();
    const opened = { canceled: false, path: "D:/fixture-only/opened.editkin.json", project: { ...createDemoProject(), name: "Opened", revision: 5 } };
    f.open.resolve(opened);
    await task;
    expect(f.loadOpenedProject).toHaveBeenCalledExactlyOnceWith(opened);
    expect(f.session.getSnapshot()).toMatchObject({ sessionId: oldId + 1, dirty: false, diskRevision: 5, projectPath: opened.path });
  });
});
