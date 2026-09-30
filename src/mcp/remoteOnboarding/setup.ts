import { randomUUID } from "node:crypto";
import { lstat, rename, unlink } from "node:fs/promises";
import { CANDIDATE_SCHEMA, LEGACY_PROVIDER_PROPOSAL_SCHEMA, PROVIDER_PROPOSAL_SCHEMA, REMOTE_SCHEMA } from "./constants";
import { type ConfigureRemoteAccessInput, type LegacyPendingRemoteSetup, type PendingRemoteConfigCandidate, type UserRemoteConfig } from "./types";
import { validateRemoteOrigin } from "./network";
import { ProposalAlreadyExistsError, readJson, remoteSetupPaths, writeJsonAtomic, writeJsonCreateNew } from "./stateFiles";
import { configurationId, exactKeys, isRecord, parseCandidate, parseConfig, parseLegacyPending, remoteAgentLineage } from "./receipts";
import { type PrepareRemoteSetupInput, assertCompatibleProposalConsent, createProviderProposal, parseProviderProposal, prepareRemoteSetupInputSchema, preparedProposalResult, proposalExpired } from "./proposal";
import { recoverPendingRenewal, renewExpiredProposalExact } from "./renewal";

export async function prepareRemoteSetup(input: PrepareRemoteSetupInput, environment: NodeJS.ProcessEnv = process.env) {
  const validated = prepareRemoteSetupInputSchema.parse(input);
  const lineage = remoteAgentLineage(environment);
  const paths = remoteSetupPaths(environment);
  const recovery = await recoverPendingRenewal(paths);
  if (recovery.kind === "blocked") {
    throw new Error(`Remote proposal renewal 需要人工 reconciliation：${recovery.reason}`);
  }
  const [existingConfig, existingCandidate, existingPending] = await Promise.all([
    readJson(paths.config),
    readJson(paths.candidate),
    readJson(paths.pending),
  ]);
  if (existingConfig !== undefined) {
    parseConfig(existingConfig);
    throw new Error("Remote 已有正式設定；prepare_remote_setup 不得覆寫");
  }
  if (existingCandidate !== undefined) {
    parseCandidate(existingCandidate);
    throw new Error("Remote 已有待桌面核准候選；prepare_remote_setup 不得覆寫");
  }
  if (existingPending !== undefined) {
    if (isRecord(existingPending) && existingPending.schema === LEGACY_PROVIDER_PROPOSAL_SCHEMA) {
      throw new Error("Remote 存在 proposal v1；缺少 connector identity 與 plan digest，必須安全遷移或捨棄，不得自動覆寫");
    }
    if (!isRecord(existingPending) || existingPending.schema !== PROVIDER_PROPOSAL_SCHEMA) {
      parseLegacyPending(existingPending, false);
      throw new Error("Remote 存在舊版確認單；已 dual-read 顯示，但不得偽裝成新版 proposal 或自動覆寫");
    }
    const current = parseProviderProposal(existingPending);
    assertCompatibleProposalConsent(current, lineage);
    if (!proposalExpired(current)) {
      if (validated.expectedExpiredProposalRevision !== undefined) {
        throw new Error("目前 Remote proposal 尚未過期；拒絕 stale expectedExpiredProposalRevision");
      }
      return preparedProposalResult(current, false);
    }
    if (validated.expectedExpiredProposalRevision !== current.proposalRevision) {
      throw new Error("Remote proposal 已過期；必須帶入目前 exact expectedExpiredProposalRevision 才能 CAS 更新");
    }
    const replacement = createProviderProposal(validated, lineage, current.workflowId);
    const renewed = await renewExpiredProposalExact(paths, current.proposalRevision, replacement);
    return preparedProposalResult(renewed, true);
  }
  if (validated.expectedExpiredProposalRevision !== undefined) {
    throw new Error("沒有可供 renewal 的 expired proposal；拒絕使用 stale expected revision 建立新 workflow");
  }
  const proposal = createProviderProposal(validated, lineage);
  try {
    await writeJsonCreateNew(paths.pending, proposal);
    return preparedProposalResult(proposal, true);
  } catch (error) {
    if (!(error instanceof ProposalAlreadyExistsError)) throw error;
    // On APFS the winning hard-link publish and temporary-link cleanup can
    // change ctime while another writer performs its bounded identity read.
    // Retry only the no-replace collision; never skip the read's integrity checks.
    let lastReadError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let winnerValue: unknown;
      try { winnerValue = await readJson(paths.pending); }
      catch (readError) { lastReadError = readError; }
      if (winnerValue !== undefined) {
        if (isRecord(winnerValue) && winnerValue.schema === PROVIDER_PROPOSAL_SCHEMA) {
          const winner = parseProviderProposal(winnerValue);
          assertCompatibleProposalConsent(winner, lineage);
          if (!proposalExpired(winner)) return preparedProposalResult(winner, false);
        }
        throw error;
      }
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (lastReadError) throw lastReadError;
    throw error;
  }
}

export async function configureRemoteAccess(input: ConfigureRemoteAccessInput, environment: NodeJS.ProcessEnv = process.env) {
  exactKeys(input, ["confirmationId", "origin", "userConfirmedDeployment", "userConfirmedProviderCosts", "userConfirmedProviderPermissions"], "configure_remote_access");
  if (input.userConfirmedDeployment !== true || input.userConfirmedProviderCosts !== true || input.userConfirmedProviderPermissions !== true) {
    throw new Error("Remote 外部部署、費用與權限尚未得到使用者明確確認");
  }
  const paths = remoteSetupPaths(environment);
  const recovery = await recoverPendingRenewal(paths);
  if (recovery.kind === "blocked") {
    throw new Error(`Remote proposal renewal 需要人工 reconciliation：${recovery.reason}`);
  }
  const currentPending = await readJson(paths.pending);
  if (isRecord(currentPending) && [PROVIDER_PROPOSAL_SCHEMA, LEGACY_PROVIDER_PROPOSAL_SCHEMA].includes(String(currentPending.schema))) {
    if (currentPending.schema === PROVIDER_PROPOSAL_SCHEMA) parseProviderProposal(currentPending);
    throw new Error("新版 Remote provider proposal 尚未有 proposal-bound approval；legacy configure_remote_access 明確拒絕此 schema");
  }
  parseLegacyPending(currentPending);
  const consuming = `${paths.pending}.consuming`;
  await rename(paths.pending, consuming).catch(() => { throw new Error("Remote 使用者確認單不存在、已失效或正由另一個設定流程使用"); });
  let pending: LegacyPendingRemoteSetup;
  try { pending = parseLegacyPending(await readJson(consuming)); }
  catch (error) {
    const destinationExists = await lstat(paths.pending).then(() => true).catch(() => false);
    if (!destinationExists) await rename(consuming, paths.pending).catch(() => undefined);
    throw error;
  }
  if (pending.confirmationId !== input.confirmationId) {
    await rename(consuming, paths.pending).catch(() => undefined);
    throw new Error("Remote 使用者確認單已失效；請重新 prepare");
  }
  const origin = validateRemoteOrigin(input.origin);
  const identity: Omit<UserRemoteConfig, "configurationId"> = {
    schema: REMOTE_SCHEMA,
    schemaVersion: 1 as const,
    mode: "user-owned-byo" as const,
    transport: pending.transport,
    origin,
    providerId: pending.providerId,
    costResponsibility: "end-user" as const,
    userConfirmedCostsAndPermissions: true as const,
    configuredAt: new Date().toISOString(),
  };
  const config: UserRemoteConfig = { ...identity, configurationId: configurationId(identity) };
  const currentConfig = await readJson(paths.config);
  const expectedConfigurationId = currentConfig !== undefined ? parseConfig(currentConfig).configurationId : null;
  const preparedAtMs = Date.now();
  const candidate: PendingRemoteConfigCandidate = {
    schema: CANDIDATE_SCHEMA,
    candidateRevision: randomUUID(),
    expectedConfigurationId,
    preparedAtMs,
    expiresAtMs: preparedAtMs + 30 * 60_000,
    configuration: config,
  };
  try { await writeJsonAtomic(paths.candidate, candidate); }
  finally { await unlink(consuming).catch(() => undefined); }
  return {
    schema: CANDIDATE_SCHEMA,
    status: "PENDING_DESKTOP_APPROVAL" as const,
    candidateRevision: candidate.candidateRevision,
    proposal: { transport: config.transport, originHost: new URL(config.origin).host, providerId: config.providerId, configurationId: config.configurationId, expiresAtMs: candidate.expiresAtMs },
    persistedSecretFields: [] as string[],
    formalConfigurationWritten: false,
    desktopApprovalRequired: true,
    nextAction: "請使用者回到 Editkin，核對供應商與 host，親自按下啟動；Tauri 才會一次性核准並提升為正式設定" as const,
  };
}
