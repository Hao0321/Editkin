import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, redo, undo } from "../domain/history";
import type { EditProject } from "../domain/types";
import type { OpenProjectResult } from "../desktop/types";
import { EXTERNAL_WRITE_UNDO_LABEL, createProjectSession, isSingleRevisionExternalWrite, nextUndoExternalWriteLabel } from "./projectSession";
import { externalWriteLabelFromReceipt, openProjectAtPath, type ProjectPathOpenInput } from "./projectPathActions";

// ROADMAP J4 / decision (f)4: another program's clean single-revision write (Shorts, long-form or a manual MCP apply)
// reloads as exactly one Undo step; anything else keeps today's reset-on-reload. Session-store controls, not native UI.
const path = "D:/fixture-only/external.editkin.json";

function written(from: EditProject, revisionDelta = 1, patch: Partial<EditProject> = {}): EditProject {
  return { ...structuredClone(from), revision: from.revision + revisionDelta, name: "Written by the agent", updatedAt: "2026-10-15T08:00:00.000Z", ...patch };
}

function host(initial = createDemoProject()) {
  const session = createProjectSession(initial, path);
  const opened = { value: undefined as OpenProjectResult | undefined };
  const input: ProjectPathOpenInput = {
    api: { openProjectPath: vi.fn(async () => opened.value!) },
    session,
    // The App's own loader: it replaces the project without knowing about Undo.
    loadOpenedProject: vi.fn((result: OpenProjectResult) => { if (result.project) session.replaceProject(result.project, result.path); }),
    setStatus: vi.fn(),
    confirmDiscard: vi.fn(() => true),
  };
  return { session, input, initial, open: (project: EditProject) => { opened.value = { canceled: false, path, project }; } };
}

describe("one Undo for a single-revision external write (E8)", () => {
  it("keeps the replaced clean content as exactly one Undo step and can redo it", () => {
    const initial = createDemoProject();
    const session = createProjectSession(initial, path);
    const next = written(initial);
    session.replaceProject(next, path, { undoFrom: { previous: initial, label: EXTERNAL_WRITE_UNDO_LABEL } });
    const adopted = session.getSnapshot();
    expect(adopted.history.past).toEqual([initial]);
    expect(adopted.history.past[0]).toBe(initial);
    expect(adopted.history).toMatchObject({ present: next, future: [], journal: [] });
    expect(adopted).toMatchObject({ dirty: false, diskRevision: next.revision, externalWrite: { label: "外部修改", revisionBefore: initial.revision, revisionAfter: next.revision } });
    expect(nextUndoExternalWriteLabel(adopted)).toBe("外部修改");

    session.setHistory(undo);
    const undone = session.getSnapshot();
    expect({ ...undone.history.present, updatedAt: "" }).toEqual({ ...initial, revision: next.revision, updatedAt: "" });
    expect(undone.history.past).toEqual([]);
    expect(undone.dirty).toBe(true);
    expect(nextUndoExternalWriteLabel(undone)).toBeUndefined();
    session.setHistory(redo);
    expect(session.getSnapshot().history.present.name).toBe("Written by the agent");

    // A later edit stacks on top; undoing it brings the external step back as the next Undo.
    session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "Manual touch" }));
    expect(session.getSnapshot().history.past).toHaveLength(2);
    expect(nextUndoExternalWriteLabel(session.getSnapshot())).toBeUndefined();
    session.setHistory(undo);
    expect(nextUndoExternalWriteLabel(session.getSnapshot())).toBe("外部修改");
    // Undoing to the content before the write and editing again starts a new branch: the external step is gone.
    session.setHistory(undo);
    session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "New branch" }));
    expect(session.getSnapshot().history.past).toHaveLength(1);
    expect(nextUndoExternalWriteLabel(session.getSnapshot())).toBeUndefined();
  });

  it("only adopts the same project exactly one clean revision later", () => {
    const initial = createDemoProject();
    expect(isSingleRevisionExternalWrite(initial, written(initial))).toBe(true);
    for (const [name, next, options] of [
      ["two revisions later", written(initial, 2), {}],
      ["same revision", written(initial, 0), {}],
      ["another project", written(initial, 1, { id: "another-project" }), {}],
      ["restored as dirty", written(initial), { dirty: true }],
    ] as const) {
      const session = createProjectSession(initial, path);
      session.replaceProject(next, path, { ...options, undoFrom: { previous: initial, label: "外部修改" } });
      expect(session.getSnapshot().history.past, name).toEqual([]);
      expect(session.getSnapshot().externalWrite, name).toBeUndefined();
    }
  });

  it("reload adopts a clean single-revision write through the host's own loader, labelled 「外部修改」", async () => {
    const f = host();
    const next = written(f.initial);
    f.open(next);
    await expect(openProjectAtPath(f.input, path, "reload")).resolves.toBe(true);
    expect(f.input.loadOpenedProject).toHaveBeenCalledTimes(1);
    const snapshot = f.session.getSnapshot();
    expect(snapshot.history.past).toEqual([f.initial]);
    expect(snapshot.history.present).toBe(next);
    expect(snapshot).toMatchObject({ dirty: false, externalWrite: { label: "外部修改" } });
    expect(f.input.confirmDiscard).not.toHaveBeenCalled();
    f.session.setHistory(undo);
    expect(f.session.getSnapshot().history.present.name).toBe(f.initial.name);
    // The arming is scoped to that one load: a later plain replace with the same object starts fresh history.
    f.session.replaceProject(next, path);
    expect(f.session.getSnapshot().history.past).toEqual([]);
  });

  it("labels the step from the committed receipt when the host can read one, and falls back otherwise", async () => {
    const f = host();
    const next = written(f.initial);
    const setReceipt = { schema: "hao.video-autopilot.execution-receipt/v1", state: "committed", projectRevisionAfter: next.revision,
      projectIdentityAfter: { id: next.id }, longformSet: { chapters: [{ chapterId: "ch-1" }, { chapterId: "ch-2" }] } };
    f.input.externalWriteLabel = async opened => externalWriteLabelFromReceipt(setReceipt, opened.project);
    f.open(next);
    await openProjectAtPath(f.input, path, "reload");
    expect(f.session.getSnapshot().externalWrite?.label).toBe("AI 長片套用（2 章）");

    const g = host();
    g.input.externalWriteLabel = async () => { throw new Error("receipt folder unreadable"); };
    g.open(written(g.initial));
    await openProjectAtPath(g.input, path, "reload");
    expect(g.session.getSnapshot()).toMatchObject({ externalWrite: { label: "外部修改" } });
    expect(g.session.getSnapshot().history.past).toHaveLength(1);
  });

  it("keeps today's reset when the session is dirty, the revision jumps, the project differs or it is an ordinary open", async () => {
    const dirty = host();
    dirty.session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "Unsaved" }));
    dirty.open(written(dirty.initial));
    await expect(openProjectAtPath(dirty.input, path, "reload")).resolves.toBe(true);
    expect(dirty.input.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(dirty.session.getSnapshot().history.past).toEqual([]);

    for (const [name, next, action] of [
      ["revision jump", (initial: EditProject) => written(initial, 2), "reload"],
      ["another project", (initial: EditProject) => written(initial, 1, { id: "someone-else" }), "reload"],
      ["recent-project open", (initial: EditProject) => written(initial), "open"],
    ] as const) {
      const f = host();
      f.open(next(f.initial));
      await expect(openProjectAtPath(f.input, path, action), name).resolves.toBe(true);
      expect(f.session.getSnapshot().history.past, name).toEqual([]);
      expect(f.session.getSnapshot().externalWrite, name).toBeUndefined();
    }
  });

  it("reads only a committed receipt for exactly this revision", () => {
    const project = written(createDemoProject());
    const receipt = { schema: "hao.video-autopilot.execution-receipt/v1", state: "committed", projectRevisionAfter: project.revision, projectIdentityAfter: { id: project.id } };
    expect(externalWriteLabelFromReceipt(receipt, project)).toBe("AI 自動剪輯套用");
    expect(externalWriteLabelFromReceipt({ ...receipt, state: "pending" }, project)).toBeUndefined();
    expect(externalWriteLabelFromReceipt({ ...receipt, projectRevisionAfter: project.revision + 1 }, project)).toBeUndefined();
    expect(externalWriteLabelFromReceipt({ ...receipt, projectIdentityAfter: { id: "other" } }, project)).toBeUndefined();
    expect(externalWriteLabelFromReceipt(undefined, project)).toBeUndefined();
  });
});
