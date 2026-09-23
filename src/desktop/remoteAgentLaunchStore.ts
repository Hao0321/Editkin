import type {
  HaoDesktopApi,
  RemoteAgentLaunchResult,
  RemoteAgentLaunchStatus,
} from "./types";

export type RemoteAgentLaunchPhase = "idle" | "running" | "cancel_requested" | "settled" | "failed";

export interface RemoteAgentLaunchState {
  phase: RemoteAgentLaunchPhase;
  target?: "codex" | "claude";
  jobId?: string;
  consentRevision?: typeof REMOTE_AGENT_CONSENT_REVISION;
  result?: RemoteAgentLaunchResult;
  error?: string;
  cancelError?: string;
}

export const REMOTE_AGENT_CONSENT_REVISION = "editkin.remote-agent-consent/v2" as const;
const REMOTE_AGENT_TRUTH_LABEL = "WINDOWS_INTERNAL_AGENT_LAUNCH_CANDIDATE_NOT_REAL_PHONE_OR_MAC_VERIFIED" as const;
const REMOTE_AGENT_RESULT_SCHEMA = "editkin.remote-agent-launch-result/v1" as const;
const REMOTE_AGENT_STATUS_SCHEMA = "editkin.remote-agent-launch-status/v1" as const;
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const UUID_V4_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_STATUSES = new Set([
  "provider_confirmation_required",
  "desktop_approval_required",
  "route_partial_verified",
  "no_verified_progress",
  "failed",
  "canceled",
  "timed_out",
  "cleanup_unconfirmed",
]);
const RESULT_KEYS = [
  "consentRevision", "jobId", "macVerified", "manualFallbackAvailable", "message",
  "outputTruncated", "providerId", "proposalDigest", "proposalRevision",
  "realPhoneReconnectVerified", "receiptPath", "resumedExistingState", "schema",
  "stateCreatedThisRun", "status", "target", "truthLabel",
] as const;
const STATUS_KEYS = [
  "cancelRequested", "consentRevision", "endedAtMs", "jobId", "phase", "result",
  "schema", "startedAtMs", "target", "truthLabel",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validTarget(value: unknown): value is "codex" | "claude" {
  return value === "codex" || value === "claude";
}

function validationError(message: string): never {
  throw new Error(`Remote AI 狀態未通過 closed-world 驗證：${message}`);
}

export function parseRemoteAgentLaunchResult(value: unknown): RemoteAgentLaunchResult {
  if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) validationError("result 欄位集合不符");
  if (value.schema !== REMOTE_AGENT_RESULT_SCHEMA || value.truthLabel !== REMOTE_AGENT_TRUTH_LABEL) {
    validationError("result schema／truthLabel 不符");
  }
  if (typeof value.jobId !== "string" || !JOB_ID_PATTERN.test(value.jobId)
      || value.consentRevision !== REMOTE_AGENT_CONSENT_REVISION || !validTarget(value.target)) {
    validationError("result job／consent／target 不符");
  }
  if (typeof value.status !== "string" || !RESULT_STATUSES.has(value.status)) validationError("result status 不符");
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > 4_096) {
    validationError("result message 不符");
  }
  if (value.providerId !== null
      && (typeof value.providerId !== "string" || !PROVIDER_ID_PATTERN.test(value.providerId))) {
    validationError("result providerId 不符");
  }
  const proposalIdentityIsNull = value.proposalRevision === null && value.proposalDigest === null;
  const proposalIdentityIsValid = typeof value.proposalRevision === "string"
    && UUID_V4_PATTERN.test(value.proposalRevision)
    && typeof value.proposalDigest === "string" && SHA256_PATTERN.test(value.proposalDigest);
  if ((!proposalIdentityIsNull && !proposalIdentityIsValid)
      || typeof value.resumedExistingState !== "boolean"
      || typeof value.stateCreatedThisRun !== "boolean"
      || (value.resumedExistingState && value.stateCreatedThisRun)) {
    validationError("result proposal identity／state lineage 不符");
  }
  if (value.manualFallbackAvailable !== true
      || typeof value.receiptPath !== "string" || !value.receiptPath.trim() || value.receiptPath.length > 4_096
      || typeof value.outputTruncated !== "boolean"
      || value.realPhoneReconnectVerified !== false || value.macVerified !== false) {
    validationError("result truth fields 不符");
  }
  // Keep the exact wire object so every subsequent hydration can re-validate it.
  return { ...value } as unknown as RemoteAgentLaunchResult;
}

export function parseRemoteAgentLaunchStatus(value: unknown): RemoteAgentLaunchStatus {
  if (!isRecord(value) || !hasExactKeys(value, STATUS_KEYS)) validationError("status 欄位集合不符");
  if (value.schema !== REMOTE_AGENT_STATUS_SCHEMA || value.truthLabel !== REMOTE_AGENT_TRUTH_LABEL
      || typeof value.cancelRequested !== "boolean") {
    validationError("status schema／truthLabel／cancel flag 不符");
  }
  if (value.phase === "idle") {
    if (value.jobId !== null || value.target !== null || value.consentRevision !== null
        || value.startedAtMs !== null || value.endedAtMs !== null || value.result !== null
        || value.cancelRequested !== false) validationError("idle lineage 不一致");
    return { ...value } as unknown as RemoteAgentLaunchStatus;
  }
  if (typeof value.jobId !== "string" || !JOB_ID_PATTERN.test(value.jobId)
      || !validTarget(value.target) || value.consentRevision !== REMOTE_AGENT_CONSENT_REVISION
      || !safeTimestamp(value.startedAtMs)) {
    validationError("status job／consent／target／start 不符");
  }
  if (value.phase === "running") {
    if (value.endedAtMs !== null || value.result !== null) validationError("running terminal fields 不得存在");
    return { ...value } as unknown as RemoteAgentLaunchStatus;
  }
  if (value.phase === "interrupted") {
    if (value.endedAtMs !== null || value.result !== null || value.cancelRequested !== false) {
      validationError("interrupted fields 不一致");
    }
    return { ...value } as unknown as RemoteAgentLaunchStatus;
  }
  if (value.phase === "terminal") {
    if (!safeTimestamp(value.endedAtMs) || value.endedAtMs < value.startedAtMs || value.cancelRequested !== false) {
      validationError("terminal timestamps／cancel flag 不一致");
    }
    const result = parseRemoteAgentLaunchResult(value.result);
    if (result.jobId !== value.jobId || result.target !== value.target
        || result.consentRevision !== value.consentRevision) {
      validationError("terminal result lineage 不一致");
    }
    return { ...value, result } as unknown as RemoteAgentLaunchStatus;
  }
  return validationError("未知 phase");
}

function createRemoteAgentJobId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const EMPTY_REMOTE_AGENT_LAUNCH_STATE: RemoteAgentLaunchState = Object.freeze({ phase: "idle" });

export function remoteAgentLaunchBusy(state: RemoteAgentLaunchState): boolean {
  return state.phase === "running" || state.phase === "cancel_requested";
}

export interface RemoteAgentLaunchStore {
  getSnapshot: () => RemoteAgentLaunchState;
  subscribe: (listener: () => void) => () => void;
  hydrate: (api: HaoDesktopApi | undefined) => Promise<void>;
  start: (api: HaoDesktopApi | undefined, target: "codex" | "claude") => Promise<RemoteAgentLaunchResult | undefined>;
  cancel: (api: HaoDesktopApi | undefined) => Promise<void>;
  clearTerminal: () => void;
}

interface RemoteAgentLaunchStoreOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createRemoteAgentLaunchStore(options: RemoteAgentLaunchStoreOptions = {}): RemoteAgentLaunchStore {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxPollAttempts = options.maxPollAttempts ?? 720;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(maxPollAttempts) || maxPollAttempts < 1) throw new Error("maxPollAttempts 必須是正整數");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new Error("pollIntervalMs 不可為負數");

  let snapshot = EMPTY_REMOTE_AGENT_LAUNCH_STATE;
  let activePromise: Promise<RemoteAgentLaunchResult> | undefined;
  let hydrationPromise: Promise<void> | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: RemoteAgentLaunchState) => {
    snapshot = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };

  const applyHydratedStatus = (status: RemoteAgentLaunchStatus) => {
    if (activePromise) return;
    if (status.phase === "idle") {
      publish(EMPTY_REMOTE_AGENT_LAUNCH_STATE);
      return;
    }
    if (status.phase === "running") {
      publish({
        phase: status.cancelRequested ? "cancel_requested" : "running",
        target: status.target,
        jobId: status.jobId,
        consentRevision: status.consentRevision,
      });
      return;
    }
    if (status.phase === "terminal") {
      publish({
        phase: "settled",
        target: status.target,
        jobId: status.jobId,
        consentRevision: status.consentRevision,
        result: status.result,
      });
      return;
    }
    publish({
      phase: "failed",
      target: status.target,
      jobId: status.jobId,
      consentRevision: status.consentRevision,
      error: "上次 Remote AI 行程已中斷；沒有終局結果，且不會冒充已完成。",
    });
  };

  const store: RemoteAgentLaunchStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async hydrate(api) {
      if (activePromise || hydrationPromise || !api?.getRemoteSetupAgentStatus) return hydrationPromise;
      const inspect = api.getRemoteSetupAgentStatus;
      let task!: Promise<void>;
      task = (async () => {
        try {
          for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
            const status = parseRemoteAgentLaunchStatus(await inspect());
            if (activePromise || hydrationPromise !== task) return;
            applyHydratedStatus(status);
            if (status.phase !== "running") return;
            if (attempt + 1 >= maxPollAttempts) {
              if (remoteAgentLaunchBusy(snapshot) && snapshot.jobId === status.jobId) {
                publish({ ...snapshot, error: "Remote AI 後端仍回報執行中；已停止自動輪詢，仍可用相同 jobId 取消。" });
              }
              return;
            }
            await sleep(pollIntervalMs);
          }
        } catch (error) {
          if (activePromise || hydrationPromise !== task) return;
          const message = error instanceof Error ? error.message : String(error);
          if (remoteAgentLaunchBusy(snapshot)) publish({ ...snapshot, error: `Remote AI 狀態同步失敗：${message}` });
          else publish({ phase: "failed", error: `Remote AI 狀態同步失敗：${message}` });
        }
      })();
      hydrationPromise = task;
      try {
        await task;
      } finally {
        if (hydrationPromise === task) hydrationPromise = undefined;
      }
    },
    async start(api, target) {
      if (hydrationPromise) await hydrationPromise;
      if (activePromise || remoteAgentLaunchBusy(snapshot)) return snapshot.result;
      const launch = api?.launchRemoteSetupAgent;
      if (!launch) {
        publish({ phase: "failed", target, error: "目前版本沒有可用的 Remote AI launcher" });
        return undefined;
      }
      const jobId = createRemoteAgentJobId();
      const consentRevision = REMOTE_AGENT_CONSENT_REVISION;
      publish({ phase: "running", target, jobId, consentRevision });
      const task = Promise.resolve().then(() => launch(target, jobId, consentRevision, true));
      activePromise = task;
      try {
        const result = parseRemoteAgentLaunchResult(await task);
        if (result.jobId !== jobId
          || result.consentRevision !== consentRevision
          || result.target !== target) {
          throw new Error("Remote AI 結果與目前 job／consent revision 不一致；已 fail closed");
        }
        if (activePromise === task) {
          publish({ phase: "settled", target, jobId, consentRevision, result });
        }
        return result;
      } catch (error) {
        if (activePromise === task) {
          publish({
            phase: "failed",
            target, jobId, consentRevision,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return undefined;
      } finally {
        if (activePromise === task) activePromise = undefined;
      }
    },
    async cancel(api) {
      const jobId = snapshot.jobId;
      if (!remoteAgentLaunchBusy(snapshot) || !jobId || !api?.cancelRemoteSetupAgent) return;
      if (snapshot.phase !== "cancel_requested") publish({ ...snapshot, phase: "cancel_requested", cancelError: undefined });
      try {
        const result = await api.cancelRemoteSetupAgent(jobId);
        if (!remoteAgentLaunchBusy(snapshot) || snapshot.jobId !== jobId) return;
        if (result.jobId !== jobId || !result.matchedActiveJob || !result.cancelRequested) {
          publish({ ...snapshot, phase: "running", cancelError: "取消要求未綁定目前作業；Remote AI 仍在執行" });
        }
      } catch (error) {
        if (remoteAgentLaunchBusy(snapshot) && snapshot.jobId === jobId) {
          publish({ ...snapshot, phase: "running", cancelError: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    clearTerminal() {
      if (!remoteAgentLaunchBusy(snapshot)) publish(EMPTY_REMOTE_AGENT_LAUNCH_STATE);
    },
  };
  return store;
}

// The owner intentionally outlives MobileConnectModal. Closing and reopening the
// modal therefore reattaches to the same bounded launch promise and terminal result.
export const remoteAgentLaunchStore = createRemoteAgentLaunchStore();
