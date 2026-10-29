import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toolbar } from "./Toolbar";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { playheadAfterProjectChange } from "./playheadBounds";

const noop = () => {};
function toolbar(patch: Partial<Parameters<typeof Toolbar>[0]>) {
  const props: Parameters<typeof Toolbar>[0] = { projectName: "我的第一支影片", hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop,
    dirty: false, recoveryState: "idle", playhead: 0, canUndo: false, canRedo: false, isDesktop: true, onNew: noop, onOpen: noop, onSave: noop,
    onUndo: noop, onRedo: noop, onExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onHelp: noop, ...patch };
  return renderToStaticMarkup(<Toolbar {...props} />);
}
const heading = (html: string) => html.match(/<div class="project-heading">.*?<\/div>/)?.[0] ?? "";

afterEach(() => interfacePreferences.setMode("simple"));

// The heading with the 儲存 button is advanced mode's toolbar since 2026-10-11; simple mode's top bar shows the same
// honest state next to the project name (checked in the next block).
describe("a project that was never written to a file is not shown as saved", () => {
  beforeEach(() => interfacePreferences.setMode("advanced"));
  it("says it has no project file yet, offers to save and marks the state dot", () => {
    const html = toolbar({ hasProjectFile: false });
    expect(heading(html)).toContain("還沒存成專案檔");
    expect(heading(html)).not.toContain("已儲存");
    expect(heading(html)).toContain('class="status-dot dirty"');
    expect(html).toMatch(/data-testid="save-project-button" title="儲存專案"/);
    expect(html).not.toContain("已安全儲存");
  });

  it("keeps 已儲存 for a project that is clean against its file, and 尚未儲存 for changes", () => {
    expect(heading(toolbar({ hasProjectFile: true }))).toContain("已儲存");
    expect(toolbar({ hasProjectFile: true })).toContain('title="已安全儲存"');
    expect(heading(toolbar({ hasProjectFile: false, dirty: true }))).toContain("尚未儲存");
    // Callers that do not know about files keep the previous behaviour.
    expect(heading(toolbar({}))).toContain("已儲存");
  });
});

describe("simple mode's top bar says the same honest save state", () => {
  beforeEach(() => interfacePreferences.setMode("simple"));
  const state = (html: string) => html.match(/<(?:button|span)[^>]*class="simple-save-state"[^>]*>.*?<\/(?:button|span)>(?=<\/div>)/)?.[0] ?? "";

  it("offers to save a desktop project that has no file yet, with the unsaved dot, and never says 已儲存", () => {
    const html = toolbar({ hasProjectFile: false });
    expect(state(html)).toContain("還沒存成專案檔");
    expect(state(html)).not.toContain("已儲存");
    expect(state(html)).toContain('class="status-dot dirty"');
    expect(html).toMatch(/<button type="button" class="simple-save-state" data-state="unsaved" data-testid="save-project-button" title="儲存專案（Ctrl\+S）"/);
  });

  it("says 已儲存 without a save button when the file is up to date, and offers saving again after a change", () => {
    const clean = toolbar({ hasProjectFile: true });
    expect(state(clean)).toContain("已儲存");
    expect(state(clean)).toContain('class="status-dot"');
    expect(clean).not.toContain('data-testid="save-project-button"');
    const changed = toolbar({ hasProjectFile: true, dirty: true, recoveryState: "saved" });
    expect(state(changed)).toContain("還沒儲存（已自動備份）");
    expect(changed).toContain('data-testid="save-project-button"');
  });

  it("in a browser, says there is nothing to save until a change, and puts 下載專案 in ⚙ 設定 → 檔案", () => {
    const web = toolbar({ isDesktop: false, hasProjectFile: false });
    expect(state(web)).toContain("還沒有修改");
    expect(state(web)).toContain('class="status-dot"');
    const dirty = toolbar({ isDesktop: false, dirty: true });
    expect(state(dirty)).toContain("還沒儲存，請下載專案");
    const settings = dirty.slice(dirty.indexOf('data-testid="interface-settings"'));
    expect(settings).toMatch(/data-testid="save-project-button" title="送出下載；不會標記已儲存，也沒有 Autosave。">下載專案</);
  });
});

describe("the playhead follows the project when it becomes shorter", () => {
  it("returns the clamped playhead only when it is past the real end", () => {
    expect(playheadAfterProjectChange(10, 6)).toBe(6);
    expect(playheadAfterProjectChange(4, 6)).toBeUndefined();
    expect(playheadAfterProjectChange(6, 6)).toBeUndefined();
    expect(playheadAfterProjectChange(3, 0)).toBe(0);
    expect(playheadAfterProjectChange(Number.NaN, 6)).toBeUndefined();
  });
});

// AST/source wiring evidence for the shell; native window, focus and installed-app behaviour are not measured here.
describe("editor shell wiring", () => {
  const text = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("EditorShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const element = (name: string) => {
    let found: ts.JsxSelfClosingElement | undefined;
    const visit = (node: ts.Node) => { if (!found && ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === name) found = node; ts.forEachChild(node, visit); };
    visit(source);
    if (!found) throw new Error(`missing <${name}>`);
    return Object.fromEntries(found.attributes.properties.filter(ts.isJsxAttribute).map(attr => [attr.name.getText(source), attr.initializer?.getText(source)]));
  };

  it("passes longer clips, in-points and refusals to the real Timeline and Inspector", () => {
    const timeline = element("Timeline");
    expect(timeline.onExtendClip).toBe("{clipSourceEdits.extendClip}");
    expect(timeline.onSlipClip).toBe("{clipSourceEdits.slipClip}");
    expect(timeline.onEditRefused).toBe("{setStatus}");
    expect(timeline.onSeek).toBe("{(time) => { pausePlayback(); setPlayhead(clampProjectSeek(time, duration)); }}");
    const inspector = element("Inspector");
    expect(inspector.sourceTimingProject).toBe("{project}");
    expect(inspector.onSlipClip).toBe("{(sourceStart) => selectedClip ? clipSourceEdits.slipClip(selectedClip.id, sourceStart) : false}");
    expect(text).toContain("createClipSourceEditActions({ getProject: () => props.projectSession.getSnapshot().history.present, runCommand, setStatus })");
  });

  it("reports empty Undo/Redo honestly, shows the file state and calls the snapshot crash recovery", () => {
    const bar = element("Toolbar");
    expect(bar.hasProjectFile).toBe("{hasProjectFile}");
    expect(bar.onUndo).toBe("{() => history.past.length ? undoEdit() : setStatus(NOTHING_TO_UNDO)}");
    expect(bar.onRedo).toBe("{() => history.future.length ? redoEdit() : setStatus(NOTHING_TO_REDO)}");
    expect(text).toContain("useHistoryShortcutGuard(history.past.length > 0, history.future.length > 0, setStatus);");
    expect(text).toContain("useProjectEndPlayheadClamp(playhead, duration, setPlayhead);");
    expect(text).toContain("{t(saveStateMessage({ mode, isDesktop, dirty: recovery.dirty, recoveryState: recovery.recoveryState, hasProjectFile }))}");
    expect(readFileSync(new URL("./saveStateLabel.ts", import.meta.url), "utf8")).toContain('return hasProjectFile ? "所有變更已儲存" : "還沒存成專案檔";');
    expect(text).toContain('t("桌面版 · 即時預覽 · 當機復原")');
    for (const old of ['t("桌面版 · 即時預覽 · 自動儲存")', 't("未儲存 · Autosave 安全")', 't("未儲存 · Autosave 失敗")', 't("未儲存 · Autosave…")']) expect(text).not.toContain(old);
    expect(text).not.toContain("Math.max(duration, 12)");
    const recovery = readFileSync(new URL("../desktop/useProjectRecovery.ts", import.meta.url), "utf8");
    expect(recovery).toContain('recoveryFailureMessage(error, "當機復原備份失敗")');
    expect(recovery).not.toMatch(/有效 autosave|"Autosave 失敗"/);
  });
});
