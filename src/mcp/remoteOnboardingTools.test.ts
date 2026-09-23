import { randomUUID } from "node:crypto";
import { access, appendFile, link, mkdir, mkdtemp, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  configureRemoteAccess,
  getRemoteSetupStatus,
  listRemoteProviderConnectorStatus,
  prepareRemoteSetup,
  type PrepareRemoteSetupInput,
  registerRemoteOnboardingTools,
  remoteSetupPaths,
  validateRemoteOrigin,
  verifyRemoteAccess,
} from "./remoteOnboardingTools";

async function fixtureEnvironment() {
  const root = await mkdtemp(join(tmpdir(), "editkin-remote-onboarding-"));
  return {
    EDITKIN_AGENT_STATE_ROOT: join(root, "agent-runtime-v3"),
    EDITKIN_REMOTE_AGENT_JOB_ID: "a".repeat(32),
    EDITKIN_REMOTE_AGENT_CONSENT_REVISION: "editkin.remote-agent-consent/v2",
  } as NodeJS.ProcessEnv;
}

function proposalInput(connectorId: "tailscale-funnel" | "cloudflare-quick-tunnel" = "tailscale-funnel"): PrepareRemoteSetupInput {
  const provider = connectorId === "tailscale-funnel"
    ? { id: "tailscale", displayName: "Tailscale", productName: "Funnel", region: "Taiwan" }
    : { id: "cloudflare", displayName: "Cloudflare", productName: "Quick Tunnel", region: "Taiwan" };
  return {
    connectorId,
    transport: "https-tunnel",
    provider,
    expectedEndpoint: {
      transport: "https-tunnel",
      publicOriginRequired: true,
      description: "Public HTTPS origin routed to the Editkin desktop Remote port",
    },
    pricing: {
      kind: "public-list-price",
      amountMicros: 5_000_000,
      currency: "USD",
      billingUnit: "per-month",
      summary: "USD 5 per month according to the cited public price page",
    },
    freeTier: "No free tier is assumed by this proposal",
    quota: "One tunnel with provider-published transfer limits",
    permissions: ["Create one HTTPS tunnel", "Route tunnel traffic to the Editkin desktop port"],
    plannedMutations: ["Create one provider tunnel", "Add one route for the Editkin Remote endpoint"],
    cancellationOrDeletionConsequences: "Deleting the tunnel removes the public route; provider billing may continue until cancellation is confirmed",
    sources: [{ label: "Provider pricing", url: "https://docs.example.test/pricing" }],
    uncertainties: ["Final taxes and traffic overage depend on the user's provider account"],
    unsupportedPrerequisites: ["Provider login and payment are outside Editkin Stage 1"],
  };
}

async function writeLegacyPending(environment: NodeJS.ProcessEnv, providerId = "custom-provider") {
  const path = remoteSetupPaths(environment).pending;
  await mkdir(dirname(path), { recursive: true });
  const confirmationId = randomUUID();
  await writeFile(path, `${JSON.stringify({
    schema: "editkin.remote-setup-confirmation/v1",
    confirmationId,
    transport: "https-tunnel",
    providerId,
    costResponsibility: "end-user",
    autoDeploy: false,
    preparedAt: new Date().toISOString(),
    remoteAgentJobId: "c".repeat(32),
    remoteAgentConsentRevision: "editkin.remote-agent-consent/v1",
  }, null, 2)}\n`, "utf8");
  return confirmationId;
}

async function approveCandidate(environment: NodeJS.ProcessEnv) {
  const paths = remoteSetupPaths(environment);
  const candidate = JSON.parse(await readFile(paths.candidate, "utf8")) as { configuration: unknown };
  await writeFile(paths.config, `${JSON.stringify(candidate.configuration)}\n`, "utf8");
  await unlink(paths.candidate);
  return candidate.configuration as { configurationId: string };
}

describe("Editkin MCP Remote onboarding", () => {
  it("is LAN-first and persists a truthful structured proposal without deployment", async () => {
    const environment = await fixtureEnvironment();
    expect(await getRemoteSetupStatus(environment)).toMatchObject({ status: "LAN_DEFAULT", transport: "lan", configured: false });
    const prepared = await prepareRemoteSetup(proposalInput(), environment);
    expect(prepared).toMatchObject({
      schema: "editkin.remote-provider-proposal/v2",
      status: "PROPOSAL_READY_NOT_APPROVED",
      created: true,
      resumed: false,
      externalMutationPerformed: false,
      autoDeploy: false,
      approvalAvailable: false,
      proposal: {
        phase: "EXACT_PROVIDER_PROPOSAL",
        truthLabel: "PROPOSAL_READY_NOT_APPROVED",
        jobId: "a".repeat(32),
        consentRevision: "editkin.remote-agent-consent/v2",
        provider: { id: "tailscale" },
        connector: {
          connectorId: "tailscale-funnel",
          availability: "research-only-disabled",
          attested: false,
          approvalEnabled: false,
        },
      },
    });
    expect(prepared.proposal.workflowId).toMatch(/^[a-f0-9]{32}$/);
    expect(prepared.proposal.proposalRevision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(prepared.proposal.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.proposal.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.proposal.sources[0].checkedAtMs).toBe(prepared.proposal.createdAtMs);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "PROPOSAL_READY_NOT_APPROVED",
      configured: false,
      resumeAvailable: true,
      proposal: { proposalRevision: prepared.proposal.proposalRevision, pricing: { amountMicros: 5_000_000, currency: "USD" } },
    });
    const persisted = await readFile(remoteSetupPaths(environment).pending, "utf8");
    expect(persisted).not.toMatch(/api.?key|access.?token|refresh.?token|cookie|password|private.?key/i);
  });

  it("dual-reads a legacy confirmation and only legacy configure can produce a desktop candidate", async () => {
    const environment = await fixtureEnvironment();
    const confirmationId = await writeLegacyPending(environment, "cloudflare-example");
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "LEGACY_PENDING_INCOMPLETE",
      configured: false,
      pendingProviderConfirmation: { confirmationId, providerId: "cloudflare-example" },
    });
    await expect(configureRemoteAccess({
      confirmationId: "00000000-0000-4000-8000-000000000000",
      origin: "https://remote.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment)).rejects.toThrow("確認單已失效");
    const configured = await configureRemoteAccess({
      confirmationId,
      origin: "https://remote.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment);
    expect(configured).toMatchObject({ status: "PENDING_DESKTOP_APPROVAL", persistedSecretFields: [], formalConfigurationWritten: false, desktopApprovalRequired: true });
    expect(JSON.stringify(configured)).not.toContain("https://remote.example.test");
    await expect(access(remoteSetupPaths(environment).config)).rejects.toThrow();
    const persisted = await readFile(remoteSetupPaths(environment).candidate, "utf8");
    expect(persisted).toContain("https://remote.example.test");
    expect(persisted).not.toMatch(/api.?key|token|cookie|password|secret/i);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({ status: "AWAITING_DESKTOP_APPROVAL", configured: false });
  });

  it("blocks proposal v1 without parsing it as legacy confirmation or auto-overwriting it", async () => {
    const environment = await fixtureEnvironment();
    const path = remoteSetupPaths(environment).pending;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ schema: "editkin.remote-provider-proposal/v1", provider: { id: "old-provider" } })}\n`, "utf8");
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "LEGACY_PROVIDER_PROPOSAL_BLOCKED",
      configured: false,
      resumeAvailable: false,
    });
    await expect(prepareRemoteSetup(proposalInput(), environment)).rejects.toThrow(/proposal v1.*connector identity.*plan digest/i);
    await expect(configureRemoteAccess({
      confirmationId: randomUUID(),
      origin: "https://remote.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment)).rejects.toThrow(/legacy configure/i);
  });

  it("shows a valid update candidate over its expected config but fails closed when pending also coexists", async () => {
    const environment = await fixtureEnvironment();
    const firstConfirmationId = await writeLegacyPending(environment, "provider-one");
    await configureRemoteAccess({
      confirmationId: firstConfirmationId,
      origin: "https://first.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment);
    const active = await approveCandidate(environment);
    const secondConfirmationId = await writeLegacyPending(environment, "provider-two");
    await configureRemoteAccess({
      confirmationId: secondConfirmationId,
      origin: "https://second.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "AWAITING_DESKTOP_APPROVAL",
      configured: true,
      configuration: { configurationId: active.configurationId },
      pendingDesktopApproval: { providerId: "provider-two" },
    });
    await writeLegacyPending(environment, "provider-three");
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "STATE_RECONCILIATION_REQUIRED",
      configured: false,
      conflict: { present: ["config", "candidate", "pending"], automaticMutationPerformed: false },
    });
    await unlink(remoteSetupPaths(environment).candidate);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "STATE_RECONCILIATION_REQUIRED",
      conflict: { present: ["config", "pending"] },
    });
  });

  it("resumes a valid proposal byte-for-byte and converges concurrent writers without overwrite", async () => {
    const environment = await fixtureEnvironment();
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      prepareRemoteSetup(proposalInput(index % 2 === 0 ? "tailscale-funnel" : "cloudflare-quick-tunnel"), environment)
    )));
    expect(attempts.filter(({ created }) => created)).toHaveLength(1);
    expect(attempts.filter(({ resumed }) => resumed)).toHaveLength(11);
    expect(new Set(attempts.map(({ proposal }) => proposal.proposalRevision)).size).toBe(1);
    const first = attempts[0];
    const persistedBefore = await readFile(remoteSetupPaths(environment).pending, "utf8");
    const resumedEnvironment = { ...environment, EDITKIN_REMOTE_AGENT_JOB_ID: "b".repeat(32) };
    const resumed = await prepareRemoteSetup(proposalInput("tailscale-funnel"), resumedEnvironment);
    expect(resumed).toMatchObject({ created: false, resumed: true });
    expect(resumed.proposal.proposalRevision).toBe(first.proposal.proposalRevision);
    expect(resumed.proposal.jobId).toBe("a".repeat(32));
    expect(await readFile(remoteSetupPaths(environment).pending, "utf8")).toBe(persistedBefore);
    await expect(prepareRemoteSetup({
      ...proposalInput("tailscale-funnel"),
      expectedExpiredProposalRevision: first.proposal.proposalRevision,
    }, resumedEnvironment)).rejects.toThrow(/尚未過期|stale expectedExpiredProposalRevision/i);
    expect(await readFile(remoteSetupPaths(environment).pending, "utf8")).toBe(persistedBefore);
  });

  it("never publishes an empty or partial final proposal while the receipt is being written", async () => {
    const environment = await fixtureEnvironment();
    const input = proposalInput();
    input.permissions = Array.from({ length: 16 }, (_, index) => `Permission ${index} ${"p".repeat(120)}`);
    input.plannedMutations = Array.from({ length: 16 }, (_, index) => `Mutation ${index} ${"m".repeat(120)}`);
    input.uncertainties = Array.from({ length: 16 }, (_, index) => `Uncertainty ${index} ${"u".repeat(110)}`);
    input.unsupportedPrerequisites = Array.from({ length: 16 }, (_, index) => `Prerequisite ${index} ${"r".repeat(108)}`);
    const finalPath = remoteSetupPaths(environment).pending;
    const observations: string[] = [];
    let settled = false;
    const writing = prepareRemoteSetup(input, environment).finally(() => { settled = true; });
    while (!settled) {
      try { observations.push(await readFile(finalPath, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const prepared = await writing;
    const finalBytes = await readFile(finalPath, "utf8");
    observations.push(finalBytes);
    for (const observed of observations) {
      const parsed = JSON.parse(observed);
      expect(parsed).toMatchObject({
        schema: "editkin.remote-provider-proposal/v2",
        proposalRevision: prepared.proposal.proposalRevision,
        proposalDigest: prepared.proposal.proposalDigest,
      });
      expect(observed).toBe(finalBytes);
    }
    expect((await readdir(remoteSetupPaths(environment).root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails a bounded read when the opened receipt grows past 64 KiB", async () => {
    const environment = await fixtureEnvironment();
    await prepareRemoteSetup(proposalInput(), environment);
    const pending = remoteSetupPaths(environment).pending;
    let opened!: () => void;
    let release!: () => void;
    const didOpen = new Promise<void>((resolve) => { opened = resolve; });
    const mayRead = new Promise<void>((resolve) => { release = resolve; });
    const status = getRemoteSetupStatus(environment, {
      afterHandleOpened: async (path) => {
        if (path !== pending) return;
        opened();
        await mayRead;
      },
    });
    await didOpen;
    try { await appendFile(pending, "x".repeat(64 * 1024 + 1), "utf8"); }
    finally { release(); }
    await expect(status).rejects.toThrow(/大小上限|成長|改變|bounded read/i);
  });

  it("fails a bounded read when the current path identity is removed after its handle opens", async () => {
    const environment = await fixtureEnvironment();
    await prepareRemoteSetup(proposalInput(), environment);
    const pending = remoteSetupPaths(environment).pending;
    const replacement = `${pending}.replacement`;
    let opened!: () => void;
    let release!: () => void;
    const didOpen = new Promise<void>((resolve) => { opened = resolve; });
    const mayRead = new Promise<void>((resolve) => { release = resolve; });
    const status = getRemoteSetupStatus(environment, {
      afterHandleOpened: async (path) => {
        if (path !== pending) return;
        opened();
        await mayRead;
      },
    });
    await didOpen;
    try {
      await writeFile(replacement, "{}\n", "utf8");
      await unlink(pending);
    } finally { release(); }
    await expect(status).rejects.toThrow(/替換|改變|bounded read/i);
    // Windows prevents publishing the replacement while the old handle is open;
    // publish it after the rejected read to prove the path can now hold a new inode.
    await rename(replacement, pending);
  });

  it("recovers deterministic renewal crash artifacts without replaying or creating a new workflow", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
      const environment = await fixtureEnvironment();
      const prepared = await prepareRemoteSetup(proposalInput(), environment);
      const paths = remoteSetupPaths(environment);
      const before = await readFile(paths.pending, "utf8");
      vi.advanceTimersByTime(30 * 60_000 + 1);
      await rename(paths.pending, paths.pendingRenewing);
      await expect(access(paths.pending)).rejects.toThrow();
      expect(await getRemoteSetupStatus(environment)).toMatchObject({
        status: "PROPOSAL_EXPIRED",
        renewal: { expectedExpiredProposalRevision: prepared.proposal.proposalRevision },
      });
      expect(await readFile(paths.pending, "utf8")).toBe(before);
      await expect(access(paths.pendingRenewing)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans a same-inode pre-unlink renewal claim and exposes conflicting crash artifacts", async () => {
    const environment = await fixtureEnvironment();
    const prepared = await prepareRemoteSetup(proposalInput("tailscale-funnel"), environment);
    const paths = remoteSetupPaths(environment);
    await link(paths.pending, paths.pendingRenewing);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "PROPOSAL_READY_NOT_APPROVED",
      proposal: { proposalRevision: prepared.proposal.proposalRevision },
    });
    await expect(access(paths.pendingRenewing)).rejects.toThrow();

    const otherEnvironment = await fixtureEnvironment();
    await prepareRemoteSetup(proposalInput("cloudflare-quick-tunnel"), otherEnvironment);
    const conflictingBytes = await readFile(remoteSetupPaths(otherEnvironment).pending, "utf8");
    await rename(paths.pending, paths.pendingRenewing);
    await writeFile(paths.pending, conflictingBytes, "utf8");
    const beforePending = await readFile(paths.pending, "utf8");
    const beforeRenewing = await readFile(paths.pendingRenewing, "utf8");
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "RENEWAL_RECONCILIATION_REQUIRED",
      configured: false,
      resumeAvailable: false,
      recovery: {
        reason: "CONFLICTING_PENDING_AND_RENEWING",
        automaticReplayPerformed: false,
      },
    });
    expect(await readFile(paths.pending, "utf8")).toBe(beforePending);
    expect(await readFile(paths.pendingRenewing, "utf8")).toBe(beforeRenewing);
  });

  it("does not turn a lone unexpected active renewing artifact into LAN or a new workflow", async () => {
    const environment = await fixtureEnvironment();
    const prepared = await prepareRemoteSetup(proposalInput("tailscale-funnel"), environment);
    const paths = remoteSetupPaths(environment);
    await rename(paths.pending, paths.pendingRenewing);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({
      status: "RENEWAL_RECONCILIATION_REQUIRED",
      recovery: { reason: "RENEWING_PROPOSAL_NOT_EXPIRED", automaticReplayPerformed: false },
    });
    await expect(prepareRemoteSetup(proposalInput("cloudflare-quick-tunnel"), environment))
      .rejects.toThrow(/reconciliation.*RENEWING_PROPOSAL_NOT_EXPIRED/i);
    await expect(access(paths.pending)).rejects.toThrow();
    expect(JSON.parse(await readFile(paths.pendingRenewing, "utf8"))).toMatchObject({
      workflowId: prepared.proposal.workflowId,
      proposalRevision: prepared.proposal.proposalRevision,
    });
  });

  it("binds a remote-only confirmation to the exact launcher job and consent revision", async () => {
    const environment = {
      ...await fixtureEnvironment(),
      EDITKIN_MCP_MODE: "remote-only",
      EDITKIN_REMOTE_AGENT_JOB_ID: "a".repeat(32),
      EDITKIN_REMOTE_AGENT_CONSENT_REVISION: "editkin.remote-agent-consent/v2",
    };
    await prepareRemoteSetup(proposalInput("tailscale-funnel"), environment);
    const persisted = JSON.parse(await readFile(remoteSetupPaths(environment).pending, "utf8"));
    expect(persisted).toMatchObject({
      jobId: "a".repeat(32),
      consentRevision: "editkin.remote-agent-consent/v2",
    });
    await expect(prepareRemoteSetup(
      proposalInput("cloudflare-quick-tunnel"),
      {
        EDITKIN_AGENT_STATE_ROOT: (await fixtureEnvironment()).EDITKIN_AGENT_STATE_ROOT,
        EDITKIN_MCP_MODE: "remote-only",
      },
    )).rejects.toThrow(/job.*consent lineage/i);
  });

  it("rejects nested unknown fields, secret-bearing sources, and fabricated unknown pricing", async () => {
    const environment = await fixtureEnvironment();
    await expect(prepareRemoteSetup({
      ...proposalInput(),
      provider: { ...proposalInput().provider, apiKey: "must-not-enter-mcp" },
    } as never, environment)).rejects.toThrow();
    await expect(prepareRemoteSetup({
      ...proposalInput(),
      sources: [{ label: "Secret URL", url: "https://docs.example.test/pricing?token=secret" }],
    }, environment)).rejects.toThrow(/HTTPS URL|query|fragment/i);
    await expect(prepareRemoteSetup({
      ...proposalInput(),
      pricing: {
        kind: "unknown",
        amountMicros: 1,
        currency: "USD",
        billingUnit: "per-month",
        summary: "Price is not known",
      },
    }, environment)).rejects.toThrow(/unknown pricing/i);
    for (const url of [
      "https://localhost/pricing",
      "https://provider.local/pricing",
      "https://metadata.google.internal/pricing",
      "https://127.0.0.1/pricing",
      "https://169.254.169.254/pricing",
      "https://192.0.2.1/pricing",
      "https://198.51.100.1/pricing",
      "https://203.0.113.1/pricing",
      "https://[::1]/pricing",
      "https://[2001:db8::1]/pricing",
    ]) {
      await expect(prepareRemoteSetup({
        ...proposalInput(),
        sources: [{ label: "Unsafe source", url }],
      }, environment)).rejects.toThrow(/HTTPS URL|來源/i);
    }
    await expect(access(remoteSetupPaths(environment).pending)).rejects.toThrow();
  });

  it("detects persisted material-field tampering through the Editkin-generated digest", async () => {
    const environment = await fixtureEnvironment();
    await prepareRemoteSetup(proposalInput(), environment);
    const path = remoteSetupPaths(environment).pending;
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.pricing.summary = "Tampered after persistence";
    await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await expect(getRemoteSetupStatus(environment)).rejects.toThrow(/digest|identity/i);
  });

  it("renews only an expired exact proposal revision and preserves the workflow lineage", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
      const environment = await fixtureEnvironment();
      const first = await prepareRemoteSetup(proposalInput("tailscale-funnel"), environment);
      const path = remoteSetupPaths(environment).pending;
      const renewalEnvironment = { ...environment, EDITKIN_REMOTE_AGENT_JOB_ID: "b".repeat(32) };
      vi.advanceTimersByTime(30 * 60_000 + 1);
      expect(await getRemoteSetupStatus(environment)).toMatchObject({
        status: "PROPOSAL_EXPIRED",
        resumeAvailable: false,
        renewal: { expectedExpiredProposalRevision: first.proposal.proposalRevision },
      });
      const expiredBytes = await readFile(path, "utf8");
      await expect(prepareRemoteSetup({
        ...proposalInput("cloudflare-quick-tunnel"),
        expectedExpiredProposalRevision: "00000000-0000-4000-8000-000000000000",
      }, renewalEnvironment)).rejects.toThrow(/exact expectedExpiredProposalRevision/i);
      expect(await readFile(path, "utf8")).toBe(expiredBytes);
      const renewed = await prepareRemoteSetup({
        ...proposalInput("cloudflare-quick-tunnel"),
        expectedExpiredProposalRevision: first.proposal.proposalRevision,
      }, renewalEnvironment);
      expect(renewed).toMatchObject({ created: true, resumed: false, proposal: { provider: { id: "cloudflare" }, connector: { connectorId: "cloudflare-quick-tunnel" } } });
      expect(renewed.proposal.workflowId).toBe(first.proposal.workflowId);
      expect(renewed.proposal.jobId).toBe("b".repeat(32));
      expect(renewed.proposal.proposalRevision).not.toBe(first.proposal.proposalRevision);
      expect(renewed.proposal.proposalDigest).not.toBe(first.proposal.proposalDigest);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicitly refuses to treat a v2 proposal as legacy configure consent and leaves it unchanged", async () => {
    const environment = await fixtureEnvironment();
    await prepareRemoteSetup(proposalInput(), environment);
    const path = remoteSetupPaths(environment).pending;
    const before = await readFile(path, "utf8");
    await expect(configureRemoteAccess({
      confirmationId: "00000000-0000-4000-8000-000000000000",
      origin: "https://remote.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment)).rejects.toThrow(/proposal-bound approval|legacy configure/i);
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(access(`${path}.consuming`)).rejects.toThrow();
  });

  it.each([
    "http://remote.example.test",
    "https://user:password@remote.example.test",
    "https://remote.example.test/path",
    "https://remote.example.test?token=secret",
    "https://localhost",
    "https://192.168.1.2",
    "https://[::ffff:7f00:1]",
    "https://2130706433",
    "https://127.1",
    "https://0x7f000001",
  ])("rejects unsafe or non-origin value %s", (value) => {
    expect(() => validateRemoteOrigin(value)).toThrow();
  });

  it("records verification only after two observed independent connections", async () => {
    const environment = await fixtureEnvironment();
    const confirmationId = await writeLegacyPending(environment, "custom-provider");
    const configured = await configureRemoteAccess({
      confirmationId,
      origin: "https://remote.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment);
    await approveCandidate(environment);
    const startedAtMs = Date.now() - 100;
    await writeFile(remoteSetupPaths(environment).runtime, `${JSON.stringify({
      schema: "editkin.remote-runtime/v3",
      transport: "https-tunnel",
      configurationId: configured.proposal.configurationId,
      probeId: "1".repeat(32),
      runtimeInstanceId: "a".repeat(32),
      processId: process.pid,
      startedAtMs,
    })}\n`);
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ schema: "editkin.remote-health/v1", probeId: "1".repeat(32) }), { status: 200 }); };
    const lookupImpl = async () => [{ address: "203.0.113.10", family: 4 }];
    const receipt = await verifyRemoteAccess(environment, fetchImpl, lookupImpl);
    expect(receipt).toMatchObject({
      status: "PARTIAL", verified: false, successfulTlsConnections: 2,
      routeEvidence: "two-pinned-independent-tls-connections-succeeded", reconnectVerified: false,
      probeId: "1".repeat(32), runtimeInstanceId: "a".repeat(32), processId: process.pid, startedAtMs,
    });
    if (receipt.status !== "PARTIAL" || !("verifiedAtMs" in receipt) || !("verifiedAt" in receipt)) {
      throw new Error("Expected a runtime-bound PARTIAL verification receipt");
    }
    expect(receipt.verifiedAtMs).toBeGreaterThan(startedAtMs);
    expect(Date.parse(receipt.verifiedAt)).toBe(receipt.verifiedAtMs);
    expect(receipt).toHaveProperty("jitterMs");
    expect(calls).toBe(2);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({ status: "CONFIGURED_ROUTE_VERIFIED", configured: true });
  });

  it("does not manufacture reconnect evidence after a failed first observation", async () => {
    const environment = await fixtureEnvironment();
    const confirmationId = await writeLegacyPending(environment, "custom-tunnel");
    await configureRemoteAccess({
      confirmationId,
      origin: "https://relay.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment);
    const configuration = await approveCandidate(environment);
    await writeFile(remoteSetupPaths(environment).runtime, `${JSON.stringify({
      schema: "editkin.remote-runtime/v3", transport: "https-tunnel", configurationId: configuration.configurationId,
      probeId: "2".repeat(32), runtimeInstanceId: "b".repeat(32), processId: process.pid, startedAtMs: Date.now() - 100,
    })}\n`);
    let calls = 0;
    const blocked = await verifyRemoteAccess(environment, async () => { calls += 1; return new Response("Not found", { status: 404 }); }, async () => [{ address: "203.0.113.11", family: 4 }]);
    expect(blocked).toMatchObject({ status: "BLOCKED", verified: false });
    expect(calls).toBe(1);
    expect(await getRemoteSetupStatus(environment)).toMatchObject({ status: "CONFIGURED_UNVERIFIED" });
  });

  it("refuses a verification receipt when the runtime instance changes during probing", async () => {
    const environment = await fixtureEnvironment();
    const confirmationId = await writeLegacyPending(environment, "custom-tunnel");
    const configured = await configureRemoteAccess({
      confirmationId,
      origin: "https://relay.example.test",
      userConfirmedDeployment: true,
      userConfirmedProviderCosts: true,
      userConfirmedProviderPermissions: true,
    }, environment);
    await approveCandidate(environment);
    const runtimePath = remoteSetupPaths(environment).runtime;
    const runtime = {
      schema: "editkin.remote-runtime/v3", transport: "https-tunnel", configurationId: configured.proposal.configurationId,
      probeId: "3".repeat(32), runtimeInstanceId: "c".repeat(32), processId: process.pid, startedAtMs: Date.now() - 100,
    };
    await writeFile(runtimePath, `${JSON.stringify(runtime)}\n`);
    let calls = 0;
    const blocked = await verifyRemoteAccess(environment, async () => {
      calls += 1;
      if (calls === 2) await writeFile(runtimePath, `${JSON.stringify({ ...runtime, runtimeInstanceId: "d".repeat(32) })}\n`);
      return new Response(JSON.stringify({ schema: "editkin.remote-health/v1", probeId: runtime.probeId }), { status: 200 });
    }, async () => [{ address: "203.0.113.12", family: 4 }]);
    expect(blocked).toMatchObject({ status: "BLOCKED", verified: false });
    await expect(access(remoteSetupPaths(environment).verification)).rejects.toThrow();
  });

  it("keeps WSS relay outside the closed Stage-1 proposal schema", async () => {
    const environment = await fixtureEnvironment();
    await expect(prepareRemoteSetup({ ...proposalInput(), transport: "cloud-relay" } as never, environment))
      .rejects.toThrow();
  });

  it("registers explicit output schemas and emits structured content", async () => {
    const environment = await fixtureEnvironment();
    const tools = new Map<string, { configuration: Record<string, unknown>; handler: (input: never) => Promise<Record<string, unknown>> }>();
    const server = { registerTool(name: string, configuration: Record<string, unknown>, handler: (input: never) => Promise<Record<string, unknown>>) { tools.set(name, { configuration, handler }); } };
    registerRemoteOnboardingTools(server as never, environment);
    expect([...tools]).toHaveLength(5);
    for (const { configuration } of tools.values()) {
      expect(configuration).toHaveProperty("outputSchema");
      expect(configuration).toHaveProperty("annotations");
    }
    const result = await tools.get("get_remote_setup_status")!.handler({} as never);
    expect(result).toHaveProperty("structuredContent.status", "LAN_DEFAULT");
    const statusSchema = tools.get("get_remote_setup_status")!.configuration.outputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(statusSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(statusSchema.safeParse({ ...(result.structuredContent as object), inventedSuccess: true }).success).toBe(false);
    const connectorResult = await tools.get("list_remote_provider_connectors")!.handler({} as never);
    expect(connectorResult).toHaveProperty("structuredContent.externalMutationToolAvailable", false);
    expect(connectorResult).toHaveProperty("structuredContent.connectors.0.approvalAvailable", false);
    const prepareTool = tools.get("prepare_remote_setup")!;
    const inputSchema = prepareTool.configuration.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(inputSchema.safeParse(proposalInput()).success).toBe(true);
    expect(inputSchema.safeParse({ ...proposalInput(), provider: { ...proposalInput().provider, token: "forbidden" } }).success).toBe(false);
    const prepared = await prepareTool.handler(proposalInput() as never);
    const outputSchema = prepareTool.configuration.outputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(outputSchema.safeParse(prepared.structuredContent).success).toBe(true);
    expect(outputSchema.safeParse({ ...(prepared.structuredContent as object), deployed: true }).success).toBe(false);
  });

  it("remote-only registration exposes exactly the three bounded research tools", async () => {
    const environment = await fixtureEnvironment();
    const tools = new Map<string, unknown>();
    const server = {
      registerTool(name: string) { tools.set(name, true); },
    };
    registerRemoteOnboardingTools(server as never, environment, { includeConfigure: false, includeVerify: false });
    expect([...tools.keys()].sort()).toEqual([
      "get_remote_setup_status",
      "list_remote_provider_connectors",
      "prepare_remote_setup",
    ]);
    expect(tools.has("configure_remote_access")).toBe(false);
    expect(tools.has("verify_remote_access")).toBe(false);
  });

  it("lists only disabled product connectors and never exposes a fake or execution capability", () => {
    const listed = listRemoteProviderConnectorStatus();
    expect(listed.externalMutationToolAvailable).toBe(false);
    expect(listed.connectors).toHaveLength(2);
    expect(listed.connectors.every((connector) => connector.approvalAvailable === false && connector.attested === false)).toBe(true);
    expect(listed.connectors.some((connector) => connector.connectorId.includes("fake"))).toBe(false);
  });
});
