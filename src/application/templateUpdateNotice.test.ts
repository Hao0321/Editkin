import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { dispatchCommand } from "../domain/history";
import type { EditProject } from "../domain/types";
import { createProjectSession } from "./projectSession";
import { createTemplateUpdateNotice, TEMPLATE_UPDATE_NOTICE_STORAGE_KEY, type TemplateUpdateNoticeState } from "./templateUpdateNotice";
import { publishTemplatesUpdateReport, registerTemplatesUpdateRunner } from "./templatesUpdateRuns";

// The notice's own logic on a real project session; the old-title count and the update runner are stand-ins here (the
// real ones are tested in referenceMotionTemplateUpdates.test.ts and TemplateUpdateNotice.test.tsx).
function project(id: string, revision = 4): EditProject {
  const value = createEmptyProject(id, { id, width: 1080, height: 1920, fps: 30 });
  value.revision = revision;
  return value;
}
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), values };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function notice(initial: EditProject, outdated: Map<string, number>, storage = memoryStorage()) {
  const session = createProjectSession(initial, "D:/projects/old.editkin.json");
  const value = createTemplateUpdateNotice({ session, storage, countOutdated: async item => outdated.get(item.id) ?? 0 });
  stops.push(value.start());
  return { session, notice: value, storage, state: (): TemplateUpdateNoticeState => value.getSnapshot() };
}

describe("the old-titles notice", () => {
  it("is offered when a project with old titles is opened, with how many; a project without them shows nothing", async () => {
    const f = notice(project("old"), new Map([["old", 3]]));
    await settle();
    expect(f.state()).toEqual({ kind: "offer", count: 3, running: false });
    f.session.replaceProject(project("plain"), "D:/projects/plain.editkin.json");
    await settle();
    expect(f.state()).toEqual({ kind: "hidden" });
  });

  it("「先不要」 hides it and does not ask again for that project at that revision; a newer revision is asked once more", async () => {
    const storage = memoryStorage();
    const f = notice(project("old", 4), new Map([["old", 2]]), storage);
    await settle();
    f.notice.dismiss();
    expect(f.state()).toEqual({ kind: "hidden" });
    expect(JSON.parse(storage.values.get(TEMPLATE_UPDATE_NOTICE_STORAGE_KEY)!)).toEqual(["old@4"]);
    // Edits in the same open project do not bring it back.
    f.session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Still old" }));
    await settle();
    expect(f.state()).toEqual({ kind: "hidden" });
    // Opening the same file again (same saved revision): not asked again — also in a new window.
    f.session.replaceProject(project("old", 4), "D:/projects/old.editkin.json");
    await settle();
    expect(f.state()).toEqual({ kind: "hidden" });
    const other = notice(project("old", 4), new Map([["old", 2]]), storage);
    await settle();
    expect(other.state()).toEqual({ kind: "hidden" });
    // The project was saved since (a newer revision): offered once more.
    f.session.replaceProject(project("old", 9), "D:/projects/old.editkin.json");
    await settle();
    expect(f.state()).toEqual({ kind: "offer", count: 2, running: false });
  });

  it("runs the window's update; it shows that it is running, and closes when nothing old is left", async () => {
    const outdated = new Map([["old", 1]]);
    const f = notice(project("old"), outdated);
    await settle();
    let finish!: () => void;
    const runner = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    stops.push(registerTemplatesUpdateRunner(runner));
    const running = f.notice.update();
    expect(f.state()).toEqual({ kind: "offer", count: 1, running: true });
    void f.notice.update(); f.notice.dismiss();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(f.state()).toEqual({ kind: "offer", count: 1, running: true });
    outdated.set("old", 0);
    publishTemplatesUpdateReport("old", { updated: [{ instanceId: "t1", title: "FOCUS" }], notUpdated: [], message: "已更新 1 個標題；文字、字型和配色都保留，一次復原即可還原。" });
    finish(); await running; await settle();
    expect(f.state()).toEqual({ kind: "hidden" });
    // Undo brings the old titles back, but the notice stays closed in this open project.
    outdated.set("old", 1);
    f.session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Undo-like change" }));
    await settle();
    expect(f.state()).toEqual({ kind: "hidden" });
  });

  it("lists the titles an update left behind and why, from here or from the template editor, until 「知道了」", async () => {
    const f = notice(project("old"), new Map([["old", 2]]));
    await settle();
    f.notice.dismiss();
    const report = { updated: [{ instanceId: "t1", title: "FOCUS" }], notUpdated: [{ instanceId: "t2", title: "BATS", reason: "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。" }],
      message: "已更新 1 個標題；「BATS」沒有更新，原因列在標題更新提示裡；一次復原即可還原。" };
    // Another project's report is not this one's business.
    publishTemplatesUpdateReport("someone-else", report);
    expect(f.state()).toEqual({ kind: "hidden" });
    publishTemplatesUpdateReport("old", report);
    expect(f.state()).toMatchObject({ kind: "result", report: { projectId: "old", ...report } });
    f.notice.dismiss();
    expect(f.state()).toEqual({ kind: "hidden" });
  });

  it("works without browser storage (blocked or failing): it is simply asked again next time", async () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const f = notice(project("old"), new Map([["old", 1]]), broken as never);
    await settle();
    expect(f.state()).toEqual({ kind: "offer", count: 1, running: false });
    f.notice.dismiss();
    expect(f.state()).toEqual({ kind: "hidden" });
  });
});
