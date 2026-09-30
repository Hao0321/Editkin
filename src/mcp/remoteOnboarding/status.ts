import { LEGACY_PROVIDER_PROPOSAL_SCHEMA, PROPOSAL_TTL_MS, PROVIDER_PROPOSAL_SCHEMA } from "./constants";
import { type RemoteJsonReadHooks } from "./types";
import { readJson, remoteSetupPaths } from "./stateFiles";
import { activeRuntime, isRecord, parseCandidate, parseConfig, parseLegacyPending, validVerification } from "./receipts";
import { parseProviderProposal, proposalExpired } from "./proposal";
import { recoverPendingRenewal, renewalReconciliationStatus } from "./renewal";

function stateReconciliationStatus(present: Array<"config" | "candidate" | "pending">, reason: string) {
  return {
    schema: "editkin.remote-setup-status/v1",
    status: "STATE_RECONCILIATION_REQUIRED" as const,
    transport: "unknown" as const,
    configured: false,
    resumeAvailable: false,
    conflict: {
      present,
      reason,
      automaticMutationPerformed: false as const,
    },
    policy: { mode: "user-owned-byo" as const, autoDeploy: false as const, costResponsibility: "end-user" as const, providerRequired: false as const },
    nextAction: "偵測到互斥或 lineage 不一致的 Remote state receipts；未隱藏、未提升、未重播，請在 Editkin 進行人工 reconciliation" as const,
  };
}

export async function getRemoteSetupStatus(
  environment: NodeJS.ProcessEnv = process.env,
  readHooks: RemoteJsonReadHooks = {},
) {
  const paths = remoteSetupPaths(environment);
  const recovery = await recoverPendingRenewal(paths);
  if (recovery.kind === "blocked") return renewalReconciliationStatus(recovery);
  const [rawConfig, rawCandidate, rawPending] = await Promise.all([
    readJson(paths.config, readHooks),
    readJson(paths.candidate, readHooks),
    readJson(paths.pending, readHooks),
  ]);
  const hasConfig = rawConfig !== undefined;
  const hasCandidate = rawCandidate !== undefined;
  const hasPending = rawPending !== undefined;
  const present: Array<"config" | "candidate" | "pending"> = [];
  if (hasConfig) present.push("config");
  if (hasCandidate) present.push("candidate");
  if (hasPending) present.push("pending");
  if (hasPending && (hasConfig || hasCandidate)) {
    return stateReconciliationStatus(present, "pending proposal/confirmation 不可與 config 或 candidate 共存");
  }
  const config = hasConfig ? parseConfig(rawConfig) : undefined;
  if (hasCandidate) {
    const candidate = parseCandidate(rawCandidate);
    if ((config && candidate.expectedConfigurationId !== config.configurationId)
      || (!config && candidate.expectedConfigurationId !== null)) {
      return stateReconciliationStatus(present, "candidate expectedConfigurationId 與目前 config identity 不一致");
    }
    return {
      schema: "editkin.remote-setup-status/v1",
      status: "AWAITING_DESKTOP_APPROVAL" as const,
      transport: candidate.configuration.transport,
      configured: Boolean(config),
      pendingDesktopApproval: {
        candidateRevision: candidate.candidateRevision,
        originHost: new URL(candidate.configuration.origin).host,
        providerId: candidate.configuration.providerId,
        expiresAtMs: candidate.expiresAtMs,
      },
      ...(config ? {
        configuration: {
          originHost: new URL(config.origin).host,
          providerId: config.providerId,
          configurationId: config.configurationId,
          configuredAt: config.configuredAt,
        },
      } : {}),
      policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
      nextAction: config
        ? "目前正式設定仍維持原狀；請回 Editkin 核對候選 revision 後再決定是否提升" as const
        : "請使用者回到 Editkin，親自按下啟動按鈕完成一次性桌面核准" as const,
    };
  }
  if (!config && hasPending) {
    if (isRecord(rawPending) && rawPending.schema === LEGACY_PROVIDER_PROPOSAL_SCHEMA) {
      return {
        schema: "editkin.remote-setup-status/v1",
        status: "LEGACY_PROVIDER_PROPOSAL_BLOCKED" as const,
        transport: "https-tunnel" as const,
        configured: false,
        resumeAvailable: false,
        policy: { mode: "user-owned-byo" as const, autoDeploy: false as const, costResponsibility: "end-user" as const, providerRequired: false as const },
        nextAction: "偵測到 proposal v1；它沒有 connector identity 與 plan digest，不能核准、續接或自動覆寫，必須由桌面安全遷移或捨棄" as const,
      };
    }
    if (isRecord(rawPending) && rawPending.schema === PROVIDER_PROPOSAL_SCHEMA) {
      const proposal = parseProviderProposal(rawPending);
      if (proposalExpired(proposal)) {
        return {
          schema: "editkin.remote-setup-status/v1",
          status: "PROPOSAL_EXPIRED" as const,
          transport: proposal.transport,
          configured: false,
          proposal,
          resumeAvailable: false,
          renewal: { expectedExpiredProposalRevision: proposal.proposalRevision },
          policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
          nextAction: "此提案已過期且從未核准或部署；重新研究後須帶入 exact expired proposal revision 才能更新" as const,
        };
      }
      return {
        schema: "editkin.remote-setup-status/v1",
        status: "PROPOSAL_READY_NOT_APPROVED" as const,
        transport: proposal.transport,
        configured: false,
        proposal,
        resumeAvailable: true,
        policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
        nextAction: "請回 Editkin 檢視價格、配額、權限與預計變更；目前尚未核准、登入供應商或部署" as const,
      };
    }
    const pending = parseLegacyPending(rawPending, false);
    const expiresAtMs = Date.parse(pending.preparedAt) + PROPOSAL_TTL_MS;
    const expired = expiresAtMs <= Date.now();
    return {
      schema: "editkin.remote-setup-status/v1",
      status: expired ? "LEGACY_PENDING_EXPIRED" as const : "LEGACY_PENDING_INCOMPLETE" as const,
      transport: pending.transport,
      configured: false,
      pendingProviderConfirmation: {
        schema: pending.schema,
        confirmationId: pending.confirmationId,
        providerId: pending.providerId,
        preparedAt: pending.preparedAt,
        expiresAtMs,
        costResponsibility: pending.costResponsibility,
      },
      resumeAvailable: !expired,
      policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
      nextAction: expired
        ? "舊版確認單已過期；它沒有價格、配額、權限與 digest，不能偽裝成新版提案或自動部署" as const
        : "這是舊版確認單，只記錄供應商識別，沒有足夠資料可視為新版外部動作核准" as const,
    };
  }
  if (!config) {
    return {
      schema: "editkin.remote-setup-status/v1",
      status: "LAN_DEFAULT" as const,
      transport: "lan" as const,
      configured: false,
      policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
      nextAction: "prepare_remote_setup" as const,
    };
  }
  const verification = await readJson(paths.verification, readHooks).catch(() => undefined);
  const runtime = activeRuntime(await readJson(paths.runtime, readHooks).catch(() => undefined), config);
  const routeVerified = runtime
    ? validVerification(verification, config.configurationId, runtime)
    : false;
  return {
    schema: "editkin.remote-setup-status/v1",
    status: routeVerified ? "CONFIGURED_ROUTE_VERIFIED" as const : "CONFIGURED_UNVERIFIED" as const,
    transport: config.transport,
    configured: true,
    configuration: { originHost: new URL(config.origin).host, providerId: config.providerId, configurationId: config.configurationId, configuredAt: config.configuredAt },
    verification: routeVerified ? verification : undefined,
    policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
    nextAction: routeVerified
      ? "路由與兩次獨立 TLS 連線已量測；仍須在 Editkin 以真手機確認配對與斷線重連" as const
      : "verify_remote_access" as const,
  };
}
