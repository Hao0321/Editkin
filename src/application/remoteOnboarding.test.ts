import { describe, expect, it } from "vitest";
import {
  EDITKIN_REMOTE_AGENT_TASK,
  preferredRemoteAgent,
  remoteAgentReady,
  remoteProposalNeedsAttention,
  type AgentConnectionsResult,
} from "./remoteOnboarding";
import type { MobileRemoteNetworkSummary } from "../desktop/mediaTypes";

const connections: AgentConnectionsResult = {
  codex: { target: "codex", available: true, configured: true, exactConfiguration: true, health: "configured" },
  claude: { target: "claude", available: true, configured: true, exactConfiguration: true, runtimeVerified: true, sessionConnected: false, health: "connected" },
  preferredTarget: "claude",
  checkedAt: 1,
};

describe("AI-assisted Remote onboarding", () => {
  it("selects only a current verified Editkin MCP connection", () => {
    expect(preferredRemoteAgent(connections)?.target).toBe("claude");
    expect(remoteAgentReady({ ...connections.codex, exactConfiguration: false, health: "outdated" })).toBe(false);
    expect(remoteAgentReady(connections.codex)).toBe(false);
  });

  it("prefers a fail-closed native-launch-ready CLI without treating it as phone verification", () => {
    const launchable: AgentConnectionsResult = {
      codex: { target: "codex", available: true, configured: true, exactConfiguration: true, loginReady: true, launchReady: true, directLaunchReady: true, runtimeVerified: false, health: "configured" },
      claude: { target: "claude", available: true, configured: true, exactConfiguration: true, loginReady: false, launchReady: false, runtimeVerified: true, health: "connected" },
      preferredTarget: "claude",
      checkedAt: 2,
    };
    expect(preferredRemoteAgent(launchable)?.target).toBe("codex");
    expect(remoteAgentReady(launchable.codex)).toBe(false);
  });

  it("does not couple frozen direct launch readiness to unrelated host MCP configuration", () => {
    const isolated: AgentConnectionsResult = {
      codex: {
        target: "codex", available: true, configured: false, exactConfiguration: false,
        directLaunchReady: true, launchReady: true, runtimeVerified: false, health: "missing",
      },
      claude: {
        target: "claude", available: true, configured: true, exactConfiguration: true,
        directLaunchReady: false, launchReady: false, loginReady: false, health: "connected",
      },
      preferredTarget: "claude",
      checkedAt: 3,
    };
    expect(preferredRemoteAgent(isolated)?.target).toBe("codex");
    expect(remoteAgentReady(isolated.codex)).toBe(false);
  });

  it("keeps the manual fallback inside the proposal-only research plane", () => {
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("只完成 Remote 研究階段");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("list_remote_provider_connectors");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("closed registry");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("建立 proposal 後立刻停下來");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("費用責任");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("價格金額／幣別／計費單位");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("來源查核時間由 Editkin");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("可能消耗我的方案額度或 API 費用");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("API key、token、cookie、密碼或其他登入資料不得");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("不得呼叫 configure_remote_access 或 verify_remote_access");
    expect(EDITKIN_REMOTE_AGENT_TASK).toContain("不得登入供應商、執行供應商 CLI、部署 tunnel、建立外部資源");
    expect(EDITKIN_REMOTE_AGENT_TASK).not.toContain("我確認後才可");
    expect(EDITKIN_REMOTE_AGENT_TASK).not.toContain("之後再呼叫 verify_remote_access");
  });

  it("keeps proposal and expiry summaries visible before starting LAN", () => {
    const summary = (setupPhase: "EXACT_PROVIDER_PROPOSAL" | "EXPIRED" | "RESEARCH_READY" | "RENEWAL_RECONCILIATION_REQUIRED" | "LEGACY_PENDING_BLOCKED" | "STATE_RECONCILIATION_REQUIRED") => ({
      schema: "editkin.remote-network-summary/v2",
      setupPhase,
    }) as MobileRemoteNetworkSummary;
    expect(remoteProposalNeedsAttention(summary("EXACT_PROVIDER_PROPOSAL"))).toBe(true);
    expect(remoteProposalNeedsAttention(summary("EXPIRED"))).toBe(true);
    expect(remoteProposalNeedsAttention(summary("RENEWAL_RECONCILIATION_REQUIRED"))).toBe(true);
    expect(remoteProposalNeedsAttention(summary("LEGACY_PENDING_BLOCKED"))).toBe(true);
    expect(remoteProposalNeedsAttention(summary("STATE_RECONCILIATION_REQUIRED"))).toBe(true);
    expect(remoteProposalNeedsAttention(summary("RESEARCH_READY"))).toBe(false);
  });
});
