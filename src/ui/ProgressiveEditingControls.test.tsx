import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPanel } from "./AgentPanel";
import { EditingProfilePicker } from "./EditingProfilePicker";
import { CLIP_TOOL_ITEMS, CLIP_TOOLS_DEFAULT_OPEN } from "./Inspector";

describe("progressive editing controls", () => {
  it("keeps one compact profile summary while preserving every profile choice", () => {
    const html = renderToStaticMarkup(<EditingProfilePicker
      profile="auto"
      hasVideo
      trackingBusy={false}
      onChange={() => undefined}
      onStartSpeakerDirector={() => undefined}
    />);
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(html).toContain("影片類型：");
    expect((html.match(/role="radio"/g) ?? []).length).toBe(7);
    expect(html).toContain("動畫 MV");
  });

  it("keeps auto edit visible and puts free-form and secondary actions behind one disclosure", () => {
    const html = renderToStaticMarkup(<AgentPanel
      status="準備完成"
      hasMedia
      onSubmit={() => undefined}
      onSemanticAutoEdit={() => undefined}
      onSmartCut={() => undefined}
      onAutomaticCaptions={() => undefined}
      onSceneSplit={() => undefined}
    />);
    expect(html).toContain("data-testid=\"semantic-edit-panel-button\"");
    expect(html).toContain("data-testid=\"agent-panel-disclosure\"");
    expect(html).toContain("自訂修改與更多功能");
    expect(html).toContain("data-testid=\"agent-input\"");
    expect(html).not.toMatch(/data-testid="agent-panel-disclosure"[^>]*\sopen(?:=|\s|>)/);
  });

  it("presents the MV route as AI planning rather than the local rough cut", () => {
    const html = renderToStaticMarkup(<AgentPanel
      status="準備完成"
      hasMedia
      musicMvMode
      onSubmit={() => undefined}
      onSemanticAutoEdit={() => undefined}
    />);
    expect(html).toContain("製作 Music MV");
    expect(html).toContain("AI 規劃 · Editkin 本機執行");
    expect(html).toContain("連接 AI");
    expect(html).not.toContain("0 AI 額度");
  });

  it("uses one non-duplicated inspector tool strip", () => {
    const labels = CLIP_TOOL_ITEMS.map(([, , label]) => label);
    expect(labels).toEqual(["調整", "文字", "濾鏡", "特效", "轉場剪法", "遮罩", "畫中畫"]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("更多");
    expect(CLIP_TOOLS_DEFAULT_OPEN).toBe(false);
  });
});
