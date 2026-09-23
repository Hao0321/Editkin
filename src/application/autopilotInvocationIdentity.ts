import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import { discoverInstalledPlugins, pluginRegistryIdentity } from "../plugins/registry";
import { canonicalJson } from "../shared/canonicalJson";
export { canonicalJson } from "../shared/canonicalJson";
import { communityKnowledgeIdentity } from "./communityKnowledge";
import { AUTOPILOT_CONTRACT, AUTOPILOT_PLAN_SCHEMA } from "./autopilotPlan";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const auditIssuerSecret = randomBytes(32);
export const AUTOPILOT_AUDIT_RECEIPT_TTL_MS = 10 * 60 * 1_000;
export const AUTOPILOT_AUDIT_RECEIPT_MAX_PENDING = 256;
const issuedAuditReceipts = new Map<string, { issuedAt: number; expiresAt: number }>();

function pruneIssuedAuditReceipts(now: number): void {
  for (const [receiptSha256, entry] of issuedAuditReceipts) {
    if (entry.expiresAt <= now) issuedAuditReceipts.delete(receiptSha256);
  }
}

function enforceIssuedAuditReceiptLimit(): void {
  while (issuedAuditReceipts.size > AUTOPILOT_AUDIT_RECEIPT_MAX_PENDING) {
    const oldest = issuedAuditReceipts.keys().next().value as string | undefined;
    if (!oldest) break;
    issuedAuditReceipts.delete(oldest);
  }
}

export function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

const liveAutopilotIdentityShape = {
  schema: z.literal("editkin.video-autopilot.live-identity/v1"),
  skill: z.strictObject({
    id: z.literal("video-autopilot"),
    revision: z.number().int().nonnegative(),
    sha256: sha256Schema,
    hardRuleCount: z.number().int().positive(),
  }),
  workflow: z.strictObject({
    schema: z.literal("hao.video-autopilot.workflow-contract/v1"),
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    planSchema: z.literal(AUTOPILOT_PLAN_SCHEMA),
    legacyPlanPolicy: z.literal("reject"),
  }),
  knowledge: z.strictObject({
    schema: z.literal("editkin.community-knowledge/v1"),
    revision: z.number().int().positive(),
    packSha256: sha256Schema,
    stableRulesSha256: sha256Schema,
    includedModuleCount: z.number().int().positive(),
    stableRuleCount: z.number().int().positive(),
  }),
  plugins: z.strictObject({
    schema: z.literal("editkin.plugin-registry-identity/v1"),
    sha256: sha256Schema,
    pluginCount: z.number().int().nonnegative(),
    diagnosticCount: z.number().int().nonnegative(),
  }),
} as const;

export const liveAutopilotIdentitySchema = z.strictObject({
  ...liveAutopilotIdentityShape,
  bindingSha256: sha256Schema,
});
export type LiveAutopilotIdentity = z.infer<typeof liveAutopilotIdentitySchema>;

interface WorkflowContractIdentitySource {
  schema?: unknown;
  contract_revision?: unknown;
  plan_schema?: unknown;
  plan_hash_algorithm?: unknown;
  legacy_plan_policy?: unknown;
}

export async function resolveLiveVideoAutopilotSkillPath(explicitPath?: string): Promise<string> {
  const configuredPath = explicitPath ?? process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL?.trim();
  const selectedPath = configuredPath || resolve(homedir(), ".codex", "skills", "video-autopilot", "SKILL.md");
  if (!isAbsolute(selectedPath)) throw new Error("EDITKIN_VIDEO_AUTOPILOT_SKILL 必須是 SKILL.md 的絕對路徑");
  const skillPath = await realpath(selectedPath);
  if (basename(skillPath).toLowerCase() !== "skill.md") {
    throw new Error("EDITKIN_VIDEO_AUTOPILOT_SKILL 必須指向 SKILL.md");
  }
  return skillPath;
}

export async function readLiveAutopilotIdentity(options: { skillPath?: string; pluginRoots?: string[] } = {}): Promise<LiveAutopilotIdentity> {
  // The configured Skill is the active agent profile. Its exact bytes and
  // workflow contract are sealed into the plan and checked again at apply.
  const skillPath = await resolveLiveVideoAutopilotSkillPath(options.skillPath);
  const workflowPath = await realpath(resolve(dirname(skillPath), "workflow_contract.json"));
  const [skillText, workflowText, registry] = await Promise.all([
    readFile(skillPath, "utf8"),
    readFile(workflowPath, "utf8"),
    discoverInstalledPlugins(options.pluginRoots),
  ]);
  if (!/^name:\s*video-autopilot\s*$/m.test(skillText)) throw new Error("目前 Skill 不是 video-autopilot");
  const ruleIds = [...new Set([...skillText.matchAll(/\bM(\d{1,4})(?:-[A-Z]+|A)?\b/g)].map((match) => match[0]))];
  const ruleNumbers = ruleIds.map((id) => Number(/^M(\d+)/.exec(id)?.[1] ?? 0));
  const publicRuleCount = [...skillText.matchAll(/^\d+\.\s+\S/gm)].length;
  if (ruleNumbers.length === 0 && publicRuleCount === 0) throw new Error("目前 video-autopilot Skill 沒有可辨識的穩定規則");

  let workflow: WorkflowContractIdentitySource;
  try { workflow = JSON.parse(workflowText) as WorkflowContractIdentitySource; }
  catch { throw new Error("video-autopilot workflow_contract.json 不是合法 JSON"); }
  if (workflow.schema !== "hao.video-autopilot.workflow-contract/v1") throw new Error("video-autopilot workflow contract schema 不支援");
  if (!Number.isInteger(workflow.contract_revision) || Number(workflow.contract_revision) < 1) throw new Error("video-autopilot workflow contract revision 不合法");
  if (workflow.plan_schema !== AUTOPILOT_PLAN_SCHEMA) throw new Error("video-autopilot workflow contract 沒有鎖定 v4");
  if (workflow.plan_hash_algorithm !== undefined && workflow.plan_hash_algorithm !== AUTOPILOT_CONTRACT.planHashAlgorithm) {
    throw new Error("video-autopilot plan hash algorithm 與目前 Editkin 不相容，請更新 Skill 後重新建立計畫");
  }
  if (workflow.legacy_plan_policy !== "reject") throw new Error("video-autopilot workflow contract 沒有拒絕 legacy plan");

  const identityBase = {
    schema: "editkin.video-autopilot.live-identity/v1" as const,
    skill: {
      id: "video-autopilot" as const,
      revision: ruleNumbers.length ? Math.max(...ruleNumbers) : Number(workflow.contract_revision),
      sha256: sha256Text(skillText),
      hardRuleCount: ruleIds.length || publicRuleCount,
    },
    workflow: {
      schema: "hao.video-autopilot.workflow-contract/v1" as const,
      revision: Number(workflow.contract_revision),
      sha256: sha256Canonical(workflow),
      planSchema: AUTOPILOT_PLAN_SCHEMA,
      legacyPlanPolicy: "reject" as const,
    },
    knowledge: communityKnowledgeIdentity(),
    plugins: pluginRegistryIdentity(registry),
  };
  return liveAutopilotIdentitySchema.parse({ ...identityBase, bindingSha256: sha256Canonical(identityBase) });
}

export interface AutopilotPlanLiveSource {
  skillId: "video-autopilot";
  revision: number;
  skillSha256: string;
  workflowContractRevision: number;
  workflowContractSha256: string;
  knowledgeRevision: number;
  knowledgeSha256: string;
  stableRulesSha256: string;
  pluginRegistrySha256: string;
  invocationBindingSha256: string;
}

export function autopilotPlanSourceFromIdentity(identity: LiveAutopilotIdentity): AutopilotPlanLiveSource {
  return {
    skillId: "video-autopilot",
    revision: identity.skill.revision,
    skillSha256: identity.skill.sha256,
    workflowContractRevision: identity.workflow.revision,
    workflowContractSha256: identity.workflow.sha256,
    knowledgeRevision: identity.knowledge.revision,
    knowledgeSha256: identity.knowledge.packSha256,
    stableRulesSha256: identity.knowledge.stableRulesSha256,
    pluginRegistrySha256: identity.plugins.sha256,
    invocationBindingSha256: identity.bindingSha256,
  };
}

export function assertAutopilotPlanSourceCurrent(source: AutopilotPlanLiveSource, identity: LiveAutopilotIdentity): void {
  const expected = autopilotPlanSourceFromIdentity(identity);
  for (const key of Object.keys(expected) as Array<keyof AutopilotPlanLiveSource>) {
    if (source[key] !== expected[key]) throw new Error(`Autopilot plan source identity 已漂移：${key}`);
  }
}

export const autopilotProjectAuditIdentitySchema = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  pathSha256: sha256Schema,
  contentSha256: sha256Schema,
});
export type AutopilotProjectAuditIdentity = z.infer<typeof autopilotProjectAuditIdentitySchema>;

export function createAutopilotProjectAuditIdentity(absoluteProjectPath: string, project: EditProject): AutopilotProjectAuditIdentity {
  const normalizedPath = process.platform === "win32" ? resolve(absoluteProjectPath).toLowerCase() : resolve(absoluteProjectPath);
  return {
    id: project.id,
    revision: project.revision,
    pathSha256: sha256Text(normalizedPath),
    contentSha256: sha256Canonical(project),
  };
}

export const autopilotAuditReceiptSchema = z.strictObject({
  schema: z.literal("hao.video-autopilot.audit-receipt/v1"),
  status: z.literal("ACCEPTED"),
  planSchema: z.literal(AUTOPILOT_PLAN_SCHEMA),
  planSha256: sha256Schema,
  project: autopilotProjectAuditIdentitySchema,
  invocation: liveAutopilotIdentitySchema,
  materialEvidenceSha256: sha256Schema,
  auditedAt: z.iso.datetime(),
  receiptSha256: sha256Schema,
  issuerProof: sha256Schema,
});
export type AutopilotAuditReceipt = z.infer<typeof autopilotAuditReceiptSchema>;

export function createAcceptedAutopilotAuditReceipt(input: {
  planSha256: string;
  project: AutopilotProjectAuditIdentity;
  invocation: LiveAutopilotIdentity;
  materialEvidence: unknown;
  auditedAt?: string;
}): AutopilotAuditReceipt {
  const auditedAt = input.auditedAt ?? new Date().toISOString();
  const auditedAtMs = Date.parse(auditedAt);
  if (!Number.isFinite(auditedAtMs)) throw new Error("Autopilot audit receipt 時間不合法");
  const base = {
    schema: "hao.video-autopilot.audit-receipt/v1" as const,
    status: "ACCEPTED" as const,
    planSchema: AUTOPILOT_PLAN_SCHEMA,
    planSha256: input.planSha256,
    project: input.project,
    invocation: input.invocation,
    materialEvidenceSha256: sha256Canonical(input.materialEvidence),
    auditedAt,
  };
  const receiptSha256 = sha256Canonical(base);
  const issuerProof = createHmac("sha256", auditIssuerSecret).update(receiptSha256).digest("hex");
  pruneIssuedAuditReceipts(Date.now());
  issuedAuditReceipts.set(receiptSha256, { issuedAt: auditedAtMs, expiresAt: auditedAtMs + AUTOPILOT_AUDIT_RECEIPT_TTL_MS });
  enforceIssuedAuditReceiptLimit();
  return autopilotAuditReceiptSchema.parse({ ...base, receiptSha256, issuerProof });
}

export function verifyAcceptedAutopilotAuditReceipt(receiptInput: unknown, expected: {
  planSha256: string;
  project: AutopilotProjectAuditIdentity;
  invocation: LiveAutopilotIdentity;
  materialEvidence: unknown;
}): AutopilotAuditReceipt {
  const receipt = autopilotAuditReceiptSchema.parse(receiptInput);
  const { receiptSha256, issuerProof, ...base } = receipt;
  if (sha256Canonical(base) !== receiptSha256) throw new Error("Autopilot audit receipt 已遭竄改");
  const expectedProof = createHmac("sha256", auditIssuerSecret).update(receiptSha256).digest();
  const providedProof = Buffer.from(issuerProof, "hex");
  if (providedProof.length !== expectedProof.length || !timingSafeEqual(providedProof, expectedProof)) {
    throw new Error("Autopilot audit receipt 不是由目前 Editkin 程序簽發");
  }
  const now = Date.now();
  const auditedAtMs = Date.parse(receipt.auditedAt);
  if (auditedAtMs > now + 5_000) {
    issuedAuditReceipts.delete(receiptSha256);
    throw new Error("Autopilot audit receipt 時間在未來，已拒絕");
  }
  if (now - auditedAtMs > AUTOPILOT_AUDIT_RECEIPT_TTL_MS) {
    issuedAuditReceipts.delete(receiptSha256);
    throw new Error("Autopilot audit receipt 已過期，請重新 audit");
  }
  pruneIssuedAuditReceipts(now);
  const issued = issuedAuditReceipts.get(receiptSha256);
  if (!issued) throw new Error("Autopilot audit receipt 未簽發、已被套用或已從有界佇列淘汰，不可重播");
  if (issued.issuedAt !== auditedAtMs || issued.expiresAt <= now) {
    issuedAuditReceipts.delete(receiptSha256);
    throw new Error("Autopilot audit receipt 已過期，請重新 audit");
  }
  if (receipt.planSha256 !== expected.planSha256) throw new Error("Autopilot audit receipt 不屬於目前 plan");
  if (canonicalJson(receipt.project) !== canonicalJson(expected.project)) throw new Error("Autopilot audit receipt 的專案 revision 或內容已過期");
  if (canonicalJson(receipt.invocation) !== canonicalJson(expected.invocation)) throw new Error("Autopilot audit receipt 的 Skill／workflow／knowledge／plugin identity 已過期");
  if (receipt.materialEvidenceSha256 !== sha256Canonical(expected.materialEvidence)) throw new Error("Autopilot audit receipt 的素材語意證據已過期");
  return receipt;
}

/** Consumes the process-issued receipt exactly once at the atomic apply boundary. */
export function consumeAcceptedAutopilotAuditReceipt(receipt: AutopilotAuditReceipt): void {
  const issued = issuedAuditReceipts.get(receipt.receiptSha256);
  issuedAuditReceipts.delete(receipt.receiptSha256);
  if (!issued || issued.expiresAt <= Date.now()) {
    throw new Error("Autopilot audit receipt 未簽發或已被套用，不可重播");
  }
}
