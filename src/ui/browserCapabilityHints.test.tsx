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

  it("explains browser draft export while preserving desktop and automation capability guards", () => {
    const props: Parameters<typeof Toolbar>[0] = {
      projectName: "P", hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop, dirty: false, recoveryState: "idle",
      playhead: 0, canUndo: false, canRedo: false, isDesktop: false, onNew: noop, onOpen: noop, onSave: noop, onUndo: noop, onRedo: noop,
      onExport: noop, onExportGraph: noop, onCancelExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onDirectorConsole: noop, onHelp: noop,
      onAutoEdit: noop, autoEditUnavailableReason: REASON,
    };
    const web = renderToStaticMarkup(Toolbar(props));
    expect(button(web, "semantic-edit-button")).toContain("disabled");
    expect(button(web, "semantic-edit-button")).toContain(REASON);
    expect(button(web, "render-button")).not.toContain("disabled");
    expect(button(web, "render-button")).toContain("即時錄製草稿影片");
    expect(button(web, "render-button")).toContain("最長 5 分鐘");
    expect(button(web, "render-button")).toContain("長邊 1280");
    expect(button(web, "render-button")).toContain("最多 30 fps");
    expect(button(web, "render-button")).toContain("請保持分頁在前景");
    expect(button(web, "render-button")).toContain("非 Rust／GPU 正式輸出");
    expect(web).toContain("輸出草稿");
    expect(button(web, "export-graph-button")).not.toContain("disabled");
    expect(web).toContain("下載專案 JSON");
    expect(web).toContain("保留可編輯的 EditGraph，不是影片");
    expect(web).not.toContain('data-testid="cancel-export-button"');
    const desktop = renderToStaticMarkup(Toolbar({ ...props, isDesktop: true, autoEditUnavailableReason: undefined }));
    expect(button(desktop, "render-button")).toContain("輸出完成影片");
    expect(button(desktop, "render-button")).not.toContain("disabled");
    expect(button(desktop, "semantic-edit-button")).not.toContain("disabled");
    expect(desktop).not.toContain('data-testid="export-graph-button"');
  });

  it("blocks duplicate drafts while exposing cancellation and retains the no-media guard", () => {
    const props: Parameters<typeof Toolbar>[0] = {
      projectName: "P", hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop, dirty: false, recoveryState: "idle",
      playhead: 0, canUndo: false, canRedo: false, isDesktop: false, onNew: noop, onOpen: noop, onSave: noop, onUndo: noop, onRedo: noop,
      onExport: noop, onExportGraph: noop, onCancelExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onDirectorConsole: noop, onHelp: noop,
    };
    const busy = renderToStaticMarkup(Toolbar({ ...props, exportBusy: true }));
    expect(button(busy, "render-button")).toContain("disabled");
    expect(busy).toContain("草稿輸出中…");
    expect(button(busy, "cancel-export-button")).not.toContain("disabled");
    const empty = renderToStaticMarkup(Toolbar({ ...props, hasUserMedia: false }));
    expect(button(empty, "render-button")).toContain("disabled");
    expect(button(empty, "render-button")).toContain("請先加入自己的影片");
    expect(empty).not.toContain('data-testid="cancel-export-button"');
  });

});
