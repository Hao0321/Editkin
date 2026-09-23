import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, undo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { acceptProjectTask } from "./projectTask";

describe("async project task ownership", () => {
  it("accepts current content and survives manual save metadata acknowledgment", () => {
    const project = createDemoProject();
    const session = createProjectSession(project);
    const task = session.beginTask(project);
    const status = vi.fn();
    expect(acceptProjectTask(task, status, "分析")).toBe(true);
    const request = session.beginSave()!;
    session.completeSave(request, { path: "D:/fixture-only/saved.json", project: { ...structuredClone(request.project), revision: 1 } });
    session.finishSave(request);
    expect(acceptProjectTask(task, status, "分析")).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });
  it("invalidates on edit even with equal timestamps, and Undo never revives an old task", () => {
    const project = createDemoProject();
    const session = createProjectSession(project);
    const task = session.beginTask(project);
    session.setHistory(state => dispatchCommand(state, { type: "rename_project", name: "Changed" }));
    const status = vi.fn();
    expect(acceptProjectTask(task, status, "自動字幕")).toBe(false);
    expect(status).toHaveBeenCalledWith(expect.stringContaining("請以目前版本重新執行"));
    session.setHistory(undo);
    expect(task.isCurrent()).toBe(false);
  });
  it("rejects same-id replacement without publishing stale status", () => {
    const project = createDemoProject();
    const session = createProjectSession(project, "same.json");
    const task = session.beginTask(project);
    session.replaceProject(structuredClone(project), "same.json");
    const status = vi.fn();
    expect(acceptProjectTask(task, status, "分析")).toBe(false);
    expect(task.isSessionCurrent()).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });
  it("rejects callbacks bound to an older render before starting backend work", () => {
    const project = createDemoProject();
    const session = createProjectSession(project);
    session.setHistory(state => dispatchCommand(state, { type: "rename_project", name: "New render" }));
    expect(session.beginTask(project).isCurrent()).toBe(false);
    expect(session.beginTask(session.getSnapshot().history.present).isCurrent()).toBe(true);
  });

  it("persists background proxy metadata without canceling valid content analysis", () => {
    const project = createDemoProject();
    const session = createProjectSession(project);
    const task = session.beginTask(project);
    const owner = session.getSnapshot().recoveryOwner;
    const asset = project.assets[0];
    const derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-08-31T00:00:00.000Z", proxyUri: "D:/fixture-only/proxy.mp4" };
    session.applyMediaDerivatives([{ assetId: asset.id, sourceUri: asset.uri, derivatives }]);
    expect(task.isCurrent()).toBe(true);
    expect(session.getSnapshot().dirty).toBe(true);
    expect(session.isRecoveryOwnerCurrent(owner)).toBe(false);
    expect(session.getSnapshot().history.present.assets[0].derivatives).toEqual(derivatives);
    const save = session.beginSave()!;
    expect(save.project.assets[0].derivatives).toEqual(derivatives);
    session.finishSave(save);
  });

  it("refuses cache metadata for relinked/missing assets and never hides a real source edit", () => {
    const project = createDemoProject();
    const session = createProjectSession(project);
    const task = session.beginTask(project);
    const asset = project.assets[0];
    const derivatives = { sourceSha256: "b".repeat(64), generatedAt: "2026-08-31T00:00:00.000Z" };
    session.applyMediaDerivatives([{ assetId: "missing", sourceUri: asset.uri, derivatives }, { assetId: asset.id, sourceUri: "different.mp4", derivatives }]);
    expect(session.getSnapshot().history.present).toBe(project);
    session.setHistory(history => ({ ...history, present: { ...history.present, assets: history.present.assets.map(item => ({ ...item, uri: "relinked.mp4" })) } }));
    expect(task.isCurrent()).toBe(false);
    const before = session.getSnapshot();
    session.applyMediaDerivatives([{ assetId: asset.id, sourceUri: asset.uri, derivatives }]);
    expect(session.getSnapshot()).toBe(before);
  });

  it("preserves undo/redo entries while treating a changed known source hash as new content", () => {
    const session = createProjectSession(createDemoProject());
    session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Undo this edit" }));
    session.setHistory(undo);
    const before = session.getSnapshot().history;
    expect(before.future).toHaveLength(1);
    const asset = before.present.assets[0];
    const update = { assetId: asset.id, sourceUri: asset.uri, derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-08-31T00:00:00.000Z" } };
    session.applyMediaDerivatives([update]);
    expect(session.getSnapshot().history.past).toBe(before.past);
    expect(session.getSnapshot().history.future).toBe(before.future);
    expect(session.getSnapshot().history.journal).toBe(before.journal);
    const task = session.beginTask();
    session.applyMediaDerivatives([{ ...update, derivatives: { ...update.derivatives, sourceSha256: "b".repeat(64) } }]);
    expect(task.isCurrent()).toBe(false);
  });
});
