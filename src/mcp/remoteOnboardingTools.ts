import type { McpServer } from "@modelcontextprotocol/server";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import {
  assertExactConnectorBinding,
  connectorBinding,
  connectorBindingSchema,
  listRemoteProviderConnectors,
  providerActionPlanDigest,
  resolveRemoteProviderConnector,
} from "./remoteProviderConnectors";
import { errorResult } from "./toolRuntime";

const REMOTE_SCHEMA = "editkin.remote-user-config/v1";
const LEGACY_PENDING_SCHEMA = "editkin.remote-setup-confirmation/v1";
const LEGACY_PROVIDER_PROPOSAL_SCHEMA = "editkin.remote-provider-proposal/v1";
const PROVIDER_PROPOSAL_SCHEMA = "editkin.remote-provider-proposal/v2";
const CANDIDATE_SCHEMA = "editkin.remote-config-candidate/v1";
const RUNTIME_SCHEMA = "editkin.remote-runtime/v3";
const VERIFICATION_SCHEMA = "editkin.remote-route-verification/v3";
const REMOTE_AGENT_CONSENT_REVISION = "editkin.remote-agent-consent/v2";
const LEGACY_REMOTE_AGENT_CONSENT_REVISION = "editkin.remote-agent-consent/v1";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const PROPOSAL_TTL_MS = 30 * 60_000;
const RELAY_PROBE_ROOM = "00000000000000000000000000000000";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32_PATTERN = /^[a-f0-9]{32}$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_DISPLAY_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const OBVIOUS_SECRET_MATERIAL_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*:\s*bearer|(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|secret)\s*[:=]/i;
const SECRET_BEARING_URL_HINT_PATTERN = /(?:^|[\/._-])(?:token|secret|password|credential|api[-_]?key|access[-_]?key)(?:[\/._-]|$)/i;

export type RemoteTransport = "https-tunnel" | "cloud-relay";

interface RemoteSetupPaths {
  root: string;
  config: string;
  candidate: string;
  pending: string;
  pendingRenewing: string;
  verification: string;
  runtime: string;
}

interface LegacyPendingRemoteSetup {
  schema: typeof LEGACY_PENDING_SCHEMA;
  confirmationId: string;
  transport: RemoteTransport;
  providerId: string;
  costResponsibility: "end-user";
  autoDeploy: false;
  preparedAt: string;
  remoteAgentJobId?: string;
  remoteAgentConsentRevision?: string;
}

function safeProposalText(maxLength: number) {
  return z.string().min(1).max(maxLength)
    .refine((value) => value === value.trim(), "不得包含前後空白")
    .refine((value) => !FORBIDDEN_DISPLAY_CHARACTER_PATTERN.test(value), "不得包含控制或雙向覆寫字元")
    .refine((value) => !OBVIOUS_SECRET_MATERIAL_PATTERN.test(value), "不得包含密鑰、token、密碼或私鑰內容");
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function safeEvidenceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname);
    assertPublicHostname(parsed.hostname);
    const literalAddress = parsed.hostname.replace(/^\[|\]$/g, "");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && parsed.hostname.length > 0
      && !SECRET_BEARING_URL_HINT_PATTERN.test(decodedPath)
      && !(isIP(literalAddress) && reservedLiteralEvidenceAddress(literalAddress));
  } catch { return false; }
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

const prepareRemoteSetupInputSchema = z.object({
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

const remoteProviderProposalSchema = z.object({
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
type RemoteProviderProposal = z.infer<typeof remoteProviderProposalSchema>;

interface UserRemoteConfig {
  schema: typeof REMOTE_SCHEMA;
  schemaVersion: 1;
  mode: "user-owned-byo";
  transport: RemoteTransport;
  origin: string;
  providerId: string;
  costResponsibility: "end-user";
  userConfirmedCostsAndPermissions: true;
  configuredAt: string;
  configurationId: string;
}

interface PendingRemoteConfigCandidate {
  schema: typeof CANDIDATE_SCHEMA;
  candidateRevision: string;
  expectedConfigurationId: string | null;
  preparedAtMs: number;
  expiresAtMs: number;
  configuration: UserRemoteConfig;
}

interface RemoteRouteVerification {
  schema: typeof VERIFICATION_SCHEMA;
  configurationId: string;
  status: "PARTIAL";
  verified: false;
  verifiedAt: string;
  verifiedAtMs: number;
  probeId: string;
  runtimeInstanceId: string;
  processId: number;
  startedAtMs: number;
  endpointKind: "editkin-tunnel";
  successfulTlsConnections: 2;
  latencyMs: [number, number];
  latencyP50Ms: number;
  jitterMs: number;
  routeEvidence: "two-pinned-independent-tls-connections-succeeded";
  reconnectVerified: false;
  requiresActiveMobileProof: true;
}

interface RemoteRuntimeIdentity {
  schema: typeof RUNTIME_SCHEMA;
  transport: RemoteTransport;
  configurationId: string;
  probeId: string;
  runtimeInstanceId: string;
  processId: number;
  startedAtMs: number;
}

export interface ConfigureRemoteAccessInput {
  confirmationId: string;
  origin: string;
  userConfirmedDeployment: true;
  userConfirmedProviderCosts: true;
  userConfirmedProviderPermissions: true;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type LookupLike = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
interface RemoteJsonReadHooks {
  afterHandleOpened?: (path: string) => Promise<void>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} 含有未允許欄位；密鑰與供應商憑證不得傳給 Editkin MCP`);
  }
}

export function remoteSetupPaths(environment: NodeJS.ProcessEnv = process.env): RemoteSetupPaths {
  const rawStateRoot = environment.EDITKIN_AGENT_STATE_ROOT?.trim();
  if (!rawStateRoot || !isAbsolute(rawStateRoot)) throw new Error("Editkin MCP 缺少受信任的 Agent state root");
  const stateRoot = resolve(rawStateRoot);
  if (basename(stateRoot).toLocaleLowerCase() !== "agent-runtime-v3") {
    throw new Error("Editkin MCP Agent state root 不是目前支援的 generation");
  }
  const root = join(dirname(stateRoot), "mobile-remote");
  return {
    root,
    config: join(root, "network-config.json"),
    candidate: join(root, "network-config-candidate.json"),
    pending: join(root, "network-setup-pending.json"),
    pendingRenewing: join(root, "network-setup-pending.json.renewing"),
    verification: join(root, "network-verification.json"),
    runtime: join(root, "network-runtime.json"),
  };
}

async function readBoundedUtf8(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_JSON_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_JSON_BYTES) throw new Error("Remote 設定檔讀取超過大小上限");
  return buffer.subarray(0, offset).toString("utf8");
}

async function readJson(path: string, hooks: RemoteJsonReadHooks = {}): Promise<unknown | undefined> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_JSON_BYTES) {
    throw new Error("Remote 設定檔必須是小型本機一般檔案；symlink/reparse 路徑已拒絕");
  }
  const handle = await open(path, "r");
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.size > MAX_JSON_BYTES
      || openedBefore.dev !== metadata.dev || openedBefore.ino !== metadata.ino
      || openedBefore.size !== metadata.size) {
      throw new Error("Remote 設定檔在讀取時被替換；已 fail closed");
    }
    await hooks.afterHandleOpened?.(path);
    const text = await readBoundedUtf8(handle);
    const openedAfter = await handle.stat();
    // The current path is only an identity witness for the already-open handle.
    // Any lookup failure (including Windows delete-pending EPERM) makes that
    // witness unverifiable, so fail closed through the common integrity check.
    const current = await lstat(path).catch(() => undefined);
    if (!openedAfter.isFile() || openedAfter.size > MAX_JSON_BYTES
      || openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino
      || openedAfter.size !== openedBefore.size || openedAfter.mtimeMs !== openedBefore.mtimeMs
      || openedAfter.ctimeMs !== openedBefore.ctimeMs || Buffer.byteLength(text, "utf8") !== openedAfter.size
      || !current || current.isSymbolicLink() || !current.isFile()
      || current.dev !== openedAfter.dev || current.ino !== openedAfter.ino || current.size !== openedAfter.size
      || current.mtimeMs !== openedAfter.mtimeMs || current.ctimeMs !== openedAfter.ctimeMs) {
      throw new Error("Remote 設定檔在 bounded read 期間成長、替換或改變；已 fail closed");
    }
    return JSON.parse(text);
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Remote 設定目錄不可是 symlink/reparse 路徑");
  }
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (previous?.isSymbolicLink() || (previous && !previous.isFile())) {
    throw new Error("Remote 設定目的地不可是 symlink/reparse 路徑");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current?.isSymbolicLink() || (current && !current.isFile())
      || Boolean(previous) !== Boolean(current)
      || (previous && current && (previous.dev !== current.dev || previous.ino !== current.ino))) {
      throw new Error("Remote 設定目的地 revision 在寫入期間改變；已拒絕覆蓋");
    }
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeJsonCreateNew(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Remote 設定目錄不可是 symlink/reparse 路徑");
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    throw new Error("Remote provider proposal 超過允許的本機 receipt 大小");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const temporaryMetadata = await handle.stat();
    if (!temporaryMetadata.isFile() || temporaryMetadata.size !== Buffer.byteLength(serialized, "utf8")) {
      throw new Error("Remote provider proposal temp receipt 未完整寫入");
    }
    temporaryIdentity = { dev: temporaryMetadata.dev, ino: temporaryMetadata.ino };
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Remote provider proposal 已存在；atomic no-replace publish 拒絕覆寫");
      }
      throw error;
    }
    const finalMetadata = await lstat(path);
    if (finalMetadata.isSymbolicLink() || !finalMetadata.isFile()
      || finalMetadata.dev !== temporaryMetadata.dev || finalMetadata.ino !== temporaryMetadata.ino
      || finalMetadata.size !== temporaryMetadata.size) {
      throw new Error("Remote provider proposal publish identity 驗證失敗");
    }
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (published && temporaryIdentity) {
      const current = await lstat(path).catch(() => undefined);
      if (current && !current.isSymbolicLink() && current.isFile()
        && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
        await unlink(path).catch(() => undefined);
      }
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validProviderId(providerId: string): string {
  const value = providerId.trim().toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(value)) throw new Error("providerId 必須是 2-63 字元的機器識別字");
  return value;
}

function remoteAgentLineage(environment: NodeJS.ProcessEnv): {
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

function assertPublicHostname(hostname: string): void {
  const host = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host === "metadata.google.internal" || host === "169.254.169.254") {
    throw new Error("Remote origin 不可指向本機、區域網路或雲端 metadata 端點");
  }
}

function privateAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return privateAddress(mapped);
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      return privateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    return true;
  }
  if (normalized.includes(":")) {
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9")
      || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function reservedLiteralEvidenceAddress(address: string): boolean {
  if (privateAddress(address)) return true;
  const normalized = address.toLocaleLowerCase();
  if (normalized.includes(":")) {
    return normalized.startsWith("2001:db8:") || normalized === "2001:db8::";
  }
  const [a, b, c] = normalized.split(".").map(Number);
  return (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function validateRemoteOrigin(input: string): string {
  if (input.length > 2_048 || input !== input.trim() || input.includes("\\") || /\s/.test(input)) {
    throw new Error("Remote origin 必須是單純、無空白的 HTTPS origin");
  }
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new Error("Remote origin 不是有效 URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Remote origin 只能包含 HTTPS scheme、公開 hostname 與選用 port；不得含路徑、帳密、query 或 fragment");
  }
  assertPublicHostname(parsed.hostname);
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && privateAddress(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("Remote origin 不可指向本機或私人 IP");
  }
  return parsed.origin;
}

function configurationId(config: Omit<UserRemoteConfig, "configurationId">): string {
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

function parseLegacyPending(value: unknown, requireFresh = true): LegacyPendingRemoteSetup {
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

function parseProviderProposal(value: unknown): RemoteProviderProposal {
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

function proposalExpired(proposal: RemoteProviderProposal): boolean {
  return proposal.expiresAtMs <= Date.now();
}

type PendingRenewalRecovery =
  | { kind: "none" | "recovered" }
  | { kind: "blocked"; reason: "INVALID_RENEWING_ARTIFACT" | "CONFLICTING_PENDING_AND_RENEWING" | "RENEWING_PROPOSAL_NOT_EXPIRED" | "RECOVERY_PUBLICATION_FAILED" };

async function optionalMetadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function recoverPendingRenewal(paths: RemoteSetupPaths): Promise<PendingRenewalRecovery> {
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

function renewalReconciliationStatus(recovery: Extract<PendingRenewalRecovery, { kind: "blocked" }>) {
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

function stateReconciliationStatus(present: Array<"config" | "candidate" | "pending">, reason: string) {
  return {
    schema: "editkin.remote-setup-status/v1",
    status: "STATE_RECONCILIATION_REQUIRED" as const,
    transport: "unknown" as const,
    configured: false,
    resumeAvailable: false,
    conflict: {
      present,
      reason,
      automaticMutationPerformed: false as const,
    },
    policy: { mode: "user-owned-byo" as const, autoDeploy: false as const, costResponsibility: "end-user" as const, providerRequired: false as const },
    nextAction: "偵測到互斥或 lineage 不一致的 Remote state receipts；未隱藏、未提升、未重播，請在 Editkin 進行人工 reconciliation" as const,
  };
}

function parseConfig(value: unknown): UserRemoteConfig {
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

function parseCandidate(value: unknown): PendingRemoteConfigCandidate {
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

function validVerification(
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

function activeRuntime(value: unknown, config: UserRemoteConfig): RemoteRuntimeIdentity | undefined {
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

function sameRuntimeInstance(left: RemoteRuntimeIdentity, right: RemoteRuntimeIdentity): boolean {
  return left.schema === right.schema && left.transport === right.transport
    && left.configurationId === right.configurationId && left.probeId === right.probeId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.processId === right.processId
    && left.startedAtMs === right.startedAtMs;
}

export async function getRemoteSetupStatus(
  environment: NodeJS.ProcessEnv = process.env,
  readHooks: RemoteJsonReadHooks = {},
) {
  const paths = remoteSetupPaths(environment);
  const recovery = await recoverPendingRenewal(paths);
  if (recovery.kind === "blocked") return renewalReconciliationStatus(recovery);
  const [rawConfig, rawCandidate, rawPending] = await Promise.all([
    readJson(paths.config, readHooks),
    readJson(paths.candidate, readHooks),
    readJson(paths.pending, readHooks),
  ]);
  const hasConfig = rawConfig !== undefined;
  const hasCandidate = rawCandidate !== undefined;
  const hasPending = rawPending !== undefined;
  const present: Array<"config" | "candidate" | "pending"> = [];
  if (hasConfig) present.push("config");
  if (hasCandidate) present.push("candidate");
  if (hasPending) present.push("pending");
  if (hasPending && (hasConfig || hasCandidate)) {
    return stateReconciliationStatus(present, "pending proposal/confirmation 不可與 config 或 candidate 共存");
  }
  const config = hasConfig ? parseConfig(rawConfig) : undefined;
  if (hasCandidate) {
    const candidate = parseCandidate(rawCandidate);
    if ((config && candidate.expectedConfigurationId !== config.configurationId)
      || (!config && candidate.expectedConfigurationId !== null)) {
      return stateReconciliationStatus(present, "candidate expectedConfigurationId 與目前 config identity 不一致");
    }
    return {
      schema: "editkin.remote-setup-status/v1",
      status: "AWAITING_DESKTOP_APPROVAL" as const,
      transport: candidate.configuration.transport,
      configured: Boolean(config),
      pendingDesktopApproval: {
        candidateRevision: candidate.candidateRevision,
        originHost: new URL(candidate.configuration.origin).host,
        providerId: candidate.configuration.providerId,
        expiresAtMs: candidate.expiresAtMs,
      },
      ...(config ? {
        configuration: {
          originHost: new URL(config.origin).host,
          providerId: config.providerId,
          configurationId: config.configurationId,
          configuredAt: config.configuredAt,
        },
      } : {}),
      policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
      nextAction: config
        ? "目前正式設定仍維持原狀；請回 Editkin 核對候選 revision 後再決定是否提升" as const
        : "請使用者回到 Editkin，親自按下啟動按鈕完成一次性桌面核准" as const,
    };
  }
  if (!config && hasPending) {
    if (isRecord(rawPending) && rawPending.schema === LEGACY_PROVIDER_PROPOSAL_SCHEMA) {
      return {
        schema: "editkin.remote-setup-status/v1",
        status: "LEGACY_PROVIDER_PROPOSAL_BLOCKED" as const,
        transport: "https-tunnel" as const,
        configured: false,
        resumeAvailable: false,
        policy: { mode: "user-owned-byo" as const, autoDeploy: false as const, costResponsibility: "end-user" as const, providerRequired: false as const },
        nextAction: "偵測到 proposal v1；它沒有 connector identity 與 plan digest，不能核准、續接或自動覆寫，必須由桌面安全遷移或捨棄" as const,
      };
    }
    if (isRecord(rawPending) && rawPending.schema === PROVIDER_PROPOSAL_SCHEMA) {
      const proposal = parseProviderProposal(rawPending);
      if (proposalExpired(proposal)) {
        return {
          schema: "editkin.remote-setup-status/v1",
          status: "PROPOSAL_EXPIRED" as const,
          transport: proposal.transport,
          configured: false,
          proposal,
          resumeAvailable: false,
          renewal: { expectedExpiredProposalRevision: proposal.proposalRevision },
          policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
          nextAction: "此提案已過期且從未核准或部署；重新研究後須帶入 exact expired proposal revision 才能更新" as const,
        };
      }
      return {
        schema: "editkin.remote-setup-status/v1",
        status: "PROPOSAL_READY_NOT_APPROVED" as const,
        transport: proposal.transport,
        configured: false,
        proposal,
        resumeAvailable: true,
        policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
        nextAction: "請回 Editkin 檢視價格、配額、權限與預計變更；目前尚未核准、登入供應商或部署" as const,
      };
    }
    const pending = parseLegacyPending(rawPending, false);
    const expiresAtMs = Date.parse(pending.preparedAt) + PROPOSAL_TTL_MS;
    const expired = expiresAtMs <= Date.now();
    return {
      schema: "editkin.remote-setup-status/v1",
      status: expired ? "LEGACY_PENDING_EXPIRED" as const : "LEGACY_PENDING_INCOMPLETE" as const,
      transport: pending.transport,
      configured: false,
      pendingProviderConfirmation: {
        schema: pending.schema,
        confirmationId: pending.confirmationId,
        providerId: pending.providerId,
        preparedAt: pending.preparedAt,
        expiresAtMs,
        costResponsibility: pending.costResponsibility,
      },
      resumeAvailable: !expired,
      policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
      nextAction: expired
        ? "舊版確認單已過期；它沒有價格、配額、權限與 digest，不能偽裝成新版提案或自動部署" as const
        : "這是舊版確認單，只記錄供應商識別，沒有足夠資料可視為新版外部動作核准" as const,
    };
  }
  if (!config) {
    return {
      schema: "editkin.remote-setup-status/v1",
      status: "LAN_DEFAULT" as const,
      transport: "lan" as const,
      configured: false,
      policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
      nextAction: "prepare_remote_setup" as const,
    };
  }
  const verification = await readJson(paths.verification, readHooks).catch(() => undefined);
  const runtime = activeRuntime(await readJson(paths.runtime, readHooks).catch(() => undefined), config);
  const routeVerified = runtime
    ? validVerification(verification, config.configurationId, runtime)
    : false;
  return {
    schema: "editkin.remote-setup-status/v1",
    status: routeVerified ? "CONFIGURED_ROUTE_VERIFIED" as const : "CONFIGURED_UNVERIFIED" as const,
    transport: config.transport,
    configured: true,
    configuration: { originHost: new URL(config.origin).host, providerId: config.providerId, configurationId: config.configurationId, configuredAt: config.configuredAt },
    verification: routeVerified ? verification : undefined,
    policy: { mode: "user-owned-byo", autoDeploy: false, costResponsibility: "end-user", providerRequired: false },
    nextAction: routeVerified
      ? "路由與兩次獨立 TLS 連線已量測；仍須在 Editkin 以真手機確認配對與斷線重連" as const
      : "verify_remote_access" as const,
  };
}

function createProviderProposal(
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

function preparedProposalResult(proposal: RemoteProviderProposal, created: boolean) {
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

function assertCompatibleProposalConsent(
  proposal: RemoteProviderProposal,
  lineage: ReturnType<typeof remoteAgentLineage>,
): void {
  if (proposal.consentRevision !== lineage.consentRevision) {
    throw new Error("既有 Remote proposal 屬於不同 consent revision；拒絕跨 consent 續接或覆寫");
  }
}

async function renewExpiredProposalExact(
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
    const winnerValue = await readJson(paths.pending).catch(() => undefined);
    if (isRecord(winnerValue) && winnerValue.schema === PROVIDER_PROPOSAL_SCHEMA) {
      const winner = parseProviderProposal(winnerValue);
      assertCompatibleProposalConsent(winner, lineage);
      if (!proposalExpired(winner)) return preparedProposalResult(winner, false);
    }
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

async function responsePrefix(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (bytes < MAX_RESPONSE_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.includes("Editkin Remote")) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function responseHasExpectedMarker(body: string, expectedProbeId?: string): boolean {
  if (!expectedProbeId) return body.includes("Editkin Remote");
  try {
    const payload = JSON.parse(body) as { schema?: unknown; probeId?: unknown };
    return payload.schema === "editkin.remote-health/v1" && payload.probeId === expectedProbeId;
  } catch { return false; }
}

async function probeWithFetch(target: string, fetchImpl: FetchLike, expectedProbeId?: string): Promise<{ ok: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json,text/html", "cache-control": "no-cache", connection: "close" },
      signal: controller.signal,
    });
    const body = response.status === 200 ? await responsePrefix(response) : "";
    return { ok: responseHasExpectedMarker(body, expectedProbeId), latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) };
  } catch {
    return { ok: false, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) };
  } finally {
    clearTimeout(timeout);
  }
}

async function probePinnedHttps(target: string, pinnedAddress: string, expectedProbeId?: string): Promise<{ ok: boolean; latencyMs: number }> {
  const url = new URL(target);
  const started = performance.now();
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe({ ok, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) });
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: pinnedAddress,
      port: url.port ? Number.parseInt(url.port, 10) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      headers: {
        host: url.host,
        accept: "application/json,text/html",
        "cache-control": "no-cache",
        connection: "close",
      },
    }, (response) => {
      let body = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Remote probe response exceeded limit"));
          return;
        }
        body += chunk;
      });
      response.on("end", () => finish(response.statusCode === 200 && responseHasExpectedMarker(body, expectedProbeId)));
    });
    request.setTimeout(PROBE_TIMEOUT_MS, () => request.destroy(new Error("Remote probe timed out")));
    request.once("error", () => finish(false));
    request.end();
  });
}

export async function verifyRemoteAccess(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
  lookupImpl: LookupLike = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  const paths = remoteSetupPaths(environment);
  const config = parseConfig(await readJson(paths.config));
  const hostname = new URL(config.origin).hostname;
  const addresses = await lookupImpl(hostname);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error("Remote origin DNS 指向本機或私人網段；已拒絕 MCP 網路探測");
  }
  const runtime = config.transport === "https-tunnel"
    ? activeRuntime(await readJson(paths.runtime), config)
    : undefined;
  if (config.transport === "https-tunnel" && !runtime) return {
    schema: VERIFICATION_SCHEMA,
    status: "BLOCKED" as const,
    verified: false,
    reason: "找不到目前這次 Editkin Remote 的本機 challenge；請先在 Editkin 明確同意費用並重新啟動 Remote",
  };
  const target = config.transport === "cloud-relay"
    ? `${config.origin}/r/${RELAY_PROBE_ROOM}`
    : `${config.origin}/api/health`;
  const pinnedAddress = [...addresses].map(({ address }) => address).sort()[0];
  const probe = (runtimeProbeId?: string) => fetchImpl
    ? probeWithFetch(target, fetchImpl, runtimeProbeId)
    : probePinnedHttps(target, pinnedAddress, runtimeProbeId);
  const first = await probe(runtime?.probeId);
  const second = first.ok ? await probe(runtime?.probeId) : { ok: false, latencyMs: 0 };
  if (!first.ok || !second.ok) return {
    schema: VERIFICATION_SCHEMA,
    status: "BLOCKED" as const,
    verified: false,
    observed: { firstConnectionSucceeded: first.ok, secondIndependentConnectionSucceeded: second.ok, latencyMs: [first.latencyMs, second.latencyMs] },
    reason: config.transport === "https-tunnel"
      ? "未觀測到可公開存取的 Editkin Remote；請先在 Editkin 重新啟動 Remote，確認 tunnel 指向固定連接埠後再試"
      : "未觀測到相容的 Editkin HTTPS/WSS relay 頁面；不得把部署視為完成",
  };
  const sorted = [first.latencyMs, second.latencyMs].sort((left, right) => left - right);
  const observedLatency = {
    latencyMs: [first.latencyMs, second.latencyMs] as [number, number],
    latencyP50Ms: Math.round(((sorted[0] + sorted[1]) / 2) * 10) / 10,
    jitterMs: Math.round(Math.abs(first.latencyMs - second.latencyMs) * 10) / 10,
  };
  if (config.transport === "cloud-relay") return {
    schema: VERIFICATION_SCHEMA,
    status: "PARTIAL" as const,
    verified: false,
    providerEndpointVerified: true,
    ...observedLatency,
    reason: "只觀測到相容 relay 的公開 HTTPS landing；尚未證明桌機 WSS、手機配對或斷線重連，不能標記 Remote 完成",
    nextAction: "在 Editkin 啟動 Remote 並用真手機跨網路配對；最終狀態仍以本機 UI 的在線裝置為準" as const,
  };
  const currentConfig = parseConfig(await readJson(paths.config));
  const currentRuntime = activeRuntime(await readJson(paths.runtime), currentConfig);
  if (currentConfig.configurationId !== config.configurationId || !runtime || !currentRuntime
    || !sameRuntimeInstance(runtime, currentRuntime)) return {
    schema: VERIFICATION_SCHEMA,
    status: "BLOCKED" as const,
    verified: false,
    reason: "Editkin Remote runtime 在探測期間已更換或停止；已拒絕簽發 stale verification receipt",
  };
  const verifiedAtMs = Math.max(Date.now(), runtime.startedAtMs + 1);
  const receipt: RemoteRouteVerification = {
    schema: VERIFICATION_SCHEMA,
    configurationId: config.configurationId,
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
    ...observedLatency,
    routeEvidence: "two-pinned-independent-tls-connections-succeeded",
    reconnectVerified: false,
    requiresActiveMobileProof: true,
  };
  await writeJsonAtomic(paths.verification, receipt);
  return {
    ...receipt,
    reason: "已量測兩次全新、DNS pinning 的 TLS 路由，但尚未觀測真手機配對、斷線與重連，所以不宣稱端到端完成",
    nextAction: "請用真手機跨網路配對並在 Editkin 確認在線；手機重新連線證據尚未自動收集" as const,
  };
}

function structuredResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function listRemoteProviderConnectorStatus() {
  return {
    schema: "editkin.remote-provider-connector-list/v1" as const,
    status: "RESEARCH_ONLY_NO_EXTERNAL_ACTION" as const,
    connectors: listRemoteProviderConnectors().map((connector) => ({
      connectorId: connector.connectorId,
      connectorRevision: connector.connectorRevision,
      manifestSha256: connector.manifestSha256,
      providerId: connector.providerId,
      providerDisplayName: connector.providerDisplayName,
      productName: connector.productName,
      transport: connector.transport,
      availability: connector.availability,
      approvalAvailable: connector.approvalAvailable,
      attested: connector.attested,
      executionOwner: connector.executionOwner,
      authMode: connector.authMode,
      stableHttpsName: connector.stableHttpsName,
      supportedPublicPorts: connector.supportedPublicPorts,
      limitations: connector.limitations,
      sourceUrls: connector.sourceUrls,
    })),
    externalMutationToolAvailable: false as const,
    nextAction: "AI 只能選擇清單中的 connector 建立 proposal；目前沒有已 attested 且 enabled 的 connector，因此不能核准、登入或部署" as const,
  };
}

const remotePolicyOutputSchema = z.object({
  mode: z.literal("user-owned-byo"),
  autoDeploy: z.literal(false),
  costResponsibility: z.literal("end-user"),
  providerRequired: z.literal(false),
}).strict();
const connectorListOutputSchema = z.object({
  schema: z.literal("editkin.remote-provider-connector-list/v1"),
  status: z.literal("RESEARCH_ONLY_NO_EXTERNAL_ACTION"),
  connectors: z.array(z.object({
    connectorId: z.string().min(1).max(63),
    connectorRevision: z.string().min(1).max(64),
    manifestSha256: z.string().regex(HEX_64_PATTERN),
    providerId: z.string().min(1).max(63),
    providerDisplayName: z.string().min(1).max(80),
    productName: z.string().min(1).max(120),
    transport: z.literal("https-tunnel"),
    availability: z.enum(["enabled", "research-only-disabled", "unsupported-temporary"]),
    approvalAvailable: z.boolean(),
    attested: z.boolean(),
    executionOwner: z.literal("native-typed-connector"),
    authMode: z.enum(["provider-owned-browser", "none"]),
    stableHttpsName: z.boolean(),
    supportedPublicPorts: z.array(z.number().int().min(1).max(65_535)).max(8),
    limitations: z.array(z.string().min(1).max(240)).min(1).max(16),
    sourceUrls: z.array(z.string().url()).min(1).max(8),
  }).strict()).min(1).max(16),
  externalMutationToolAvailable: z.literal(false),
  nextAction: z.string().min(1),
}).strict();
const statusOutputSchema = z.object({
  schema: z.literal("editkin.remote-setup-status/v1"),
  status: z.enum([
    "LAN_DEFAULT", "PROPOSAL_READY_NOT_APPROVED", "PROPOSAL_EXPIRED", "LEGACY_PROVIDER_PROPOSAL_BLOCKED", "LEGACY_PENDING_INCOMPLETE",
    "LEGACY_PENDING_EXPIRED", "AWAITING_DESKTOP_APPROVAL", "CONFIGURED_UNVERIFIED", "CONFIGURED_ROUTE_VERIFIED",
    "RENEWAL_RECONCILIATION_REQUIRED", "STATE_RECONCILIATION_REQUIRED",
  ]),
  transport: z.enum(["lan", "https-tunnel", "cloud-relay", "unknown"]),
  configured: z.boolean(),
  proposal: remoteProviderProposalSchema.optional(),
  resumeAvailable: z.boolean().optional(),
  renewal: z.object({ expectedExpiredProposalRevision: z.string().regex(UUID_V4_PATTERN) }).strict().optional(),
  recovery: z.object({
    artifact: z.literal("network-setup-pending.json.renewing"),
    reason: z.enum(["INVALID_RENEWING_ARTIFACT", "CONFLICTING_PENDING_AND_RENEWING", "RENEWING_PROPOSAL_NOT_EXPIRED", "RECOVERY_PUBLICATION_FAILED"]),
    automaticReplayPerformed: z.literal(false),
  }).strict().optional(),
  conflict: z.object({
    present: z.array(z.enum(["config", "candidate", "pending"])).min(1).max(3)
      .refine((values) => new Set(values).size === values.length),
    reason: z.string().min(1).max(240),
    automaticMutationPerformed: z.literal(false),
  }).strict().optional(),
  pendingProviderConfirmation: z.object({
    schema: z.literal(LEGACY_PENDING_SCHEMA),
    confirmationId: z.string().regex(UUID_V4_PATTERN),
    providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
    preparedAt: z.string().datetime(),
    expiresAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
    costResponsibility: z.literal("end-user"),
  }).strict().optional(),
  pendingDesktopApproval: z.object({
    candidateRevision: z.string().regex(UUID_V4_PATTERN),
    originHost: z.string().min(1).max(255),
    providerId: z.string().min(1).max(63),
    expiresAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
  }).strict().optional(),
  configuration: z.object({
    originHost: z.string().min(1).max(255),
    providerId: z.string().min(1).max(63),
    configurationId: z.string().regex(HEX_64_PATTERN),
    configuredAt: z.string().datetime(),
  }).strict().optional(),
  verification: z.unknown().optional(),
  policy: remotePolicyOutputSchema,
  nextAction: z.string(),
}).strict();
const prepareOutputSchema = z.object({
  schema: z.literal(PROVIDER_PROPOSAL_SCHEMA),
  status: z.literal("PROPOSAL_READY_NOT_APPROVED"),
  created: z.boolean(),
  resumed: z.boolean(),
  proposal: remoteProviderProposalSchema,
  externalMutationPerformed: z.literal(false),
  autoDeploy: z.literal(false),
  approvalAvailable: z.boolean(),
  nextAction: z.string(),
}).strict();
const configureOutputSchema = z.object({
  schema: z.literal(CANDIDATE_SCHEMA),
  status: z.literal("PENDING_DESKTOP_APPROVAL"),
  candidateRevision: z.string().regex(UUID_V4_PATTERN),
  proposal: z.object({
    transport: z.enum(["https-tunnel", "cloud-relay"]),
    originHost: z.string().min(1).max(255),
    providerId: z.string().min(1).max(63),
    configurationId: z.string().regex(HEX_64_PATTERN),
    expiresAtMs: z.number().nonnegative().refine(Number.isSafeInteger),
  }).strict(),
  persistedSecretFields: z.array(z.string()).max(0),
  formalConfigurationWritten: z.literal(false),
  desktopApprovalRequired: z.literal(true),
  nextAction: z.string(),
}).strict();
const verifyOutputSchema = z.object({
  schema: z.literal(VERIFICATION_SCHEMA),
  status: z.enum(["BLOCKED", "PARTIAL"]),
  verified: z.literal(false),
  reason: z.string(),
  nextAction: z.string().optional(),
  observed: z.object({
    firstConnectionSucceeded: z.boolean(),
    secondIndependentConnectionSucceeded: z.boolean(),
    latencyMs: z.tuple([z.number(), z.number()]),
  }).strict().optional(),
  providerEndpointVerified: z.literal(true).optional(),
  configurationId: z.string().regex(HEX_64_PATTERN).optional(),
  verifiedAt: z.string().datetime().optional(),
  verifiedAtMs: z.number().nonnegative().refine(Number.isSafeInteger).optional(),
  probeId: z.string().regex(HEX_32_PATTERN).optional(),
  runtimeInstanceId: z.string().regex(HEX_32_PATTERN).optional(),
  processId: z.number().positive().refine(Number.isSafeInteger).optional(),
  startedAtMs: z.number().nonnegative().refine(Number.isSafeInteger).optional(),
  endpointKind: z.literal("editkin-tunnel").optional(),
  successfulTlsConnections: z.literal(2).optional(),
  latencyMs: z.tuple([z.number(), z.number()]).optional(),
  latencyP50Ms: z.number().nonnegative().optional(),
  jitterMs: z.number().nonnegative().optional(),
  routeEvidence: z.literal("two-pinned-independent-tls-connections-succeeded").optional(),
  reconnectVerified: z.literal(false).optional(),
  requiresActiveMobileProof: z.literal(true).optional(),
}).strict();

export function registerRemoteOnboardingTools(
  server: McpServer,
  environment: NodeJS.ProcessEnv = process.env,
  options: { includeConfigure?: boolean; includeVerify?: boolean } = {},
): void {
  server.registerTool("get_remote_setup_status", {
    description: "讀取 Editkin Remote 的 LAN／使用者自備跨網路設定與最後一次真實驗證 receipt；不讀取或回傳任何供應商密鑰。",
    inputSchema: z.object({}).strict(),
    outputSchema: statusOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return structuredResult(await getRemoteSetupStatus(environment)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("list_remote_provider_connectors", {
    description: "唯讀列出 Editkin closed registry 內的 Remote connector 研究狀態、限制與 manifest identity。不登入、不執行 provider CLI、不建立／刪除資源，也不開放 external mutation。",
    inputSchema: z.object({}).strict(),
    outputSchema: connectorListOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return structuredResult(listRemoteProviderConnectorStatus()); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_remote_setup", {
    description: "從 closed registry 選擇 connector，驗證並保存一份綁定 connector manifest 與 exact plan digest、有來源／價格／配額／權限／預計變更的非機密 Remote provider proposal v2。這一步不登入供應商、不部署、不付款、不寫正式設定，也不宣稱路由或手機連線已完成。",
    inputSchema: prepareRemoteSetupInputSchema,
    outputSchema: prepareOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try { return structuredResult(await prepareRemoteSetup(input, environment)); }
    catch (error) { return errorResult(error); }
  });

  if (options.includeConfigure !== false) {
    server.registerTool("configure_remote_access", {
      description: "只保留給舊版 confirmation receipt 的相容遷移：建立無密鑰公開 HTTPS origin 短效候選，仍須桌面核准。新版 provider proposal 沒有 proposal-bound approval／deployment receipt 時會明確拒絕；不接受 token、API key、cookie、密碼或自動部署。",
      inputSchema: z.object({
        confirmationId: z.string().uuid(),
        origin: z.string().url().max(2_048),
        userConfirmedDeployment: z.literal(true),
        userConfirmedProviderCosts: z.literal(true),
        userConfirmedProviderPermissions: z.literal(true),
      }).strict(),
      outputSchema: configureOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input) => {
      try { return structuredResult(await configureRemoteAccess(input, environment)); }
      catch (error) { return errorResult(error); }
    });
  }

  if (options.includeVerify !== false) {
    server.registerTool("verify_remote_access", {
      description: "對桌面已核准的非機密 HTTPS origin，以預解析且固定的公開 IP 建立兩個全新 TLS socket，量測 route latency 與 jitter。真 Editkin challenge 也只會回 PARTIAL；沒有手機配對與斷線重連證據絕不宣稱端到端完成。",
      inputSchema: z.object({}).strict(),
      outputSchema: verifyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async () => {
      try { return structuredResult(await verifyRemoteAccess(environment)); }
      catch (error) { return errorResult(error); }
    });
  }
}
