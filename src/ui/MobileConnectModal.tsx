import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import {
  EDITKIN_REMOTE_AGENT_TASK,
  preferredRemoteAgent,
  type AgentConnectionSummary,
  type AgentConnectionsResult,
} from "../application/remoteOnboarding";
import type { MobileRemoteNetworkSummary, MobileRemoteResult, MobileRemoteStartOptions, MobileRemoteStatus } from "../desktop/types";
import {
  remoteAgentLaunchBusy,
  type RemoteAgentLaunchState,
} from "../desktop/remoteAgentLaunchStore";
import {
  MOBILE_REMOTE_SETUP_PHASE,
  REMOTE_PROVIDER_ACTION_STATE,
  type RemoteProviderActionSummary,
  type RemoteProviderProposal,
} from "../desktop/mediaTypes";
import "./mobileConnect.css";

interface MobileConnectModalProps {
  remote?: MobileRemoteResult;
  status?: MobileRemoteStatus;
  networkSummary?: MobileRemoteNetworkSummary;
  agentLaunch: RemoteAgentLaunchState;
  onStartAgent: (target: "codex" | "claude") => Promise<unknown>;
  onCancelAgent: () => Promise<void>;
  onClose: () => void;
  onStart?: (options: MobileRemoteStartOptions) => void;
  onStop: () => void;
  onRevoke: (deviceId: string) => void;
  onOpenAgentConnect?: () => void;
  onProviderAction?: (intent: "login" | "resume" | "cancel" | "reconcile") => void;
}

const AGENT_LABEL = { codex: "Codex", claude: "Claude Code" } as const;
const BILLING_UNIT_LABEL: Record<Exclude<RemoteProviderProposal["pricing"]["billingUnit"], "unknown">, string> = {
  "per-month": "／月",
  "per-gigabyte": "／GB",
  "per-hour": "／小時",
  "one-time": "（一次性）",
};
const KNOWN_BILLING_UNITS = new Set<string>(Object.keys(BILLING_UNIT_LABEL));

type ProposalPresentationState = "none" | "legacy" | "ready" | "expired" | "invalid";

export function dismissRemoteAgentModal(
  agentLaunch: RemoteAgentLaunchState,
  onClose: () => void,
): boolean {
  if (remoteAgentLaunchBusy(agentLaunch)) return false;
  onClose();
  return true;
}

export function agentState(connection?: AgentConnectionSummary): string {
  if (!connection) return "檢查中";
  if (connection.directLaunchReady) return "可產生 Remote 方案";
  if (connection.sessionConnected) return "工作階段已連線";
  if (connection.runtimeVerified) return "MCP 探測通過";
  if (connection.health === "configured" && connection.exactConfiguration) return "已設定，待工作階段確認";
  if (connection.health === "outdated") return "需更新";
  if (connection.health === "failed") return "檢查失敗";
  return connection.available ? "未設定" : "未安裝";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function remoteProposalIsCoherent(proposal: RemoteProviderProposal): boolean {
  if (!proposal || typeof proposal !== "object"
      || !proposal.provider || !proposal.expectedEndpoint || !proposal.pricing
      || !Array.isArray(proposal.permissions) || proposal.permissions.length === 0
      || !Array.isArray(proposal.plannedMutations) || proposal.plannedMutations.length === 0
      || !Array.isArray(proposal.sources) || proposal.sources.length === 0
      || !Array.isArray(proposal.uncertainties)
      || !Array.isArray(proposal.unsupportedPrerequisites)) return false;
  const pricing = proposal.pricing;
  const pricingIsCoherent = pricing.kind === "unknown"
    ? pricing.amountMicros === null && pricing.currency === null && pricing.billingUnit === "unknown" && proposal.uncertainties.length > 0
    : Number.isSafeInteger(pricing.amountMicros) && pricing.amountMicros >= 0
      && /^[A-Z]{3}$/.test(pricing.currency) && KNOWN_BILLING_UNITS.has(pricing.billingUnit);
  const connectorApprovalAvailable = proposal.connector?.availability === "enabled"
    && proposal.connector.attested === true
    && proposal.connector.approvalEnabled === true;
  return proposal.schema === "editkin.remote-provider-proposal/v2"
    && proposal.phase === "EXACT_PROVIDER_PROPOSAL"
    && proposal.truthLabel === "PROPOSAL_READY_NOT_APPROVED"
    && proposal.costResponsibility === "end-user"
    && proposal.externalMutationPerformed === false
    && proposal.autoDeploy === false
    && typeof proposal.connector?.connectorId === "string"
    && typeof proposal.connector?.connectorRevision === "string"
    && /^[a-f0-9]{64}$/.test(proposal.connector?.manifestSha256 ?? "")
    && proposal.connector?.executionOwner === "native-typed-connector"
    && proposal.approvalAvailable === connectorApprovalAvailable
    && /^[a-f0-9]{64}$/.test(proposal.planDigest)
    && proposal.expectedEndpoint.publicOriginRequired === true
    && proposal.expectedEndpoint.transport === proposal.transport
    && proposal.transport === "https-tunnel"
    && proposal.sources.every((source) => Boolean(safeHttpsUrl(source.url))
      && Number.isSafeInteger(source.checkedAtMs) && source.checkedAtMs > 0)
    && Number.isSafeInteger(proposal.expiresAtMs)
    && proposal.expiresAtMs > 0
    && pricingIsCoherent;
}

export type ProviderActionIntent = "login" | "resume" | "cancel" | "reconcile";

export function providerActionPresentation(
  action?: RemoteProviderActionSummary,
  proposal?: RemoteProviderProposal,
): { valid: boolean; title: string; detail: string; intent?: ProviderActionIntent; label?: string } | undefined {
  if (!action) return undefined;
  const exactBinding = proposal?.approvalAvailable === true
    && proposal.proposalDigest === action.proposalDigest
    && proposal.planDigest === action.planDigest
    && proposal.connector.connectorId === action.connectorId
    && proposal.connector.connectorRevision === action.connectorRevision
    && proposal.connector.manifestSha256 === action.connectorManifestSha256
    && action.providerOwnedLogin === true
    && action.secretsAcceptedByEditkin === false
    && /^[a-f0-9]{32}$/.test(action.actionId);
  const mutationTruthMatchesState = action.state === REMOTE_PROVIDER_ACTION_STATE.PROVIDER_ACTION_RECONCILIATION_REQUIRED
    ? action.mutationTruth === "unknown"
    : action.state === REMOTE_PROVIDER_ACTION_STATE.AWAITING_DESKTOP_APPROVAL
      ? action.mutationTruth === "confirmed"
      : action.state === REMOTE_PROVIDER_ACTION_STATE.PROVIDER_ACTION_RUNNING
        ? action.mutationTruth === "none" || action.mutationTruth === "unknown"
        : action.mutationTruth === "none";
  if (!exactBinding || !mutationTruthMatchesState) return {
    valid: false,
    title: "供應商動作狀態不一致",
    detail: "Proposal、connector 或 plan identity 不一致；Editkin 已停止，不會重播或建立外部資源。",
  };
  switch (action.state) {
    case REMOTE_PROVIDER_ACTION_STATE.APPROVED_NOT_STARTED:
      return { valid: true, title: "已核准，尚未執行", detail: "即將由 native connector 執行單一已核准 plan；AI 不會操作供應商。", intent: "resume", label: "開始已核准的設定" };
    case REMOTE_PROVIDER_ACTION_STATE.PROVIDER_AUTH_REQUIRED:
      return { valid: true, title: "需要在供應商完成登入", detail: "登入由供應商自己的瀏覽器流程處理；Editkin 不讀取或保存密碼、token、cookie。", intent: "login", label: "開啟供應商登入" };
    case REMOTE_PROVIDER_ACTION_STATE.PROVIDER_ACTION_RUNNING:
      return action.cancelAvailable
        ? { valid: true, title: "供應商正在處理", detail: "只執行這次核准的單一 plan；停止後仍會先對帳，絕不盲目重送。", intent: "cancel", label: "停止並安全對帳" }
        : { valid: true, title: "供應商正在處理", detail: "目前不可安全取消；Editkin 會保留 action ID 並等待可驗證結果。" };
    case REMOTE_PROVIDER_ACTION_STATE.PROVIDER_ACTION_RECONCILIATION_REQUIRED:
      return action.reconcileAvailable
        ? { valid: true, title: "結果不明，需要安全對帳", detail: "不會重跑 create 或 delete；只讀檢查同一 action/resource 的真實狀態。", intent: "reconcile", label: "只讀對帳供應商狀態" }
        : { valid: true, title: "結果不明，已停止", detail: "目前沒有可驗證的只讀對帳路徑；禁止盲目重試。" };
    case REMOTE_PROVIDER_ACTION_STATE.FAILED_NO_MUTATION:
      return action.resumeAvailable
        ? { valid: true, title: "設定未建立任何資源", detail: "已確認沒有外部 mutation；可沿用同一 idempotency identity 再次開始。", intent: "resume", label: "重新開始已核准 plan" }
        : { valid: true, title: "設定未完成", detail: "已確認沒有外部 mutation；目前不可重試。" };
    case REMOTE_PROVIDER_ACTION_STATE.CANCELED_NO_MUTATION:
      return action.resumeAvailable
        ? { valid: true, title: "已取消，沒有建立資源", detail: "已確認外部狀態乾淨；可稍後沿用同一核准 identity。", intent: "resume", label: "繼續已核准 plan" }
        : { valid: true, title: "已取消，沒有建立資源", detail: "外部狀態已確認乾淨。" };
    case REMOTE_PROVIDER_ACTION_STATE.AWAITING_DESKTOP_APPROVAL:
      return { valid: true, title: "供應商步驟完成，等待桌面核准", detail: "這還不是已設定或已連線；請核對候選網址與 configuration identity 後再啟動。" };
  }
}

export function proposalPresentationState(
  networkSummary?: MobileRemoteNetworkSummary,
  nowMs = Date.now(),
): ProposalPresentationState {
  if (!networkSummary) return "none";
  if (networkSummary.schema !== "editkin.remote-network-summary/v2") return "legacy";
  if (!networkSummary.proposal) return "none";
  if (!remoteProposalIsCoherent(networkSummary.proposal)
      || networkSummary.proposedTransport !== networkSummary.proposal.transport) return "invalid";
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.EXPIRED) {
    return networkSummary.truthLabel === "PROPOSAL_EXPIRED_NOT_APPROVED" ? "expired" : "invalid";
  }
  if (networkSummary.proposal.expiresAtMs <= nowMs) return "expired";
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.EXACT_PROVIDER_PROPOSAL
      && networkSummary.truthLabel === "PROPOSAL_READY_NOT_APPROVED") return "ready";
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.AWAITING_DESKTOP_APPROVAL
      || networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.CONFIGURED_UNVERIFIED
      || networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.ROUTE_PARTIAL_VERIFIED
      || networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.CONNECTED) return "none";
  return "invalid";
}

export function remoteProposalGenerationBlocked(networkSummary?: MobileRemoteNetworkSummary): boolean {
  if (!networkSummary || networkSummary.schema !== "editkin.remote-network-summary/v2") return false;
  const researchCanStart = networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.RESEARCH_READY
    && networkSummary.truthLabel === "READY_TO_RESEARCH";
  const expiredCanRenew = networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.EXPIRED
    && networkSummary.truthLabel === "PROPOSAL_EXPIRED_NOT_APPROVED";
  return !researchCanStart && !expiredCanRenew;
}

function blockedRemoteSetupCopy(networkSummary?: MobileRemoteNetworkSummary): { title: string; detail: string } | undefined {
  if (!networkSummary || networkSummary.schema !== "editkin.remote-network-summary/v2") return undefined;
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.RENEWAL_RECONCILIATION_REQUIRED
      && networkSummary.truthLabel === "RENEWAL_RECOVERY_REQUIRED_NO_AUTOMATIC_REPLAY") {
    return { title: "續約復原需要人工處理", detail: "舊方案不會自動重播；請先完成狀態對帳，再建立新的研究方案。" };
  }
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.LEGACY_PENDING_BLOCKED
      && networkSummary.truthLabel === "LEGACY_PENDING_REQUIRES_MIGRATION_OR_DISCARD") {
    return { title: "舊版確認單已封鎖", detail: "它缺少價格、配額、權限與完整 identity，必須先遷移或安全捨棄。" };
  }
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.ENV_CONFIGURED_READ_ONLY
      && networkSummary.truthLabel === "ENV_CONFIGURED_OUTSIDE_EDITKIN") {
    return { title: "目前由環境變數管理", detail: "Editkin 只讀顯示這個外部設定，不會讓 AI 覆寫或把它當成桌面核准候選。" };
  }
  if (networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.STATE_RECONCILIATION_REQUIRED
      && networkSummary.truthLabel === "STATE_CONFLICT_REQUIRES_MANUAL_RECONCILIATION") {
    return { title: "Remote 狀態需要人工對帳", detail: "偵測到互相衝突或過期的狀態來源；在完成安全清理前，不會研究、核准或啟動。" };
  }
  return undefined;
}

export function remoteStartApproval(networkSummary?: MobileRemoteNetworkSummary): MobileRemoteStartOptions | undefined {
  if (!networkSummary || networkSummary.schema !== "editkin.remote-network-summary/v2") return undefined;
  const phaseTruthMatches = networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.AWAITING_DESKTOP_APPROVAL
    ? networkSummary.truthLabel === "DESKTOP_APPROVAL_REQUIRED_NOT_CONNECTED"
    : networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.CONFIGURED_UNVERIFIED
      ? networkSummary.truthLabel === "CONFIGURED_NOT_VERIFIED"
      : networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.ENV_CONFIGURED_READ_ONLY
        ? networkSummary.truthLabel === "ENV_CONFIGURED_OUTSIDE_EDITKIN"
      : networkSummary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.ROUTE_PARTIAL_VERIFIED
        ? networkSummary.truthLabel === "ROUTE_PARTIAL_NOT_REAL_PHONE_RECONNECT_VERIFIED"
        : false;
  if (!phaseTruthMatches || !networkSummary.requiresExternalTrafficConsent) return undefined;
  if (networkSummary.pendingDesktopApproval
      && (!networkSummary.candidateRevision || !networkSummary.configurationId)) return undefined;
  if (!networkSummary.pendingDesktopApproval && !networkSummary.configurationId) return undefined;
  if (!networkSummary.pendingDesktopApproval) return {
    externalTrafficConfirmed: true,
    expectedConfigurationId: networkSummary.configurationId,
  };
  return {
    externalTrafficConfirmed: true,
    expectedCandidateRevision: networkSummary.candidateRevision,
    expectedConfigurationId: networkSummary.configurationId,
  };
}

function formatCheckedAt(checkedAtMs: number): string {
  if (!Number.isFinite(checkedAtMs) || checkedAtMs <= 0) return "查核時間無效";
  const checkedAt = new Date(checkedAtMs);
  if (!Number.isFinite(checkedAt.getTime())) return "查核時間無效";
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(checkedAt);
}

function formatProposalPrice(proposal: RemoteProviderProposal): string {
  const pricing = proposal.pricing;
  if (pricing.kind === "unknown") return `價格尚未查證 · ${pricing.summary}`;
  const amount = pricing.amountMicros / 1_000_000;
  let formatted = `${pricing.currency} ${amount.toLocaleString("zh-TW")}`;
  try {
    formatted = new Intl.NumberFormat("zh-TW", { style: "currency", currency: pricing.currency }).format(amount);
  } catch {
    // Keep the explicit currency code when the runtime does not recognize it.
  }
  return `${pricing.kind === "estimate" ? "估算 " : "公開牌價 "}${formatted}${BILLING_UNIT_LABEL[pricing.billingUnit]} · ${pricing.summary}`;
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function ProposalList({ items, emptyLabel = "未列出" }: { items: string[]; emptyLabel?: string }) {
  if (items.length === 0) return <p className="remote-proposal-empty">{emptyLabel}</p>;
  return <ul className="remote-proposal-list">{items.slice(0, 8).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>;
}

function RemoteProposalCard({
  proposal,
  state,
  resumeAvailable,
}: {
  proposal: RemoteProviderProposal;
  state: "ready" | "expired";
  resumeAvailable: boolean;
}) {
  const sources = proposal.sources.map((source) => ({ ...source, safeUrl: safeHttpsUrl(source.url) }));
  return <section className={`remote-proposal-card ${state}`} aria-label="Remote 可檢查方案">
    <header>
      <div>
        <span className="remote-proposal-kicker">REMOTE · 可檢查研究方案</span>
        <h3>{proposal.provider.displayName} · {proposal.provider.productName}</h3>
      </div>
      <span className="remote-proposal-badge">{state === "expired" ? "已過期" : "待你檢查"}</span>
    </header>
    <p className="remote-proposal-truth"><b>尚未登入 · 尚未部署 · 尚未連線</b><span>{state === "expired" ? "這份方案已失效，不能核准或啟動；必須先重新研究。" : "這只是研究結果，不會自動建立資源或產生費用。"}</span></p>
    <dl className="remote-proposal-summary">
      <div className="wide"><dt>Native connector</dt><dd>{proposal.connector.connectorId} · {proposal.connector.availability === "enabled" ? "已啟用" : proposal.connector.availability === "research-only-disabled" ? "研究中，尚未啟用" : "暫時方案，不支援產品使用"}</dd></div>
      <div><dt>供應商地區</dt><dd>{proposal.provider.region}</dd></div>
      <div><dt>連線方式</dt><dd>{proposal.transport === "https-tunnel" ? "使用者自備 HTTPS tunnel" : "使用者自備 WSS relay"}</dd></div>
      <div className="wide"><dt>價格</dt><dd>{formatProposalPrice(proposal)}</dd></div>
      <div><dt>免費額度</dt><dd>{proposal.freeTier}</dd></div>
      <div><dt>配額</dt><dd>{proposal.quota}</dd></div>
      <div className="wide"><dt>費用責任</dt><dd>由你自己的供應商帳戶承擔；Editkin 不代付。</dd></div>
      <div className="wide"><dt>方案有效至</dt><dd>{formatCheckedAt(proposal.expiresAtMs)}</dd></div>
    </dl>
    <details className="remote-proposal-details">
      <summary>檢查權限、異動與來源</summary>
      <div className="remote-proposal-detail-grid">
        <section><h4>需要的權限</h4><ProposalList items={proposal.permissions} /></section>
        <section><h4>預計異動</h4><ProposalList items={proposal.plannedMutations} /></section>
        <section className="wide"><h4>預期公開端點</h4><p>{proposal.expectedEndpoint.description}（目前尚未建立）</p></section>
        <section className="wide"><h4>取消／刪除後果</h4><p>{proposal.cancellationOrDeletionConsequences}</p></section>
        <section><h4>不確定性</h4><ProposalList items={proposal.uncertainties} emptyLabel="未列出不確定性" /></section>
        <section><h4>不支援的前置條件</h4><ProposalList items={proposal.unsupportedPrerequisites} emptyLabel="沒有已知項目" /></section>
        <section className="wide"><h4>公開來源</h4><ul className="remote-proposal-sources">{sources.slice(0, 8).map((source, index) => <li key={`${index}-${source.label}`}><span>{source.label}</span>{source.safeUrl ? <a href={source.safeUrl} target="_blank" rel="noreferrer noopener">開啟來源</a> : <em>非 HTTPS，未提供連結</em>}<small>方案記錄時間：{formatCheckedAt(source.checkedAtMs)}</small></li>)}</ul></section>
      </div>
    </details>
    {!proposal.approvalAvailable && state === "ready" && <p className="remote-proposal-resume"><b>目前只能研究，不能核准</b> · 此 connector 尚未同時通過 enabled 與 native attestation；Editkin 不會顯示登入或部署按鈕。</p>}
    {resumeAvailable && state === "ready" && <small className="remote-proposal-resume">方案已安全保留，可稍後回來檢查；不會自動部署。</small>}
  </section>;
}

export function MobileConnectModal({ remote, status, networkSummary, agentLaunch, onStartAgent, onCancelAgent, onClose, onStart, onStop, onRevoke, onOpenAgentConnect, onProviderAction }: MobileConnectModalProps) {
  const [qrCode, setQrCode] = useState<string>();
  const [copied, setCopied] = useState(remote?.copied ?? false);
  const [agentTaskCopied, setAgentTaskCopied] = useState(false);
  const [agentConnections, setAgentConnections] = useState<AgentConnectionsResult>();
  const [agentCheckFailed, setAgentCheckFailed] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<"codex" | "claude">();
  const [agentScopeConfirmed, setAgentScopeConfirmed] = useState(false);
  const agentLaunchBusy = remoteAgentLaunchBusy(agentLaunch);
  const agentLaunchResult = agentLaunch.result;
  const agentLaunchError = agentLaunch.error ?? agentLaunch.cancelError;
  const connected = Boolean(remote) && (status?.connectedCount ?? 0) > 0;
  const activeTransport = remote?.transport ?? networkSummary?.transport ?? "lan";
  const internet = activeTransport !== "lan";
  const transportLabel = activeTransport === "cloud-relay" ? "使用者自備 WSS relay" : activeTransport === "https-tunnel" ? "使用者自備 HTTPS tunnel" : "預設 LAN";
  const preferredAgent = useMemo(() => preferredRemoteAgent(agentConnections), [agentConnections]);
  const selectedConnection = selectedAgent ? agentConnections?.[selectedAgent] : undefined;
  const proposalState = proposalPresentationState(networkSummary);
  const proposal = networkSummary?.schema === "editkin.remote-network-summary/v2" ? networkSummary.proposal : undefined;
  const startApproval = remoteStartApproval(networkSummary);
  const proposalGenerationBlocked = remoteProposalGenerationBlocked(networkSummary);
  const blockedSetupCopy = blockedRemoteSetupCopy(networkSummary);
  const providerAction = networkSummary?.schema === "editkin.remote-network-summary/v2" ? networkSummary.providerAction : undefined;
  const providerActionCopy = providerActionPresentation(providerAction, proposal);
  const canRequestProposal = !remote && !startApproval
    && !proposalGenerationBlocked
    && (proposalState === "none" || proposalState === "legacy" || proposalState === "expired");
  const showAgentSetup = canRequestProposal || agentLaunchBusy || Boolean(agentLaunchError);

  useEffect(() => {
    if (!remote) {
      setQrCode(undefined);
      return;
    }
    let active = true;
    void QRCode.toDataURL(remote.url, {
      width: 360,
      margin: 1,
      color: { dark: "#08090d", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).then((value) => { if (active) setQrCode(value); });
    return () => { active = false; };
  }, [remote]);

  useEffect(() => {
    let active = true;
    const inspect = window.haoDesktop?.inspectAgentConnections;
    if (!inspect) {
      setAgentCheckFailed(true);
      return () => { active = false; };
    }
    void inspect().then((result) => {
      if (active) {
        setAgentConnections(result);
        setSelectedAgent((current) => current ?? preferredRemoteAgent(result)?.target);
      }
    }).catch(() => {
      if (active) setAgentCheckFailed(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissRemoteAgentModal(agentLaunch, onClose);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [agentLaunch, onClose]);

  const copy = async () => {
    if (!remote) return;
    setCopied(await copyText(remote.url));
  };

  const startAiSetup = async () => {
    setAgentTaskCopied(false);
    const target = selectedAgent ?? preferredAgent?.target;
    const connection = target ? agentConnections?.[target] : undefined;
    if (!target || !connection?.directLaunchReady) {
      onOpenAgentConnect?.();
      return;
    }
    if (!agentScopeConfirmed) return;
    const launch = onStartAgent(target);
    setAgentScopeConfirmed(false);
    await launch;
  };

  const cancelAiSetup = async () => {
    await onCancelAgent();
  };

  const chooseAgent = (target: "codex" | "claude") => {
    if (target === selectedAgent) return;
    setSelectedAgent(target);
    setAgentScopeConfirmed(false);
  };

  const copyManualFallback = async () => {
    setAgentTaskCopied(await copyText(EDITKIN_REMOTE_AGENT_TASK));
  };

  const quality = networkSummary?.quality;
  const hasMeasuredQuality = Number.isFinite(quality?.latencyP50Ms) && Number.isFinite(quality?.jitterMs);
  const qualityVerified = quality?.status === "verified" && hasMeasuredQuality && quality.reconnectVerified;
  const qualityText = qualityVerified
    ? `已實測 ${Math.round(quality!.latencyP50Ms!)} ms · jitter ${Math.round(quality!.jitterMs!)} ms · 重新連線通過`
    : quality?.status === "partial" && hasMeasuredQuality
      ? `路由實測 ${Math.round(quality.latencyP50Ms!)} ms · jitter ${Math.round(quality.jitterMs!)} ms · 真手機重連待驗證`
    : internet ? "尚未完成外網健康與重新連線實測" : "LAN 不經外部供應商";
  const previewText = activeTransport === "cloud-relay"
    ? "Relay 模式只傳控制與狀態，不傳影片預覽。"
    : activeTransport === "https-tunnel"
      ? "Tunnel 設計上支援手機預覽，仍待真手機外網實測；預覽流量會計入你的供應商用量。"
      : "LAN 預覽只在同一個區域網路傳輸。";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissRemoteAgentModal(agentLaunch, onClose); }}>
      <section className="mobile-connect-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-connect-title">
        <button type="button" className="modal-close" onClick={() => dismissRemoteAgentModal(agentLaunch, onClose)} disabled={agentLaunchBusy} aria-label={agentLaunchBusy ? "Remote AI 執行中，請先取消" : "關閉"}>×</button>
        <div className="mobile-connect-copy">
          <span className="mobile-connect-kicker">EDITKIN REMOTE</span>
          <h2 id="mobile-connect-title">{connected
            ? "手機已綁定 Editkin"
            : remote
              ? "掃描 QR，連上你的電腦"
              : proposalState === "ready"
                ? "檢查 AI 準備的 Remote 方案"
                : proposalState === "expired"
                  ? "Remote 方案已過期"
                  : "啟動前先確認連線方式"}</h2>
          <p>{remote
            ? connected
              ? internet ? "手機已透過你自己的跨網路服務連線；素材與 GPU 輸出仍留在桌機。" : "手機已在同一個 Wi-Fi 連線；素材與 GPU 輸出都留在桌機。"
              : internet ? "已使用跨網路設定，仍待真手機外網實測；供應商帳號與連線由你管理。" : "目前使用免費 LAN；手機與電腦連到同一個 Wi-Fi 即可。"
            : "Editkin 不持有 AI 或供應商 API key。AI 只研究並建立綁定 connector 與 plan digest 的方案；所有未來供應商動作只能由 native typed connector 在你核准後執行，目前不會替你登入、部署或冒充已連線。"}</p>

          {proposal && (proposalState === "ready" || proposalState === "expired") && networkSummary?.schema === "editkin.remote-network-summary/v2" && <RemoteProposalCard proposal={proposal} state={proposalState} resumeAvailable={networkSummary.resumeAvailable} />}
          {proposalState === "invalid" && <div className="remote-proposal-invalid" role="alert"><b>方案資料不完整，已停止後續操作</b><span>Editkin 不會顯示核准或啟動按鈕。請重新產生一份符合安全格式的方案。</span></div>}
          {blockedSetupCopy && <div className="mobile-external-consent" role="status"><strong>{blockedSetupCopy.title}</strong><p>{blockedSetupCopy.detail}</p></div>}
          {providerActionCopy && <section className={`mobile-external-consent ${providerActionCopy.valid ? "" : "invalid"}`} role={providerActionCopy.valid ? "status" : "alert"} aria-label="Remote provider 動作狀態">
            <strong>{providerActionCopy.title}</strong>
            <p>{providerActionCopy.detail}</p>
            {providerActionCopy.intent && providerActionCopy.label && onProviderAction && <button type="button" onClick={() => onProviderAction(providerActionCopy.intent!)}>{providerActionCopy.label}</button>}
          </section>}

          {showAgentSetup && <section className="mobile-ai-setup" aria-label="AI 輔助跨網路方案研究">
            <div className="mobile-agent-picker" aria-label="選擇 AI">
              {(["codex", "claude"] as const).map((target) => <button type="button" key={target} className={selectedAgent === target ? "selected" : ""} onClick={() => chooseAgent(target)} disabled={agentLaunchBusy} aria-pressed={selectedAgent === target}><strong>{AGENT_LABEL[target]}</strong><small>{agentCheckFailed ? "無法檢查" : agentState(agentConnections?.[target])}</small></button>)}
            </div>
            <label className="mobile-agent-consent">
              <input type="checkbox" checked={agentScopeConfirmed} onChange={(event) => setAgentScopeConfirmed(event.currentTarget.checked)} disabled={agentLaunchBusy || !selectedAgent} />
              <span><b>允許 AI 研究 Remote 方案</b><small>AI 只可檢查狀態、讀取 closed connector 清單並建立 proposal，不可登入或操作供應商。這次最長 5 分鐘的研究會使用 Codex／Claude CLI 已登入的帳戶，可能消耗你的方案額度或 API 費用；Editkin 只檢查並立即丟棄「是否已登入」狀態，不要求、讀取或保存 key、token、cookie、密碼，也不代付費用。</small></span>
            </label>
            {selectedConnection?.launcherPath && <small className="mobile-agent-launcher-path" title={selectedConnection.launcherPath}>將啟動已檢查的 CLI：{selectedConnection.launcherPath}</small>}
            <button type="button" className="mobile-ai-primary" onClick={() => void startAiSetup()} data-testid="ai-remote-setup" disabled={agentLaunchBusy || (Boolean(selectedAgent && selectedConnection?.directLaunchReady) && !agentScopeConfirmed)}>
              <span aria-hidden="true">✦</span> {agentLaunchBusy ? "AI 正在產生可檢查方案…" : "讓 AI 產生可檢查方案"}
            </button>
            {agentLaunchBusy && <button type="button" className="mobile-ai-cancel" onClick={() => void cancelAiSetup()} disabled={agentLaunch.phase === "cancel_requested"}>{agentLaunch.phase === "cancel_requested" ? "正在取消並確認清理…" : "取消並清理子行程"}</button>}
            {agentLaunchResult && <div className={`mobile-ai-result ${agentLaunchResult.status}`} role="status"><b>{agentLaunchResult.message}</b><small>Windows 內部候選 · 真手機跨網重連與 Mac 尚未驗證，不會冒充完成。</small></div>}
            {(agentLaunchError || agentLaunchResult?.manualFallbackAvailable) && <button type="button" className="mobile-ai-fallback" onClick={() => void copyManualFallback()}>{agentTaskCopied ? "✓ 一般工作階段任務已複製" : "複製一般工作階段任務"}</button>}
            <small>{agentLaunchError
              ? `${agentLaunchError}；可${agentTaskCopied ? "將已複製任務貼到" : "複製任務到"}一般可見的 Codex／Claude 工作階段。這不是隔離環境：只應使用 Editkin remote-only MCP，任何其他工具呼叫都要逐次人工審核。`
              : agentTaskCopied
                ? `✓ 已複製 Remote 分階段任務，可貼到一般可見的 ${selectedAgent ? AGENT_LABEL[selectedAgent] : "Codex／Claude"} 工作階段；只應使用 Editkin remote-only MCP，任何其他工具呼叫都要逐次人工審核。`
                : agentLaunchResult?.manualFallbackAvailable
                  ? "這會在一般可見的 Codex／Claude 工作階段執行，不是隔離環境；只應使用 Editkin remote-only MCP，任何其他工具呼叫都要逐次人工審核。"
                : selectedAgent && agentConnections?.[selectedAgent]?.directLaunchReady
                  ? `${AGENT_LABEL[selectedAgent]} 可由 Editkin 注入 remote-only MCP；CLI 只沿用自己的既有登入，任務走 stdin 且不交給 shell。`
                  : selectedAgent
                    ? agentConnections?.[selectedAgent]?.launcherReason ?? "尚未通過安全啟動檢查。"
                    : "選擇 Codex 或 Claude Code；未驗證登入與 Editkin MCP 前不會啟動。"}</small>
          </section>}

          <div className={`mobile-quality ${qualityVerified ? "verified" : "pending"}`}>
            <strong>{transportLabel}</strong><span>{qualityText}</span><small>{previewText}</small>
          </div>

          {startApproval && networkSummary && !remote && <div className="mobile-external-consent">
            <strong>{networkSummary.pendingDesktopApproval ? "AI 已準備好，等待你在桌面核准" : "外部流量尚未啟動"}</strong>
            <p>這次會使用你的 {networkSummary.providerId} 帳戶{networkSummary.originHost ? `（${networkSummary.originHost}）` : ""}；用量與費用由你承擔。Editkin 不代付、不保存供應商密鑰。</p>
            <button type="button" onClick={() => onStart?.(startApproval)}>{networkSummary.pendingDesktopApproval ? "核對無誤，寫入設定並啟動" : "我了解並啟動已設定的跨網路 Remote"}</button>
          </div>}

          {remote && <>
            <ol>
              <li>{connected ? "一次性 QR 憑證已移除，長效裝置金鑰不會顯示在網址" : "掃描右側一次性 QR Code"}</li>
              <li>{connected ? "Remote 重啟或網路暫斷後，網址可達時會自動重新連線" : "手機瀏覽器直接開啟，不需安裝或登入 Editkin 帳號"}</li>
              <li>{connected ? "遺失手機時，可在下方單獨撤銷該裝置" : "不用輸入 IP、連接埠或配對碼"}</li>
            </ol>
            {remote.warning && <div className="mobile-remote-warning">{remote.warning}</div>}
            {(status?.devices.length ?? 0) > 0 && <div className="mobile-device-list">{status?.devices.map((device) => <span key={device.id} className={device.connected ? "online" : "offline"}><i />{device.name}<button type="button" onClick={() => onRevoke(device.id)} aria-label={`撤銷 ${device.name}`}>撤銷</button></span>)}</div>}
            <button type="button" className="secondary-button" onClick={() => void copy()}>{copied ? "✓ 配對連結已備妥" : "複製配對連結"}</button>
            <button type="button" className="danger-link" onClick={onStop}>暫停 Remote（保留永久綁定）</button>
          </>}
        </div>
        <div className={`mobile-connect-qr ${connected ? "connected" : ""} ${remote ? "" : "preflight"}`}>
          {remote ? qrCode ? <img src={qrCode} alt="Editkin Remote 配對 QR Code" /> : <div className="qr-placeholder">產生安全配對碼…</div> : <div className="remote-preflight-mark"><b>1</b><span>研究方案</span><b>2</b><span>確認費用</span><b>3</b><span>桌面核准</span><b>4</b><span>實測連線</span></div>}
          <span><i /> {remote ? connected ? `${status?.connectedCount} 台手機在線` : "等待手機掃描" : "尚未產生或傳送配對憑證"}</span>
          <small>{remote ? connected ? `${status?.trustedCount ?? status?.devices.length ?? 0} 台已綁定 · 可隨時撤銷` : `${transportLabel} · ${internet ? "費用由你的供應商帳戶承擔" : "零雲端流量費"} · QR 10 分鐘有效` : "部署與外部流量都必須先取得你的確認"}</small>
        </div>
      </section>
    </div>
  );
}
