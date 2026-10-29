import { Children, isValidElement, type ReactNode, type ReactElement, type MouseEvent } from "react";
import { describe, it, expect, vi } from "vitest";
import { Toolbar } from "./Toolbar";

// This test exercises the menu callbacks directly; localization hooks are covered
// through real React rendering and the preference-store suite.
vi.mock("./i18n/interfacePreferences", () => ({
  useI18n: () => ({ t: (source: string) => source }),
}));

type Action = ReactElement<{ onClick?: (event: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; children?: ReactNode; "data-testid"?: string }>;
function actions(node: ReactNode, found: Action[] = []): Action[] {
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === "button") found.push(child as Action);
    actions(child.props.children, found);
  });
  return found;
}
const noop = () => {};
const baseProps: Parameters<typeof Toolbar>[0] = { projectName: "P1", hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop,
  dirty: false, recoveryState: "idle", playhead: 0, canUndo: false, canRedo: false, isDesktop: true, onNew: noop, onOpen: noop, onSave: noop,
  onUndo: noop, onRedo: noop, onExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onHelp: noop };

// Updated 2026-10-23 (P6/P7 pack). This suite used to drive the 導演台 (director console) entry in 更多工具, a dead path:
// EditorShell never passed onDirectorConsole and no button rendered it. The props (onDirectorConsole, onReview,
// reviewing) are removed. The behaviour it guarded still holds for the current 更多工具 entries, so the same
// close-the-parent-menu-first check now runs on each of them, and the director console stays absent.
describe("advanced toolbar 更多工具 entries", () => {
  const menuEntries = [
    ["semantic-edit-button", "onAutoEdit"], ["open-agent-connect-button", "onOpenAgentConnect"], ["mobile-remote-button", "onMobileRemote"],
    ["render-openexr-sequence-button", "onExportOpenExrSequence"], ["render-alpha-master-button", "onExportAlphaMaster"],
  ] as const;
  it.each(menuEntries.flatMap(entry => [true, false].map(parentExists => [...entry, parentExists] as const)))(
    "%s closes its parent menu before running %s (parent exists: %s)", (testId, handlerName, parentExists) => {
      const menu = { open: true };
      const handler = vi.fn(() => { if (parentExists) expect(menu.open).toBe(false); });
      const action = actions(Toolbar({ ...baseProps, onAutoEdit: noop, onMobileRemote: noop, onExportOpenExrSequence: noop, onExportAlphaMaster: noop, [handlerName]: handler }))
        .find(node => node.props["data-testid"] === testId);
      expect(action, testId).toBeDefined();
      expect(action!.props.disabled).toBeFalsy();
      const closest = vi.fn(() => parentExists ? menu : null);
      action!.props.onClick!({ currentTarget: { closest } } as unknown as MouseEvent<HTMLButtonElement>);
      expect(closest).toHaveBeenCalledWith("details.project-menu");
      expect(handler).toHaveBeenCalledOnce();
    });

  it("closes the menu before checking for updates", () => {
    const menu = { open: true }, onCheckUpdates = vi.fn(() => expect(menu.open).toBe(false));
    const action = actions(Toolbar({ ...baseProps, onCheckUpdates })).find(node => JSON.stringify(node.props.children).includes("檢查更新"))!;
    action.props.onClick!({ currentTarget: { closest: () => menu } } as unknown as MouseEvent<HTMLButtonElement>);
    expect(onCheckUpdates).toHaveBeenCalledOnce();
  });

  it("has no director console entry, and its step strip is the three current steps", () => {
    const onAddMedia = vi.fn(), onEdit = vi.fn(), onExport = vi.fn();
    const buttons = actions(Toolbar({ ...baseProps, onAddMedia, onEdit, onExport }));
    expect(buttons.some(node => node.props["data-testid"] === "director-console-button")).toBe(false);
    const steps = buttons.filter(node => String(node.props["data-testid"] ?? "").startsWith("flow-step-"));
    expect(steps.map(node => node.props["data-testid"])).toEqual(["flow-step-1", "flow-step-2", "flow-step-3"]);
    for (const step of steps) step.props.onClick!({} as MouseEvent<HTMLButtonElement>);
    expect(onAddMedia).toHaveBeenCalledOnce(); expect(onEdit).toHaveBeenCalledOnce(); expect(onExport).toHaveBeenCalledOnce();
  });
});
