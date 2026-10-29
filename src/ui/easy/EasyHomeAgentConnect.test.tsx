import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interfacePreferences } from "../i18n/interfacePreferences";
import { createDemoEasyEngine } from "./easyEngines";
import { createEasyFlowController } from "./easyFlowController";
import type { EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore } from "./easyFlowModel";
import { EasyScreen, type EasyScreenProps } from "./EasyScreens";
import { FirstProjectStart } from "../FirstProjectStart";
import { AgentHelpCardLive } from "../agentConnect/AgentHelpEntryV1";
import { agentRuntimeRepairV1 } from "../agentConnect/agentRuntimeRepairV1";

// 2026-10-23 (release-notes blocker, Area D action 2) put the AI connection on simple mode's first screen, folded.
// 2026-10-29 (Hao: 傻瓜化連老人、小孩都會用): it is now one big 「讓 AI 幫我剪片」 card in plain sight — the same card as
// the advanced start and the same words as the simple top bar's button — still below 選擇影片 and never a second primary.
afterEach(async () => { interfacePreferences.setMode("simple"); await interfacePreferences.setLocale("zh-TW"); });
function host(): EasyFlowHost {
  return { store: createEasyFlowStore(), engine: createDemoEasyEngine({ previewUrl: "demo.mp4", wait: () => Promise.resolve() }), picker: "dialog",
    chooseVideo: vi.fn(async () => ({ kind: "nothing" as const })), discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn() };
}
function props(value: EasyFlowHost, patch: Partial<EasyScreenProps> = {}): EasyScreenProps {
  const controller = createEasyFlowController(value, () => 1_000);
  return { state: value.store.getState(), controller, formatStatus: value.engine.formatStatus, videoUrls: {}, canReveal: false, picker: value.picker,
    onChooseVideo: () => {}, onFilesChosen: () => {}, onSeekPreview: () => {}, now: 0, ...patch };
}
function expand(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  // The live entry reads shared state with a hook: keep it as one element (its onClick is the screen's handler).
  if (element.type === AgentHelpCardLive) return [element];
  if (typeof element.type === "function") return expand((element.type as (value: unknown) => ReactNode)(element.props));
  return [element, ...expand(element.props.children)];
}
const noop = () => {};

describe("simple start screen: 讓 AI 幫我剪片", () => {
  it("shows one big, unfolded 讓 AI 幫我剪片 card after 選擇影片 and the other ways in, and it opens the Agent Connect dialog", () => {
    const connect = vi.fn(), html = renderToStaticMarkup(<EasyScreen {...props(host(), { onConnectAgent: connect })} />);
    const choose = html.indexOf('data-testid="easy-choose-video"'), links = html.indexOf('data-testid="easy-open-project"'), ai = html.indexOf('data-testid="easy-ai-section"');
    expect(choose).toBeGreaterThan(0); expect(links).toBeGreaterThan(choose); expect(ai).toBeGreaterThan(links);
    expect(html).toMatch(/<section class="easy-ai" aria-label="讓 AI 幫我剪片" data-testid="easy-ai-section"><button type="button" class="agent-help-card" data-testid="welcome-agent-connect">/);
    expect(html).not.toMatch(/<details class="easy-ai"/);
    expect(html).toContain("<strong>讓 AI 幫我剪片</strong><small>用 Claude Code 或 Codex，說一句話就幫你剪。</small>");
    expect((html.match(/data-easy-primary=""/g) ?? []).length).toBe(1);
    const button = expand(<EasyScreen {...props(host(), { onConnectAgent: connect })} />).find(element => element.type === AgentHelpCardLive)!;
    button.props.onClick(); expect(connect).toHaveBeenCalledOnce();
  });
  it("after an Editkin update whose refresh failed, the same card says 「Editkin 更新後要重新連一次 AI」 with 重新連一次", () => {
    agentRuntimeRepairV1.publish({ state: "failed", message: "generation pointer mismatch" });
    try {
      const html = renderToStaticMarkup(<EasyScreen {...props(host(), { onConnectAgent: noop })} />);
      expect(html).toMatch(/<button type="button" class="agent-help-card" data-repair="true" data-testid="welcome-agent-connect">/);
      expect(html).toContain("<strong>Editkin 更新後要重新連一次 AI</strong>");
      expect(html).toContain('<span class="agent-help-card-action">重新連一次</span>');
    } finally { agentRuntimeRepairV1.markConnected(); }
    expect(renderToStaticMarkup(<EasyScreen {...props(host(), { onConnectAgent: noop })} />)).toContain("<strong>讓 AI 幫我剪片</strong>");
  });
  it("is absent without the desktop's connect handler", () => {
    expect(renderToStaticMarkup(<EasyScreen {...props(host())} />)).not.toContain("easy-ai-section");
  });
  it("FirstProjectStart passes it on the desktop only; the advanced start shows the same card", () => {
    interfacePreferences.setMode("simple");
    const start = (isDesktop: boolean) => renderToStaticMarkup(<FirstProjectStart isDesktop={isDesktop} onImport={noop} onExploreDemo={noop} onHelp={noop}
      onConnectAgent={isDesktop ? noop : undefined} easyFlowHost={host()} />);
    expect(start(true)).toContain('data-testid="welcome-agent-connect"');
    expect(start(false)).not.toContain('data-testid="welcome-agent-connect"');
    // A browser build never shows it, even if a handler were passed.
    expect(renderToStaticMarkup(<FirstProjectStart isDesktop={false} onImport={noop} onExploreDemo={noop} onHelp={noop} onConnectAgent={noop} easyFlowHost={host()} />))
      .not.toContain("welcome-agent-connect");
    interfacePreferences.setMode("advanced");
    const advanced = renderToStaticMarkup(<FirstProjectStart isDesktop onImport={noop} onExploreDemo={noop} onHelp={noop} onConnectAgent={noop} />);
    expect(advanced).toMatch(/<div class="first-project-agent"><button type="button" class="agent-help-card" data-testid="welcome-agent-connect">/);
    expect(advanced).not.toContain("first-project-ai");
  });
  it("names it in every interface language", async () => {
    for (const locale of ["en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      const html = renderToStaticMarkup(<EasyScreen {...props(host(), { onConnectAgent: noop })} />);
      const label = interfacePreferences.translate("讓 AI 幫我剪片");
      expect(label).not.toBe("讓 AI 幫我剪片");
      expect(html).toContain(`<strong>${label.replace(/'/g, "&#x27;")}</strong>`);
    }
    await interfacePreferences.setLocale("en");
    expect(renderToStaticMarkup(<EasyScreen {...props(host(), { onConnectAgent: noop })} />)).toContain("<strong>Let AI edit for me</strong><small>Use Claude Code or Codex — say one sentence and it edits for you.</small>");
  }, 180_000);
});
