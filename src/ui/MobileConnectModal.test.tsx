import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  agentState,
  dismissRemoteAgentModal,
  MobileConnectModal,
  proposalPresentationState,
  providerActionPresentation,
  remoteProposalGenerationBlocked,
  remoteStartApproval,
} from "./MobileConnectModal";
import type { RemoteAgentLaunchState } from "../desktop/remoteAgentLaunchStore";
import {
  MOBILE_REMOTE_SETUP_PHASE,
  REMOTE_PROVIDER_ACTION_STATE,
  type MobileRemoteNetworkSummary,
  type MobileRemoteNetworkSummaryV2,
  type RemoteProviderProposal,
} from "../desktop/mediaTypes";

const proposal: RemoteProviderProposal = {
  schema: "editkin.remote-provider-proposal/v2",
  phase: "EXACT_PROVIDER_PROPOSAL",
  truthLabel: "PROPOSAL_READY_NOT_APPROVED",
  workflowId: "workflow-1",
  jobId: "0123456789abcdef0123456789abcdef",
  consentRevision: "editkin.remote-agent-consent/v2",
  proposalRevision: "proposal-1",
  proposalDigest: "a".repeat(64),
  connector: {
    connectorId: "tailscale-funnel",
    connectorRevision: "research-2026-09-05",
    manifestSha256: "9a1bb69d46389cf660bcc8c2e0b0e8f1da3f9f19a8098c23cefd41f2c6853600",
    availability: "research-only-disabled",
    attested: false,
    approvalEnabled: false,
    executionOwner: "native-typed-connector",
  },
  planDigest: "b".repeat(64),
  transport: "https-tunnel",
  provider: { id: "tailscale", displayName: "Tailscale", productName: "Funnel", region: "Taiwan" },
  expectedEndpoint: { transport: "https-tunnel", publicOriginRequired: true, description: "Public HTTPS origin" },
  pricing: { kind: "public-list-price", amountMicros: 5_000_000, currency: "USD", billingUnit: "per-month", summary: "公開月費" },
  freeTier: "每月 1 GB",
  quota: "每月 100 GB",
  permissions: ["建立 tunnel"],
  plannedMutations: ["新增一個 tunnel 資源"],
  cancellationOrDeletionConsequences: "刪除後公開網址失效。",
  sources: [
    { label: "官方價格頁", url: "https://example.com/pricing", checkedAtMs: Date.now() - 60_000 },
  ],
  uncertainties: [],
  unsupportedPrerequisites: [],
  costResponsibility: "end-user",
  externalMutationPerformed: false,
  autoDeploy: false,
  approvalAvailable: false,
  createdAtMs: Date.now() - 60_000,
  updatedAtMs: Date.now() - 30_000,
  expiresAtMs: Date.now() + 600_000,
};

function v2Summary(overrides: Partial<MobileRemoteNetworkSummaryV2> = {}): MobileRemoteNetworkSummaryV2 {
  return {
    schema: "editkin.remote-network-summary/v2",
    transport: "lan",
    configured: false,
    pendingDesktopApproval: false,
    providerId: "tailscale",
    costResponsibility: "end-user",
    requiresExternalTrafficConsent: true,
    previewSupport: "preview-available",
    quality: { status: "local", reconnectVerified: false },
    setupPhase: MOBILE_REMOTE_SETUP_PHASE.EXACT_PROVIDER_PROPOSAL,
    truthLabel: "PROPOSAL_READY_NOT_APPROVED",
    proposedTransport: "https-tunnel",
    proposal,
    resumeAvailable: true,
    ...overrides,
  };
}

function renderModal(networkSummary?: MobileRemoteNetworkSummary): string {
  return renderToStaticMarkup(<MobileConnectModal
    networkSummary={networkSummary}
    agentLaunch={{ phase: "idle" }}
    onStartAgent={async () => undefined}
    onCancelAgent={async () => undefined}
    onClose={() => undefined}
    onStart={() => undefined}
    onStop={() => undefined}
    onRevoke={() => undefined}
  />);
}

describe("MobileConnectModal Remote Agent lifecycle", () => {
  it.each(["running", "cancel_requested"] as const)("refuses every shared dismiss path while phase is %s", (phase) => {
    const close = vi.fn();
    expect(dismissRemoteAgentModal({ phase }, close)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("allows close after the terminal result is retained outside the modal", () => {
    const close = vi.fn();
    expect(dismissRemoteAgentModal({ phase: "settled" }, close)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("renders the close control disabled and keeps an explicit cancel action while busy", () => {
    const agentLaunch: RemoteAgentLaunchState = { phase: "running", target: "codex" };
    const html = renderToStaticMarkup(<MobileConnectModal
      agentLaunch={agentLaunch}
      onStartAgent={async () => undefined}
      onCancelAgent={async () => undefined}
      onClose={() => undefined}
      onStop={() => undefined}
      onRevoke={() => undefined}
    />);
    expect(html).toContain('aria-label="Remote AI 執行中，請先取消"');
    expect(html).toMatch(/class="modal-close"[^>]*disabled=""/);
    expect(html).toContain("取消並清理子行程");
  });

  it("labels manual fallback as a visible agent session with explicit remote-only review boundaries", () => {
    const agentLaunch: RemoteAgentLaunchState = {
      phase: "settled",
      target: "codex",
      result: {
        schema: "editkin.remote-agent-launch-result/v1",
        truthLabel: "WINDOWS_INTERNAL_AGENT_LAUNCH_CANDIDATE_NOT_REAL_PHONE_OR_MAC_VERIFIED",
        target: "codex",
        jobId: "1".repeat(32),
        consentRevision: "editkin.remote-agent-consent/v2",
        status: "no_verified_progress",
        message: "沒有可驗證進度",
        providerId: null,
        proposalRevision: null,
        proposalDigest: null,
        resumedExistingState: false,
        stateCreatedThisRun: false,
        manualFallbackAvailable: true,
        receiptPath: "C:\\Editkin\\remote-receipt.json",
        outputTruncated: false,
        realPhoneReconnectVerified: false,
        macVerified: false,
      },
    };
    const html = renderToStaticMarkup(<MobileConnectModal
      agentLaunch={agentLaunch}
      onStartAgent={async () => undefined}
      onCancelAgent={async () => undefined}
      onClose={() => undefined}
      onStop={() => undefined}
      onRevoke={() => undefined}
    />);
    expect(html).toContain("複製一般工作階段任務");
    expect(html).toContain("一般可見的 Codex／Claude 工作階段");
    expect(html).toContain("只應使用 Editkin remote-only MCP");
    expect(html).toContain("逐次人工審核");
    expect(html).not.toContain("安全備援");
  });

  it("shows frozen direct launch readiness without claiming host MCP or phone verification", () => {
    expect(agentState({
      target: "codex",
      available: true,
      configured: false,
      exactConfiguration: false,
      directLaunchReady: true,
      runtimeVerified: false,
      health: "missing",
    })).toBe("可產生 Remote 方案");
  });

  it("renders an inspectable amber proposal without deployment or activation controls", () => {
    const html = renderModal(v2Summary());
    expect(html).toContain("REMOTE · 可檢查研究方案");
    expect(html).toContain("Tailscale · Funnel");
    expect(html).toContain("尚未登入 · 尚未部署 · 尚未連線");
    expect(html).toContain("目前只能研究，不能核准");
    expect(html).toContain("公開牌價");
    expect(html).toContain("每月 1 GB");
    expect(html).toContain("每月 100 GB");
    expect(html).toContain("檢查權限、異動與來源");
    expect(html).toContain('href="https://example.com/pricing"');
    expect(html).not.toContain("核對無誤，寫入設定並啟動");
    expect(html).not.toContain("我了解並啟動已設定的跨網路 Remote");
    expect(html).not.toContain("讓 AI 產生可檢查方案");
    expect(remoteStartApproval(v2Summary())).toBeUndefined();
  });

  it("maps each future provider-owned lifecycle state to at most one truthful primary action", () => {
    const actionableProposal: RemoteProviderProposal = {
      ...proposal,
      approvalAvailable: true,
      connector: {
        ...proposal.connector,
        connectorId: "fixture-connector",
        connectorRevision: "test-1",
        manifestSha256: "c".repeat(64),
        availability: "enabled",
        attested: true,
        approvalEnabled: true,
      },
      planDigest: "d".repeat(64),
      proposalDigest: "e".repeat(64),
    };
    const baseAction = {
      schema: "editkin.remote-provider-action-summary/v1" as const,
      actionId: "f".repeat(32),
      proposalDigest: actionableProposal.proposalDigest,
      connectorId: actionableProposal.connector.connectorId,
      connectorRevision: actionableProposal.connector.connectorRevision,
      connectorManifestSha256: actionableProposal.connector.manifestSha256,
      planDigest: actionableProposal.planDigest,
      mutationTruth: "none" as const,
      providerOwnedLogin: true as const,
      secretsAcceptedByEditkin: false as const,
      resumeAvailable: false,
      cancelAvailable: false,
      reconcileAvailable: false,
    };
    expect(providerActionPresentation({ ...baseAction, state: REMOTE_PROVIDER_ACTION_STATE.PROVIDER_AUTH_REQUIRED }, actionableProposal)?.intent).toBe("login");
    expect(providerActionPresentation({ ...baseAction, state: REMOTE_PROVIDER_ACTION_STATE.PROVIDER_ACTION_RUNNING, mutationTruth: "unknown", cancelAvailable: true }, actionableProposal)?.intent).toBe("cancel");
    expect(providerActionPresentation({ ...baseAction, state: REMOTE_PROVIDER_ACTION_STATE.PROVIDER_ACTION_RECONCILIATION_REQUIRED, mutationTruth: "unknown", reconcileAvailable: true }, actionableProposal)?.intent).toBe("reconcile");
    expect(providerActionPresentation({ ...baseAction, state: REMOTE_PROVIDER_ACTION_STATE.CANCELED_NO_MUTATION, resumeAvailable: true }, actionableProposal)?.intent).toBe("resume");
    expect(providerActionPresentation({ ...baseAction, state: REMOTE_PROVIDER_ACTION_STATE.AWAITING_DESKTOP_APPROVAL, mutationTruth: "confirmed" }, actionableProposal)?.intent).toBeUndefined();
    expect(providerActionPresentation({ ...baseAction, state: REMOTE_PROVIDER_ACTION_STATE.PROVIDER_AUTH_REQUIRED, proposalDigest: "0".repeat(64) }, actionableProposal)).toMatchObject({ valid: false });
  });

  it("treats expired and malformed proposals as non-actionable", () => {
    const expired = v2Summary({
      setupPhase: MOBILE_REMOTE_SETUP_PHASE.EXPIRED,
      truthLabel: "PROPOSAL_EXPIRED_NOT_APPROVED",
      proposal: { ...proposal, expiresAtMs: Date.now() - 1 },
    });
    const expiredHtml = renderModal(expired);
    expect(proposalPresentationState(expired)).toBe("expired");
    expect(expiredHtml).toContain("這份方案已失效，不能核准或啟動");
    expect(expiredHtml).toContain("讓 AI 產生可檢查方案");
    expect(expiredHtml).not.toContain("核對無誤，寫入設定並啟動");

    const incoherentPricing = v2Summary({ proposal: { ...proposal, pricing: { kind: "unknown", amountMicros: null, currency: null, billingUnit: "unknown", summary: "未知" }, uncertainties: [] } });
    expect(proposalPresentationState(incoherentPricing)).toBe("invalid");
    expect(renderModal(incoherentPricing)).toContain("方案資料不完整，已停止後續操作");
    const unsafeSource = v2Summary({ proposal: { ...proposal, sources: [{ label: "不安全來源", url: "http://example.com/insecure", checkedAtMs: Date.now() }] } });
    expect(proposalPresentationState(unsafeSource)).toBe("invalid");
    expect(renderModal(unsafeSource)).not.toContain('href="http://example.com/insecure"');
  });

  it("never treats a legacy summary as activation authority", () => {
    const legacy: MobileRemoteNetworkSummary = {
      schema: "editkin.remote-network-summary/v1",
      transport: "https-tunnel",
      configured: true,
      pendingDesktopApproval: false,
      configurationId: "old-config",
      providerId: "legacy",
      costResponsibility: "end-user",
      requiresExternalTrafficConsent: true,
      previewSupport: "preview-available",
      quality: { status: "unverified", reconnectVerified: false },
    };
    const html = renderModal(legacy);
    expect(proposalPresentationState(legacy)).toBe("legacy");
    expect(remoteStartApproval(legacy)).toBeUndefined();
    expect(html).toContain("讓 AI 產生可檢查方案");
    expect(html).not.toContain("我了解並啟動已設定的跨網路 Remote");
  });

  it("shows desktop activation only for a bound v2 approval phase", () => {
    const awaiting = v2Summary({
      setupPhase: MOBILE_REMOTE_SETUP_PHASE.AWAITING_DESKTOP_APPROVAL,
      truthLabel: "DESKTOP_APPROVAL_REQUIRED_NOT_CONNECTED",
      pendingDesktopApproval: true,
      candidateRevision: "candidate-1",
      configurationId: "configuration-1",
    });
    const approval = remoteStartApproval(awaiting);
    expect(approval).toEqual({
      externalTrafficConfirmed: true,
      expectedCandidateRevision: "candidate-1",
      expectedConfigurationId: "configuration-1",
    });
    expect(renderModal(awaiting)).toContain("核對無誤，寫入設定並啟動");
    expect(remoteStartApproval({ ...awaiting, truthLabel: "PROPOSAL_READY_NOT_APPROVED" })).toBeUndefined();
    expect(remoteStartApproval({ ...awaiting, candidateRevision: undefined })).toBeUndefined();
  });

  it("binds an established file-config restart to the exact active configuration id", () => {
    const configured = v2Summary({
      setupPhase: MOBILE_REMOTE_SETUP_PHASE.CONFIGURED_UNVERIFIED,
      truthLabel: "CONFIGURED_NOT_VERIFIED",
      configured: true,
      pendingDesktopApproval: false,
      candidateRevision: undefined,
      configurationId: "a".repeat(64),
      proposal: undefined,
      proposedTransport: undefined,
      transport: "https-tunnel",
      resumeAvailable: false,
    });
    expect(remoteStartApproval(configured)).toEqual({
      externalTrafficConfirmed: true,
      expectedConfigurationId: "a".repeat(64),
    });
    expect(remoteStartApproval({ ...configured, configurationId: undefined })).toBeUndefined();
    expect(remoteStartApproval({ ...configured, truthLabel: "PROPOSAL_READY_NOT_APPROVED" })).toBeUndefined();

    const environmentConfigured = {
      ...configured,
      setupPhase: MOBILE_REMOTE_SETUP_PHASE.ENV_CONFIGURED_READ_ONLY,
      truthLabel: "ENV_CONFIGURED_OUTSIDE_EDITKIN" as const,
      configurationId: "b".repeat(64),
      providerId: "environment-configured",
    };
    expect(remoteProposalGenerationBlocked(environmentConfigured)).toBe(true);
    expect(remoteStartApproval(environmentConfigured)).toEqual({
      externalTrafficConfirmed: true,
      expectedConfigurationId: "b".repeat(64),
    });
    const environmentHtml = renderModal(environmentConfigured);
    expect(environmentHtml).toContain("目前由環境變數管理");
    expect(environmentHtml).toContain("我了解並啟動已設定的跨網路 Remote");
    expect(environmentHtml).not.toContain("讓 AI 產生可檢查方案");
    expect(remoteStartApproval({ ...environmentConfigured, configurationId: undefined })).toBeUndefined();
  });

  it.each([
    [MOBILE_REMOTE_SETUP_PHASE.RENEWAL_RECONCILIATION_REQUIRED, "RENEWAL_RECOVERY_REQUIRED_NO_AUTOMATIC_REPLAY", "續約復原需要人工處理"],
    [MOBILE_REMOTE_SETUP_PHASE.LEGACY_PENDING_BLOCKED, "LEGACY_PENDING_REQUIRES_MIGRATION_OR_DISCARD", "舊版確認單已封鎖"],
    [MOBILE_REMOTE_SETUP_PHASE.STATE_RECONCILIATION_REQUIRED, "STATE_CONFLICT_REQUIRES_MANUAL_RECONCILIATION", "Remote 狀態需要人工對帳"],
  ] as const)("keeps %s read-only and hides agent/start actions", (setupPhase, truthLabel, expectedTitle) => {
    const blocked = v2Summary({
      setupPhase,
      truthLabel,
      proposal: undefined,
      proposedTransport: undefined,
      resumeAvailable: false,
    });
    const html = renderModal(blocked);
    expect(remoteProposalGenerationBlocked(blocked)).toBe(true);
    expect(remoteStartApproval(blocked)).toBeUndefined();
    expect(html).toContain(expectedTitle);
    expect(html).not.toContain("讓 AI 產生可檢查方案");
    expect(html).not.toContain("核對無誤，寫入設定並啟動");
    expect(html).not.toContain("我了解並啟動已設定的跨網路 Remote");
  });
});
