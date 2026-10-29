import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSession } from "../application/projectSession";
import { inspectReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import { instanceOf, oldTitlesProject, physicalTemplateText } from "../application/oldTitleTemplatesFixture";
import { latestTemplatesUpdateReport } from "../application/templatesUpdateRuns";
import { dispatchCommand, undo } from "../domain/history";
import type { EditorCommand } from "../domain/commandTypes";
// The real translations; only the hook that subscribes to them is a plain call, so the component can also be called directly.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { runTemplatesUpdate, TemplateUpdateNotice, TEMPLATES_UPDATE_RUNNING } from "./TemplateUpdateNotice";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const byTestId = (tree: ReactNode, id: string) => elements(tree).find(element => element.props["data-testid"] === id);
/** The production component rendered for real (server markup), and its element tree for the button handlers. */
function shown(state: Parameters<typeof TemplateUpdateNotice>[0]["state"]) {
  return { html: renderToStaticMarkup(<TemplateUpdateNotice state={state} onUpdate={vi.fn()} onDismiss={vi.fn()} />) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the old-titles notice in the editor", () => {
  it("is one calm line with 「把標題更新到新版」 and 「先不要」, not a dialog", () => {
    const f = shown({ kind: "offer", count: 3, running: false });
    expect(f.html).toContain("這個專案有 3 個標題是舊版模板做的；更新到新版後就能繼續改字，文字都會保留。");
    expect(f.html).toContain("把標題更新到新版");
    expect(f.html).toContain("先不要");
    expect(f.html).toContain('role="status"');
    expect(f.html).not.toMatch(/role="(alert)?dialog"|aria-modal/);
    expect(f.html).toContain('data-state="offer"');
  });
  it("says it is updating and cannot be pressed twice while it runs", () => {
    const f = shown({ kind: "offer", count: 3, running: true });
    expect(f.html).toContain("正在更新…");
    expect(f.html).toMatch(/data-testid="template-update-run"[^>]*disabled=""/);
    expect(f.html).toMatch(/data-testid="template-update-dismiss"[^>]*disabled=""/);
  });
  it("after an update, lists each title left behind with its plain reason until 「知道了」", () => {
    const report = { episode: 1, projectId: "p", updated: [{ instanceId: "t1", title: "FOCUS" }], message: "",
      notUpdated: [{ instanceId: "t2", title: "BATS", reason: "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。" }] };
    const f = shown({ kind: "result", report });
    expect(f.html).toContain("已更新 1 個標題；下面的標題沒有更新：");
    expect(f.html).toContain("<b>BATS</b>片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。");
    expect(f.html).toContain("知道了");
    expect(shown({ kind: "result", report: { ...report, updated: [] } }).html).toContain("下面的標題沒有更新：");
    expect(renderToStaticMarkup(<TemplateUpdateNotice state={{ kind: "hidden" }} onUpdate={vi.fn()} onDismiss={vi.fn()} />)).toBe("");
  });
  it("its buttons call the update and the dismissal", () => {
    const onUpdate = vi.fn(), onDismiss = vi.fn();
    const offer = TemplateUpdateNotice({ state: { kind: "offer", count: 1, running: false }, onUpdate, onDismiss });
    (byTestId(offer, "template-update-run")!.props.onClick as () => void)();
    (byTestId(offer, "template-update-dismiss")!.props.onClick as () => void)();
    expect([onUpdate.mock.calls.length, onDismiss.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("「把標題更新到新版」 from the notice: the editor's own template runner, one command, one Undo", () => {
  async function host() {
    const f = await oldTitlesProject();
    const session = createProjectSession(f.project, "D:/projects/old.editkin.json");
    const statuses: string[] = [], commands: EditorCommand[] = [];
    const runCommand = vi.fn((command: EditorCommand, message?: string) => {
      commands.push(command);
      session.setHistory(history => dispatchCommand(history, command));
      if (message) statuses.push(message);
      return true;
    });
    const pausePlayback = vi.fn();
    const createTextPreparer = () => ({ prepareText: physicalTemplateText, dispose: () => undefined });
    return { f, session, statuses, commands, runCommand, pausePlayback,
      run: () => runTemplatesUpdate({ session, runCommand, setStatus: message => { statuses.push(message); }, pausePlayback, createTextPreparer }) };
  }

  it("updates the old titles in one command, says so plainly, publishes what it left behind, and one Undo restores everything", async () => {
    const h = await host();
    expect(await h.run()).toBe("APPLIED");
    expect(h.pausePlayback).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual([TEMPLATES_UPDATE_RUNNING, "已更新 1 個標題；2 個標題沒有更新，原因列在標題更新提示裡；一次復原即可還原。"]);
    expect(h.commands).toHaveLength(1);
    const present = h.session.getSnapshot().history.present;
    expect((await inspectReferenceMotionTemplateInstance(present, h.f.ids.fresh)).status).toBe("CURRENT");
    expect(instanceOf(present, h.f.ids.fresh).input.title).toBe("FOCUS");
    expect(latestTemplatesUpdateReport()).toMatchObject({ projectId: h.f.project.id, updated: [{ instanceId: h.f.ids.fresh }],
      notUpdated: [{ instanceId: h.f.ids.edited }, { instanceId: h.f.ids.short }] });
    h.session.setHistory(history => undo(history));
    expect(h.session.getSnapshot().history.present).toEqual(h.f.project);
  }, 120_000);

  it("a second time changes nothing", async () => {
    const h = await host();
    await h.run();
    const after = h.session.getSnapshot().history.present;
    expect(await h.run()).toBe("UNCHANGED");
    expect(h.commands).toHaveLength(1);
    expect(h.session.getSnapshot().history.present).toBe(after);
    expect(h.statuses.at(-1)).toBe("標題沒有更新：2 個標題不能自動更新，原因列在標題更新提示裡。");
  }, 120_000);

  it("applies nothing when the project changes while it runs", async () => {
    const h = await host();
    const running = h.run();
    // Another edit lands while the titles are being laid out again.
    h.session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Changed meanwhile" }));
    expect(await running).not.toBe("APPLIED");
    expect(h.commands).toHaveLength(0);
    expect(h.session.getSnapshot().history.present.name).toBe("Changed meanwhile");
    expect((await inspectReferenceMotionTemplateInstance(h.session.getSnapshot().history.present, h.f.ids.fresh)).status).toBe("ENVIRONMENT_CHANGED");
  }, 120_000);
});
