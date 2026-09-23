import { createHash } from "node:crypto";
import * as z from "zod/v4";
import registryDocument from "../shared/remoteProviderConnectorRegistry.json";

export const REMOTE_PROVIDER_CONNECTOR_REGISTRY_SCHEMA = "editkin.remote-provider-connector-registry/v1" as const;
export const REMOTE_PROVIDER_ACTION_PLAN_SCHEMA = "editkin.remote-provider-action-plan/v1" as const;

const connectorIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const connectorRevisionSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,63}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const httpsSourceSchema = z.string().url().max(2_048).refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
}, "connector source 必須是無帳密、query 或 fragment 的 HTTPS URL");

const rawConnectorManifestSchema = z.object({
  connectorId: connectorIdSchema,
  connectorRevision: connectorRevisionSchema,
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
  providerDisplayName: z.string().trim().min(1).max(80),
  productName: z.string().trim().min(1).max(120),
  transport: z.literal("https-tunnel"),
  availability: z.enum(["enabled", "research-only-disabled", "unsupported-temporary"]),
  approvalEnabled: z.boolean(),
  attested: z.boolean(),
  executionOwner: z.literal("native-typed-connector"),
  authMode: z.enum(["provider-owned-browser", "none"]),
  stableHttpsName: z.boolean(),
  supportedPublicPorts: z.array(z.number().int().min(1).max(65_535)).max(8)
    .refine((ports) => new Set(ports).size === ports.length, "public ports 不可重複"),
  allowedPlanOperations: z.array(z.enum([
    "inspect-status",
    "request-provider-owned-login",
    "create-or-resume-single-funnel",
    "cancel-single-funnel",
    "reconcile-single-funnel",
  ])).min(1).max(8).refine((operations) => new Set(operations).size === operations.length, "plan operations 不可重複"),
  limitations: z.array(z.string().trim().min(1).max(240)).min(1).max(16),
  sourceUrls: z.array(httpsSourceSchema).min(1).max(8)
    .refine((urls) => new Set(urls).size === urls.length, "connector source URL 不可重複"),
}).strict().superRefine((manifest, context) => {
  const approvalAvailable = manifest.availability === "enabled" && manifest.approvalEnabled && manifest.attested;
  if (manifest.approvalEnabled !== approvalAvailable) {
    context.addIssue({
      code: "custom",
      path: ["approvalEnabled"],
      message: "只有 enabled 且 attested 的 connector 才可開放 approval",
    });
  }
  if (manifest.authMode === "none" && manifest.allowedPlanOperations.includes("request-provider-owned-login")) {
    context.addIssue({ code: "custom", path: ["allowedPlanOperations"], message: "無登入 connector 不可宣告 provider-owned login" });
  }
});

const rawRegistrySchema = z.object({
  schema: z.literal(REMOTE_PROVIDER_CONNECTOR_REGISTRY_SCHEMA),
  registryRevision: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
  connectors: z.array(rawConnectorManifestSchema).min(1).max(16),
}).strict().superRefine((registry, context) => {
  const connectorIds = registry.connectors.map(({ connectorId }) => connectorId);
  if (new Set(connectorIds).size !== connectorIds.length) {
    context.addIssue({ code: "custom", path: ["connectors"], message: "connectorId 必須在 registry 內全域唯一" });
  }
  if (registry.connectors.some((connector) => connector.connectorId.includes("fake"))) {
    context.addIssue({ code: "custom", path: ["connectors"], message: "產品 registry 不可包含 fake connector" });
  }
});

export type RawRemoteProviderConnectorManifest = z.infer<typeof rawConnectorManifestSchema>;
export type RemoteProviderConnectorAvailability = RawRemoteProviderConnectorManifest["availability"];

export interface RemoteProviderConnectorManifest extends RawRemoteProviderConnectorManifest {
  registryRevision: string;
  manifestSha256: string;
  approvalAvailable: boolean;
}

export interface RemoteProviderConnectorBinding {
  connectorId: string;
  connectorRevision: string;
  manifestSha256: string;
  availability: RemoteProviderConnectorAvailability;
  attested: boolean;
  approvalEnabled: boolean;
  executionOwner: "native-typed-connector";
}

export interface ProviderActionPlanIdentity {
  connector: RemoteProviderConnectorBinding;
  provider: { id: string; productName: string; region: string };
  transport: "https-tunnel";
  expectedEndpoint: { transport: "https-tunnel"; publicOriginRequired: true; description: string };
  permissions: readonly string[];
  plannedMutations: readonly string[];
  cancellationOrDeletionConsequences: string;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function connectorManifestDigest(
  registryRevision: string,
  manifest: RawRemoteProviderConnectorManifest,
): string {
  return sha256Json([
    REMOTE_PROVIDER_CONNECTOR_REGISTRY_SCHEMA,
    registryRevision,
    manifest.connectorId,
    manifest.connectorRevision,
    manifest.providerId,
    manifest.providerDisplayName,
    manifest.productName,
    manifest.transport,
    manifest.availability,
    manifest.approvalEnabled,
    manifest.attested,
    manifest.executionOwner,
    manifest.authMode,
    manifest.stableHttpsName,
    manifest.supportedPublicPorts,
    manifest.allowedPlanOperations,
    manifest.limitations,
    manifest.sourceUrls,
  ]);
}

function freezeConnector(connector: RemoteProviderConnectorManifest): RemoteProviderConnectorManifest {
  Object.freeze(connector.supportedPublicPorts);
  Object.freeze(connector.allowedPlanOperations);
  Object.freeze(connector.limitations);
  Object.freeze(connector.sourceUrls);
  return Object.freeze(connector);
}

export function parseRemoteProviderConnectorRegistry(value: unknown): readonly RemoteProviderConnectorManifest[] {
  const registry = rawRegistrySchema.parse(value);
  return Object.freeze(registry.connectors.map((manifest) => freezeConnector({
    ...manifest,
    supportedPublicPorts: [...manifest.supportedPublicPorts],
    allowedPlanOperations: [...manifest.allowedPlanOperations],
    limitations: [...manifest.limitations],
    sourceUrls: [...manifest.sourceUrls],
    registryRevision: registry.registryRevision,
    manifestSha256: connectorManifestDigest(registry.registryRevision, manifest),
    approvalAvailable: manifest.availability === "enabled" && manifest.approvalEnabled === true && manifest.attested === true,
  })));
}

const PRODUCT_CONNECTORS = parseRemoteProviderConnectorRegistry(registryDocument);

function cloneConnector(connector: RemoteProviderConnectorManifest): RemoteProviderConnectorManifest {
  return freezeConnector({
    ...connector,
    supportedPublicPorts: [...connector.supportedPublicPorts],
    allowedPlanOperations: [...connector.allowedPlanOperations],
    limitations: [...connector.limitations],
    sourceUrls: [...connector.sourceUrls],
  });
}

export function listRemoteProviderConnectors(): readonly RemoteProviderConnectorManifest[] {
  return Object.freeze(PRODUCT_CONNECTORS.map(cloneConnector));
}

export function resolveRemoteProviderConnector(connectorId: string): RemoteProviderConnectorManifest {
  const connector = PRODUCT_CONNECTORS.find((candidate) => candidate.connectorId === connectorId);
  if (!connector) throw new Error("Remote provider connector 不在 closed registry");
  return cloneConnector(connector);
}

export function connectorBinding(connector: RemoteProviderConnectorManifest): RemoteProviderConnectorBinding {
  return {
    connectorId: connector.connectorId,
    connectorRevision: connector.connectorRevision,
    manifestSha256: connector.manifestSha256,
    availability: connector.availability,
    attested: connector.attested,
    approvalEnabled: connector.approvalEnabled,
    executionOwner: connector.executionOwner,
  };
}

export function providerActionPlanDigest(plan: ProviderActionPlanIdentity): string {
  return sha256Json([
    REMOTE_PROVIDER_ACTION_PLAN_SCHEMA,
    [
      plan.connector.connectorId,
      plan.connector.connectorRevision,
      plan.connector.manifestSha256,
      plan.connector.availability,
      plan.connector.attested,
      plan.connector.approvalEnabled,
      plan.connector.executionOwner,
    ],
    [plan.provider.id, plan.provider.productName, plan.provider.region],
    plan.transport,
    [plan.expectedEndpoint.transport, plan.expectedEndpoint.publicOriginRequired, plan.expectedEndpoint.description],
    plan.permissions,
    plan.plannedMutations,
    plan.cancellationOrDeletionConsequences,
  ]);
}

export function connectorBindingSchema() {
  return z.object({
    connectorId: connectorIdSchema,
    connectorRevision: connectorRevisionSchema,
    manifestSha256: digestSchema,
    availability: z.enum(["enabled", "research-only-disabled", "unsupported-temporary"]),
    attested: z.boolean(),
    approvalEnabled: z.boolean(),
    executionOwner: z.literal("native-typed-connector"),
  }).strict();
}

export function assertExactConnectorBinding(binding: RemoteProviderConnectorBinding, providerId: string): RemoteProviderConnectorManifest {
  const parsed = connectorBindingSchema().parse(binding);
  const manifest = resolveRemoteProviderConnector(parsed.connectorId);
  const expected = connectorBinding(manifest);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)
      || providerId !== manifest.providerId
      || parsed.approvalEnabled !== (parsed.availability === "enabled" && parsed.attested)) {
    throw new Error("Remote proposal connector identity 與 closed registry 不一致");
  }
  return manifest;
}
