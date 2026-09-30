import { link, lstat, unlink } from "node:fs/promises";
import { MAX_JSON_BYTES } from "./constants";
import { type RemoteSetupPaths } from "./types";
import { optionalMetadata, readJson, writeJsonCreateNew } from "./stateFiles";
import { type RemoteProviderProposal, parseProviderProposal, proposalExpired } from "./proposal";

type PendingRenewalRecovery =
  | { kind: "none" | "recovered" }
  | { kind: "blocked"; reason: "INVALID_RENEWING_ARTIFACT" | "CONFLICTING_PENDING_AND_RENEWING" | "RENEWING_PROPOSAL_NOT_EXPIRED" | "RECOVERY_PUBLICATION_FAILED" };

export async function recoverPendingRenewal(paths: RemoteSetupPaths): Promise<PendingRenewalRecovery> {
  const renewingMetadata = await optionalMetadata(paths.pendingRenewing);
  if (!renewingMetadata) return { kind: "none" };
  if (renewingMetadata.isSymbolicLink() || !renewingMetadata.isFile() || renewingMetadata.size > MAX_JSON_BYTES) {
    return { kind: "blocked", reason: "INVALID_RENEWING_ARTIFACT" };
  }
  const pendingMetadata = await optionalMetadata(paths.pending);
  if (pendingMetadata) {
    if (pendingMetadata.isSymbolicLink() || !pendingMetadata.isFile() || pendingMetadata.size > MAX_JSON_BYTES) {
      return { kind: "blocked", reason: "CONFLICTING_PENDING_AND_RENEWING" };
    }
    if (pendingMetadata.dev !== renewingMetadata.dev || pendingMetadata.ino !== renewingMetadata.ino
      || pendingMetadata.size !== renewingMetadata.size) {
      return { kind: "blocked", reason: "CONFLICTING_PENDING_AND_RENEWING" };
    }
    try { await unlink(paths.pendingRenewing); }
    catch { return { kind: "blocked", reason: "RECOVERY_PUBLICATION_FAILED" }; }
    return { kind: "recovered" };
  }
  let proposal: RemoteProviderProposal;
  try { proposal = parseProviderProposal(await readJson(paths.pendingRenewing)); }
  catch { return { kind: "blocked", reason: "INVALID_RENEWING_ARTIFACT" }; }
  if (!proposalExpired(proposal)) {
    return { kind: "blocked", reason: "RENEWING_PROPOSAL_NOT_EXPIRED" };
  }
  try {
    await link(paths.pendingRenewing, paths.pending);
    const restored = await lstat(paths.pending);
    if (restored.isSymbolicLink() || !restored.isFile()
      || restored.dev !== renewingMetadata.dev || restored.ino !== renewingMetadata.ino
      || restored.size !== renewingMetadata.size) {
      if (!restored.isSymbolicLink() && restored.isFile()
        && restored.dev === renewingMetadata.dev && restored.ino === renewingMetadata.ino) {
        await unlink(paths.pending).catch(() => undefined);
      }
      return { kind: "blocked", reason: "RECOVERY_PUBLICATION_FAILED" };
    }
    await unlink(paths.pendingRenewing);
    return { kind: "recovered" };
  } catch {
    const restored = await optionalMetadata(paths.pending);
    if (restored && !restored.isSymbolicLink() && restored.isFile()
      && restored.dev === renewingMetadata.dev && restored.ino === renewingMetadata.ino) {
      await unlink(paths.pending).catch(() => undefined);
    }
    return { kind: "blocked", reason: "RECOVERY_PUBLICATION_FAILED" };
  }
}

export function renewalReconciliationStatus(recovery: Extract<PendingRenewalRecovery, { kind: "blocked" }>) {
  return {
    schema: "editkin.remote-setup-status/v1",
    status: "RENEWAL_RECONCILIATION_REQUIRED" as const,
    transport: "https-tunnel" as const,
    configured: false,
    resumeAvailable: false,
    recovery: {
      artifact: "network-setup-pending.json.renewing" as const,
      reason: recovery.reason,
      automaticReplayPerformed: false as const,
    },
    policy: { mode: "user-owned-byo" as const, autoDeploy: false as const, costResponsibility: "end-user" as const, providerRequired: false as const },
    nextAction: "偵測到無法安全自動判定的 proposal renewal crash artifact；未重播、未部署，請在 Editkin 檢查並進行人工 reconciliation" as const,
  };
}

export async function renewExpiredProposalExact(
  paths: RemoteSetupPaths,
  expectedRevision: string,
  replacement: RemoteProviderProposal,
): Promise<RemoteProviderProposal> {
  let claimed = false;
  try {
    try {
      await link(paths.pending, paths.pendingRenewing);
      claimed = true;
    } catch {
      throw new Error("Remote expired proposal CAS 失敗；proposal revision 或 renewal claim 已由另一個流程改變");
    }
    const [pendingMetadata, renewingMetadata] = await Promise.all([
      lstat(paths.pending),
      lstat(paths.pendingRenewing),
    ]);
    if (pendingMetadata.isSymbolicLink() || renewingMetadata.isSymbolicLink()
      || !pendingMetadata.isFile() || !renewingMetadata.isFile()
      || pendingMetadata.dev !== renewingMetadata.dev || pendingMetadata.ino !== renewingMetadata.ino
      || pendingMetadata.size !== renewingMetadata.size) {
      throw new Error("Remote expired proposal CAS claim identity 驗證失敗");
    }
    await unlink(paths.pending);
    const current = parseProviderProposal(await readJson(paths.pendingRenewing));
    if (current.proposalRevision !== expectedRevision || !proposalExpired(current)) {
      throw new Error("Remote expired proposal CAS 失敗；expected proposal revision 不再是目前過期 revision");
    }
    await writeJsonCreateNew(paths.pending, replacement);
    await unlink(paths.pendingRenewing).catch(() => {
      throw new Error("Remote proposal renewal 已發布，但舊 claim 清理失敗；需要 reconciliation");
    });
    return replacement;
  } catch (error) {
    if (claimed) {
      const recovery = await recoverPendingRenewal(paths);
      if (recovery.kind === "blocked") {
        throw new Error(`Remote proposal renewal 需要人工 reconciliation：${recovery.reason}`);
      }
    }
    throw error;
  }
}
