import { readFileSync } from "node:fs";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationStatus } from "./OperationStatus";
import { EDITOR_THEMES } from "./theme";

function intrinsicWidthViolations(source: string): string[] {
  const declarations = new Map<string, Record<string, string>>();
  postcss.parse(source).walkRules((rule) => {
    if (rule.parent?.type !== "root") return;
    const properties: Record<string, string> = {};
    rule.walkDecls((entry) => { properties[entry.prop] = entry.value; });
    declarations.set(rule.selector, properties);
  });
  const expected = [
    [".status-bar:has(> .operation-status)", "min-width", "0"],
    [".operation-status", "flex", "1 1 0px"],
    [".operation-status", "width", "0"],
    [".operation-status", "min-width", "0"],
    [".operation-status", "contain", "inline-size"],
  ];
  return expected.flatMap(([selector, property, value]) => declarations.get(selector)?.[property] === value ? [] : [`${selector}: ${property}`]);
}

describe("persistent operation status", () => {
  it("keeps the full message accessible in a polite live summary without automatically opening", () => {
    const message = "智慧成片失敗：請先加入自己的影片。\n原有修改仍保留，請重新執行。";
    const html = renderToStaticMarkup(<OperationStatus status={message} runtimeInfo="桌面版 · 手機已連線 2" />);
    expect(html).toContain('data-testid="operation-status"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toContain(`>${message}</span>`);
    expect(html).toContain(`<p class="operation-status-full-message">${message}</p>`);
    expect(html).toContain("桌面版 · 手機已連線 2");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(html).not.toContain('role="alert"');
  });

  it.each(["分析中…", "已完成 · 仍需審片", "失敗：模型尚未就緒", "專案已有新修改，未套用舊結果"])("renders %s neutrally without declaring success", (status) => {
    const html = renderToStaticMarkup(<OperationStatus status={status} runtimeInfo="本機編輯" />);
    expect(html).toContain(`>${status}</span>`);
    expect(html).not.toMatch(/data-status=|class="(?:success|error|passed|failed)"/);
  });

  it("escapes diagnostic text and has a nonempty idle fallback", () => {
    const html = renderToStaticMarkup(<OperationStatus status={'<script>alert("bad")</script>'} runtimeInfo="runtime <info>" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("runtime &lt;info&gt;");
    expect(renderToStaticMarkup(<OperationStatus status="  " runtimeInfo="本機" />)).toContain("目前沒有進行中的操作。");
  });

  it("preserves a long unbroken message without using its intrinsic width to size the footer", () => {
    const message = `path_${"x".repeat(8192)}`;
    const html = renderToStaticMarkup(<OperationStatus status={message} runtimeInfo="桌面版" />);
    expect(html).toContain(`>${message}</span>`);
    expect(html).toContain(`<p class="operation-status-full-message">${message}</p>`);
    expect(intrinsicWidthViolations(readFileSync(new URL("./operationStatus.css", import.meta.url), "utf8"))).toEqual([]);
    // Source-level protection only; real document/footer bounds and pointer
    // hit-testing are measured separately in operation-status-browser.html.
  });

  it("calibration rejects the actual intrinsic-width baseline, despite its bounded floating panel", () => {
    const before = ".operation-status{position:relative;flex:1 1 40%;min-width:0;max-width:min(720px,60%)}.operation-status-panel{position:absolute;width:min(480px,calc(100vw - 28px));overflow:auto}";
    expect(intrinsicWidthViolations(before)).toEqual([
      ".status-bar:has(> .operation-status): min-width",
      ".operation-status: flex", ".operation-status: width", ".operation-status: contain",
    ]);
  });

  it("calibration catches loss of the parent grid-item shrink guard or inline containment", () => {
    const source = readFileSync(new URL("./operationStatus.css", import.meta.url), "utf8");
    const noContainment = postcss.parse(source);
    noContainment.walkDecls("contain", (entry) => { entry.remove(); });
    expect(intrinsicWidthViolations(noContainment.toString())).toContain(".operation-status: contain");
    const noFooterGuard = postcss.parse(source);
    noFooterGuard.walkRules(".status-bar:has(> .operation-status)", (rule) => { rule.remove(); });
    expect(intrinsicWidthViolations(noFooterGuard.toString())).toContain(".status-bar:has(> .operation-status): min-width");
  });

  it.each(EDITOR_THEMES)("keeps the same markup in the %s theme", (theme) => {
    const component = <OperationStatus status="正在聽懂內容與找鏡頭" runtimeInfo="桌面版" />;
    const plain = renderToStaticMarkup(component);
    expect(renderToStaticMarkup(<div data-theme={theme}>{component}</div>)).toBe(`<div data-theme="${theme}">${plain}</div>`);
  });

  it("uses a bounded upward disclosure, readable text and no added app grid row", () => {
    const css = postcss.parse(readFileSync(new URL("./operationStatus.css", import.meta.url), "utf8"));
    const declarations = new Map<string, Record<string, string>>();
    css.walkRules((rule) => {
      if (rule.parent?.type !== "root") return;
      const properties: Record<string, string> = {};
      rule.walkDecls((entry) => { properties[entry.prop] = entry.value; });
      declarations.set(rule.selector, properties);
    });
    expect(declarations.get(".operation-status-panel")).toMatchObject({
      position: "absolute", bottom: "calc(100% + 8px)", width: "min(480px, calc(100vw - 28px))", "max-height": "min(420px, calc(100dvh - 64px))", overflow: "auto",
    });
    expect(declarations.get(".operation-status .operation-status-message")).toMatchObject({ "font-size": "12px", "white-space": "nowrap", "text-overflow": "ellipsis" });
    const gridChanges: string[] = [];
    css.walkDecls("grid-template-rows", (entry) => { gridChanges.push(entry.value); });
    expect(gridChanges).toEqual([]);
    css.walkDecls("font-size", (entry) => { expect(parseFloat(entry.value)).toBeGreaterThanOrEqual(12); });
  });
});
