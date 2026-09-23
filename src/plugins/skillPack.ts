import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { compareUtf8Bytes } from "../shared/utf8ByteOrder";

export const EDITKIN_SKILL_PACK_SCHEMA = "hao.editkin.skill-pack/v1" as const;
export const EDITKIN_WORKFLOW_PROFILE_SCHEMA = "hao.editkin.workflow-profile/v1" as const;
export const EDITKIN_SKILL_SELECTION_RECEIPT_SCHEMA = "hao.video-autopilot.skill-selection-receipt/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const identifierSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/);
const skillReferenceSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,127}\/[a-z][a-z0-9_.-]{0,95}$/);
export const editkinFormatSchema = z.enum(["any", "longform", "shorts", "reels", "podcast"]);

const workflowPreferencesSchema = z.strictObject({
  pacing: z.enum(["calm", "balanced", "dense"]).optional(),
  captionDensity: z.enum(["minimal", "balanced", "dense"]).optional(),
  captionColorPolicy: z.literal("single_primary_text_color").optional(),
  graphicDensity: z.enum(["minimal", "balanced", "expressive"]).optional(),
  transitionPolicy: z.enum(["clean_first", "motivated_only", "expressive_when_evidenced"]).optional(),
  colorPolicy: z.literal("single_primary_look").optional(),
  audioPolicy: z.enum(["dialogue_first", "music_first", "balanced_layers"]).optional(),
});

const capabilityQueryKindSchema = z.enum([
  "effect",
  "transition",
  "generator",
  "analysis",
  "workflow_tool",
  "importer",
  "exporter",
  "asset_pack",
  "knowledge_pack",
]);

const capabilityQuerySchema = z.strictObject({
  id: identifierSchema,
  kind: capabilityQueryKindSchema,
  semanticRoles: z.array(identifierSchema).min(1).max(8),
  formats: z.array(editkinFormatSchema).min(1).max(5).default(["any"]),
  maxCandidates: z.number().int().min(1).max(3).default(3),
  required: z.boolean().default(false),
});

const skillGuardrailsSchema = z.strictObject({
  maxCapabilityDeepReads: z.number().int().min(1).max(3),
  maxContextTokens: z.number().int().min(120).max(700),
  maxAutomaticActions: z.number().int().min(1).max(32),
  structuredCommandsOnly: z.literal(true),
  auditBeforeApply: z.literal(true),
  humanReviewRequired: z.literal(true),
  publishAllowed: z.literal(false),
});

const outcomeLearningSchema = z.strictObject({
  checkpoints: z.array(z.enum(["D2", "D7", "D28"])).min(1).max(3),
  learnFromHumanReview: z.literal(true),
  automaticCoreMutation: z.literal(false),
});

export const editkinSkillPackSchema = z.strictObject({
  schema: z.literal(EDITKIN_SKILL_PACK_SCHEMA),
  identity: z.strictObject({
    pluginId: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
    capabilityId: identifierSchema,
    version: semverSchema,
  }),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(360),
  planSchema: z.literal("hao.video-autopilot.edit-plan/v4"),
  conflictGroup: identifierSchema.optional(),
  defaultPriority: z.number().int().min(-100).max(100).default(0),
  preferences: workflowPreferencesSchema,
  capabilityQueries: z.array(capabilityQuerySchema).max(12),
  guardrails: skillGuardrailsSchema,
  outcomeLearning: outcomeLearningSchema,
}).superRefine((pack, context) => {
  const queryIds = pack.capabilityQueries.map((query) => query.id);
  if (new Set(queryIds).size !== queryIds.length) {
    context.addIssue({ code: "custom", path: ["capabilityQueries"], message: "Skill Pack query id 不可重複" });
  }
  const checkpoints = pack.outcomeLearning.checkpoints;
  if (new Set(checkpoints).size !== checkpoints.length) {
    context.addIssue({ code: "custom", path: ["outcomeLearning", "checkpoints"], message: "Outcome checkpoint 不可重複" });
  }
});

export type EditkinSkillPack = z.infer<typeof editkinSkillPackSchema>;

const skillGrantSchema = z.strictObject({
  skillId: skillReferenceSchema,
  manifestSha256: sha256Schema,
  packSha256: sha256Schema,
  permissions: z.array(z.literal("workflow.read")).length(1),
});

export const editkinPluginPermissionSchema = z.enum([
  "project.read",
  "project.write",
  "media.read",
  "render.effect",
  "assets.read",
  "knowledge.read",
  "workflow.read",
]);

const pluginGrantSchema = z.strictObject({
  pluginId: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
  manifestSha256: sha256Schema,
  capabilityIds: z.array(identifierSchema).min(1).max(32),
  permissions: z.array(editkinPluginPermissionSchema).min(1).max(7),
}).superRefine((grant, context) => {
  if (new Set(grant.capabilityIds).size !== grant.capabilityIds.length) {
    context.addIssue({ code: "custom", path: ["capabilityIds"], message: "plugin grant capability 不可重複" });
  }
  if (new Set(grant.permissions).size !== grant.permissions.length) {
    context.addIssue({ code: "custom", path: ["permissions"], message: "plugin grant permission 不可重複" });
  }
});

export const editkinWorkflowProfileSchema = z.strictObject({
  schema: z.literal(EDITKIN_WORKFLOW_PROFILE_SCHEMA),
  id: identifierSchema,
  revision: z.number().int().positive(),
  enabledSkills: z.array(skillReferenceSchema).max(32),
  priority: z.array(skillReferenceSchema).max(32).default([]),
  grants: z.array(skillGrantSchema).max(32),
  pluginGrants: z.array(pluginGrantSchema).max(64).default([]),
  conflictPolicy: z.enum(["fail_closed", "profile_priority"]).default("fail_closed"),
}).superRefine((profile, context) => {
  for (const [field, values] of [["enabledSkills", profile.enabledSkills], ["priority", profile.priority]] as const) {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [field], message: `${field} 不可重複` });
  }
  const enabled = new Set(profile.enabledSkills);
  if (profile.priority.some((skillId) => !enabled.has(skillId))) {
    context.addIssue({ code: "custom", path: ["priority"], message: "priority 只能引用已啟用 Skill" });
  }
  if (profile.priority.length !== profile.enabledSkills.length || profile.enabledSkills.some((skillId) => !profile.priority.includes(skillId))) {
    context.addIssue({ code: "custom", path: ["priority"], message: "priority 必須是 enabledSkills 的完整排列" });
  }
  const grants = profile.grants.map((grant) => grant.skillId);
  if (new Set(grants).size !== grants.length) context.addIssue({ code: "custom", path: ["grants"], message: "同一 Skill 只能有一份 grant" });
  if (profile.grants.some((grant) => !enabled.has(grant.skillId))) {
    context.addIssue({ code: "custom", path: ["grants"], message: "grant 只能引用已啟用 Skill" });
  }
  if (profile.enabledSkills.some((skillId) => !grants.includes(skillId))) {
    context.addIssue({ code: "custom", path: ["grants"], message: "每個已啟用 Skill 都必須有一份精確 grant" });
  }
  const pluginGrants = profile.pluginGrants.map((grant) => grant.pluginId);
  if (new Set(pluginGrants).size !== pluginGrants.length) context.addIssue({ code: "custom", path: ["pluginGrants"], message: "同一 Plugin 只能有一份 automation grant" });
});

export type EditkinWorkflowProfile = z.infer<typeof editkinWorkflowProfileSchema>;

export const editkinSkillContextSchema = z.strictObject({
  format: editkinFormatSchema.exclude(["any"]),
  domain: identifierSchema,
  semanticRoles: z.array(identifierSchema).max(20),
}).superRefine((context, refinement) => {
  if (new Set(context.semanticRoles).size !== context.semanticRoles.length) {
    refinement.addIssue({ code: "custom", path: ["semanticRoles"], message: "semanticRoles 不可重複" });
  }
});

export type EditkinSkillContext = z.infer<typeof editkinSkillContextSchema>;

export function editkinSkillFormatForAutopilotRoute(format: string): EditkinSkillContext["format"] {
  if (format === "shorts" || format === "reels" || format === "podcast") return format;
  return "longform";
}

const selectedSkillSchema = z.strictObject({
  skillId: skillReferenceSchema,
  manifestSha256: sha256Schema,
  packSha256: sha256Schema,
  precedence: z.number().int().nonnegative(),
});

const compiledQuerySchema = capabilityQuerySchema.extend({ sourceSkillId: skillReferenceSchema });

const compiledWorkflowSchema = z.strictObject({
  preferences: workflowPreferencesSchema,
  capabilityQueries: z.array(compiledQuerySchema).max(36),
  guardrails: skillGuardrailsSchema,
  outcomeLearning: outcomeLearningSchema,
});

const skillRejectionSchema = z.strictObject({
  skillId: skillReferenceSchema,
  reason: z.enum(["context_mismatch", "conflict_lower_priority"]),
});

export const editkinSkillSelectionReceiptSchema = z.strictObject({
  schema: z.literal(EDITKIN_SKILL_SELECTION_RECEIPT_SCHEMA),
  profile: z.strictObject({ id: identifierSchema, revision: z.number().int().positive() }),
  profileSha256: sha256Schema,
  context: editkinSkillContextSchema,
  pluginRegistrySha256: sha256Schema,
  selected: z.array(selectedSkillSchema).max(16),
  rejected: z.array(skillRejectionSchema).max(32),
  compiled: compiledWorkflowSchema,
  estimatedContextTokens: z.number().int().nonnegative().max(700),
  receiptSha256: sha256Schema,
});

export type EditkinSkillSelectionReceipt = z.infer<typeof editkinSkillSelectionReceiptSchema>;

export interface InstalledSkillPackCandidate {
  skillId: string;
  pluginId: string;
  capabilityId: string;
  pluginVersion: string;
  manifestSha256: string;
  packSha256: string;
  formats: Array<z.infer<typeof editkinFormatSchema>>;
  semanticRoles: string[];
  planningReady: boolean;
  pack: EditkinSkillPack;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8Bytes(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function skillPackSha256(value: string | Buffer | unknown): string {
  const source = typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return createHash("sha256").update(source).digest("hex");
}

function defaultCompiledWorkflow(): z.infer<typeof compiledWorkflowSchema> {
  return {
    preferences: {},
    capabilityQueries: [],
    guardrails: {
      maxCapabilityDeepReads: 3,
      maxContextTokens: 700,
      maxAutomaticActions: 32,
      structuredCommandsOnly: true,
      auditBeforeApply: true,
      humanReviewRequired: true,
      publishAllowed: false,
    },
    outcomeLearning: {
      checkpoints: ["D2", "D7", "D28"] as Array<"D2" | "D7" | "D28">,
      learnFromHumanReview: true,
      automaticCoreMutation: false,
    },
  };
}

function contextMatches(candidate: InstalledSkillPackCandidate, context: EditkinSkillContext): boolean {
  const formatMatches = candidate.formats.includes("any") || candidate.formats.includes(context.format);
  if (!formatMatches) return false;
  if (!candidate.semanticRoles.length || !context.semanticRoles.length) return true;
  const roles = new Set(context.semanticRoles);
  return candidate.semanticRoles.some((role) => roles.has(role));
}

function selectedOrder(profile: EditkinWorkflowProfile, candidates: InstalledSkillPackCandidate[]): InstalledSkillPackCandidate[] {
  const explicit = new Map(profile.priority.map((skillId, index) => [skillId, index]));
  return [...candidates].sort((left, right) => {
    const leftRank = explicit.get(left.skillId);
    const rightRank = explicit.get(right.skillId);
    if (leftRank !== undefined || rightRank !== undefined) return (leftRank ?? 10_000) - (rightRank ?? 10_000);
    if (left.pack.defaultPriority !== right.pack.defaultPriority) return right.pack.defaultPriority - left.pack.defaultPriority;
    return compareUtf8Bytes(left.skillId, right.skillId);
  });
}

function mergeWorkflow(selected: InstalledSkillPackCandidate[]) {
  const compiled = defaultCompiledWorkflow();
  const preferences = compiled.preferences as Record<string, unknown>;
  const checkpoints = new Set<"D2" | "D7" | "D28">();
  for (const candidate of selected) {
    for (const [key, value] of Object.entries(candidate.pack.preferences)) {
      if (preferences[key] === undefined) preferences[key] = value;
    }
    for (const query of candidate.pack.capabilityQueries) {
      compiled.capabilityQueries.push({ ...query, sourceSkillId: candidate.skillId });
    }
    compiled.guardrails.maxCapabilityDeepReads = Math.min(compiled.guardrails.maxCapabilityDeepReads, candidate.pack.guardrails.maxCapabilityDeepReads);
    compiled.guardrails.maxContextTokens = Math.min(compiled.guardrails.maxContextTokens, candidate.pack.guardrails.maxContextTokens);
    compiled.guardrails.maxAutomaticActions = Math.min(compiled.guardrails.maxAutomaticActions, candidate.pack.guardrails.maxAutomaticActions);
    for (const checkpoint of candidate.pack.outcomeLearning.checkpoints) checkpoints.add(checkpoint);
  }
  if (selected.length) compiled.outcomeLearning.checkpoints = (["D2", "D7", "D28"] as const).filter((item) => checkpoints.has(item));
  return compiledWorkflowSchema.parse(compiled);
}

export function resolveEditkinSkillWorkflow(
  candidatesInput: InstalledSkillPackCandidate[],
  profileInput: EditkinWorkflowProfile,
  contextInput: EditkinSkillContext,
  pluginRegistrySha256: string,
): EditkinSkillSelectionReceipt {
  if (!/^[a-f0-9]{64}$/.test(pluginRegistrySha256)) throw new Error("Skill selection 缺少合法 plugin registry SHA-256");
  const profile = editkinWorkflowProfileSchema.parse(profileInput);
  const context = editkinSkillContextSchema.parse({ ...contextInput, semanticRoles: [...contextInput.semanticRoles].sort() });
  const byId = new Map(candidatesInput.map((candidate) => [candidate.skillId, candidate]));
  const grants = new Map(profile.grants.map((grant) => [grant.skillId, grant]));
  const enabled: InstalledSkillPackCandidate[] = [];
  const rejected: Array<z.infer<typeof skillRejectionSchema>> = [];
  for (const skillId of profile.enabledSkills) {
    const candidate = byId.get(skillId);
    if (!candidate || !candidate.planningReady) throw new Error(`已啟用 Skill 不存在或 planning readiness 未通過：${skillId}`);
    const grant = grants.get(skillId);
    if (!grant || grant.manifestSha256 !== candidate.manifestSha256 || grant.packSha256 !== candidate.packSha256) {
      throw new Error(`Skill grant 缺失或已因版本／hash 漂移失效：${skillId}`);
    }
    if (!contextMatches(candidate, context)) rejected.push({ skillId, reason: "context_mismatch" });
    else enabled.push(candidate);
  }

  const ordered = selectedOrder(profile, enabled);
  const selected: InstalledSkillPackCandidate[] = [];
  const groups = new Map<string, InstalledSkillPackCandidate>();
  for (const candidate of ordered) {
    const group = candidate.pack.conflictGroup;
    const declaredConflict = group ? groups.get(group) : undefined;
    const preferenceConflict = selected.find((current) => Object.entries(candidate.pack.preferences).some(([key, value]) => {
      const currentValue = (current.pack.preferences as Record<string, unknown>)[key];
      return currentValue !== undefined && currentValue !== value;
    }));
    const conflict = declaredConflict ?? preferenceConflict;
    if (conflict) {
      if (profile.conflictPolicy === "fail_closed") throw new Error(`Skill 衝突需要使用者決定：${conflict.skillId} / ${candidate.skillId}`);
      rejected.push({ skillId: candidate.skillId, reason: "conflict_lower_priority" });
      continue;
    }
    if (group) groups.set(group, candidate);
    selected.push(candidate);
  }
  const compiled = mergeWorkflow(selected);
  const receiptBase = {
    schema: EDITKIN_SKILL_SELECTION_RECEIPT_SCHEMA,
    profile: { id: profile.id, revision: profile.revision },
    profileSha256: skillPackSha256(profile),
    context,
    pluginRegistrySha256,
    selected: selected.map((candidate, precedence) => ({
      skillId: candidate.skillId,
      manifestSha256: candidate.manifestSha256,
      packSha256: candidate.packSha256,
      precedence,
    })),
    rejected: rejected.sort((left, right) => compareUtf8Bytes(left.skillId, right.skillId)),
    compiled,
  };
  const estimatedContextTokens = Math.ceil(Buffer.byteLength(canonicalJson({ ...receiptBase, estimatedContextTokens: 999, receiptSha256: "0".repeat(64) }), "utf8") / 4);
  if (estimatedContextTokens > compiled.guardrails.maxContextTokens) {
    throw new Error(`Skill selection receipt 超過 context 預算：${estimatedContextTokens}/${compiled.guardrails.maxContextTokens}`);
  }
  const base = { ...receiptBase, estimatedContextTokens };
  return editkinSkillSelectionReceiptSchema.parse({ ...base, receiptSha256: skillPackSha256(base) });
}

export function createEmptyEditkinSkillSelectionReceipt(
  pluginRegistrySha256: string,
  context: EditkinSkillContext,
): EditkinSkillSelectionReceipt {
  return resolveEditkinSkillWorkflow([], {
    schema: EDITKIN_WORKFLOW_PROFILE_SCHEMA,
    id: "default-safe",
    revision: 1,
    enabledSkills: [],
    priority: [],
    grants: [],
    pluginGrants: [],
    conflictPolicy: "fail_closed",
  }, context, pluginRegistrySha256);
}

export function verifyEditkinSkillSelectionReceipt(
  receiptInput: unknown,
  candidates: InstalledSkillPackCandidate[],
  expectedContext: EditkinSkillContext,
  expectedPluginRegistrySha256: string,
  expectedProfileInput: EditkinWorkflowProfile,
): EditkinSkillSelectionReceipt {
  const receipt = assertEditkinSkillSelectionReceiptIntegrity(receiptInput);
  if (receipt.pluginRegistrySha256 !== expectedPluginRegistrySha256) throw new Error("Skill selection receipt 的 plugin registry 已漂移");
  const expectedProfile = editkinWorkflowProfileSchema.parse(expectedProfileInput);
  if (skillPackSha256(expectedProfile) !== receipt.profileSha256) throw new Error("Skill selection receipt 的 Workflow Profile 已漂移");
  const expected = resolveEditkinSkillWorkflow(candidates, expectedProfile, expectedContext, expectedPluginRegistrySha256);
  if (canonicalJson(expected) !== canonicalJson(receipt)) throw new Error("Skill selection receipt 與目前 Skill Pack／Profile／context 不一致");
  return receipt;
}

export function assertEditkinSkillSelectionReceiptIntegrity(receiptInput: unknown): EditkinSkillSelectionReceipt {
  const receipt = editkinSkillSelectionReceiptSchema.parse(receiptInput);
  const { receiptSha256, ...base } = receipt;
  if (skillPackSha256(base) !== receiptSha256) throw new Error("Skill selection receipt 已遭竄改");
  return receipt;
}

export function compactInstalledSkill(candidate: InstalledSkillPackCandidate) {
  return {
    skillId: candidate.skillId,
    title: candidate.pack.title,
    description: candidate.pack.description,
    pluginVersion: candidate.pluginVersion,
    manifestSha256: candidate.manifestSha256,
    packSha256: candidate.packSha256,
    formats: candidate.formats,
    semanticRoles: candidate.semanticRoles,
    planningReady: candidate.planningReady,
    preferences: Object.keys(candidate.pack.preferences),
    capabilityQueryCount: candidate.pack.capabilityQueries.length,
    maxContextTokens: candidate.pack.guardrails.maxContextTokens,
  };
}
