import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentSetupResult } from "../desktop/types";
import { AGENT_CONNECT_KIT_URL_V1, agentConnectFailureV1 } from "../application/agentConnectOutcomeV1";
import type { AgentConnectBridgeV1, AgentConnectRequestV1 } from "./agentConnect/agentConnectTypesV1";

// The production dialog called directly with indexed hook doubles (no DOM here): its flow is taken from the rendered
// screen, driven, and the dialog rendered again. 2026-10-29: the plain-words wizard replaced the two connect buttons.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks.values[i], (next: unknown) => { hooks.values[i] = next; }]; },
  useRef: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useEffect: () => {} }));
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { AgentConnectModal } from "./AgentConnectModal";
import type { AgentConnectFlowV1 } from "./agentConnect/agentConnectFlowV1";

type Element = ReactElement<Record<string, any>>;
/** Every element, with the dialog's (hook-free) screen components expanded in place. */
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement<Record<string, any>>(node)) return [];
  if (typeof node.type === "function") return [node, ...all((node.type as (props: unknown) => ReactNode)(node.props))];
  return [node, ...all(node.props.children as ReactNode)];
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function open(results: AgentSetupResult[], installed = { claude: true, codex: true }) {
  hooks.values = []; hooks.index = 0;
  const requests: Array<{ target: string; request?: AgentConnectRequestV1 }> = [];
  const onConnect = vi.fn(async (target: "codex" | "claude", request?: AgentConnectRequestV1) => {
    requests.push({ target, request });
    return results.length > 1 ? results.shift() : results[0];
  });
  const bridge: AgentConnectBridgeV1 = { detect: async () => installed, openUrl: vi.fn(async () => undefined), copyText: vi.fn(async () => true),
    suggestWorkspace: async () => ({ token: "suggest-token", displayName: "Editkin 作品", displayPath: "C:\\Users\\Ama\\Documents\\Editkin 作品", exists: false, remembered: false }) };
  const onClose = vi.fn();
  const render = () => { hooks.index = 0; return AgentConnectModal({ onClose, onConnect, bridge }); };
  const flow = (all(render()).find(element => element.props.flow)!.props.flow) as AgentConnectFlowV1;
  return { flow, onConnect, requests, bridge, onClose, html: () => renderToStaticMarkup(render()), tree: () => all(render()) };
}
async function connect(t: ReturnType<typeof open>, target: "codex" | "claude") {
  t.flow.start(); await flush();
  t.flow.choose(target);
  t.flow.next(); await flush();
  await t.flow.useSuggestion();
  await t.flow.connect();
}

describe("Agent Connect dialog (production component)", () => {
  it("is a labelled modal dialog that hands the chosen folder (a token, never a path) and a progress callback to the desktop setup; × waits while it connects", async () => {
    const t = open([{ canceled: false, target: "claude", status: "installed", health: "connected", runtimeVerified: true }]);
    expect(t.html()).toMatch(/<section class="agent-connect-modal agent-easy" role="dialog" aria-modal="true" aria-labelledby="agent-connect-title"/);
    t.flow.start(); await flush();
    t.flow.next(); await flush();
    await t.flow.useSuggestion();
    const running = t.flow.connect();
    expect(t.tree().find(element => element.props["data-testid"] === "agent-connect-close")!.props.disabled).toBe(true);
    await running;
    expect(t.requests[0].target).toBe("claude");
    expect(t.requests[0].request?.workspaceToken).toBe("suggest-token");
    expect(JSON.stringify(t.requests[0].request)).not.toContain("Documents");
    expect(typeof t.requests[0].request?.onProgress).toBe("function");
    expect(t.tree().find(element => element.props["data-testid"] === "agent-connect-close")!.props.disabled).toBe(false);
    t.tree().find(element => element.props["data-testid"] === "agent-connect-close")!.props.onClick();
    expect(t.onClose).toHaveBeenCalledOnce();
  });
  it("a repeat Codex connect (already_installed) is 連好了！ with the sentence to paste; the technical line stays folded", async () => {
    const t = open([{ canceled: false, target: "codex", status: "already_installed", health: "configured", runtimeVerified: true, runtimeToolCount: 104,
      message: "Codex 已設定最新版 Editkin MCP；本機 runtime 已通過真握手。", verification: "已真實啟動最新 v3 generation launcher（104 tools／v4 live identity）" }]);
    await connect(t, "codex");
    const html = t.html();
    expect(html).toContain(">連好了！</h2>");
    expect(html).toContain("Codex 之前就連好了，不用再設定。");
    expect(html).toContain("最後一步：打開 Codex，把這句話貼上去");
    expect(html).toContain("在跳出來的視窗輸入 codex，按 Enter。");
    expect(html).toMatch(/<details class="easy-details agent-easy-tech" data-testid="agent-connect-detail"><summary>技術細節<\/summary><p>已確認 Editkin 的 104 個剪輯工具可以啟動<\/p>.*v3 generation launcher/);
    expect(html).not.toContain("這次沒有連成功");
    expect(html).not.toContain("如果 Codex 本來就開著");
  });
  it("an older desktop's missing Kit: plain words, 看怎麼裝 opens the Kit page, the native text under 查看原因, nothing to paste", async () => {
    const native = "找不到最新版 video-autopilot SKILL.md；Editkin 不會在缺少規則真相時假裝已連線";
    const t = open([agentConnectFailureV1("codex", native)]);
    await connect(t, "codex");
    const html = t.html();
    expect(html).toContain(">還差一個「影片自動剪輯技能」</h2>");
    expect(html).toMatch(/<summary>查看原因<\/summary><p>找不到最新版 video-autopilot SKILL.md/);
    expect(html).not.toContain("我自己貼指令");
    expect(html).not.toContain("無法建立 Agent 串接設定");
    t.tree().find(element => element.props["data-testid"] === "agent-connect-fix-kit")!.props.onClick();
    await flush();
    expect(t.bridge.openUrl).toHaveBeenCalledWith(AGENT_CONNECT_KIT_URL_V1);
  });
  it("a failure with no cause says so in plain words with 再試一次 (not paste steps); a copied command opens the paste steps", async () => {
    const failed = open([{ canceled: false, target: "claude", status: "failed", health: "failed", message: "Claude Code 這次沒有連成功。" }]);
    await connect(failed, "claude");
    expect(failed.html()).toContain(">這次沒連上</h2>");
    expect(failed.html()).toContain("再試一次");
    expect(failed.html()).not.toContain("按 Ctrl+V 貼上");
    const copied = open([{ canceled: false, target: "claude", status: "command_copied", health: "manual_step", runtimeVerified: true, message: "尚未找到可用的 Claude Code CLI；安全備援指令已複製。" }]);
    await connect(copied, "claude");
    expect(copied.html()).toContain(">還差一步：自己貼一次指令</h2>");
    expect(copied.html()).toContain("<li>按 Ctrl+V 貼上</li>");
    expect(copied.html()).toContain("貼好了，再檢查一次");
  });
  it("closing the folder picker is not a failure: back to the folder step", async () => {
    const t = open([{ canceled: true, target: "claude", message: "已取消選擇工作資料夾；沒有變更 Codex／Claude 設定" }]);
    await connect(t, "claude");
    expect(t.flow.getState().screen).toBe("folder");
    expect(t.html()).not.toContain("沒連上");
  });
});
