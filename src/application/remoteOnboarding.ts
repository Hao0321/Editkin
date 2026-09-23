import {
  MOBILE_REMOTE_SETUP_PHASE,
  type MobileRemoteNetworkSummary,
} from "../desktop/mediaTypes";

export const EDITKIN_REMOTE_AGENT_TASK = [
  "請用 Editkin remote-only MCP 只完成 Remote 研究階段：研究並建立一份可檢查 proposal v2，不要設定或啟動連線。",
  "先呼叫 get_remote_setup_status，再呼叫 list_remote_provider_connectors；若尚無有效方案，只能從 closed registry 選擇 connector，依我的地區、既有帳戶、延遲、價格與免費額度檢查適用性。清單標為 disabled／unsupported 的 connector 仍只能研究，不能核准或執行。",
  "只可呼叫 prepare_remote_setup 建立 proposal。方案必須明列 connectorId、供應商與產品、地區、預計 transport、價格金額／幣別／計費單位、免費額度、配額、所需權限、預計異動、取消或刪除後果、來源網址、不確定性與不支援的前置條件；connector identity、plan digest 與來源查核時間由 Editkin 在寫入時可信地補上。",
  "建立 proposal 後立刻停下來，等我回 Editkin 檢查；研究完成不代表已核准、已登入、已部署或已連線。不得呼叫 configure_remote_access 或 verify_remote_access，也不得登入供應商、執行供應商 CLI、部署 tunnel、建立外部資源、產生費用或修改正式設定。",
  "API key、token、cookie、密碼或其他登入資料不得要求我提供、不得傳給 Editkin MCP、不得寫入 Editkin、proposal 或 log。AI 研究會使用我已登入的 Codex／Claude 帳戶，可能消耗我的方案額度或 API 費用；Tunnel 費用責任也只能標示為 end-user。無法查證價格或配額時必須列為不確定，不可猜測。",
].join(" ");

export function remoteProposalNeedsAttention(summary?: MobileRemoteNetworkSummary): boolean {
  return summary?.schema === "editkin.remote-network-summary/v2"
    && (summary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.EXACT_PROVIDER_PROPOSAL
      || summary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.EXPIRED
      || summary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.RENEWAL_RECONCILIATION_REQUIRED
      || summary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.LEGACY_PENDING_BLOCKED
      || summary.setupPhase === MOBILE_REMOTE_SETUP_PHASE.STATE_RECONCILIATION_REQUIRED
      || Boolean(summary.proposal));
}

export type AgentConnectionHealth = "connected" | "configured" | "outdated" | "missing" | "failed";

export interface AgentConnectionSummary {
  target: "codex" | "claude";
  available: boolean;
  configured: boolean;
  exactConfiguration: boolean;
  runtimeVerified?: boolean;
  sessionConnected?: boolean;
  loginReady?: boolean;
  launchReady?: boolean;
  directLaunchReady?: boolean;
  launcherPath?: string;
  launcherIdentityPinned?: boolean;
  hostConfigurationInspected?: boolean;
  launcherReason?: string;
  health: AgentConnectionHealth;
}

export interface AgentConnectionsResult {
  codex: AgentConnectionSummary;
  claude: AgentConnectionSummary;
  preferredTarget?: "codex" | "claude";
  checkedAt: number;
}

export function remoteAgentReady(connection: AgentConnectionSummary): boolean {
  return connection.exactConfiguration && connection.runtimeVerified === true && connection.health === "connected";
}

export function preferredRemoteAgent(connections?: AgentConnectionsResult): AgentConnectionSummary | undefined {
  if (!connections) return undefined;
  const preferred = connections.preferredTarget ? connections[connections.preferredTarget] : undefined;
  const launchReady = (connection: AgentConnectionSummary) => connection.directLaunchReady === true;
  if (preferred && launchReady(preferred)) return preferred;
  const launchable = [connections.codex, connections.claude].find(launchReady);
  if (launchable) return launchable;
  if (preferred && remoteAgentReady(preferred)) return preferred;
  const runtimeVerified = [connections.codex, connections.claude].find(remoteAgentReady);
  if (runtimeVerified) return runtimeVerified;
  const configured = (connection: AgentConnectionSummary) => connection.exactConfiguration
    && connection.configured && (connection.health === "configured" || connection.health === "connected");
  if (preferred && configured(preferred)) return preferred;
  return [connections.codex, connections.claude].find(configured);
}
