import { readFileSync } from "node:fs";
import postcss, { type Root, type Rule } from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceControls } from "./WorkspaceControls";
import { EDITOR_THEMES, THEME_PARITY_CONTRACT } from "./theme";
import { WORKSPACE_PRESETS } from "./workspaceLayout";

const projectCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const workspaceCss = readFileSync(new URL("./workspaceLayout.css", import.meta.url), "utf8");
const nestedPanel = ".project-menu .workspace-controls > .workspace-controls-popover";
const compact = (value: string | undefined) => value?.replace(/\s+/g, "");

// This is a source invariant check, not a CSS layout engine or pointer hit test.
// Actual packaged checkbox-center, scroll and viewport acceptance is separate.
function declaration(root: Root, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const node of root.nodes) {
    if (node.type !== "rule" || node.selector !== selector) continue;
    node.walkDecls(property, (entry) => { value = entry.value; });
  }
  return compact(value);
}

function nestingViolations(menuSource: string, workspaceSource: string): string[] {
  const menu = postcss.parse(menuSource);
  const workspace = postcss.parse(workspaceSource);
  const expectations: Array<[Root, string, string, string]> = [
    [menu, ".project-menu-popover", "width", "min(310px, calc(100vw - 24px))"],
    [menu, ".project-menu-popover", "overflow", "auto"],
    [menu, ".project-menu-popover", "max-height", "calc(100vh - 92px)"],
    [menu, ".project-menu-group-body", "grid-template-columns", "minmax(0, 1fr)"],
    [menu, ".project-menu-group-body > .workspace-controls", "min-width", "0"],
    [workspace, nestedPanel, "position", "static"],
    [workspace, nestedPanel, "inset", "auto"],
    [workspace, nestedPanel, "width", "100%"],
    [workspace, nestedPanel, "min-width", "0"],
    [workspace, nestedPanel, "max-width", "100%"],
    [workspace, nestedPanel, "box-sizing", "border-box"],
    [workspace, nestedPanel, "overflow-wrap", "anywhere"],
    [workspace, ".project-menu .workspace-controls-heading", "flex-wrap", "wrap"],
    [workspace, ".project-menu .workspace-preset-grid", "grid-template-columns", "repeat(2, minmax(0, 1fr))"],
    [workspace, ".project-menu .workspace-preset-grid button", "min-width", "0"],
    [workspace, ".project-menu .workspace-preset-grid button", "white-space", "normal"],
    [workspace, ".project-menu .workspace-controls fieldset", "min-inline-size", "0"],
    [workspace, ".project-menu .workspace-controls fieldset", "grid-template-columns", "repeat(2, minmax(0, 1fr))"],
    [workspace, ".project-menu .workspace-controls fieldset label", "min-width", "0"],
    [workspace, ".project-menu .workspace-controls fieldset input", "flex", "0 0 17px"],
    [workspace, ".project-menu .workspace-text-size", "grid-template-columns", "minmax(0, 1fr) minmax(0, 140px)"],
    [workspace, ".project-menu .workspace-text-size select", "min-width", "0"],
  ];
  return expectations.flatMap(([root, selector, property, expected]) => (
    declaration(root, selector, property) === compact(expected) ? [] : [`${selector}: ${property}`]
  ));
}

function mutateDeclaration(source: string, selector: string, property: string, value: string): string {
  const root = postcss.parse(source);
  const rule = root.nodes.find((node): node is Rule => node.type === "rule" && node.selector === selector);
  if (!rule) throw new Error(`Missing calibration rule: ${selector}`);
  let replacements = 0;
  rule.walkDecls(property, (entry) => { entry.value = value; replacements += 1; });
  if (replacements !== 1) throw new Error(`Expected one calibration declaration: ${selector} ${property}`);
  return root.toString();
}

describe("nested workspace disclosure source invariants", () => {
  it("keeps the full nested panel in document flow and leaves its parent vertically scrollable", () => {
    expect(nestingViolations(projectCss, workspaceCss)).toEqual([]);
  });

  it("rejects the observed 310px clipping parent / absolute 360px child baseline", () => {
    const oldMenu = ".project-menu-popover { width:310px; overflow:auto; max-height:calc(100vh - 92px) }";
    const oldWorkspace = ".workspace-controls-popover { position:absolute; top:49px; right:0; width:360px }";
    expect(nestingViolations(oldMenu, oldWorkspace)).toContain(`${nestedPanel}: position`);
    expect(nestingViolations(oldMenu, oldWorkspace)).toContain(`${nestedPanel}: width`);
  });

  it.each([
    ["floating nested panel", nestedPanel, "position", "absolute"],
    ["oversized nested panel", nestedPanel, "width", "360px"],
    ["fieldset intrinsic overflow", ".project-menu .workspace-controls fieldset", "min-inline-size", "min-content"],
    ["intrinsic grid overflow", ".project-menu .workspace-preset-grid", "grid-template-columns", "repeat(2, 1fr)"],
    ["shrinking checkbox", ".project-menu .workspace-controls fieldset input", "flex", "1 1 auto"],
    ["unwrapped preset label", ".project-menu .workspace-preset-grid button", "white-space", "nowrap"],
  ])("calibration rejects %s", (_label, selector, property, value) => {
    expect(nestingViolations(projectCss, mutateDeclaration(workspaceCss, selector, property, value)))
      .toContain(`${selector}: ${property}`);
  });

  it("rejects a scroll-disabling parent workaround", () => {
    expect(nestingViolations(mutateDeclaration(projectCss, ".project-menu-popover", "overflow", "hidden"), workspaceCss))
      .toContain(".project-menu-popover: overflow");
  });

  it("keeps standalone mobile behavior while using a more specific unconditional nested rule", () => {
    const root = postcss.parse(workspaceCss);
    const mobile: string[] = [];
    root.walkAtRules("media", (media) => {
      if (compact(media.params) !== "(max-width:900px)") return;
      media.walkRules(".workspace-controls-popover", (rule) => {
        rule.walkDecls("position", (entry) => { mobile.push(entry.value); });
      });
    });
    expect(mobile).toEqual(["fixed"]);
    expect(declaration(root, ".workspace-controls-popover", "position")).toBe("absolute");
    expect(declaration(root, nestedPanel, "position")).toBe("static");
    // All selectors here are class-only: nested scope has 3 vs standalone 1.
    expect(nestedPanel.split(".").length - 1).toBe(3);
    const themeOverrides: string[] = [];
    for (const source of [workspaceCss, projectCss]) {
      postcss.parse(source).walkRules((rule) => {
        if (rule.selector.includes("data-theme") && /workspace-(controls|preset|text-size)/.test(rule.selector)) {
          themeOverrides.push(rule.selector);
        }
      });
    }
    expect(themeOverrides).toEqual([]);
    expect(THEME_PARITY_CONTRACT.sharedLayout).toBe(true);
  });
});

describe("workspace controls retain their shared real component DOM", () => {
  const renderControls = () => renderToStaticMarkup(<WorkspaceControls
    layout={WORKSPACE_PRESETS.edit}
    onPreset={() => undefined}
    onPatch={() => undefined}
    onReset={() => undefined}
  />);

  it.each(EDITOR_THEMES)("retains every preset, checkbox and text-size option under %s", (theme) => {
    const controls = renderControls();
    const themed = renderToStaticMarkup(<div data-theme={theme}><WorkspaceControls
      layout={WORKSPACE_PRESETS.edit}
      onPreset={() => undefined}
      onPatch={() => undefined}
      onReset={() => undefined}
    /></div>);
    expect(themed).toBe(`<div data-theme="${theme}">${controls}</div>`);
    expect(controls.match(/type="checkbox"/g)).toHaveLength(4);
    expect(controls.match(/<button /g)).toHaveLength(5);
    expect(controls.match(/<option /g)).toHaveLength(2);
    for (const label of ["素材庫", "屬性面板", "自動剪輯", "時間軸", "簡易", "剪輯", "調色", "專注", "大字（推薦）", "標準"]) {
      expect(controls).toContain(label);
    }
    expect(controls).toContain('data-testid="workspace-controls"');
  });
});
