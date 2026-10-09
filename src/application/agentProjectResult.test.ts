// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import type { OpenProjectResult } from "../desktop/types";
import { createProjectSession } from "./projectSession";
import { openAgentProjectResult, parseAgentProjectResults, type AgentProjectResult } from "./agentProjectResult";

const result: AgentProjectResult = { path: "D:/fixture/previous.editkin.json", projectId: "previous", projectName: "先前專案", workingCopy: true };
function fixture() {
  const session = createProjectSession({ ...createDemoProject(), id: "current" });
  const opened = { canceled: false, project: { ...createDemoProject(), id: result.projectId }, path: result.path };
  const load = vi.fn<(path: string) => Promise<OpenProjectResult>>(async () => opened);
  const confirm = vi.fn(() => true), open = vi.fn();
  const edit = () => session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "newer current edit" }));
  return { result, session, opened, load, confirm, open, edit };
}

describe("explicitly opening a completed background Agent project", () => {
  it("opens a working result as an unsaved project, preserving its identity", async () => {
    const f = fixture();
    expect(await openAgentProjectResult(f)).toBe(true);
    expect(f.load).toHaveBeenCalledWith(result.path);
    expect(f.open).toHaveBeenCalledWith({ ...f.opened, path: undefined });
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("keeps a saved result at its original path", async () => {
    const f = fixture();
    await openAgentProjectResult({ ...f, result: { ...result, workingCopy: false } });
    expect(f.open).toHaveBeenCalledWith(f.opened);
  });
  it("leaves unsaved current edits and the result notice intact when declined", async () => {
    const f = fixture(); f.edit(); f.confirm.mockReturnValue(false);
    expect(await openAgentProjectResult(f)).toBe(false);
    expect(f.session.getSnapshot().history.present.name).toBe("newer current edit");
    expect(f.load).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it.each(["edit", "switch", "save"])("refuses to replace current content after a %s during I/O", async change => {
    const f = fixture();
    f.load.mockImplementation(async () => {
      if (change === "edit") f.edit();
      if (change === "switch") f.session.replaceProject({ ...createDemoProject(), id: "later-project" });
      if (change === "save") f.session.beginSave();
      return f.opened;
    });
    await expect(openAgentProjectResult(f)).rejects.toThrow("載入期間");
    expect(f.open).not.toHaveBeenCalled();
  });
  it("does not start reading while a save is pending", async () => {
    const f = fixture(); f.session.beginSave();
    await expect(openAgentProjectResult(f)).rejects.toThrow("正在儲存");
    expect(f.load).not.toHaveBeenCalled();
  });
  it("refuses a changed project identity at the old result path", async () => {
    const f = fixture(); f.opened.project.id = "unexpected";
    await expect(openAgentProjectResult(f)).rejects.toThrow("內容不符");
    expect(f.open).not.toHaveBeenCalled();
  });
  it("loads only five valid local result entries and tolerates corrupt optional storage", () => {
    expect(parseAgentProjectResults("broken")).toEqual([]);
    expect(parseAgentProjectResults(JSON.stringify([null, { path: "" }, result]))).toEqual([result]);
    expect(parseAgentProjectResults(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ ...result, path: `D:/fixture/${i}` }))))).toHaveLength(5);
  });
});
