import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";
import { interfacePreferences, UI_LOCALES } from "./i18n/interfacePreferences";

const noop = () => {};
function fixture(): TimelineProps {
  const project = createDemoProject();
  project.captions.push({ id: "caption-original", text: "原文 日本語 한국어 {count}", start: 1, duration: 3 });
  return { project, duration: 12, playhead: 1, runtimeUrls: {}, selectedCaptionId: "caption-original",
    onSeek: noop, onSelect: noop, onSelectCaption: noop, onMoveClip: noop, onMoveCaption: noop,
    onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onEditSelection: noop, onAddTrack: noop,
    onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop,
    onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop };
}

// Static React markup checks placement and semantics, not browser geometry.
function primaryAccessDefects(html: string, selectionLabel: string): string[] {
  const disclosure = html.indexOf('<details class="timeline-more"');
  return ["add-caption-button", "edit-selection-button"].flatMap(id => {
    const buttons = [...html.matchAll(new RegExp(`<button\\b([^>]*\\bdata-testid="${id}"[^>]*)>([\\s\\S]*?)</button>`, "g"))];
    if (buttons.length !== 1) return [`${id}: count`];
    const button = buttons[0];
    if (disclosure < 0 || button.index! > disclosure) return [`${id}: hidden`];
    if (/(?:^|\s)disabled(?:\s|=|$)/.test(button[1])) return [`${id}: disabled`];
    if (id === "edit-selection-button" && !button[2].includes(selectionLabel)) return [`${id}: label`];
    return [];
  });
}

afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); interfacePreferences.setMode("simple"); });

// Since 2026-10-11 the 調整片段／調整字幕 button is an advanced-mode tool: simple mode (the default) has no such button,
// because picking a clip or text opens its panel by itself (see "simple mode: picking opens the panel" below). These
// checks of the button therefore run in advanced mode, where it keeps every earlier behaviour.
describe("primary selection editing access", () => {
  beforeEach(() => { interfacePreferences.setMode("advanced"); });
  const positive = '<button data-testid="add-caption-button">＋ 文字</button><button data-testid="edit-selection-button">調整字幕</button><details class="timeline-more"></details>';
  it("calibrates a reachable known-good control", () => { expect(primaryAccessDefects(positive, "調整字幕")).toEqual([]); });
  it.each([
    ["missing edit action", positive.replace(/<button data-testid="edit-selection-button">.*?<\/button>/, "")],
    ["hidden text action", positive.replace('<details class="timeline-more">', '').replace('<button data-testid="add-caption-button">', '<details class="timeline-more"><button data-testid="add-caption-button">')],
    ["disabled selected action", positive.replace('<button data-testid="edit-selection-button"', '<button disabled="" data-testid="edit-selection-button"')],
    ["wrong selection label", positive.replace("調整字幕", "調整片段")],
    ["duplicate action", positive.replace('</details>', '</details><button data-testid="edit-selection-button">調整字幕</button>')],
  ])("calibration rejects %s", (_name, html) => { expect(primaryAccessDefects(html, "調整字幕").length).toBeGreaterThan(0); });

  it("offers the main text and caption actions without extra tools", () => {
    expect(primaryAccessDefects(renderToStaticMarkup(<Timeline {...fixture()} />), "調整字幕")).toEqual([]);
  });

  it.each(UI_LOCALES)("keeps both clip and caption actions visible in %s without changing author data", async locale => {
    await interfacePreferences.setLocale(locale);
    const value = fixture(), before = JSON.stringify(value.project);
    for (const kind of ["caption", "clip"] as const) {
      value.selectedCaptionId = kind === "caption" ? "caption-original" : undefined;
      value.selectedClipId = kind === "clip" ? "clip-demo" : undefined;
      const html = renderToStaticMarkup(<Timeline {...value} />);
      expect(primaryAccessDefects(html, interfacePreferences.translate(kind === "caption" ? "調整字幕" : "調整片段"))).toEqual([]);
      expect(html).toContain("原文 日本語 한국어 {count}");
    }
    expect(JSON.stringify(value.project)).toBe(before);
  });

  it.each(["none", "stale"])("disables properties for %s selection", selection => {
    const value = fixture();
    value.selectedCaptionId = selection === "stale" ? "removed-caption" : undefined;
    value.selectedClipId = selection === "stale" ? "removed-clip" : undefined;
    const html = renderToStaticMarkup(<Timeline {...value} />);
    expect(primaryAccessDefects(html, "調整片段")).toEqual(["edit-selection-button: disabled"]);
  });

  it("omits the edit action in standalone timelines with no panel owner", () => {
    const value = fixture();
    value.onEditSelection = undefined;
    expect(renderToStaticMarkup(<Timeline {...value} />)).not.toContain('data-testid="edit-selection-button"');
  });

  it("wires the real shell timeline to panel reveal and add-then-reveal callbacks", () => {
    // AST wiring evidence only; native layout, focus and human usability remain unmeasured.
    const source = ts.createSourceFile("EditorShell.tsx", readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let timeline: ts.JsxSelfClosingElement | undefined, reveal: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "Timeline") timeline = node;
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "openSelectionInspector" && node.initializer && ts.isArrowFunction(node.initializer)) reveal = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(timeline).toBeDefined(); expect(reveal).toBeDefined();
    const attrs = timeline!.attributes.properties.filter(ts.isJsxAttribute);
    expect(attrs.find(attr => attr.name.getText(source) === "onEditSelection")?.initializer?.getText(source)).toBe("{openSelectionInspector}");
    const add = attrs.find(attr => attr.name.getText(source) === "onAddCaption");
    expect(add?.initializer?.getText(source)).toBe("{() => { addCaption(); openSelectionInspector(); }}");
    const calls: string[] = [];
    const collect = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node.getText(source)); ts.forEachChild(node, collect); };
    collect(reveal!);
    // Updated 2026-10-11: simple mode opens the panel for the pick (setSelectionPanelOpen); advanced mode keeps the
    // workspace layout's inspector switch exactly as before.
    expect(calls).toEqual(["pausePlayback()", "setReviewing(false)", "setDirectorConsoleOpened(false)", "setSelectionPanelOpen(true)",
      "workspace.patch({ inspectorVisible: true })", 'setCompactPane("inspector")']);
  });
});

describe("simple mode: picking opens the panel", () => {
  beforeEach(() => { interfacePreferences.setMode("simple"); });
  // Rewritten on purpose (2026-10-11, the 剪刀 tool): the row starts with the two tools' own group (a <div>), so the row
  // runs up to the zoom that follows it rather than to the first closing </div>.
  const rowOf = (html: string) => {
    const start = html.indexOf('class="timeline-quick-actions"');
    return html.slice(start, html.indexOf('data-testid="timeline-zoom-control"', start));
  };

  it.each(UI_LOCALES)("keeps ＋ 文字 in the row and has no 調整片段／調整字幕 button, with any selection, in %s", async locale => {
    await interfacePreferences.setLocale(locale);
    for (const selection of ["caption", "clip", "none"] as const) {
      const value = fixture();
      value.selectedCaptionId = selection === "caption" ? "caption-original" : undefined;
      value.selectedClipId = selection === "clip" ? "clip-demo" : undefined;
      const html = renderToStaticMarkup(<Timeline {...value} />);
      expect(rowOf(html)).toContain('data-testid="add-caption-button"');
      expect(html).not.toContain('data-testid="edit-selection-button"');
      expect(html).not.toContain('class="timeline-more"');
    }
  });

  it("wires a click on a clip, caption or title to the shell's panel reveal", () => {
    // AST wiring evidence; the click itself is driven in Timeline.editTransport.test.tsx and the headless captures.
    const text = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("EditorShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let timeline: ts.JsxSelfClosingElement | undefined, reveal: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "Timeline") timeline = node;
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "revealSelectionPanel" && node.initializer && ts.isArrowFunction(node.initializer)) reveal = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(source);
    const attrs = timeline!.attributes.properties.filter(ts.isJsxAttribute);
    expect(attrs.find(attr => attr.name.getText(source) === "onActivateSelection")?.initializer?.getText(source)).toBe("{revealSelectionPanel}");
    expect(reveal!.getText(source)).toContain("if (!simpleMode) return;");
    expect(reveal!.getText(source)).toContain("setSelectionPanelOpen(true)");
    // The panel shows only for a pick in simple mode on a wide window; the narrow window uses its 屬性面板 tab.
    expect(text).toContain('const inspectorShown = simpleMode ? (compactWorkspace ? compactPane === "inspector" : selectionPanelOpen && hasSelection) : workspace.layout.inspectorVisible;');
  });
});
