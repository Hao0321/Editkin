import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it , vi } from "vitest";
import { AgentPanel } from "./AgentPanel";
import { EditingProfilePicker } from "./EditingProfilePicker";
import { Toolbar } from "./Toolbar";
import { interfacePreferences } from "./i18n/interfacePreferences";

const REASON = "網頁版沒有本機 Whisper／FFmpeg 引擎，這項功能需要桌面版。";
const noop = () => undefined;

function button(html: string, testId: string): string {
  const match = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!match) throw new Error(`missing ${testId}`);
  return match[0];
}

function agentPanel(unavailableReason?: string) {
  return renderToStaticMarkup(<AgentPanel status="" onSubmit={noop} hasMedia unavailableReason={unavailableReason}
    onSmartCut={noop} onAutomaticCaptions={noop} onSceneSplit={noop} onSemanticAutoEdit={noop} />);
}

describe("browser capability hints", () => {
  it("disables every engine-backed one-click action with the reason instead of failing after a click", () => {
    const html = agentPanel(REASON);
    for (const id of ["semantic-edit-panel-button", "smart-cut-button", "automatic-caption-button", "scene-split-button"]) {
      const tag = button(html, id);
      expect(tag, id).toContain("disabled");
      expect(tag, id).toContain(REASON);
    }
    expect(html).toContain('data-testid="agent-unavailable-note"');
  });

  it("leaves the actions enabled and shows no note when the engines exist", () => {
    const html = agentPanel();
    for (const id of ["semantic-edit-panel-button", "smart-cut-button", "automatic-caption-button", "scene-split-button"]) {
      expect(button(html, id), id).not.toContain("disabled");
    }
    expect(html).not.toContain("agent-unavailable-note");
  });

  it("disables the speaker director for the same reason", () => {
    const render = (unavailableReason?: string) => renderToStaticMarkup(
      <EditingProfilePicker profile="podcast_on_camera" hasVideo trackingBusy={false} onChange={noop} onStartSpeakerDirector={noop} unavailableReason={unavailableReason} />);
    expect(/<button[^>]*speaker-director-button[^>]*>/.exec(render(REASON))![0]).toMatch(/disabled[^>]*title=/);
    expect(/<button[^>]*speaker-director-button[^>]*>/.exec(render())![0]).not.toContain("disabled");
  });

  it("explains in the toolbar that the browser export is a project file, not a video", () => {
    const props: Parameters<typeof Toolbar>[0] = {
      projectName: "P", hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop, dirty: false, recoveryState: "idle",
      playhead: 0, canUndo: false, canRedo: false, isDesktop: false, onNew: noop, onOpen: noop, onSave: noop, onUndo: noop, onRedo: noop,
      onExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onDirectorConsole: noop, onHelp: noop,
      onAutoEdit: noop, autoEditUnavailableReason: REASON,
    };
    // 先做一版粗剪 lives in 更多工具, which is advanced mode's since 2026-10-11 (simple mode's top bar is checked below).
    interfacePreferences.setMode("advanced");
    const web = renderToStaticMarkup(Toolbar(props));
    expect(button(web, "semantic-edit-button")).toContain("disabled");
    expect(button(web, "render-button")).toContain("網頁版無法輸出影片");
    const desktop = renderToStaticMarkup(Toolbar({ ...props, isDesktop: true, autoEditUnavailableReason: undefined }));
    expect(button(desktop, "render-button")).toContain("輸出完成影片");
    expect(button(desktop, "semantic-edit-button")).not.toContain("disabled");
    interfacePreferences.setMode("simple");
    const simpleWeb = renderToStaticMarkup(Toolbar(props)), simpleDesktop = renderToStaticMarkup(Toolbar({ ...props, isDesktop: true }));
    expect(button(simpleWeb, "render-button")).toContain("網頁版無法輸出影片");
    expect(simpleWeb).toContain("匯出專案");
    expect(button(simpleDesktop, "render-button")).toContain("輸出完成影片");
    expect(simpleDesktop).toContain("輸出影片");
    expect(simpleWeb).not.toContain("semantic-edit-button");
  });
});

afterEach(() => interfacePreferences.setMode("simple"));

// Direct handler/hook-double controls isolate the new subscription. Real React
// localization and browser state continuity are checked in separate suites.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
