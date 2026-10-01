import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPanel } from "./AgentPanel";
import { EditingProfilePicker } from "./EditingProfilePicker";
import { Toolbar } from "./Toolbar";

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
  it("keeps Web Audio Smart Cut available while disabling engine-backed actions", () => {
    const html = agentPanel(REASON);
    for (const id of ["semantic-edit-panel-button", "automatic-caption-button", "scene-split-button"]) {
      const tag = button(html, id);
      expect(tag, id).toContain("disabled");
      expect(tag, id).toContain(REASON);
    }
    expect(html).toContain('data-testid="agent-unavailable-note"');
    expect(button(html, "smart-cut-button")).not.toContain("disabled");
    expect(button(html, "smart-cut-button")).not.toContain(REASON);
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
    const web = renderToStaticMarkup(Toolbar(props));
    expect(button(web, "semantic-edit-button")).toContain("disabled");
    expect(button(web, "render-button")).toContain("網頁版無法輸出影片");
    const desktop = renderToStaticMarkup(Toolbar({ ...props, isDesktop: true, autoEditUnavailableReason: undefined }));
    expect(button(desktop, "render-button")).toContain("輸出完成影片");
    expect(button(desktop, "semantic-edit-button")).not.toContain("disabled");
  });
});
