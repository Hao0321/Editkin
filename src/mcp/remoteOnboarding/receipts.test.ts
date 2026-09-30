import { describe, expect, it } from "vitest";
import { CANDIDATE_SCHEMA, REMOTE_AGENT_CONSENT_REVISION, REMOTE_SCHEMA, RUNTIME_SCHEMA, VERIFICATION_SCHEMA } from "./constants";
import {
  activeRuntime, configurationId, exactKeys, parseCandidate, parseConfig, remoteAgentLineage, validVerification,
} from "./receipts";
import type { UserRemoteConfig } from "./types";

function config(overrides: Partial<Omit<UserRemoteConfig, "configurationId">> = {}): UserRemoteConfig {
  const identity: Omit<UserRemoteConfig, "configurationId"> = {
    schema: REMOTE_SCHEMA,
    schemaVersion: 1,
    mode: "user-owned-byo",
    transport: "https-tunnel",
    origin: "https://remote.example.com",
    providerId: "tailscale",
    costResponsibility: "end-user",
    userConfirmedCostsAndPermissions: true,
    configuredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return { ...identity, configurationId: configurationId(identity) };
}

function candidate(preparedAtMs = Date.now()) {
  return {
    schema: CANDIDATE_SCHEMA,
    candidateRevision: "3f2b8c1e-5d4a-4f6b-9a7c-1e2d3c4b5a69",
    expectedConfigurationId: null,
    preparedAtMs,
    expiresAtMs: preparedAtMs + 30 * 60_000,
    configuration: config(),
  };
}

describe("remote onboarding receipts", () => {
  it("rejects any receipt key outside the reviewed shape so secrets cannot ride along", () => {
    expect(() => exactKeys({ a: 1, b: 2 }, ["a", "b"], "x")).not.toThrow();
    expect(() => exactKeys({ a: 1, apiKey: "s" }, ["a"], "x")).toThrow("未允許欄位");
    expect(() => exactKeys({ a: 1 }, ["a", "b"], "x")).toThrow("未允許欄位");
  });

  it("accepts an untampered config and binds identity to every material field", () => {
    const good = config();
    expect(parseConfig(good)).toEqual(good);
    expect(() => parseConfig({ ...good, origin: "https://attacker.example.com" })).toThrow("identity");
    expect(() => parseConfig({ ...good, providerId: "other" })).toThrow("identity");
    expect(() => parseConfig({ ...good, configuredAt: "2026-01-02T00:00:00.000Z" })).toThrow("identity");
    expect(() => parseConfig({ ...good, extra: true })).toThrow("未允許欄位");
    expect(() => parseConfig(undefined)).toThrow();
    const local = config({ origin: "https://localhost" });
    expect(() => parseConfig(local)).toThrow();
  });

  it("accepts only fresh candidates with a 30 minute lifetime wrapping a valid config", () => {
    expect(parseCandidate(candidate()).configuration.origin).toBe("https://remote.example.com");
    expect(() => parseCandidate(candidate(Date.now() - 31 * 60_000))).toThrow("過期");
    expect(() => parseCandidate({ ...candidate(), expiresAtMs: Date.now() + 60 * 60_000 })).toThrow("過期");
    expect(() => parseCandidate({ ...candidate(), candidateRevision: "not-a-uuid" })).toThrow("格式");
    expect(() => parseCandidate({ ...candidate(), configuration: { ...config(), origin: "https://evil.example.com" } })).toThrow("identity");
  });

  it("requires exact job and consent lineage from the launcher environment", () => {
    const jobId = "b".repeat(32);
    expect(remoteAgentLineage({
      EDITKIN_REMOTE_AGENT_JOB_ID: jobId,
      EDITKIN_REMOTE_AGENT_CONSENT_REVISION: REMOTE_AGENT_CONSENT_REVISION,
    })).toEqual({ jobId, consentRevision: REMOTE_AGENT_CONSENT_REVISION });
    expect(() => remoteAgentLineage({})).toThrow("lineage");
    expect(() => remoteAgentLineage({
      EDITKIN_REMOTE_AGENT_JOB_ID: jobId,
      EDITKIN_REMOTE_AGENT_CONSENT_REVISION: "editkin.remote-agent-consent/v1",
    })).toThrow("lineage");
  });

  it("trusts a runtime receipt only for the same config, a live process, and a real start time", () => {
    const current = config();
    const receipt = {
      schema: RUNTIME_SCHEMA,
      transport: current.transport,
      configurationId: current.configurationId,
      probeId: "c".repeat(32),
      runtimeInstanceId: "d".repeat(32),
      startedAtMs: Date.now() - 1_000,
      processId: process.pid,
    };
    expect(activeRuntime(receipt, current)?.probeId).toBe(receipt.probeId);
    expect(activeRuntime({ ...receipt, configurationId: "e".repeat(64) }, current)).toBeUndefined();
    expect(activeRuntime({ ...receipt, startedAtMs: Date.now() + 60_000 }, current)).toBeUndefined();
    expect(activeRuntime({ ...receipt, processId: 0 }, current)).toBeUndefined();
    expect(activeRuntime({ ...receipt, extra: 1 }, current)).toBeUndefined();
    expect(activeRuntime("nope", current)).toBeUndefined();
  });

  it("accepts a verification receipt only for the current runtime and never as verified", () => {
    const current = config();
    const runtime = {
      schema: RUNTIME_SCHEMA as typeof RUNTIME_SCHEMA,
      transport: current.transport,
      configurationId: current.configurationId,
      probeId: "c".repeat(32),
      runtimeInstanceId: "d".repeat(32),
      processId: process.pid,
      startedAtMs: Date.now() - 5_000,
    };
    const verifiedAtMs = Date.now();
    const receipt = {
      schema: VERIFICATION_SCHEMA,
      configurationId: current.configurationId,
      status: "PARTIAL",
      verified: false,
      verifiedAt: new Date(verifiedAtMs).toISOString(),
      verifiedAtMs,
      probeId: runtime.probeId,
      runtimeInstanceId: runtime.runtimeInstanceId,
      processId: runtime.processId,
      startedAtMs: runtime.startedAtMs,
      endpointKind: "editkin-tunnel",
      successfulTlsConnections: 2,
      latencyMs: [10, 12],
      latencyP50Ms: 11,
      jitterMs: 2,
      routeEvidence: "two-pinned-independent-tls-connections-succeeded",
      reconnectVerified: false,
      requiresActiveMobileProof: true,
    };
    expect(validVerification(receipt, current.configurationId, runtime)).toBe(true);
    expect(validVerification({ ...receipt, verified: true }, current.configurationId, runtime)).toBe(false);
    expect(validVerification({ ...receipt, reconnectVerified: true }, current.configurationId, runtime)).toBe(false);
    expect(validVerification({ ...receipt, runtimeInstanceId: "f".repeat(32) }, current.configurationId, runtime)).toBe(false);
    expect(validVerification({ ...receipt, verifiedAtMs: Date.now() - 16 * 60_000, verifiedAt: new Date(Date.now() - 16 * 60_000).toISOString() }, current.configurationId, runtime)).toBe(false);
    expect(validVerification({ ...receipt, token: "x" }, current.configurationId, runtime)).toBe(false);
  });
});
