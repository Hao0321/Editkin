import { readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toolbar } from "./Toolbar";
import { InterfaceSettings } from "./InterfaceSettings";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { PROJECT_FORMATS } from "../application/projectFormats";
import { AgentHelpButton, AgentHelpButtonLive } from "./agentConnect/AgentHelpEntryV1";
import { agentRuntimeRepairV1 } from "./agentConnect/agentRuntimeRepairV1";

// Simple mode's editor top bar (2026-10-11): one row with the app mark, the project's name and save state, 復原／重做,
// ⚙ 設定, ? 說明 and the one main 輸出影片. Static React markup and handler doubles; the real layout at 1440×900,
// 1280×720 and 800×560 in zh-TW and English is in .rd/benchmarks/usable-v1-20261009/work/simple-declutter-20261011.
// useRef/useEffect doubles let InterfaceSettings be called directly for its switch's handler (no DOM here).
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

const noop = () => {};
const recent = [{ path: "D:\\Projects\\Taipei\\trip.editkin.json", name: "台北一日遊", openedAt: Date.UTC(2026, 9, 9) }];
function render(patch: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  const props: Parameters<typeof Toolbar>[0] = { projectName: "我的第一支影片", hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop,
    dirty: false, recoveryState: "idle", playhead: 0, canUndo: true, canRedo: false, isDesktop: true, hasProjectFile: true, onNew: noop, onOpen: noop,
    onSave: noop, onUndo: noop, onRedo: noop, onExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onHelp: noop,
    onAutoEdit: noop, onAddMedia: noop, onEdit: noop, onSaveAs: noop, recentProjects: recent, onOpenRecent: noop,
    textSize: "large", onTextSizeChange: noop, projectFormat: { width: 1920, height: 1080, onChange: noop },
    workspaceControls: <details data-testid="workspace-controls"><summary>工作區</summary></details>, ...patch };
  return renderToStaticMarkup(<Toolbar {...props} />);
}
/** The bar without the ⚙ popover's body: what is on screen while ⚙ is closed. */
const bar = (html: string) => html.replace(/<div class="interface-settings-body">[\s\S]*?<\/div><\/details>/, "</details>");
const controls = (html: string) => [...html.matchAll(/<(button|summary|select|input)\b[^>]*>/g)].map(match => match[0]);
const settingsBody = (html: string) => html.slice(html.indexOf('<div class="interface-settings-body">'));

afterEach(async () => { interfacePreferences.setMode("simple"); await interfacePreferences.setLocale("zh-TW"); });

describe("simple mode's one-row editor top bar", () => {
  it("shows only 復原, 重做, ⚙ 設定, ? 說明, 讓 AI 幫我剪片 and 輸出影片 while ⚙ is closed (a saved desktop project)", () => {
    const html = render();
    const visible = controls(bar(html));
    expect(visible).toHaveLength(6);
    expect(visible[0]).toContain('data-testid="undo-button"');
    expect(visible[1]).toContain('data-testid="redo-button"');
    expect(visible[2]).toMatch(/^<summary aria-label="介面設定"/);
    expect(visible[3]).toContain('data-testid="beginner-guide-button"');
    expect(visible[4]).toContain('data-testid="simple-ai-help"');
    expect(visible[5]).toContain('data-testid="render-button"');
    expect(bar(html)).toContain("<span>讓 AI 幫我剪片</span></button>");
    expect(bar(html)).toContain(">設定</span>");
    expect(bar(html)).toContain("說明</button>");
    expect(bar(html)).toContain("輸出影片</button>");
    expect(html).toContain('data-toolbar-layout="simple"');
  });

  it("drops the four steps, 更多工具, the 檔案 button and the separate save／download button from the bar", () => {
    const html = render(), outside = bar(html);
    for (const id of ["flow-step-1", "flow-step-4", "file-menu", "director-console-button", "semantic-edit-button", "workspace-controls"]) expect(html, id).not.toContain(`data-testid="${id}"`);
    expect(html).not.toContain('class="project-menu');
    expect(html).not.toContain('class="quick-flow"');
    expect(outside).not.toContain("下載專案");
    expect(outside).not.toContain('data-testid="save-project-button"');
  });

  it("makes 復原 and 重做 icon buttons with a name, a tooltip and their keys", () => {
    const html = render();
    expect(html).toMatch(/data-testid="undo-button" aria-label="復原" title="復原（Ctrl\/Cmd\+Z）" aria-keyshortcuts="Control\+Z Meta\+Z"><span aria-hidden="true">↶<\/span><\/button>/);
    expect(html).toMatch(/disabled="" data-testid="redo-button" aria-label="重做" title="重做（Ctrl\/Cmd\+Shift\+Z）" aria-keyshortcuts="Control\+Shift\+Z Meta\+Shift\+Z"><span aria-hidden="true">↷<\/span><\/button>/);
  });

  it("keeps the start screen and advanced mode on the full toolbar", () => {
    expect(render({ workspaceMode: "welcome" })).not.toContain('data-toolbar-layout="simple"');
    interfacePreferences.setMode("advanced");
    const html = render();
    expect(html).not.toContain('data-toolbar-layout="simple"');
    for (const id of ["flow-step-1", "flow-step-3", "file-menu", "save-project-button", "semantic-edit-button", "workspace-controls", "theme-select"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    // Updated 2026-10-22 (P8): the four editing workspaces (interfaceMessages.70) replaced the 檢查 step and the 導演台
    // button; the bar is 加入影片 → 剪輯 → 輸出 and markers are made with M on the timeline.
    for (const id of ["flow-step-4", "director-console-button"]) expect(html, id).not.toContain(`data-testid="${id}"`);
    expect(html).toContain("快速教學");
  });
});

describe("⚙ 設定 in the simple editor", () => {
  it("holds language, size, theme, text size, the project shape, the files and the 進階模式 switch, in that order", () => {
    const body = settingsBody(render());
    const order = ["ui-language-select", "ui-scale-select", "theme-select", "text-size-select", "project-format-control", "open-project-button",
      "save-as-project-button", "new-project-button", "recent-project-0", "advanced-mode-switch"].map(id => body.indexOf(`data-testid="${id}"`));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("台北一日遊");
  });

  it("offers every project shape once and marks the current one", () => {
    const body = settingsBody(render({ projectFormat: { width: 1080, height: 1920, onChange: noop } }));
    for (const format of PROJECT_FORMATS) expect(body.split(`data-testid="project-format-${format.id}"`)).toHaveLength(2);
    expect(body).toMatch(/<button type="button" aria-pressed="true" data-testid="project-format-vertical"/);
    expect(body.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(body).toMatch(/data-testid="project-format-control" data-project-width="1080" data-project-height="1920"/);
  });

  it("keeps the browser honest: 下載專案 is there, Save As and recent projects are not", () => {
    const body = settingsBody(render({ isDesktop: false }));
    expect(body).toMatch(/data-testid="save-project-button" title="送出下載；不會標記已儲存，也沒有 Autosave。">下載專案<\/button>/);
    expect(body).not.toContain("save-as-project-button");
    expect(body).not.toContain("recent-project-0");
  });

  it("names its button 設定 in every language, and the 進階模式 switch flips the mode", async () => {
    for (const locale of ["en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      const html = render();
      expect(bar(html)).toContain(`>${interfacePreferences.translate("設定")}</span>`);
      expect(html).toContain(interfacePreferences.translate("顯示全部專業工具"));
      // Japanese writes 設定 the same way; elsewhere no Chinese 設定 is left.
      if (interfacePreferences.translate("設定") !== "設定") expect(html).not.toContain(">設定<");
    }
    await interfacePreferences.setLocale("zh-TW");
    const html = render();
    expect(html).toMatch(/<button type="button" role="switch" aria-checked="false" class="interface-mode-switch" data-testid="advanced-mode-switch">/);
    const tree = InterfaceSettings({ label: "設定" });
    const find = (node: ReactNode): Record<string, unknown> | undefined => {
      if (Array.isArray(node)) { for (const child of node) { const found = find(child); if (found) return found; } return undefined; }
      if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(node)) return undefined;
      return node.props["data-testid"] === "advanced-mode-switch" ? node.props : find(node.props.children);
    };
    const toggle = find(tree)!;
    (toggle.onClick as () => void)();
    expect(interfacePreferences.getSnapshot().mode).toBe("advanced");
    expect(render()).not.toContain('data-toolbar-layout="simple"');
    (find(InterfaceSettings({ label: "設定" }))!.onClick as () => void)();
    expect(interfacePreferences.getSnapshot().mode).toBe("simple");
  });

  it("keeps the start screen's ⚙ as before: language and size in the button, no editor sections", () => {
    const html = renderToStaticMarkup(<InterfaceSettings />);
    expect(html).toMatch(/<summary aria-label="介面設定"><span aria-hidden="true">⚙<\/span><span>繁體中文<\/span><small>100%<\/small><\/summary>/);
    for (const id of ["theme-select", "project-format-control", "open-project-button"]) expect(html).not.toContain(`data-testid="${id}"`);
    expect(html).toContain('data-testid="advanced-mode-switch"');
  });
});

describe("the editor shell's simple layout (source wiring; the screens are in the headless captures)", () => {
  const shell = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8");
  it("passes the text size and the project shape to the top bar", () => {
    expect(shell).toContain("textSize={workspace.layout.textSize}");
    expect(shell).toContain("onTextSizeChange={(textSize) => workspace.patch({ textSize })}");
    expect(shell).toContain("projectFormat={{ width: project.width, height: project.height, onChange: changeProjectFormat }}");
  });
  it("keeps the 影片類型 row, the footer's save state and project shape, and the engineering panel sections in advanced mode", () => {
    expect(shell).toContain("{!simpleMode && <Suspense fallback={null}><EditingProfilePicker");
    expect(shell).toContain('{!simpleMode && <span data-testid="save-state">');
    expect(shell).toContain('{!simpleMode && <details className="project-format-control"');
    // Updated 2026-10-22 (P8): since the four editing workspaces these panels are scoped by workspace inside the Inspector,
    // not by mode. 字幕檢查與匯出 has its own simple-mode face (a 尋找取代 button, CaptionDelivery.tsx); 3D and saved original
    // scenes sit in 特效. (Whether 立體 Motion 場景 belongs in simple mode's 特效 is left to the design owner.)
    expect(shell).toContain('onCaptionCommand={command => runCommand(command, "已修正字幕句尾時間，可復原。 ")}');
    // Updated 2026-10-23 (P6/P7 pack): the design owner ruled 立體 Motion 場景 and saved original scenes advanced-only (the
    // 2026-10-11 simple-mode rule), so simple mode passes neither to the Inspector and its 特效 shows neither.
    expect(shell).toContain('onMesh3dCommand={simpleMode ? undefined : command => runCommand(command, "已更新可編輯 3D 場景，可復原。 ")}');
    expect(shell).toContain("originalMotionScenesControl={simpleMode ? undefined : <SavedOriginalMotionScenes");
    const inspector = readFileSync(new URL("./Inspector.tsx", import.meta.url), "utf8");
    expect(inspector).toContain("(isEditing ? <CaptionDelivery");
    expect(inspector).toContain("(isEffects ? <Mesh3dControls");
    expect(inspector).toContain("{isEffects && originalMotionScenesControl}");
  });
  it("gives simple mode one calm layout that an old saved layout cannot change", () => {
    // Updated 2026-10-22 (P8): the fixed four-workspace layout always shows the media panel and the timeline, in both modes
    // (the 外觀與工作區 panel switches are no longer mounted), so no saved layout can hide them; automation stays advanced-only.
    expect(shell).toContain("const mediaShown = true;");
    expect(shell).toContain("const timelineShown = true;");
    expect(shell).toContain('const automationShown = activeWorkspace === "edit" && !simpleMode && workspace.layout.automationVisible;');
    // Updated 2026-10-23 (P6/P7 pack): the never-read selectionPanelOpen state is removed. A wide window always shows the
    // panel (empty state 點一下片段或字幕); a narrow one shows the picked item's 屬性面板 tab, and any new mode starts on 預覽.
    expect(shell).not.toContain("selectionPanelOpen");
    expect(shell).toContain('const inspectorShown = compactWorkspace ? compactPane === "inspector" : true;');
    expect(shell).toContain('if (simpleMode && compactWorkspace) setCompactPane("inspector");');
  });
  it("hides the second play button and the engine badges over the preview in simple mode", () => {
    const css = readFileSync(new URL("./simpleWorkspace.css", import.meta.url), "utf8");
    expect(css).toContain('.app-shell[data-interface-mode="simple"] :is(.preview-play, .native-preview-play) { display: none; }');
    expect(css).toContain(':is([data-testid="professional-engine-tools"], [data-testid="inspector-advanced"], [data-testid="clip-in-point"])');
    const preview = readFileSync(new URL("./Preview.tsx", import.meta.url), "utf8");
    expect(preview).toContain('<span data-preview-detail="engine">');
  });
});

// 2026-10-23 (release-notes blocker, Area D action 2): simple mode has no 更多工具, so ⚙ 設定 carried 「連接 AI 助手」.
// 2026-10-29 (Hao: 傻瓜化): 「讓 AI 幫我剪片」 is in the bar itself; ⚙ 設定 › AI 協助剪輯 keeps the same words.
describe("讓 AI 幫我剪片 in the simple editor", () => {
  const find = (node: ReactNode, id: string): { props: Record<string, any> } | undefined => {
    if (Array.isArray(node)) { for (const child of node) { const found = find(child, id); if (found) return found; } return undefined; }
    if (!isValidElement<Record<string, any>>(node)) return undefined;
    if (node.props["data-testid"] === id) return node;
    return find(node.props.children, id);
  };
  it("is a button in the bar on the desktop (no switch to 進階模式, no ⚙) and opens the Agent Connect dialog", async () => {
    const { SimpleEditorTopBar } = await import("./SimpleEditorTopBar");
    const open = vi.fn(), html = render({ onOpenAgentConnect: open });
    expect(bar(html)).toMatch(/<button type="button" class="agent-help-button" data-testid="simple-ai-help"><svg[^>]*>[\s\S]*?<\/svg><span>讓 AI 幫我剪片<\/span><\/button>/);
    const props = { projectName: "P", hasUserMedia: true, isDesktop: true, dirty: false, recoveryState: "idle" as const, canUndo: false, canRedo: false, theme: "sky" as const,
      onThemeChange: noop, onUndo: noop, onRedo: noop, onSave: noop, onNew: noop, onOpen: noop, onHelp: noop, onExport: noop, onOpenAgentConnect: open };
    // The bar's button is its own (hook-free) component: expand it to reach the real button's handler.
    const expandFind = (node: ReactNode): { props: Record<string, any> } | undefined => {
      if (Array.isArray(node)) { for (const child of node) { const found = expandFind(child); if (found) return found; } return undefined; }
      if (!isValidElement<Record<string, any>>(node)) return undefined;
      if (node.type === AgentHelpButtonLive) return expandFind(AgentHelpButtonLive(node.props as Parameters<typeof AgentHelpButtonLive>[0]));
      if (node.type === AgentHelpButton) return expandFind(AgentHelpButton(node.props as Parameters<typeof AgentHelpButton>[0]));
      if (node.props["data-testid"] === "simple-ai-help") return node;
      return expandFind(node.props.children);
    };
    expandFind(SimpleEditorTopBar(props))!.props.onClick();
    expect(open).toHaveBeenCalledOnce();
  });
  it("⚙ 設定 › AI 協助剪輯 says the same 讓 AI 幫我剪片, closes ⚙ and opens the dialog", async () => {
    const { SimpleEditorTopBar } = await import("./SimpleEditorTopBar");
    const open = vi.fn(), html = render({ onOpenAgentConnect: open });
    expect(settingsBody(html)).toContain('data-testid="simple-agent-connect"');
    expect(settingsBody(html)).toContain("AI 協助剪輯");
    expect(settingsBody(html)).toMatch(/data-testid="simple-agent-connect">讓 AI 幫我剪片<\/button>/);
    expect(bar(html)).not.toContain("simple-agent-connect");
    const props = { projectName: "P", hasUserMedia: true, isDesktop: true, dirty: false, recoveryState: "idle" as const, canUndo: false, canRedo: false, theme: "sky" as const,
      onThemeChange: noop, onUndo: noop, onRedo: noop, onSave: noop, onNew: noop, onOpen: noop, onHelp: noop, onExport: noop, onOpenAgentConnect: open };
    const button = find(SimpleEditorTopBar(props), "simple-agent-connect")!;
    const menu = { removeAttribute: vi.fn() };
    button.props.onClick({ currentTarget: { closest: (selector: string) => selector === "details" ? menu : null } });
    expect(menu.removeAttribute).toHaveBeenCalledWith("open");
    expect(open).toHaveBeenCalledOnce();
  });
  it("after an Editkin update whose refresh failed, the bar button says 重新連一次 AI", () => {
    agentRuntimeRepairV1.publish({ state: "failed" });
    try {
      expect(bar(render())).toMatch(/class="agent-help-button" data-repair="true" data-testid="simple-ai-help" title="Editkin 更新後要重新連一次 AI">[\s\S]*?<span>重新連一次 AI<\/span>/);
    } finally { agentRuntimeRepairV1.markConnected(); }
  });
  it("is absent in the browser build", () => {
    const html = render({ isDesktop: false, onOpenAgentConnect: noop });
    expect(html).not.toContain("simple-agent-connect");
    expect(html).not.toContain("simple-ai-help");
  });
  it("reads the same in English", async () => {
    await interfacePreferences.setLocale("en");
    expect(bar(render())).toContain("<span>Let AI edit for me</span></button>");
  }, 120_000);
});
