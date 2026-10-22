import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FirstProjectStart } from "./FirstProjectStart";
import { Toolbar } from "./Toolbar";

const noop = () => {};
function toolbar(isDesktop: boolean, hasUserMedia = false) {
  return renderToStaticMarkup(<Toolbar projectName="Original graph" hasUserMedia={hasUserMedia} workspaceMode="editor" theme="sky"
    onThemeChange={noop} dirty recoveryState="idle" playhead={0} canUndo={false} canRedo={false} isDesktop={isDesktop}
    onNew={noop} onOpen={noop} onSave={noop} onUndo={noop} onRedo={noop} onExport={noop} onOpenAgentConnect={noop}
    onCheckUpdates={noop} onDirectorConsole={noop} onHelp={noop} />);
}
describe("file action reachability and honest browser labels (static UI only)", () => {
  it("exposes graph open on the browser welcome page", () => {
    const html = renderToStaticMarkup(<FirstProjectStart isDesktop={false} onImport={noop} onOpenProject={noop} onExploreDemo={noop} onHelp={noop} />);
    expect(html).toContain('data-testid="welcome-open-project"');
    expect(html).not.toContain('data-testid="welcome-agent-connect"');
  });
  it("exposes browser New/Open/Download and enables graph export without footage", () => {
    const html = toolbar(false);
    for (const id of ["new-project-button", "open-project-button", "save-project-button", "render-button"]) expect(html).toContain(`data-testid="${id}"`);
    expect(/<button[^>]*data-testid="render-button"/.exec(html)![0]).not.toContain("disabled");
    expect(html).toContain("不會標記已儲存");
    expect(html).toContain("沒有 Autosave");
    expect(html).not.toContain("已安全儲存");
  });
  it("preserves native render prerequisites and native save wording", () => {
    const html = toolbar(true);
    expect(/<button[^>]*data-testid="render-button"/.exec(html)![0]).toContain("disabled");
    expect(html).toContain("儲存專案");
    expect(html).not.toContain("送出下載；不會標記已儲存");
  });
});
