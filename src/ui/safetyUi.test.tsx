import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryChoiceDialog } from "./RecoveryChoiceDialog";
import { CloseConfirmDialog } from "./CloseConfirmDialog";
import { FileMenu } from "./FileMenu";
import { AppProblemNotices } from "./ProblemNotice";
import { MissingMediaNotice, ProjectChangedNotice } from "./ShellNotices";
import { AppVersionInfo } from "./AppVersionInfo";
import { Toolbar } from "./Toolbar";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { reportAppProblem, resetAppProblemsForTest } from "../application/appProblemStore";
import type { WindowCloseGuard } from "../desktop/useWindowCloseGuard";
import type { MediaAsset } from "../domain/types";

afterEach(() => { resetAppProblemsForTest(); vi.unstubAllGlobals(); interfacePreferences.setMode("simple"); });

const recovery = (patch = {}) => ({ savedAt: "2026/10/10 下午1:00:00", projectName: "旅行 vlog", projectPath: "D:\\Projects\\trip.editkin.json", savedFileAvailable: true, choose: vi.fn(), ...patch });
const guard = (patch: Partial<WindowCloseGuard> = {}): WindowCloseGuard => ({ asking: true, dirty: true, exporting: false,
  saveAndClose: vi.fn(), closeWithoutSaving: vi.fn(), cancel: vi.fn(), ...patch });

describe("crash recovery: three choices instead of a Cancel that deleted the backup", () => {
  it("offers the recovered copy first, the last saved file, and a 不要了 that asks again", () => {
    const html = renderToStaticMarkup(<RecoveryChoiceDialog request={recovery()} />);
    expect(html).toContain("上次的工作幫你找回來了");
    expect(html).toContain("這是 2026/10/10 下午1:00:00 還沒存的「旅行 vlog」");
    expect(html.indexOf("recovery-restore")).toBeLessThan(html.indexOf("recovery-open-saved"));
    expect(html).toMatch(/class="primary"[^>]*data-testid="recovery-restore"/);
    expect(html).toContain("找回的版本會另外保留，不會刪掉");
    expect(html).toContain("丟掉找回的版本（會再問一次）");
    // 不要了 only opens the confirmation; nothing is chosen from the first screen.
    expect(html).not.toContain("recovery-discard-confirm");
  });

  it("hides the saved-file choice when there is no saved file, and explains a failed open plainly", () => {
    const html = renderToStaticMarkup(<RecoveryChoiceDialog request={recovery({ savedFileAvailable: false, failure: "ENOENT: no such file" })} />);
    expect(html).not.toContain("recovery-open-saved");
    expect(html).toContain("打不開上次存的檔案。你可以打開找回的版本，或選「不要了」。");
    expect(html).toContain("<summary>查看原因</summary><p>ENOENT: no such file</p>");
  });
});

describe("closing the window", () => {
  it("asks to save first when there are unsaved changes", () => {
    const html = renderToStaticMarkup(<CloseConfirmDialog guard={guard()} />);
    expect(html).toContain("要先存檔再關閉嗎？");
    expect(html).toMatch(/class="primary"[^>]*data-testid="close-save-and-close"/);
    expect(html).toContain("不存檔，直接關閉");
    expect(html).toContain('data-testid="close-cancel"');
    expect(html).not.toContain("影片也還在輸出");
    expect(renderToStaticMarkup(<CloseConfirmDialog guard={guard({ exporting: true })} />)).toContain("影片也還在輸出，關閉後會停止。");
  });

  it("asks only about the export when everything is saved, keeping 繼續輸出 as the safe choice", () => {
    const html = renderToStaticMarkup(<CloseConfirmDialog guard={guard({ dirty: false, exporting: true })} />);
    expect(html).toContain("影片還在輸出，要停止並關閉嗎？");
    expect(html).toMatch(/class="primary"[^>]*data-testid="close-cancel"[^>]*>繼續輸出/);
    expect(html).toContain("停止輸出並關閉");
    expect(renderToStaticMarkup(<CloseConfirmDialog guard={guard({ busy: "saving" })} />)).toContain("正在存檔…");
  });
});

describe("the 檔案 menu: Save As and recent projects where people can see them", () => {
  const recent = [{ path: "D:\\Projects\\Taipei\\trip.editkin.json", name: "台北一日遊", openedAt: Date.UTC(2026, 9, 9) }];
  it("lists open, Save As, new and the recent projects on the desktop", () => {
    const html = renderToStaticMarkup(<FileMenu isDesktop editor onNew={vi.fn()} onOpen={vi.fn()} onSaveAs={vi.fn()} recentProjects={recent} onOpenRecent={vi.fn()} />);
    for (const id of ["file-menu", "open-project-button", "save-as-project-button", "new-project-button", "recent-project-0"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("台北一日遊");
    expect(html).toContain("Projects\\Taipei");
    expect(renderToStaticMarkup(<FileMenu isDesktop editor onNew={vi.fn()} onOpen={vi.fn()} onSaveAs={vi.fn()} recentProjects={[]} onOpenRecent={vi.fn()} />))
      .toContain("存過或打開過的專案會出現在這裡");
  });

  it("keeps the browser build honest: no Save As or recent list", () => {
    const html = renderToStaticMarkup(<FileMenu isDesktop={false} editor onNew={vi.fn()} onOpen={vi.fn()} onSaveAs={vi.fn()} recentProjects={recent} onOpenRecent={vi.fn()} />);
    expect(html).not.toContain("save-as-project-button");
    expect(html).not.toContain("最近的作品");
  });

  it("is part of the toolbar, before 儲存, and 更多工具 no longer duplicates new/open", () => {
    // The 檔案 button is advanced mode's toolbar since 2026-10-11 (simple mode puts the same items in ⚙ 設定, below).
    interfacePreferences.setMode("advanced");
    const noop = () => undefined;
    const html = renderToStaticMarkup(<Toolbar projectName="trip" hasUserMedia workspaceMode="editor" theme="sky" onThemeChange={noop} dirty recoveryState="idle"
      playhead={0} canUndo={false} canRedo={false} isDesktop onNew={noop} onOpen={noop} onSave={noop} onUndo={noop} onRedo={noop} onExport={noop}
      onOpenAgentConnect={noop} onCheckUpdates={noop} onDirectorConsole={noop} onHelp={noop} onSaveAs={noop} recentProjects={recent} onOpenRecent={noop} />);
    expect(html.indexOf('data-testid="file-menu"')).toBeLessThan(html.indexOf('data-testid="save-project-button"'));
    expect(html.match(/data-testid="new-project-button"/g)).toHaveLength(1);
    expect(html.match(/data-testid="open-project-button"/g)).toHaveLength(1);
  });

  it("in simple mode lives in ⚙ 設定 → 檔案 instead of its own button, with every item once", () => {
    interfacePreferences.setMode("simple");
    const noop = () => undefined;
    const html = renderToStaticMarkup(<Toolbar projectName="trip" hasUserMedia workspaceMode="editor" theme="sky" onThemeChange={noop} dirty recoveryState="idle"
      playhead={0} canUndo={false} canRedo={false} isDesktop onNew={noop} onOpen={noop} onSave={noop} onUndo={noop} onRedo={noop} onExport={noop}
      onOpenAgentConnect={noop} onCheckUpdates={noop} onDirectorConsole={noop} onHelp={noop} onSaveAs={noop} recentProjects={recent} onOpenRecent={noop} />);
    expect(html).not.toContain('data-testid="file-menu"');
    const settings = html.slice(html.indexOf('data-testid="interface-settings"'));
    for (const id of ["open-project-button", "save-as-project-button", "new-project-button", "recent-project-0"]) {
      expect(html.match(new RegExp(`data-testid="${id}"`, "g")), id).toHaveLength(1);
      expect(settings, id).toContain(`data-testid="${id}"`);
    }
    expect(settings).toContain("台北一日遊");
    expect(settings).toContain("Projects\\Taipei");
  });
});

describe("plain problem notices", () => {
  it("say what failed, what happened and what to do, with the raw reason folded and one main button", () => {
    reportAppProblem("save", new Error("專案已被其他視窗或 Agent 更新（目前 revision 7，你的版本 6）"), [{ label: "另存新檔", run: vi.fn(), primary: true }]);
    const html = renderToStaticMarkup(<AppProblemNotices />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("沒有存檔成功");
    expect(html).toContain("為了不蓋掉那些修改，這次沒有存。");
    expect(html).toContain("請用「另存新檔」把你的版本存成另一個檔案");
    expect(html).toMatch(/<details class="plain-problem-reason"><summary>查看原因<\/summary><p>專案已被其他視窗/);
    expect(html.match(/plain-problem-primary/g)).toHaveLength(1);
  });

  it("lists moved media with a 重新找檔案 button each, and a changed project file with reload or keep-my-copy", () => {
    const assets = [{ id: "a1", name: "IMG_0001.MOV", uri: "D:\\old\\IMG_0001.MOV", kind: "video" }] as MediaAsset[];
    const missing = renderToStaticMarkup(<MissingMediaNotice assets={assets} onRelink={vi.fn()} />);
    expect(missing).toContain("有 1 個素材找不到了");
    expect(missing).toContain('data-testid="desktop-relink-a1"');
    const changedClean = renderToStaticMarkup(<ProjectChangedNotice change={{ kind: "changed", path: "D:\\p.json", revision: 9 }} dirty={false} onReload={vi.fn()} onSaveCopy={vi.fn()} onDismiss={vi.fn()} />);
    expect(changedClean).toContain("專案檔被其他程式改過了");
    expect(changedClean).toContain("載入新的版本");
    expect(changedClean).not.toContain("project-changed-save-copy");
    const changedDirty = renderToStaticMarkup(<ProjectChangedNotice change={{ kind: "changed", path: "D:\\p.json", revision: 9 }} dirty onReload={vi.fn()} onSaveCopy={vi.fn()} onDismiss={vi.fn()} />);
    expect(changedDirty).toContain("把我的版本另存新檔");
    const gone = renderToStaticMarkup(<ProjectChangedNotice change={{ kind: "missing", path: "D:\\p.json" }} dirty={false} onReload={vi.fn()} onSaveCopy={vi.fn()} onDismiss={vi.fn()} />);
    expect(gone).toContain("找不到這個專案檔了");
    expect(gone).not.toContain("project-changed-reload");
  });
});

describe("version in Settings", () => {
  it("renders the about section (the build ID arrives from the desktop host)", () => {
    vi.stubGlobal("window", {});
    const html = renderToStaticMarkup(<AppVersionInfo />);
    expect(html).toContain("關於 Editkin");
    expect(html).toContain('data-testid="app-version-info"');
  });
});
