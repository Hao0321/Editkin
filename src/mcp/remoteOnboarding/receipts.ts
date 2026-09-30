import { createHash } from "node:crypto";
import { CANDIDATE_SCHEMA, HEX_32_PATTERN, LEGACY_PENDING_SCHEMA, LEGACY_REMOTE_AGENT_CONSENT_REVISION, PROPOSAL_TTL_MS, REMOTE_AGENT_CONSENT_REVISION, REMOTE_SCHEMA, RUNTIME_SCHEMA, UUID_V4_PATTERN, VERIFICATION_SCHEMA } from "./constants";
import { type LegacyPendingRemoteSetup, type PendingRemoteConfigCandidate, type RemoteRouteVerification, type RemoteRuntimeIdentity, type UserRemoteConfig } from "./types";
import { validateRemoteOrigin } from "./network";

export function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} 含有未允許欄位；密鑰與供應商憑證不得傳給 Editkin MCP`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validProviderId(providerId: string): string {
  const value = providerId.trim().toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(value)) throw new Error("providerId 必須是 2-63 字元的機器識別字");
  return value;
}

export function remoteAgentLineage(environment: NodeJS.ProcessEnv): {
  jobId: string;
  consentRevision: typeof REMOTE_AGENT_CONSENT_REVISION;
} {
  const jobId = environment.EDITKIN_REMOTE_AGENT_JOB_ID ?? "";
  const consentRevision = environment.EDITKIN_REMOTE_AGENT_CONSENT_REVISION ?? "";
  if (!HEX_32_PATTERN.test(jobId) || consentRevision !== REMOTE_AGENT_CONSENT_REVISION) {
    throw new Error("Remote proposal 缺少 exact job／consent lineage");
  }
  return { jobId, consentRevision };
}

export function configurationId(config: Omit<UserRemoteConfig, "configurationId">): string {
  return createHash("sha256").update([
    config.schema,
    String(config.schemaVersion),
    config.mode,
    config.transport,
    config.origin,
    config.providerId,
    config.costResponsibility,
    String(config.userConfirmedCostsAndPermissions),
    config.configuredAt,
  ].join("\0")).digest("hex");
}

export function parseLegacyPending(value: unknown, requireFresh = true): LegacyPendingRemoteSetup {
  if (!isRecord(value)) throw new Error("Remote 設定確認單不存在或格式不合法");
  const hasLineage = "remoteAgentJobId" in value || "remoteAgentConsentRevision" in value;
  exactKeys(value, [
    "schema", "confirmationId", "transport", "providerId", "costResponsibility", "autoDeploy", "preparedAt",
    ...(hasLineage ? ["remoteAgentJobId", "remoteAgentConsentRevision"] : []),
  ], "Remote 設定確認單");
  if (value.schema !== LEGACY_PENDING_SCHEMA || typeof value.confirmationId !== "string"
    || !UUID_V4_PATTERN.test(value.confirmationId)
    || !["https-tunnel", "cloud-relay"].includes(String(value.transport))
    || typeof value.providerId !== "string" || validProviderId(value.providerId) !== value.providerId
    || value.costResponsibility !== "end-user" || value.autoDeploy !== false
    || typeof value.preparedAt !== "string"
    || (hasLineage && (typeof value.remoteAgentJobId !== "string" || !HEX_32_PATTERN.test(value.remoteAgentJobId)
      || ![LEGACY_REMOTE_AGENT_CONSENT_REVISION, REMOTE_AGENT_CONSENT_REVISION]
        .includes(String(value.remoteAgentConsentRevision))))) {
    throw new Error("Remote 設定確認單不存在或格式不合法");
  }
  const pending = value as unknown as LegacyPendingRemoteSetup;
  const preparedAt = Date.parse(pending.preparedAt);
  if (!Number.isFinite(preparedAt) || new Date(preparedAt).toISOString() !== pending.preparedAt
    || preparedAt > Date.now() + 60_000) {
    throw new Error("Remote 設定確認單不存在或格式不合法");
  }
  if (requireFresh && Date.now() - preparedAt > PROPOSAL_TTL_MS) {
    throw new Error("Remote 使用者確認單已過期；請重新 prepare 並再次說明費用與權限");
  }
  return pending;
}

export function parseConfig(value: unknown): UserRemoteConfig {
  if (!isRecord(value)) throw new Error("Remote 設定檔不存在或格式不合法");
  exactKeys(value, ["schema", "schemaVersion", "mode", "transport", "origin", "providerId", "costResponsibility", "userConfirmedCostsAndPermissions", "configuredAt", "configurationId"], "Remote 設定檔");
  if (value.schema !== REMOTE_SCHEMA || value.schemaVersion !== 1 || value.mode !== "user-owned-byo"
    || !["https-tunnel", "cloud-relay"].includes(String(value.transport)) || typeof value.origin !== "string"
    || typeof value.providerId !== "string" || value.costResponsibility !== "end-user"
    || value.userConfirmedCostsAndPermissions !== true || typeof value.configuredAt !== "string"
    || typeof value.configurationId !== "string") throw new Error("Remote 設定檔不存在或格式不合法");
  const parsed = value as unknown as UserRemoteConfig;
  const { configurationId: recordedId, ...identity } = parsed;
  if (validateRemoteOrigin(parsed.origin) !== parsed.origin || configurationId(identity) !== recordedId) {
    throw new Error("Remote 設定檔 identity 驗證失敗");
  }
  return parsed;
}

export function parseCandidate(value: unknown): PendingRemoteConfigCandidate {
  if (!isRecord(value)) throw new Error("Remote 桌面核准候選不存在或格式不合法");
  exactKeys(value, ["schema", "candidateRevision", "expectedConfigurationId", "preparedAtMs", "expiresAtMs", "configuration"], "Remote 桌面核准候選");
  if (value.schema !== CANDIDATE_SCHEMA || typeof value.candidateRevision !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.candidateRevision)
    || (value.expectedConfigurationId !== null && (typeof value.expectedConfigurationId !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedConfigurationId)))
    || typeof value.preparedAtMs !== "number" || !Number.isSafeInteger(value.preparedAtMs)
    || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs)) {
    throw new Error("Remote 桌面核准候選不存在或格式不合法");
  }
  const candidate = value as unknown as PendingRemoteConfigCandidate;
  if (candidate.preparedAtMs > Date.now() + 60_000 || candidate.expiresAtMs <= Date.now()
    || candidate.expiresAtMs - candidate.preparedAtMs !== 30 * 60_000) {
    throw new Error("Remote 桌面核准候選已過期；請重新說明費用與權限");
  }
  parseConfig(candidate.configuration);
  return candidate;
}

export function validVerification(
  value: unknown,
  expectedConfigurationId: string,
  runtime: RemoteRuntimeIdentity,
): value is RemoteRouteVerification {
  if (!isRecord(value)) return false;
  try {
    exactKeys(value, ["schema", "configurationId", "status", "verified", "verifiedAt", "verifiedAtMs", "probeId", "runtimeInstanceId", "processId", "startedAtMs", "endpointKind", "successfulTlsConnections", "latencyMs", "latencyP50Ms", "jitterMs", "routeEvidence", "reconnectVerified", "requiresActiveMobileProof"], "Remote route verification");
  } catch { return false; }
  const verifiedAtMs = value.verifiedAtMs;
  return value.schema === VERIFICATION_SCHEMA && value.configurationId === expectedConfigurationId
    && value.status === "PARTIAL" && value.verified === false
    && value.probeId === runtime.probeId && value.runtimeInstanceId === runtime.runtimeInstanceId
    && value.processId === runtime.processId && value.startedAtMs === runtime.startedAtMs
    && value.endpointKind === "editkin-tunnel" && value.successfulTlsConnections === 2
    && value.routeEvidence === "two-pinned-independent-tls-connections-succeeded"
    && value.reconnectVerified === false && value.requiresActiveMobileProof === true
    && typeof verifiedAtMs === "number" && Number.isSafeInteger(verifiedAtMs)
    && verifiedAtMs > runtime.startedAtMs
    && verifiedAtMs <= Date.now() + 60_000 && Date.now() - verifiedAtMs <= 15 * 60_000
    && Array.isArray(value.latencyMs) && value.latencyMs.length === 2 && value.latencyMs.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    && typeof value.latencyP50Ms === "number" && Number.isFinite(value.latencyP50Ms) && value.latencyP50Ms >= 0
    && typeof value.jitterMs === "number" && Number.isFinite(value.jitterMs) && value.jitterMs >= 0
    && typeof value.verifiedAt === "string" && Date.parse(value.verifiedAt) === verifiedAtMs;
}

export function activeRuntime(value: unknown, config: UserRemoteConfig): RemoteRuntimeIdentity | undefined {
  if (!isRecord(value)) return undefined;
  try {
    exactKeys(value, ["schema", "transport", "configurationId", "probeId", "runtimeInstanceId", "startedAtMs", "processId"], "Remote runtime receipt");
  } catch { return undefined; }
  if (value.schema !== RUNTIME_SCHEMA || value.transport !== config.transport
    || value.configurationId !== config.configurationId || typeof value.probeId !== "string"
    || !/^[a-f0-9]{32}$/.test(value.probeId) || typeof value.runtimeInstanceId !== "string"
    || !/^[a-f0-9]{32}$/.test(value.runtimeInstanceId) || typeof value.startedAtMs !== "number"
    || !Number.isSafeInteger(value.startedAtMs) || value.startedAtMs > Date.now()
    || typeof value.processId !== "number" || !Number.isSafeInteger(value.processId) || value.processId <= 0) return undefined;
  try { process.kill(value.processId, 0); }
  catch { return undefined; }
  return value as unknown as RemoteRuntimeIdentity;
}

export function sameRuntimeInstance(left: RemoteRuntimeIdentity, right: RemoteRuntimeIdentity): boolean {
  return left.schema === right.schema && left.transport === right.transport
    && left.configurationId === right.configurationId && left.probeId === right.probeId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.processId === right.processId
    && left.startedAtMs === right.startedAtMs;
}
