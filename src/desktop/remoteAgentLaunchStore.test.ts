import { describe, expect, it, vi } from "vitest";
import type { HaoDesktopApi, RemoteAgentLaunchResult, RemoteAgentLaunchStatus } from "./types";
import {
  createRemoteAgentLaunchStore,
  parseRemoteAgentLaunchResult,
  parseRemoteAgentLaunchStatus,
  REMOTE_AGENT_CONSENT_REVISION,
} from "./remoteAgentLaunchStore";

const TRUTH_LABEL = "WINDOWS_INTERNAL_AGENT_LAUNCH_CANDIDATE_NOT_REAL_PHONE_OR_MAC_VERIFIED" as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function wireResult(overrides: Record<string, unknown> = {}): RemoteAgentLaunchResult {
  return {
    schema: "editkin.remote-agent-launch-result/v1",
    truthLabel: TRUTH_LABEL,
    target: "codex",
    jobId: "0".repeat(32),
    consentRevision: REMOTE_AGENT_CONSENT_REVISION,
    status: "no_verified_progress",
    message: "fixture",
    providerId: null,
    proposalRevision: null,
    proposalDigest: null,
    resumedExistingState: false,
    stateCreatedThisRun: false,
    manualFallbackAvailable: true,
    receiptPath: "C:/fixture/receipt.json",
    outputTruncated: false,
    realPhoneReconnectVerified: false,
    macVerified: false,
    ...overrides,
  } as unknown as RemoteAgentLaunchResult;
}

function wireStatus(
  phase: "idle" | "running" | "terminal" | "interrupted",
  overrides: Record<string, unknown> = {},
): RemoteAgentLaunchStatus {
  const idle = phase === "idle";
  const terminal = phase === "terminal";
  const jobId = idle ? null : "0".repeat(32);
  const target = idle ? null : "codex";
  const consentRevision = idle ? null : REMOTE_AGENT_CONSENT_REVISION;
  const startedAtMs = idle ? null : 100;
  return {
    schema: "editkin.remote-agent-launch-status/v1",
    phase,
    truthLabel: TRUTH_LABEL,
    jobId,
    target,
    consentRevision,
    startedAtMs,
    endedAtMs: terminal ? 200 : null,
    cancelRequested: false,
    result: terminal ? wireResult({ jobId, target, consentRevision }) : null,
    ...overrides,
  } as unknown as RemoteAgentLaunchStatus;
}

describe("Remote Agent launch owner", () => {
  it("keeps the active promise and terminal result after every modal subscriber unmounts", async () => {
    const pending = deferred<RemoteAgentLaunchResult>();
    const launchRemoteSetupAgent = vi.fn(() => pending.promise);
    const store = createRemoteAgentLaunchStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const task = store.start({ launchRemoteSetupAgent } as unknown as HaoDesktopApi, "codex");
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ phase: "running", target: "codex" });
    const { jobId, consentRevision } = store.getSnapshot();
    unsubscribe();
    pending.resolve(wireResult({ jobId, consentRevision }));
    await task;
    expect(store.getSnapshot()).toMatchObject({ phase: "settled", result: { jobId, consentRevision } });
    expect(launchRemoteSetupAgent).toHaveBeenCalledTimes(1);
    expect(launchRemoteSetupAgent).toHaveBeenCalledWith("codex", jobId, consentRevision, true);
  });

  it("fails closed on a stale result and sends cancel only for the active job id", async () => {
    const pending = deferred<RemoteAgentLaunchResult>();
    const launchRemoteSetupAgent = vi.fn(() => pending.promise);
    const cancelRemoteSetupAgent = vi.fn(async (jobId: string) => ({
      jobId, running: true, cancelRequested: true, matchedActiveJob: true,
    }));
    const store = createRemoteAgentLaunchStore();
    const api = { launchRemoteSetupAgent, cancelRemoteSetupAgent } as unknown as HaoDesktopApi;
    const task = store.start(api, "codex");
    await Promise.resolve();
    const activeJobId = store.getSnapshot().jobId!;
    await store.cancel(api);
    expect(cancelRemoteSetupAgent).toHaveBeenCalledWith(activeJobId);
    pending.resolve(wireResult({ jobId: "f".repeat(32) }));
    await task;
    expect(store.getSnapshot()).toMatchObject({ phase: "failed", jobId: activeJobId });
    expect(store.getSnapshot().error).toContain("不一致");
  });

  it("hydrates a durable running job and polls until its bound terminal result", async () => {
    const getRemoteSetupAgentStatus = vi.fn()
      .mockResolvedValueOnce(wireStatus("running"))
      .mockResolvedValueOnce(wireStatus("terminal"));
    const store = createRemoteAgentLaunchStore({ maxPollAttempts: 3, sleep: async () => undefined });
    await store.hydrate({ getRemoteSetupAgentStatus } as unknown as HaoDesktopApi);
    expect(getRemoteSetupAgentStatus).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      phase: "settled",
      jobId: "0".repeat(32),
      result: { status: "no_verified_progress" },
    });
  });

  it("hydrates idle and interrupted durable truth without inventing a result", async () => {
    const idleStore = createRemoteAgentLaunchStore();
    await idleStore.hydrate({ getRemoteSetupAgentStatus: async () => wireStatus("idle") } as unknown as HaoDesktopApi);
    expect(idleStore.getSnapshot()).toEqual({ phase: "idle" });

    const interruptedStore = createRemoteAgentLaunchStore();
    await interruptedStore.hydrate({ getRemoteSetupAgentStatus: async () => wireStatus("interrupted") } as unknown as HaoDesktopApi);
    expect(interruptedStore.getSnapshot()).toMatchObject({ phase: "failed", jobId: "0".repeat(32) });
    expect(interruptedStore.getSnapshot().result).toBeUndefined();
    expect(interruptedStore.getSnapshot().error).toContain("已中斷");
  });

  it("does not clobber an active in-memory launch with a hydration request", async () => {
    const pending = deferred<RemoteAgentLaunchResult>();
    const launchRemoteSetupAgent = vi.fn(() => pending.promise);
    const getRemoteSetupAgentStatus = vi.fn(async () => wireStatus("terminal", {
      jobId: "f".repeat(32),
      result: wireResult({ jobId: "f".repeat(32) }),
    }));
    const api = { launchRemoteSetupAgent, getRemoteSetupAgentStatus } as unknown as HaoDesktopApi;
    const store = createRemoteAgentLaunchStore();
    const launch = store.start(api, "codex");
    await store.hydrate(api);
    expect(getRemoteSetupAgentStatus).not.toHaveBeenCalled();
    const current = store.getSnapshot();
    pending.resolve(wireResult({ jobId: current.jobId, consentRevision: current.consentRevision }));
    await launch;
    expect(store.getSnapshot()).toMatchObject({ phase: "settled", jobId: current.jobId });
  });

  it("queues a new launch behind the initial durable status read", async () => {
    const pendingStatus = deferred<RemoteAgentLaunchStatus>();
    const getRemoteSetupAgentStatus = vi.fn(() => pendingStatus.promise);
    const launchRemoteSetupAgent = vi.fn(async (
      target: "codex" | "claude",
      jobId: string,
      consentRevision: string,
    ) => wireResult({ target, jobId, consentRevision }));
    const api = { getRemoteSetupAgentStatus, launchRemoteSetupAgent } as unknown as HaoDesktopApi;
    const store = createRemoteAgentLaunchStore();
    const hydration = store.hydrate(api);
    const launch = store.start(api, "codex");
    await Promise.resolve();
    expect(launchRemoteSetupAgent).not.toHaveBeenCalled();
    pendingStatus.resolve(wireStatus("idle"));
    await hydration;
    await launch;
    expect(launchRemoteSetupAgent).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ phase: "settled", target: "codex" });
  });

  it("keeps cancel authority when bounded polling ends while backend is still running", async () => {
    const getRemoteSetupAgentStatus = vi.fn(async () => wireStatus("running", { cancelRequested: true }));
    const store = createRemoteAgentLaunchStore({ maxPollAttempts: 2, sleep: async () => undefined });
    await store.hydrate({ getRemoteSetupAgentStatus } as unknown as HaoDesktopApi);
    expect(getRemoteSetupAgentStatus).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ phase: "cancel_requested", jobId: "0".repeat(32) });
    expect(store.getSnapshot().error).toContain("停止自動輪詢");
  });

  it("strictly rejects extra keys, stale terminal lineage and old consent", async () => {
    expect(() => parseRemoteAgentLaunchResult({ ...wireResult(), injected: true })).toThrow("closed-world");
    expect(() => parseRemoteAgentLaunchStatus(wireStatus("running", { consentRevision: "editkin.remote-agent-consent/v1" }))).toThrow("consent");
    expect(() => parseRemoteAgentLaunchStatus(wireStatus("terminal", {
      result: wireResult({ jobId: "f".repeat(32) }),
    }))).toThrow("lineage");
    expect(() => parseRemoteAgentLaunchResult(wireResult({
      resumedExistingState: true,
      stateCreatedThisRun: true,
    }))).toThrow("state lineage");

    const store = createRemoteAgentLaunchStore();
    await store.hydrate({
      getRemoteSetupAgentStatus: async () => ({ ...wireStatus("idle"), injected: true }) as unknown as RemoteAgentLaunchStatus,
    } as unknown as HaoDesktopApi);
    expect(store.getSnapshot()).toMatchObject({ phase: "failed" });
    expect(store.getSnapshot().error).toContain("closed-world");
  });
});
