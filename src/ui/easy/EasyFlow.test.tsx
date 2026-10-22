import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstProjectStart } from "../FirstProjectStart";
import { interfacePreferences } from "../i18n/interfacePreferences";
import { EasyFlow } from "./EasyFlow";
import { createDemoEasyEngine, ROUGH_CUT_STEPS } from "./easyEngines";
import type { EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore } from "./easyFlowModel";

afterEach(() => { interfacePreferences.setMode("simple"); });
const noop = () => undefined;

function host(): EasyFlowHost {
  return {
    store: createEasyFlowStore(), engine: createDemoEasyEngine({ previewUrl: "demo.mp4" }), picker: "dialog",
    chooseVideo: vi.fn(async () => ({ kind: "nothing" as const })), discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn(),
  };
}
const start = (easyFlowHost?: EasyFlowHost) => renderToStaticMarkup(<FirstProjectStart isDesktop onImport={noop} onDesktopImport={noop} onOpenProject={noop}
  onExploreDemo={noop} onHelp={noop} easyFlowHost={easyFlowHost} />);

describe("simple mode starts with the easy flow", () => {
  it("shows 放影片進來，我幫你剪好 when the editor shell provides the flow", () => {
    const markup = start(host());
    expect(markup).toContain('data-testid="easy-flow"');
    expect(markup).toContain("放影片進來，我幫你剪好");
    expect(markup).not.toContain('data-testid="first-project-start"');
    // Editor shortcuts (save, undo, play…) stay off while the flow is on screen.
    expect(markup).toMatch(/data-testid="easy-flow"[^>]*data-shortcuts-blocked="true"/);
  });

  it("keeps the existing welcome in advanced mode", () => {
    interfacePreferences.setMode("advanced");
    const markup = start(host());
    expect(markup).toContain('data-testid="first-project-start"');
    expect(markup).not.toContain('data-testid="easy-flow"');
  });

  it("keeps the existing welcome until the shell provides the flow, and never simulates in production", () => {
    const markup = start();
    expect(markup).toContain('data-testid="first-project-start"');
    expect(markup).toContain('data-testid="import-media-button"');
    expect(markup).not.toContain("easy-flow");
  });

  it("renders whatever screen the host's flow is on", () => {
    const flow = host();
    flow.store.dispatch({ type: "choose-format", format: "horizontal" });
    flow.store.dispatch({ type: "pick-started" });
    flow.store.dispatch({ type: "pick-finished", video: { id: "v", name: "IMG_3310.MOV", orientation: "landscape" },
      check: { ok: true, plan: { needsTitle: false, steps: ROUGH_CUT_STEPS, canRestyle: false, canEditText: false, rendersPreview: false, canCancel: false } } });
    const markup = renderToStaticMarkup(<EasyFlow host={flow} />);
    expect(markup).toContain('data-easy-screen="genre"');
    expect(markup).toContain('data-easy-format="horizontal"');
    expect(markup).toContain("這支影片在拍什麼？");
    expect(markup).toContain("IMG_3310.MOV");
  });
});
