import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import { createProjectDownloadOwner } from "../application/projectDownloadLease";
import { ProjectDownloadNotice } from "./ProjectDownloadNotice";

const cleanups: Array<() => void> = [];
function fixture() {
  vi.useFakeTimers();
  let count = 0;
  vi.stubGlobal("URL", { createObjectURL: () => `blob:visible-${++count}`, revokeObjectURL: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { createElement: () => ({ href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() }), body: { appendChild: vi.fn() } });
  const session = createProjectSession(createDemoProject()), owner = createProjectDownloadOwner({ session, onChange: vi.fn() });
  cleanups.push(owner.attach()); owner.request();
  return { session, owner, lease: owner.getCurrent()! };
}
function props(node: ReactNode, testId: string): Record<string, unknown> {
  if (Array.isArray(node)) {
    for (const child of node) { try { return props(child, testId); } catch { /* continue */ } }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    if (node.props["data-testid"] === testId) return node.props;
    if (node.props.children) return props(node.props.children as ReactNode, testId);
  }
  throw new Error(`Missing actual notice element ${testId}`);
}
function click(value: Record<string, unknown>, event: object) {
  if (typeof value.onClick !== "function") throw new Error("Missing actual click handler");
  value.onClick(event);
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("controlled visible project link (static/direct handler controls, not disk delivery)", () => {
  it("renders a visible focusable genuine href/download with truthful request wording", () => {
    const f = fixture(), tree = ProjectDownloadNotice({ lease: f.lease, onCancel: f.owner.cancel }), html = renderToStaticMarkup(tree);
    // Actual source style only: open status is 80, modal backdrop is 100.
    expect(props(tree, "project-download-notice").style).toMatchObject({ position: "absolute", zIndex: 90 });
    const link = /<a[^>]*data-testid="project-download-link"[^>]*>/.exec(html)![0];
    expect(link).toContain(`href="${f.lease.url}"`);
    expect(link).toContain(`download="${f.lease.filename}"`);
    expect(link).not.toMatch(/hidden|tabindex="-1"|aria-hidden="true"/);
    expect(html).toContain("送出時的專案版本");
    expect(html).toContain("不會標記已儲存");
    expect(html).toContain("15 秒內有效");
  });
  it("labels a real edited graph older while keeping the same href and permits that sent snapshot", () => {
    const f = fixture();
    f.session.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "Later current graph" }));
    const tree = ProjectDownloadNotice({ lease: f.lease, onCancel: f.owner.cancel });
    expect(renderToStaticMarkup(tree)).toContain("先前送出的版本；目前修改未包含");
    const link = props(tree, "project-download-link"), preventDefault = vi.fn();
    expect(link.href).toBe(f.lease.url);
    click(link, { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it("a retired rendered link blocks navigation and its cancel button cannot cancel a newer lease", () => {
    const f = fixture(), tree = ProjectDownloadNotice({ lease: f.lease, onCancel: f.owner.cancel });
    f.owner.request(); const current = f.owner.getCurrent()!;
    const preventDefault = vi.fn();
    click(props(tree, "project-download-link"), { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    click(props(tree, "project-download-cancel"), {});
    expect(f.owner.getCurrent()).toBe(current);
  });
});
