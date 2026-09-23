import { Children, isValidElement, type ReactNode, type ReactElement, type MouseEvent } from "react";
import { describe, it, expect, vi } from "vitest";
import { Toolbar } from "./Toolbar";

function findAction(node: ReactNode): ReactElement<{ onClick: (event: MouseEvent<HTMLButtonElement>) => void }> | undefined {
  let found: ReturnType<typeof findAction>;
  Children.forEach(node, child => {
    if (found || !isValidElement<{ children?: ReactNode; "data-testid"?: string }>(child)) return;
    if (child.props["data-testid"] === "director-console-button") found = child as NonNullable<typeof found>;
    else found = findAction(child.props.children);
  });
  return found;
}

describe("Director workspace entry", () => {
  it.each([true, false])("closes its parent menu before opening the dock (parent exists: %s)", parentExists => {
    const menu = { open: true };
    const noop = () => {};
    const onDirectorConsole = vi.fn(() => { if (parentExists) expect(menu.open).toBe(false); });
    const props: Parameters<typeof Toolbar>[0] = {projectName:"P1", hasUserMedia:true, workspaceMode:"editor", theme:"sky", onThemeChange:noop, dirty:false, recoveryState:"idle", playhead:0, canUndo:false, canRedo:false, isDesktop:true, onNew:noop, onOpen:noop, onSave:noop, onUndo:noop, onRedo:noop, onExport:noop, onOpenAgentConnect:noop, onCheckUpdates:noop, onDirectorConsole, onHelp:noop};
    const action = findAction(Toolbar(props));
    expect(action).toBeDefined();
    const closest = vi.fn(() => parentExists ? menu : null);
    action!.props.onClick({currentTarget:{closest}} as unknown as MouseEvent<HTMLButtonElement>);
    expect(closest).toHaveBeenCalledWith("details.project-menu");
    expect(onDirectorConsole).toHaveBeenCalledOnce();
  });
});
