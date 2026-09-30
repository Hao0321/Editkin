import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { connectorBinding, connectorBindingSchema, assertExactConnectorBinding, providerActionPlanDigest, resolveRemoteProviderConnector } from "../remoteProviderConnectors";
import { FORBIDDEN_DISPLAY_CHARACTER_PATTERN, HEX_32_PATTERN, HEX_64_PATTERN, OBVIOUS_SECRET_MATERIAL_PATTERN, PROPOSAL_TTL_MS, PROVIDER_PROPOSAL_SCHEMA, REMOTE_AGENT_CONSENT_REVISION, UUID_V4_PATTERN } from "./constants";
import { safeEvidenceUrl } from "./network";
import { remoteAgentLineage } from "./receipts";

function safeProposalText(maxLength: number) {
  return z.string().min(1).max(maxLength)
    .refine((value) => value === value.trim(), "不得包含前後空白")
    .refine((value) => !FORBIDDEN_DISPLAY_CHARACTER_PATTERN.test(value), "不得包含控制或雙向覆寫字元")
    .refine((value) => !OBVIOUS_SECRET_MATERIAL_PATTERN.test(value), "不得包含密鑰、token、密碼或私鑰內容");
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const proposalStringListSchema = z.array(safeProposalText(160)).max(16)
  .refine(uniqueStrings, "項目不可重複");
const proposalRequiredStringListSchema = proposalStringListSchema.min(1);
const proposalProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
  displayName: safeProposalText(80),
  productName: safeProposalText(120),
  region: safeProposalText(80),
}).strict();
const proposalExpectedEndpointSchema = z.object({
  transport: z.literal("https-tunnel"),
  publicOriginRequired: z.literal(true),
  description: safeProposalText(240),
}).strict();
const proposalPricingSchema = z.object({
  kind: z.enum(["public-list-price", "estimate", "unknown"]),
  amountMicros: z.number().nonnegative().refine(Number.isSafeInteger).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  billingUnit: z.enum(["per-month", "per-gigabyte", "per-hour", "one-time", "unknown"]),
  summary: safeProposalText(240),
}).strict().superRefine((pricing, context) => {
  if (pricing.kind === "unknown") {
    if (pricing.amountMicros !== null || pricing.currency !== null || pricing.billingUnit !== "unknown") {
      context.addIssue({ code: "custom", message: "unknown pricing 不可偽造金額、幣別或計費單位" });
    }
    return;
  }
  if (pricing.amountMicros === null || pricing.currency === null || pricing.billingUnit === "unknown") {
    context.addIssue({ code: "custom", message: "已知或估算價格必須包含金額、幣別與計費單位" });
  }
});
const proposalSourceSchema = z.object({
  label: safeProposalText(120),
  url: z.string().max(2_048).refine(safeEvidenceUrl, "來源必須是無帳密、query 或 fragment 的 HTTPS URL"),
  checkedAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
}).strict();
const proposalInputSourceSchema = proposalSourceSchema.omit({ checkedAtMs: true });
const proposalSourcesSchema = z.array(proposalSourceSchema).min(1).max(8)
  .refine((sources) => new Set(sources.map(({ url }) => url)).size === sources.length, "來源 URL 不可重複");
const proposalInputSourcesSchema = z.array(proposalInputSourceSchema).min(1).max(8)
  .refine((sources) => new Set(sources.map(({ url }) => url)).size === sources.length, "來源 URL 不可重複");

export const prepareRemoteSetupInputSchema = z.object({
  connectorId: z.string().min(1).max(63).refine((value) => {
    try { resolveRemoteProviderConnector(value); return true; }
    catch { return false; }
  }, "connector 不在 Editkin closed registry"),
  transport: z.literal("https-tunnel"),
  provider: proposalProviderSchema,
  expectedEndpoint: proposalExpectedEndpointSchema,
  pricing: proposalPricingSchema,
  freeTier: safeProposalText(240),
  quota: safeProposalText(240),
  permissions: proposalRequiredStringListSchema,
  plannedMutations: proposalRequiredStringListSchema,
  cancellationOrDeletionConsequences: safeProposalText(320),
  sources: proposalInputSourcesSchema,
  uncertainties: proposalStringListSchema,
  unsupportedPrerequisites: proposalStringListSchema,
  expectedExpiredProposalRevision: z.string().regex(UUID_V4_PATTERN).optional(),
}).strict().superRefine((proposal, context) => {
  if (proposal.pricing.kind === "unknown" && proposal.uncertainties.length === 0) {
    context.addIssue({ code: "custom", path: ["uncertainties"], message: "未知價格必須明列至少一項不確定性" });
  }
});

export const remoteProviderProposalSchema = z.object({
  schema: z.literal(PROVIDER_PROPOSAL_SCHEMA),
  phase: z.literal("EXACT_PROVIDER_PROPOSAL"),
  truthLabel: z.literal("PROPOSAL_READY_NOT_APPROVED"),
  workflowId: z.string().regex(HEX_32_PATTERN),
  jobId: z.string().regex(HEX_32_PATTERN),
  consentRevision: z.literal(REMOTE_AGENT_CONSENT_REVISION),
  proposalRevision: z.string().regex(UUID_V4_PATTERN),
  proposalDigest: z.string().regex(HEX_64_PATTERN),
  connector: connectorBindingSchema(),
  planDigest: z.string().regex(HEX_64_PATTERN),
  transport: z.literal("https-tunnel"),
  provider: proposalProviderSchema,
  expectedEndpoint: proposalExpectedEndpointSchema,
  pricing: proposalPricingSchema,
  freeTier: safeProposalText(240),
  quota: safeProposalText(240),
  permissions: proposalRequiredStringListSchema,
  plannedMutations: proposalRequiredStringListSchema,
  cancellationOrDeletionConsequences: safeProposalText(320),
  sources: proposalSourcesSchema,
  uncertainties: proposalStringListSchema,
  unsupportedPrerequisites: proposalStringListSchema,
  costResponsibility: z.literal("end-user"),
  externalMutationPerformed: z.literal(false),
  autoDeploy: z.literal(false),
  approvalAvailable: z.boolean(),
  createdAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
  updatedAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
  expiresAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
}).strict().superRefine((proposal, context) => {
  if (proposal.pricing.kind === "unknown" && proposal.uncertainties.length === 0) {
    context.addIssue({ code: "custom", path: ["uncertainties"], message: "未知價格必須明列至少一項不確定性" });
  }
});

export type PrepareRemoteSetupInput = z.infer<typeof prepareRemoteSetupInputSchema>;
export type RemoteProviderProposal = z.infer<typeof remoteProviderProposalSchema>;

function providerProposalDigest(proposal: Omit<RemoteProviderProposal, "proposalDigest"> | RemoteProviderProposal): string {
  return createHash("sha256").update(JSON.stringify([
    proposal.schema,
    proposal.phase,
    proposal.truthLabel,
    proposal.workflowId,
    proposal.jobId,
    proposal.consentRevision,
    proposal.proposalRevision,
    [
      proposal.connector.connectorId,
      proposal.connector.connectorRevision,
      proposal.connector.manifestSha256,
      proposal.connector.availability,
      proposal.connector.attested,
      proposal.connector.approvalEnabled,
      proposal.connector.executionOwner,
    ],
    proposal.planDigest,
    proposal.transport,
    [proposal.provider.id, proposal.provider.displayName, proposal.provider.productName, proposal.provider.region],
    [proposal.expectedEndpoint.transport, proposal.expectedEndpoint.publicOriginRequired, proposal.expectedEndpoint.description],
    [proposal.pricing.kind, proposal.pricing.amountMicros, proposal.pricing.currency, proposal.pricing.billingUnit, proposal.pricing.summary],
    proposal.freeTier,
    proposal.quota,
    proposal.permissions,
    proposal.plannedMutations,
    proposal.cancellationOrDeletionConsequences,
    proposal.sources.map((source) => [source.label, source.url, source.checkedAtMs]),
    proposal.uncertainties,
    proposal.unsupportedPrerequisites,
    proposal.costResponsibility,
    proposal.externalMutationPerformed,
    proposal.autoDeploy,
    proposal.approvalAvailable,
    proposal.createdAtMs,
    proposal.updatedAtMs,
    proposal.expiresAtMs,
  ])).digest("hex");
}

export function parseProviderProposal(value: unknown): RemoteProviderProposal {
  const proposal = remoteProviderProposalSchema.parse(value);
  const connector = assertExactConnectorBinding(proposal.connector, proposal.provider.id);
  const expectedPlanDigest = providerActionPlanDigest({
    connector: proposal.connector,
    provider: {
      id: proposal.provider.id,
      productName: proposal.provider.productName,
      region: proposal.provider.region,
    },
    transport: proposal.transport,
    expectedEndpoint: proposal.expectedEndpoint,
    permissions: proposal.permissions,
    plannedMutations: proposal.plannedMutations,
    cancellationOrDeletionConsequences: proposal.cancellationOrDeletionConsequences,
  });
  if (proposal.updatedAtMs !== proposal.createdAtMs
    || proposal.expiresAtMs - proposal.createdAtMs !== PROPOSAL_TTL_MS
    || proposal.createdAtMs > Date.now() + 60_000
    || proposal.sources.some(({ checkedAtMs }) => checkedAtMs !== proposal.createdAtMs)
    || proposal.provider.displayName !== connector.providerDisplayName
    || proposal.provider.productName !== connector.productName
    || proposal.planDigest !== expectedPlanDigest
    || proposal.approvalAvailable !== connector.approvalAvailable
    || providerProposalDigest(proposal) !== proposal.proposalDigest) {
    throw new Error("Remote provider proposal identity、timestamp 或 digest 驗證失敗");
  }
  return proposal;
}

export function proposalExpired(proposal: RemoteProviderProposal): boolean {
  return proposal.expiresAtMs <= Date.now();
}

export function createProviderProposal(
  input: PrepareRemoteSetupInput,
  lineage: ReturnType<typeof remoteAgentLineage>,
  workflowId = randomUUID().replaceAll("-", ""),
): RemoteProviderProposal {
  const createdAtMs = Date.now();
  const { connectorId, expectedExpiredProposalRevision: _expectedExpiredProposalRevision, sources, ...researched } = input;
  const connector = resolveRemoteProviderConnector(connectorId);
  if (researched.provider.id !== connector.providerId
      || researched.provider.displayName !== connector.providerDisplayName
      || researched.provider.productName !== connector.productName
      || researched.transport !== connector.transport) {
    throw new Error("AI 研究的 provider identity 與 selected closed connector 不一致");
  }
  const binding = connectorBinding(connector);
  const planDigest = providerActionPlanDigest({
    connector: binding,
    provider: {
      id: researched.provider.id,
      productName: researched.provider.productName,
      region: researched.provider.region,
    },
    transport: researched.transport,
    expectedEndpoint: researched.expectedEndpoint,
    permissions: researched.permissions,
    plannedMutations: researched.plannedMutations,
    cancellationOrDeletionConsequences: researched.cancellationOrDeletionConsequences,
  });
  const unsigned: Omit<RemoteProviderProposal, "proposalDigest"> = {
    schema: PROVIDER_PROPOSAL_SCHEMA,
    phase: "EXACT_PROVIDER_PROPOSAL",
    truthLabel: "PROPOSAL_READY_NOT_APPROVED",
    workflowId,
    jobId: lineage.jobId,
    consentRevision: lineage.consentRevision,
    proposalRevision: randomUUID(),
    connector: binding,
    planDigest,
    ...researched,
    sources: sources.map((source) => ({ ...source, checkedAtMs: createdAtMs })),
    costResponsibility: "end-user",
    externalMutationPerformed: false,
    autoDeploy: false,
    approvalAvailable: connector.approvalAvailable,
    createdAtMs,
    updatedAtMs: createdAtMs,
    expiresAtMs: createdAtMs + PROPOSAL_TTL_MS,
  };
  return { ...unsigned, proposalDigest: providerProposalDigest(unsigned) };
}

export function preparedProposalResult(proposal: RemoteProviderProposal, created: boolean) {
  return {
    schema: PROVIDER_PROPOSAL_SCHEMA,
    status: "PROPOSAL_READY_NOT_APPROVED" as const,
    created,
    resumed: !created,
    proposal,
    externalMutationPerformed: false as const,
    autoDeploy: false as const,
    approvalAvailable: proposal.approvalAvailable,
    nextAction: "請回 Editkin 檢視完整價格、配額、權限與預計變更；這一步沒有登入、部署、付款或建立公開路由" as const,
  };
}

export function assertCompatibleProposalConsent(
  proposal: RemoteProviderProposal,
  lineage: ReturnType<typeof remoteAgentLineage>,
): void {
  if (proposal.consentRevision !== lineage.consentRevision) {
    throw new Error("既有 Remote proposal 屬於不同 consent revision；拒絕跨 consent 續接或覆寫");
  }
}
