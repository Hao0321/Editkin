import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import type { BatchAutoEditSession, HaoDesktopApi, OpenProjectResult } from "./types";
import { useBatchAutoEdit } from "./useBatchAutoEdit";

// Exercise the production callback and real ProjectSession store with stable hook
// slots. Effects and React scheduling are deliberately not simulated: these are
// handler race controls, not React lifecycle or delivered native-dialog evidence.
const hookSlots = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
  useRef: (initial: unknown) => {
    const index = hookSlots.index++;
    hookSlots.values[index] ??= { current: initial };
    return hookSlots.values[index];
  },
  useState: (initial: unknown) => {
    const index = hookSlots.index++;
    if (!(index in hookSlots.values)) hookSlots.values[index] = typeof initial === "function" ? initial() : initial;
    return [hookSlots.values[index], (next: unknown) => {
      hookSlots.values[index] = typeof next === "function" ? next(hookSlots.values[index]) : next;
    }];
  },
}));

const batch: BatchAutoEditSession = {
  schemaVersion: 1, id: "batch-fixture", editorialProfile: "auto",
  outputRoot: "D:/fixture-only/batch", createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z",
  jobs: [{ id: "job-1", sourcePath: "D:/fixture-only/source.mp4", sourceName: "source.mp4", status: "completed", warnings: [] }],
};
const projectPath = "D:/fixture-only/current.editkin.json";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount() {
  const projectSession = createProjectSession(createDemoProject(), projectPath);
  const pending = deferred<OpenProjectResult>();
  const openBatchProject = vi.fn(() => pending.promise);
  const onStatus = vi.fn();
  const callbackStates: Array<{ name: string; dirty: boolean; sessionId: number }> = [];
  const onOpenProject = vi.fn((opened: OpenProjectResult) => {
    const current = projectSession.getSnapshot();
    callbackStates.push({ name: current.history.present.name, dirty: current.dirty, sessionId: current.sessionId });
    if (opened.project) projectSession.replaceProject(opened.project, opened.path);
  });
  const confirm = vi.fn(() => false);
  vi.stubGlobal("window", { confirm });
  hookSlots.values = [batch, true];
  const options = { api: { openBatchProject } as unknown as HaoDesktopApi, projectSession, onOpenProject, onStatus };
  const render = () => { hookSlots.index = 0; return useBatchAutoEdit(options); };
  const edit = (name: string) => projectSession.setHistory(current => dispatchCommand(current, { type: "rename_project", name }));
  const opened = (): OpenProjectResult => ({ canceled: false, path: "D:/fixture-only/batch/job-1.editkin.json", project: { ...createDemoProject(), name: "Batch result" } });
  return { projectSession, pending, openBatchProject, onStatus, onOpenProject, callbackStates, confirm, render, edit, opened };
}

beforeEach(() => { hookSlots.values = []; hookSlots.index = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("batch-open handler ownership (not native UI or React lifecycle acceptance)", () => {
  it("opens a clean current session once and closes the batch panel", async () => {
    const fixture = mount();
    const original = fixture.projectSession.getSnapshot();
    const result = fixture.opened();
    const opening = fixture.render().openProject("job-1");
    fixture.pending.resolve(result);
    await opening;
    expect(fixture.openBatchProject).toHaveBeenCalledExactlyOnceWith(batch.id, "job-1");
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.onOpenProject).toHaveBeenCalledExactlyOnceWith(result);
    expect(fixture.projectSession.getSnapshot().sessionId).toBe(original.sessionId + 1);
    expect(fixture.projectSession.getSnapshot().history.present).toBe(result.project);
    expect(fixture.projectSession.getSnapshot().dirty).toBe(false);
    expect(fixture.render().show).toBe(false);
    expect(fixture.onStatus).toHaveBeenCalledTimes(1);
    expect(fixture.onStatus).toHaveBeenCalledWith(expect.stringContaining(result.path!));
  });

  it("declines existing dirty content before any open IPC and releases the guard", async () => {
    const fixture = mount();
    fixture.edit("Already unsaved");
    const original = fixture.projectSession.getSnapshot();
    await fixture.render().openProject("job-1");
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.openBatchProject).not.toHaveBeenCalled();
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot()).toBe(original);
    expect(fixture.render().show).toBe(true);

    fixture.confirm.mockReturnValue(true);
    const retry = fixture.render().openProject("job-1");
    fixture.pending.resolve(fixture.opened());
    await retry;
    expect(fixture.openBatchProject).toHaveBeenCalledTimes(1);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
    expect(fixture.confirm).toHaveBeenCalledTimes(2);
  });

  it("accepts unchanged dirty content with exactly one initial confirmation", async () => {
    const fixture = mount();
    fixture.edit("Accepted unsaved content");
    fixture.confirm.mockReturnValue(true);
    const opening = fixture.render().openProject("job-1");
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
    expect(fixture.callbackStates).toEqual([{ name: "Accepted unsaved content", dirty: true, sessionId: 1 }]);
  });

  it("preserves dirty new edits when a deferred batch open is declined", async () => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.edit("New unsaved content while opening");
    fixture.pending.resolve(fixture.opened());
    await opening;
    // Baseline diagnosis records the actual callback's state before replacement.
    if (fixture.onOpenProject.mock.calls.length) console.info(JSON.stringify({
      defect: "deferred-batch-open-overwrites-new-dirty-content",
      callbackStates: fixture.callbackStates,
      resultingName: fixture.projectSession.getSnapshot().history.present.name,
      resultingDirty: fixture.projectSession.getSnapshot().dirty,
    }));
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot().history.present.name).toBe("New unsaved content while opening");
    expect(fixture.projectSession.getSnapshot().dirty).toBe(true);
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.render().show).toBe(true);
  });

  it("opens after explicitly accepting new content created during the wait", async () => {
    const fixture = mount();
    fixture.confirm.mockReturnValue(true);
    const opening = fixture.render().openProject("job-1");
    fixture.edit("New content accepted");
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
    expect(fixture.callbackStates).toEqual([{ name: "New content accepted", dirty: true, sessionId: 1 }]);
  });

  it.each([false, true])("asks again after initially accepted dirty content changes (second answer %s)", async answer => {
    const fixture = mount();
    fixture.edit("Initial unsaved content");
    fixture.confirm.mockReturnValueOnce(true).mockReturnValueOnce(answer);
    const opening = fixture.render().openProject("job-1");
    fixture.edit("Later unsaved content");
    const beforeResult = fixture.projectSession.getSnapshot();
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.confirm).toHaveBeenCalledTimes(2);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(answer ? 1 : 0);
    expect(fixture.onStatus).toHaveBeenCalledTimes(answer ? 1 : 0);
    if (!answer) expect(fixture.projectSession.getSnapshot()).toBe(beforeResult);
  });

  it("does not repeat consent for save-only metadata while accepted content remains dirty", async () => {
    const fixture = mount();
    // A submitted save of the original content acknowledges after a newer edit.
    const save = fixture.projectSession.beginSave()!;
    fixture.edit("Unsaved content accepted before waiting");
    fixture.confirm.mockReturnValue(true);
    const started = fixture.projectSession.getSnapshot();
    const opening = fixture.render().openProject("job-1");
    expect(fixture.projectSession.completeSave(save, {
      canceled: false, path: projectPath,
      project: { ...save.project, revision: save.project.revision + 1 },
    })).toBe(true);
    fixture.projectSession.finishSave(save);
    const acknowledged = fixture.projectSession.getSnapshot();
    expect(acknowledged.history.present).not.toBe(started.history.present);
    expect(acknowledged.contentOwner).toBe(started.contentOwner);
    expect(acknowledged.dirty).toBe(true);
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("does not prompt after the save contract acknowledges new content before the result", async () => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.edit("New but saved content");
    const save = fixture.projectSession.beginSave()!;
    // Contract acknowledgement, not real filesystem durability evidence.
    expect(fixture.projectSession.completeSave(save, {
      canceled: false, path: projectPath,
      project: { ...save.project, revision: save.project.revision + 1 },
    })).toBe(true);
    fixture.projectSession.finishSave(save);
    expect(fixture.projectSession.getSnapshot().dirty).toBe(false);
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("discards a deferred result after replacement with the same project ID and path", async () => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.projectSession.replaceProject({ ...createDemoProject(), name: "Replacement same identity" }, projectPath);
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot().history.present.name).toBe("Replacement same identity");
    expect(fixture.render().show).toBe(true);
  });

  it("does not publish a late failure into a replacement with the same ID and path", async () => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.projectSession.replaceProject({ ...createDemoProject(), name: "Replacement while failing" }, projectPath);
    const replacement = fixture.projectSession.getSnapshot();
    fixture.pending.reject(new Error("Late native read failure"));
    await opening;
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot()).toBe(replacement);
    expect(fixture.render().show).toBe(true);
  });

  it.each([
    { canceled: true },
    { canceled: false },
  ] satisfies OpenProjectResult[])("preserves new content and panel on non-open result %j", async result => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.edit("Keep new content on canceled or empty result");
    const current = fixture.projectSession.getSnapshot();
    fixture.pending.resolve(result);
    await opening;
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot()).toBe(current);
    expect(fixture.render().show).toBe(true);
  });

  it.each([
    [new Error("Native read failed"), "Native read failed"],
    ["原始 Tauri 錯誤", "原始 Tauri 錯誤"],
    [{ unexpected: true }, "無法開啟批次專案"],
  ])("preserves content on current-session failure and reports its actual error %j", async (error, expected) => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.edit("Keep edits on failure");
    const current = fixture.projectSession.getSnapshot();
    fixture.pending.reject(error);
    await opening;
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).toHaveBeenCalledExactlyOnceWith(expected);
    expect(fixture.projectSession.getSnapshot()).toBe(current);
    expect(fixture.render().show).toBe(true);
  });

  it("guards immediate and rerender duplicate opens synchronously, then allows retry", async () => {
    const fixture = mount();
    const firstRender = fixture.render();
    const opening = firstRender.openProject("job-1");
    await firstRender.openProject("job-1");
    await fixture.render().openProject("job-1");
    expect(fixture.openBatchProject).toHaveBeenCalledTimes(1);
    fixture.pending.resolve({ canceled: true });
    await opening;
    fixture.openBatchProject.mockResolvedValueOnce(fixture.opened());
    await fixture.render().openProject("job-1");
    expect(fixture.openBatchProject).toHaveBeenCalledTimes(2);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("releases the synchronous guard after a thrown open failure", async () => {
    const fixture = mount();
    fixture.openBatchProject.mockImplementationOnce(() => { throw new Error("Synchronous native failure"); });
    await fixture.render().openProject("job-1");
    expect(fixture.onStatus).toHaveBeenCalledExactlyOnceWith("Synchronous native failure");
    const retry = fixture.render().openProject("job-1");
    fixture.pending.resolve(fixture.opened());
    await retry;
    expect(fixture.openBatchProject).toHaveBeenCalledTimes(2);
    expect(fixture.onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("checks session ownership again after the initial confirmation", async () => {
    const fixture = mount();
    fixture.edit("Initially dirty");
    fixture.confirm.mockImplementationOnce(() => {
      fixture.projectSession.replaceProject({ ...createDemoProject(), name: "Replacement during confirmation" }, projectPath);
      return true;
    });
    await fixture.render().openProject("job-1");
    expect(fixture.openBatchProject).not.toHaveBeenCalled();
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot().history.present.name).toBe("Replacement during confirmation");
  });

  it("checks session ownership again after the renewed confirmation", async () => {
    const fixture = mount();
    const opening = fixture.render().openProject("job-1");
    fixture.edit("New dirty content");
    fixture.confirm.mockImplementationOnce(() => {
      fixture.projectSession.replaceProject({ ...createDemoProject(), name: "Replacement during renewed confirmation" }, projectPath);
      return true;
    });
    fixture.pending.resolve(fixture.opened());
    await opening;
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.onOpenProject).not.toHaveBeenCalled();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.projectSession.getSnapshot().history.present.name).toBe("Replacement during renewed confirmation");
  });
});
