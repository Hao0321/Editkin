import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

// Source guards for the start → editor path at 1280×720, 1440×900 and the 800×560 minimum window. The rendered layout
// was checked in headless Chrome in zh-TW and English (.rd/benchmarks/usable-v1-20261009/work/layout-1280-20261010): no
// horizontal page scroll, no cut text, nothing drawn over another control.
function rules(file: string) {
  const css = postcss.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  return (selector: string, media?: string) => {
    let found: Rule | undefined;
    css.walkRules(item => {
      const parent = item.parent?.type === "atrule" ? (item.parent as unknown as { params: string }).params : undefined;
      if (parent === media && item.selectors.includes(selector)) found = item;
    });
    if (!found) throw new Error(`missing ${selector}${media ? ` in ${media}` : ""}`);
    const declarations: Record<string, string> = {};
    found.walkDecls(decl => { declarations[decl.prop] = decl.value.replace(/\s+/g, " "); });
    return declarations;
  };
}

describe("the 示範模式 banner takes the preview's top row instead of floating over it", () => {
  const rule = rules("./firstProjectStart.css");

  it("sits in the preview column's grid area on a wide window (third column next to the media panel)", () => {
    expect(rule(".workspace-grid > .demo-workspace-banner")).toMatchObject({ transform: "none", left: "24px", right: "24px", top: "5px" });
    // Explicit end lines: with an auto end the banner reached across the Inspector (seen with the Inspector open).
    expect(rule(".workspace-grid > .demo-workspace-banner", "(min-width: 1040px)")).toMatchObject({ "grid-row": "1 / 2", "grid-column": "1 / 2" });
    expect(rule(".workspace-grid:has(> .media-bin) > .demo-workspace-banner", "(min-width: 1040px)")).toMatchObject({ "grid-column": "3 / 4" });
  });

  it("hides the technical words it replaces, and sits under the panel tabs (preview tab only) on a narrow window", () => {
    expect(rule(".workspace-grid:has(> .demo-workspace-banner) .preview-toolbar > :is(span:first-child, .preview-badges)")).toMatchObject({ visibility: "hidden" });
    expect(rule(".workspace-grid > .demo-workspace-banner", "(max-width: 1039px)")).toMatchObject({ top: "calc(var(--ui-target-size, 44px) + 21px)" });
    expect(rule('.app-shell[data-active-pane]:not([data-active-pane="preview"]) .workspace-grid > .demo-workspace-banner', "(max-width: 1039px)"))
      .toMatchObject({ display: "none" });
  });

  it("fades out with the row it replaces when the preview column scrolls, instead of covering the picture", () => {
    expect(rule(".workspace-grid > .demo-workspace-banner")).toMatchObject({ "animation-timeline": "--editkin-preview-column" });
    expect(rule(".workspace-grid:has(> .demo-workspace-banner) > .center-workspace")).toMatchObject({ "scroll-timeline": "--editkin-preview-column block" });
  });
});

describe("the editor frame", () => {
  const rule = rules("./accessibleWorkspace.css");

  it("wraps the brand line inside its column instead of running under the step buttons", () => {
    expect(rule(".app-shell[data-interface-mode] .toolbar")).toMatchObject({ "grid-template-columns": "minmax(120px,160px) minmax(200px,1fr)" });
    expect(rule(".app-shell[data-interface-mode] .brand-copy span")).toMatchObject({ "white-space": "normal", "text-wrap": "balance" });
  });

  it("gives the 素材庫 and 屬性面板 panes a usable height on a narrow window instead of a sliver", () => {
    expect(rule('.app-shell[data-interface-mode][data-compact-workspace="true"] .workspace-grid > :is(.media-bin, .inspector)'))
      .toMatchObject({ flex: "0 0 auto", height: "min(560px, max(360px, calc(100dvh - 140px)))" });
  });
});
