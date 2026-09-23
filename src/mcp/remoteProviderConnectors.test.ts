import { describe, expect, it } from "vitest";
import {
  connectorBinding,
  listRemoteProviderConnectors,
  parseRemoteProviderConnectorRegistry,
  providerActionPlanDigest,
  resolveRemoteProviderConnector,
} from "./remoteProviderConnectors";

describe("Remote provider connector closed registry", () => {
  it("contains only the two non-actionable research manifests and no product fake", () => {
    const connectors = listRemoteProviderConnectors();
    expect(connectors.map(({ connectorId }) => connectorId)).toEqual([
      "tailscale-funnel",
      "cloudflare-quick-tunnel",
    ]);
    expect(connectors.every((connector) => connector.approvalAvailable === false
      && connector.approvalEnabled === false
      && connector.attested === false)).toBe(true);
    expect(connectors.some(({ connectorId }) => connectorId.includes("fake"))).toBe(false);
    expect(connectors[0].manifestSha256).toBe("9a1bb69d46389cf660bcc8c2e0b0e8f1da3f9f19a8098c23cefd41f2c6853600");
    expect(connectors[1].manifestSha256).toBe("fd2fc94da87838bbe25e51a04bd31c1aca09d03e6445d3c41eb0e94242597ba2");
  });

  it("fails closed on fake product entries, duplicate connectorId, and approval without attestation", () => {
    const manifest = {
      connectorId: "fixture-connector",
      connectorRevision: "test-1",
      providerId: "fixture-provider",
      providerDisplayName: "Fixture Provider",
      productName: "Fixture Tunnel",
      transport: "https-tunnel",
      availability: "research-only-disabled",
      approvalEnabled: false,
      attested: false,
      executionOwner: "native-typed-connector",
      authMode: "provider-owned-browser",
      stableHttpsName: true,
      supportedPublicPorts: [443],
      allowedPlanOperations: ["inspect-status"],
      limitations: ["Test fixture"],
      sourceUrls: ["https://example.test/fixture"],
    };
    const registry = { schema: "editkin.remote-provider-connector-registry/v1", registryRevision: "2026-09-05.1", connectors: [manifest] };
    expect(() => parseRemoteProviderConnectorRegistry({ ...registry, connectors: [{ ...manifest, connectorId: "fake-connector" }] })).toThrow(/fake/i);
    expect(() => parseRemoteProviderConnectorRegistry({ ...registry, connectors: [manifest, manifest] })).toThrow(/connectorId.*唯一/i);
    expect(() => parseRemoteProviderConnectorRegistry({
      ...registry,
      connectors: [manifest, { ...manifest, connectorRevision: "test-2" }],
    })).toThrow(/connectorId.*唯一/i);
    expect(() => parseRemoteProviderConnectorRegistry({ ...registry, connectors: [{ ...manifest, approvalEnabled: true }] })).toThrow(/enabled.*attested/i);
  });

  it("returns deeply immutable, independently cloned connector snapshots", () => {
    const firstList = listRemoteProviderConnectors();
    const connectorId = firstList[0].connectorId;
    const expectedProductName = firstList[0].productName;
    const expectedLimitations = [...firstList[0].limitations];

    expect(Object.isFrozen(firstList)).toBe(true);
    expect(Object.isFrozen(firstList[0])).toBe(true);
    expect(Object.isFrozen(firstList[0].limitations)).toBe(true);
    expect(() => (firstList as unknown as RemoteProviderConnectorManifestForMutation[]).pop()).toThrow(TypeError);
    expect(() => {
      (firstList[0] as RemoteProviderConnectorManifestForMutation).productName = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      (firstList[0].limitations as string[]).push("mutated");
    }).toThrow(TypeError);

    const secondList = listRemoteProviderConnectors();
    const resolved = resolveRemoteProviderConnector(connectorId);
    expect(secondList).not.toBe(firstList);
    expect(secondList[0]).not.toBe(firstList[0]);
    expect(secondList[0].productName).toBe(expectedProductName);
    expect(secondList[0].limitations).toEqual(expectedLimitations);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.sourceUrls)).toBe(true);
  });

  it("binds an exact plan to connector manifest, provider, permissions, and mutations", () => {
    const connector = listRemoteProviderConnectors()[0];
    const plan = {
      connector: connectorBinding(connector),
      provider: { id: connector.providerId, productName: connector.productName, region: "Taiwan" },
      transport: "https-tunnel" as const,
      expectedEndpoint: { transport: "https-tunnel" as const, publicOriginRequired: true as const, description: "Public HTTPS origin" },
      permissions: ["Create one funnel"],
      plannedMutations: ["Create one public route"],
      cancellationOrDeletionConsequences: "The route becomes unreachable",
    };
    const digest = providerActionPlanDigest(plan);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(providerActionPlanDigest({ ...plan, plannedMutations: ["Create two public routes"] })).not.toBe(digest);
    expect(providerActionPlanDigest({ ...plan, connector: { ...plan.connector, manifestSha256: "0".repeat(64) } })).not.toBe(digest);
  });
});

type RemoteProviderConnectorManifestForMutation = {
  productName: string;
};
