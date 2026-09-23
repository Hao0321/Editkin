import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import * as z from "zod/v4";
import { aestheticSystemSchema, editorCommandSchema } from "../domain/schema";
import type { EditorCommand } from "../domain/commands";
import { assertBuildNarrative, editorialPlanSchema, parseLowerThirdEvidenceReference, summarizeEditorialPlan } from "./editorialPlan";
import skillIntegrationLedger from "../../video-autopilot-skill-integration.json";
import { compactAestheticContract } from "./editkinAesthetic";
import { communityKnowledgeSummary } from "./communityKnowledgeSummary";
import { assertMotionGraphicPresetBinding } from "../creative/motionGraphicPresets";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import {
  AUTOPILOT_CONTEXT_PROTOCOL,
  inferenceRouterSha256,
  inferenceRunSchema,
  renderInferenceRouterMarkdown,
  summarizeInference,
} from "./inferencePolicy";
import { assertRotoKeyerMaterialEvidenceBinding, assertRotoKeyerPlanCommandBinding, rotoKeyerPlanSchema } from "./rotoKeyerAutopilot";
import {
  assertEditkinSkillSelectionReceiptIntegrity,
  editkinSkillFormatForAutopilotRoute,
  editkinSkillSelectionReceiptSchema,
} from "../plugins/skillPack";
import { pluginAutomationApplicationSchema } from "../plugins/automationContract";
import { EDITKIN_MOTION } from "../motion/identity";
import { assertMotionTreatmentBinding, MOTION_TREATMENT_FAMILIES, summarizeMotionTreatment } from "./motionTreatment";
import { designEvidenceSchema, assertDesignDecisionBinding } from "./autopilotDesignContract";
import { assertAutoColorCommandBinding, autoColorBindingsSchema } from "./autoColorDecision";

export const AUTOPILOT_PLAN_SCHEMA_V1 = "hao.video-autopilot.edit-plan/v1" as const;
export const AUTOPILOT_PLAN_SCHEMA_V2 = "hao.video-autopilot.edit-plan/v2" as const;
export const AUTOPILOT_PLAN_SCHEMA_V3 = "hao.video-autopilot.edit-plan/v3" as const;
export const AUTOPILOT_PLAN_SCHEMA = "hao.video-autopilot.edit-plan/v4" as const;
export const AUTOPILOT_MAX_CONTEXT_TOKENS = 1_100;
export const AUTOPILOT_MAX_MEMORY_RULES = 6;
export const AUTOPILOT_MAX_COMMANDS = 100;
export const AUTOPILOT_MAX_PLAN_BYTES = 256 * 1024;
export const LOWER_THIRD_UNIT_STAGGER_SECONDS = 0.08;

export const AUTOPILOT_RULE_FAMILIES = [
  { id: "bounded-context-routing", integration: "contract_enforced", evidence: "src/application/autopilotPlan.ts" },
  { id: "bounded-memory-selection", integration: "contract_enforced", evidence: "src/application/autopilotPlan.ts" },
  { id: "source-and-memory-receipt", integration: "contract_enforced", evidence: "src/application/autopilotPlan.ts" },
  { id: "original-assets-read-only", integration: "native_enforced", evidence: "src/domain/commands.ts" },
  { id: "structured-edit-commands", integration: "native_enforced", evidence: "src/domain/schema.ts" },
  { id: "semantic-asset-selection", integration: "contract_enforced", evidence: "src/application/editorialPlan.ts" },
  { id: "license-fail-closed", integration: "native_enforced", evidence: "src/application/creativeLibrary.ts" },
  { id: "creative-brief-and-packaging", integration: "contract_enforced", evidence: "src/application/editorialPlan.ts" },
  { id: "promise-stakes-payoff", integration: "contract_enforced", evidence: "src/application/editorialPlan.ts" },
  { id: "energy-beat-curve", integration: "contract_enforced", evidence: "src/application/editorialPlan.ts" },
  { id: "captions-graphics-separated", integration: "native_plus_contract", evidence: "src/application/editorialPlan.ts" },
  { id: "semantic-graphics", integration: "native_plus_contract", evidence: "src/application/editorialPlan.ts" },
  { id: "single-creative-look", integration: "native_plus_contract", evidence: "src/render/creativeFilters.ts" },
  { id: "motivated-transitions", integration: "native_plus_contract", evidence: "src/application/editorialPlan.ts" },
  { id: "layered-audio-design", integration: "native_plus_contract", evidence: "src/application/editorialPlan.ts" },
  { id: "frame-quantized-motion", integration: "native_enforced", evidence: "src/motion/composition.ts" },
  { id: "tracking-confidence-loss", integration: "native_enforced", evidence: "src/application/motionTracking.ts" },
  { id: "atomic-project-update", integration: "native_enforced", evidence: "src/application/projectFiles.ts" },
  { id: "quality-state-honesty", integration: "contract_enforced", evidence: "src/application/autopilotPlan.ts" },
  { id: "artifact-and-outcome-contract", integration: "contract_enforced", evidence: "src/application/editorialPlan.ts" },
  { id: "format-specific-builder", integration: "orchestrator_only", evidence: "MCP plan source receipt" },
  { id: "quality-95-human-review", integration: "orchestrator_only", evidence: "MCP plan quality state" },
  { id: "publish-hub-lifecycle", integration: "orchestrator_only", evidence: "MCP plan source receipt" },
  { id: "outcome-learning", integration: "orchestrator_only", evidence: "MCP learning-event handoff" },
  { id: "model-capability-routing", integration: "contract_enforced", evidence: "src/application/inferencePolicy.ts" },
  { id: "markdown-json-context-separation", integration: "contract_enforced", evidence: "src/application/inferencePolicy.ts" },
  { id: "model-independent-semantic-audit", integration: "native_plus_contract", evidence: "src/mcp/autopilotTools.ts" },
  { id: "material-multimodal-evidence", integration: "native_plus_contract", evidence: "src/application/materialIntelligence.ts" },
  { id: "session-subscription-no-editor-api-key", integration: "native_enforced", evidence: "src/mcp/materialIntelligenceTools.ts" },
  { id: "editorial-unit-cardinality", integration: "native_plus_contract", evidence: "src/application/skillEditorialBatch.ts" },
  { id: "dynamic-hard-rule-coverage", integration: "contract_enforced", evidence: "scripts/video-autopilot-rule-coverage-gate.mjs" },
  { id: "anonymous-aesthetic-standard", integration: "native_plus_contract", evidence: "src/application/editkinAesthetic.ts" },
  { id: "anonymous-community-knowledge", integration: "native_plus_contract", evidence: "src/application/communityKnowledge.ts" },
  { id: "bounded-runtime-loading", integration: "native_enforced", evidence: "scripts/bundle-size-gate.mjs" },
  { id: "dynamic-plugin-capabilities", integration: "native_plus_contract", evidence: "src/mcp/pluginTools.ts" },
  { id: "declarative-skill-pack-selection", integration: "native_plus_contract", evidence: "src/plugins/skillPack.ts" },
  { id: "plugin-command-provenance", integration: "native_plus_contract", evidence: "src/plugins/automationContract.ts" },
  { id: "roto-keyer-evidence-routing", integration: "native_plus_contract", evidence: "src/application/rotoKeyerAutopilot.ts" },
] as const;

export const AUTOPILOT_CONTRACT = {
  schemaVersion: 4,
  product: "Editkin",
  productVersion: "0.15.0",
  planSchema: AUTOPILOT_PLAN_SCHEMA,
  planHashAlgorithm: "sha256-canonical-json-utf8-keys-v1",
  legacyPlanSchemas: [AUTOPILOT_PLAN_SCHEMA_V3, AUTOPILOT_PLAN_SCHEMA_V2, AUTOPILOT_PLAN_SCHEMA_V1],
  sourcePolicy: {
    dynamicCanonicalSkill: true,
    packagePrivateSkillOrMemory: false,
    packageAnonymousAestheticMemory: true,
    maxContextTokens: AUTOPILOT_MAX_CONTEXT_TOKENS,
    maxSelectedMemoryRules: AUTOPILOT_MAX_MEMORY_RULES,
    maxCommands: AUTOPILOT_MAX_COMMANDS,
    maxPlanBytes: AUTOPILOT_MAX_PLAN_BYTES,
    contextProtocol: AUTOPILOT_CONTEXT_PROTOCOL,
    modelProfilesAreClaimsNotTrustBoundaries: true,
    semanticGateIndependentOfModel: true,
    productAuditApplyCurrentPlanOnly: true,
    legacyPlanPolicy: "import_only_reject_audit_apply",
    liveInvocationIdentityRequired: true,
  },
  planes: [
    { id: "control", role: "source and memory receipt plus bounded contract", integration: "bridge" },
    { id: "decision", role: "route, brief, beats, packaging and selected memory IDs", integration: "bridge" },
    { id: "design", role: "captions, semantic graphics, transitions, audio, grade, motion and tracking", integration: "native_plus_bridge" },
    { id: "asset", role: "licensed metadata search and portable semantic asset IDs", integration: "native_plus_bridge" },
    { id: "execution", role: "EditGraph, Rust planning and FFmpeg render", integration: "native" },
    { id: "evidence", role: "two-phase plan receipt, review state and outcome handoff", integration: "native_plus_bridge" },
  ],
  ruleFamilies: AUTOPILOT_RULE_FAMILIES,
  aesthetic: compactAestheticContract(),
  skillDependencies: skillIntegrationLedger.dependencies.map(({ skillId, integration, scope }) => ({ skillId, integration, scope })),
  communityKnowledge: communityKnowledgeSummary(),
} as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const memoryRuleIdSchema = z.string().regex(/^(?:M\d{1,4}|K-[a-f0-9]{12})$/i);
const routeSchema = z.strictObject({
  mode: z.enum(["plan", "build", "audit", "learn", "outcome"]),
  format: z.enum(["longform", "shorts", "reels", "vlog", "podcast", "interview", "ai_short_drama"]),
  domain: z.string().trim().min(1).max(64),
});
const budgetSchema = z.strictObject({
  contextTokens: z.number().int().min(1).max(AUTOPILOT_MAX_CONTEXT_TOKENS),
  selectedMemoryRuleIds: z.array(memoryRuleIdSchema).max(AUTOPILOT_MAX_MEMORY_RULES),
  trimmedMemoryRuleCount: z.number().int().nonnegative(),
  assetCandidateCount: z.number().int().min(0).max(64),
});
const assuranceSchema = z.strictObject({
  originalAssetsReadOnly: z.literal(true), structuredCommandsOnly: z.literal(true), semanticAssetsOnly: z.literal(true),
  licenseFailClosed: z.literal(true), captionsSeparateFromGraphics: z.literal(true), reviewDoesNotEqualCertification: z.literal(true),
});
const qualitySchema = z.strictObject({
  state: z.enum(["draft", "machine_checked", "review_required"]),
  humanReviewId: z.string().trim().min(1).max(128).optional(),
});
const materialEvidenceSchema = z.strictObject({
  schema: z.literal("hao.editkin.material-intelligence/v1"),
  receipts: z.array(z.strictObject({
    materialId: sha256Schema,
    sourceSha256: sha256Schema,
    assetId: z.string().trim().min(1).max(256),
    clipId: z.string().trim().min(1).max(256),
    semanticReceiptSha256: sha256Schema,
  })).min(1).max(32),
});

export const currentAutopilotPlanSchema = z.strictObject({
  schema: z.literal(AUTOPILOT_PLAN_SCHEMA),
  source: z.strictObject({
    skillId: z.literal("video-autopilot"), revision: z.number().int().nonnegative(), skillSha256: sha256Schema,
    workflowContractRevision: z.number().int().positive(), workflowContractSha256: sha256Schema,
    knowledgeRevision: z.number().int().positive(), knowledgeSha256: sha256Schema, stableRulesSha256: sha256Schema,
    pluginRegistrySha256: sha256Schema, invocationBindingSha256: sha256Schema,
  }),
  route: routeSchema,
  budget: budgetSchema,
  assurances: assuranceSchema,
  quality: qualitySchema,
  inference: inferenceRunSchema,
  materialEvidence: materialEvidenceSchema,
  extensions: z.strictObject({
    skillSelection: editkinSkillSelectionReceiptSchema,
    pluginApplications: z.array(pluginAutomationApplicationSchema).max(16),
  }),
  rotoKeyer: rotoKeyerPlanSchema.optional(),
  autoColor: autoColorBindingsSchema.optional(),
  // Historical plans remain readable; current product audit/apply requires this.
  designEvidence: designEvidenceSchema.optional(),
  aesthetic: aestheticSystemSchema,
  editorial: editorialPlanSchema,
  commands: z.array(editorCommandSchema).min(1).max(AUTOPILOT_MAX_COMMANDS),
});

export const legacyAutopilotPlanV3Schema = z.strictObject({
  schema: z.literal(AUTOPILOT_PLAN_SCHEMA_V3),
  source: z.strictObject({
    skillId: z.literal("video-autopilot"), revision: z.number().int().nonnegative(), skillSha256: sha256Schema,
    knowledgeRevision: z.number().int().nonnegative(), knowledgeSha256: sha256Schema,
  }),
  route: routeSchema,
  budget: budgetSchema,
  assurances: assuranceSchema,
  quality: qualitySchema,
  inference: inferenceRunSchema,
  editorial: editorialPlanSchema,
  commands: z.array(editorCommandSchema).min(1).max(AUTOPILOT_MAX_COMMANDS),
});

export const legacyAutopilotPlanV2Schema = z.strictObject({
  schema: z.literal(AUTOPILOT_PLAN_SCHEMA_V2),
  source: z.strictObject({
    skillId: z.literal("video-autopilot"), revision: z.number().int().nonnegative(), skillSha256: sha256Schema,
    knowledgeRevision: z.number().int().nonnegative(), knowledgeSha256: sha256Schema,
  }),
  route: routeSchema,
  budget: budgetSchema,
  assurances: assuranceSchema,
  quality: qualitySchema,
  editorial: editorialPlanSchema,
  commands: z.array(editorCommandSchema).min(1).max(AUTOPILOT_MAX_COMMANDS),
});

export const legacyAutopilotPlanV1Schema = z.strictObject({
  schema: z.literal(AUTOPILOT_PLAN_SCHEMA_V1),
  source: z.strictObject({ skillId: z.literal("video-autopilot"), revision: z.number().int().nonnegative(), skillSha256: sha256Schema }),
  route: routeSchema,
  budget: budgetSchema,
  assurances: assuranceSchema,
  quality: qualitySchema,
  commands: z.array(editorCommandSchema).min(1).max(AUTOPILOT_MAX_COMMANDS),
});

export const autopilotPlanSchema = z.union([currentAutopilotPlanSchema, legacyAutopilotPlanV3Schema, legacyAutopilotPlanV2Schema, legacyAutopilotPlanV1Schema]);
export type CurrentAutopilotPlan = z.infer<typeof currentAutopilotPlanSchema>;
export type LegacyAutopilotPlanV3 = z.infer<typeof legacyAutopilotPlanV3Schema>;
export type LegacyAutopilotPlanV2 = z.infer<typeof legacyAutopilotPlanV2Schema>;
export type LegacyAutopilotPlanV1 = z.infer<typeof legacyAutopilotPlanV1Schema>;
export type AutopilotPlan = CurrentAutopilotPlan | LegacyAutopilotPlanV3 | LegacyAutopilotPlanV2 | LegacyAutopilotPlanV1;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isCurrentAutopilotPlan(plan: AutopilotPlan): plan is CurrentAutopilotPlan {
  return plan.schema === AUTOPILOT_PLAN_SCHEMA;
}

const NATIVE_GRAPHIC_KINDS = {
  title_card: new Set(["title"]),
  context_card: new Set(["card"]),
  tracked_value_label: new Set(["tag"]),
  challenge_ledger: new Set(["counter"]),
  telemetry_callout: new Set(["tag", "card"]),
  proof_freeze: new Set(["card"]),
  scale_ladder: new Set(["counter", "card"]),
  map: new Set(["card"]),
  diagram: new Set(["card"]),
  lower_third_name: new Set(["card"]),
  lower_third_affiliation: new Set(["tag"]),
} as const;

function assertVisibleEditorialExecution(plan: CurrentAutopilotPlan): void {
  const graphicCommands = plan.commands
    .filter((command): command is Extract<EditorCommand, { type: "add_motion_graphic" }> => command.type === "add_motion_graphic")
    .map((command) => command.graphic);
  const commandById = new Map(graphicCommands.map((graphic) => [graphic.id, graphic]));
  const aestheticCommands = plan.commands.filter((command): command is Extract<EditorCommand, { type: "set_aesthetic_system" }> => command.type === "set_aesthetic_system");
  if (aestheticCommands.length !== 1) throw new Error("v4 Build 必須正好一次套用匿名美感標準");
  if (aestheticCommands[0].aestheticSystem.sourceSha256 !== plan.aesthetic.sourceSha256
    || aestheticCommands[0].aestheticSystem.primaryFamily !== plan.aesthetic.primaryFamily) {
    throw new Error("美感計畫與 set_aesthetic_system 執行命令不一致");
  }
  if (plan.aesthetic.review.status === "PASSED") throw new Error("AI 計畫不可代替人類把美感標成 PASSED");

  const shortGameBuild = plan.route.mode === "build"
    && (plan.route.format === "shorts" || plan.route.format === "reels")
    && /game|gaming|toy|陀螺|戰鬥|對戰/i.test(`${plan.route.domain} ${plan.editorial.brief.premise}`);
  if (shortGameBuild && plan.editorial.graphics.length === 0) {
    throw new Error("遊戲／玩具直式 Build 不可提交空 graphics；至少要有可見主標與語意 HUD");
  }

  if (shortGameBuild && !plan.editorial.graphics.some((event) => event.kind === "title_card")) {
    throw new Error("遊戲／玩具直式 Build 缺少 title_card，首屏承諾沒有可見原生圖層");
  }

  const challengeLanguage = /(?:\d+|[一二三四五六七八九十百]+)\s*(?:局|輪|關|次)|\b\d+\s*(?:rounds?|matches?|stages?)\b|挑戰|challenge/i.test([
    plan.editorial.brief.premise,
    plan.editorial.brief.stakes,
    plan.editorial.narrative.backbone,
    ...plan.editorial.packaging.hypotheses.map((item) => `${item.title} ${item.thumbnailPromise}`),
  ].join(" "));
  if (shortGameBuild && challengeLanguage && !plan.editorial.graphics.some((event) => event.kind === "challenge_ledger")) {
    throw new Error("多局／挑戰型直式 Build 缺少 challenge_ledger，觀眾無法看見進度狀態");
  }

  for (const event of plan.editorial.graphics) {
    if (event.kind === "subject_sheen" || event.kind === "money_burst") {
      throw new Error(`${event.kind} 尚無原生像素執行器，不可只寫進 editorial plan 後假裝已渲染`);
    }
    const graphic = commandById.get(event.id);
    if (!graphic) throw new Error(`editorial graphic 沒有對應 add_motion_graphic 命令：${event.id}`);
    if (event.presetVariant) assertMotionPresetVariantBinding(graphic, event.presetId, event.presetVariant);
    else assertMotionGraphicPresetBinding(graphic, event.presetId);
    const allowedKinds = NATIVE_GRAPHIC_KINDS[event.kind];
    if (!allowedKinds.has(graphic.kind as never)) {
      throw new Error(`editorial graphic ${event.id} 的原生 kind 不符：${event.kind} -> ${graphic.kind}`);
    }
    if (graphic.text.trim() !== event.message.trim()) {
      throw new Error(`editorial graphic ${event.id} 的可見文字與計畫 message 不一致`);
    }
    if (event.trackingId && graphic.trackId !== event.trackingId) {
      throw new Error(`editorial graphic ${event.id} 沒有綁定計畫要求的 trackingId`);
    }
  }
}

function assertLowerThirdEvidenceReceiptBinding(plan: CurrentAutopilotPlan): void {
  const graphicIds = new Set<string>();
  const groups = new Map<string, typeof plan.editorial.graphics>();
  const lowerThirdEventIds = new Set<string>();
  for (const event of plan.editorial.graphics) {
    if (graphicIds.has(event.id)) throw new Error(`v4 editorial graphic id 不可重複：${event.id}`);
    graphicIds.add(event.id);
    if (event.kind !== "lower_third_name" && event.kind !== "lower_third_affiliation") continue;
    lowerThirdEventIds.add(event.id);
    const suffix = event.kind === "lower_third_name" ? "_name" : "_unit";
    const family = event.presetId.endsWith(suffix) ? event.presetId.slice(0, -suffix.length) : "";
    const key = `${family}\u0000${event.range.startFrame}\u0000${event.range.endFrame}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  for (const group of groups.values()) {
    const names = group.filter((event) => event.kind === "lower_third_name");
    const affiliations = group.filter((event) => event.kind === "lower_third_affiliation");
    if (names.length !== 1 || affiliations.length !== 1) {
      throw new Error("人物字幕條的人名 BAR 與單位 BAR 必須使用同系列 preset 並一對一出現");
    }
    const nameRefs = [...new Set(names[0].evidenceRefs)].sort();
    const affiliationRefs = [...new Set(affiliations[0].evidenceRefs)].sort();
    if (nameRefs.length !== names[0].evidenceRefs.length || affiliationRefs.length !== affiliations[0].evidenceRefs.length
      || nameRefs.length !== affiliationRefs.length || nameRefs.some((reference, index) => reference !== affiliationRefs[index])) {
      throw new Error("人物字幕條配對必須共享同一組且不重複的 identity evidence refs");
    }
  }
  for (const command of plan.commands) {
    if (command.type !== "add_motion_graphic") continue;
    const presetId = command.graphic.presetId ?? "";
    if ((presetId.startsWith("lower_third_") || presetId.startsWith("editkin.lower-third/")) && !lowerThirdEventIds.has(command.graphic.id)) {
      throw new Error(`人物字幕條 command ${command.graphic.id} 沒有 evidence-bound editorial identity event`);
    }
  }
  for (const event of plan.editorial.graphics) {
    if (event.kind !== "lower_third_name" && event.kind !== "lower_third_affiliation") continue;
    for (const reference of event.evidenceRefs) {
      const parsed = parseLowerThirdEvidenceReference(reference);
      if (!parsed) throw new Error(`人物字幕條 ${event.id} 證據必須是 material semantic transcript cue 的 canonical identity evidence ref`);
      const carried = plan.materialEvidence.receipts.some((receipt) => receipt.materialId === parsed.materialId
        && receipt.semanticReceiptSha256 === parsed.semanticReceiptSha256);
      if (!carried) throw new Error(`人物字幕條 ${event.id} 的 evidence ref 沒有解析到 plan 隨附的 material semantic receipt`);
    }
  }
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-7;
}

/**
 * Bind frame-addressed editorial intent to the project's second-addressed
 * native command.  Parsing alone cannot do this honestly because a v4 plan
 * does not carry an authoritative project fps; audit/apply call this with the
 * live project fps before any mutation.
 */
export function assertAutopilotProjectTimelineBinding(plan: CurrentAutopilotPlan, projectFps: number): void {
  if (!Number.isFinite(projectFps) || projectFps <= 0) throw new Error("Autopilot project fps 不合法，無法綁定 editorial frame range");
  const commands = plan.commands.filter((command): command is Extract<EditorCommand, { type: "add_motion_graphic" }> => command.type === "add_motion_graphic");
  for (const event of plan.editorial.graphics) {
    const lowerThird = event.kind === "lower_third_name" || event.kind === "lower_third_affiliation";
    if (!lowerThird && !event.presetVariant) continue;
    const label = lowerThird ? "人物字幕條" : "圖文變體";
    const matches = commands.filter((command) => command.graphic.id === event.id);
    if (matches.length !== 1) throw new Error(`${label} ${event.id} 必須正好綁定一個 add_motion_graphic command`);
    const graphic = matches[0].graphic;
    if (event.presetVariant) assertMotionGraphicV2Contract(graphic, projectFps);
    const expectedStart = event.range.startFrame / projectFps;
    const expectedEnd = event.range.endFrame / projectFps;
    const fullDuration = expectedEnd - expectedStart;
    const unitDelay = Math.min(
      LOWER_THIRD_UNIT_STAGGER_SECONDS,
      Math.max(0, fullDuration - 1 / projectFps),
    );
    const intendedStart = event.kind === "lower_third_affiliation" ? expectedStart + unitDelay : expectedStart;
    const intendedDuration = event.kind === "lower_third_affiliation" ? fullDuration - unitDelay : fullDuration;
    if (!closeEnough(graphic.timelineStart, intendedStart) || !closeEnough(graphic.duration, intendedDuration)
      || !closeEnough(graphic.timelineStart + graphic.duration, expectedEnd)) {
      throw new Error(`${label} ${event.id} 的 add_motion_graphic 時間沒有忠實對應 editorial frame range（單位 BAR 固定最多延遲 ${LOWER_THIRD_UNIT_STAGGER_SECONDS}s，結束幀必須相同）`);
    }
  }
}

export function parseAutopilotPlan(input: unknown): AutopilotPlan {
  if (byteLength(input) > AUTOPILOT_MAX_PLAN_BYTES) throw new Error(`Autopilot plan 超過 ${AUTOPILOT_MAX_PLAN_BYTES} bytes`);
  const plan = autopilotPlanSchema.parse(input);
  if (new Set(plan.budget.selectedMemoryRuleIds).size !== plan.budget.selectedMemoryRuleIds.length) throw new Error("Autopilot plan 含重複 memory rule id");
  if (isCurrentAutopilotPlan(plan)) {
    if (plan.budget.contextTokens !== plan.inference.context.packetTokens) {
      throw new Error("Autopilot context Token budget 與 inference packet receipt 不一致");
    }
    const expectedRouter = inferenceRouterSha256(renderInferenceRouterMarkdown(plan.inference.taskClass, plan.inference.priority));
    if (plan.inference.context.markdownRouterSha256 !== expectedRouter) throw new Error("Autopilot Markdown router hash 與標準 bounded packet 不一致");
    if (plan.route.mode === "build") assertBuildNarrative(plan.editorial);
    assertVisibleEditorialExecution(plan);
    assertLowerThirdEvidenceReceiptBinding(plan);
    assertMotionTreatmentBinding(plan.editorial.motionTreatment, plan.commands as EditorCommand[], plan.editorial.narrative.beats.map(beat => beat.id));
    if (plan.designEvidence) assertDesignDecisionBinding(plan.designEvidence, plan.commands as EditorCommand[], plan.editorial.narrative.beats.map(beat => beat.id));
    assertRotoKeyerPlanCommandBinding(plan.rotoKeyer, plan.commands as EditorCommand[], plan.quality.state, plan.budget.contextTokens);
    assertAutoColorCommandBinding(plan.autoColor, plan.commands as EditorCommand[]);
    const materialIds = plan.materialEvidence.receipts.map((receipt) => receipt.materialId);
    if (new Set(materialIds).size !== materialIds.length) throw new Error("Autopilot plan 含重複 material receipt");
    assertRotoKeyerMaterialEvidenceBinding(plan.rotoKeyer, plan.materialEvidence.receipts);
    const skillSelection = assertEditkinSkillSelectionReceiptIntegrity(plan.extensions.skillSelection);
    if (skillSelection.pluginRegistrySha256 !== plan.source.pluginRegistrySha256) throw new Error("Skill selection 與 plan source 的 plugin registry 不一致");
    if (skillSelection.context.format !== editkinSkillFormatForAutopilotRoute(plan.route.format) || skillSelection.context.domain !== plan.route.domain) {
      throw new Error("Skill selection context 與 Autopilot route 不一致");
    }
    const applicationIndexes = plan.extensions.pluginApplications.flatMap((application) => application.commandIndexes);
    if (new Set(applicationIndexes).size !== applicationIndexes.length) throw new Error("多個 plugin application 綁定到同一 command index");
  }
  return plan;
}

export function autopilotPlanSha256(plan: AutopilotPlan): string {
  // The wire author's property order is not preserved by schema parsing.
  // Canonical UTF-8 key order binds content and array order, not insertion order.
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

export function autopilotCommands(plan: AutopilotPlan): EditorCommand[] {
  return plan.commands as EditorCommand[];
}

export function autopilotPlanCoverage(plan: AutopilotPlan) {
  if (isCurrentAutopilotPlan(plan)) {
    return { level: "current_multimodal_editorial_contract", legacy: false, inference: summarizeInference(plan.inference), materialReceiptCount: plan.materialEvidence.receipts.length, selectedSkillPackCount: plan.extensions.skillSelection.selected.length, pluginApplicationCount: plan.extensions.pluginApplications.length, rotoKeyerDecisionCount: plan.rotoKeyer?.decisions.length ?? 0, editorial: summarizeEditorialPlan(plan.editorial), motionTreatment: summarizeMotionTreatment(plan.editorial.motionTreatment, plan.commands as EditorCommand[]) };
  }
  if (plan.schema === AUTOPILOT_PLAN_SCHEMA_V3) {
    return { level: "legacy_model_adaptive_compatibility_only", legacy: true, inference: summarizeInference(plan.inference), editorial: summarizeEditorialPlan(plan.editorial), missing: ["material keyframe receipt", "transcript evidence", "source-bound semantic receipt"] };
  }
  if (plan.schema === AUTOPILOT_PLAN_SCHEMA_V2) {
    return { level: "legacy_editorial_compatibility_only", legacy: true, editorial: summarizeEditorialPlan(plan.editorial), missing: ["model and reasoning receipt", "Markdown router hash", "automatic escalation policy"] };
  }
  return { level: "legacy_compatibility_only", legacy: true, missing: ["editorial", "knowledge receipt", "model and reasoning receipt", "packaging", "outcome checkpoints"] };
}

export function compactAutopilotContract() {
  return {
    schemaVersion: AUTOPILOT_CONTRACT.schemaVersion,
    productVersion: AUTOPILOT_CONTRACT.productVersion,
    planSchema: AUTOPILOT_CONTRACT.planSchema,
    planHashAlgorithm: AUTOPILOT_CONTRACT.planHashAlgorithm,
    legacyPlanSchemas: AUTOPILOT_CONTRACT.legacyPlanSchemas,
    sourcePolicy: AUTOPILOT_CONTRACT.sourcePolicy,
    planes: AUTOPILOT_CONTRACT.planes,
    ruleFamilies: AUTOPILOT_CONTRACT.ruleFamilies.map(({ id, integration }) => ({ id, integration })),
    aesthetic: AUTOPILOT_CONTRACT.aesthetic,
    designExecution: {
      tool: "get_autopilot_design_brief", planPath: "designEvidence", schema: "editkin.autopilot-design-evidence/v1",
      pages: "context, then beat:<id> for each narrative beat; follow nextOffset until hasMore=false",
      policy: "Required for current audit/apply. Compile current private Skill design DNA and learning, bind identity plus request and every recipeSha256 to real visual/audio commandIndexes. Declare all ten editorial.motionTreatment families. Sources are recompiled at audit and apply, including memory-only changes. Historical plans remain readable; command provenance is not a human aesthetic score.",
    },
    motion: {
      ...EDITKIN_MOTION,
      discover: "list_creative_presets",
      indexArguments: { kind: "motion" },
      inspectArgument: "motionPresetId",
      presetVariant: { schema: "editkin.motion-preset-variant/v1", planPath: "editorial.graphics[].presetVariant", descriptor: "presets.motionPresetVariant", policy: "Optional v2-only explicit visual overrides bound to the registered seed SHA-256. Unchanged stock presets retain exact binding; resolved commands, event timing and engine limits are still checked." },
      treatmentSchema: "editkin.motion-treatment/v1",
      treatmentPath: "editorial.motionTreatment",
      families: MOTION_TREATMENT_FAMILIES,
      policy: "Use the latest Skill and source semantics to consider every family. Each use/omit needs a reason; use binds beatIds and actual commandIndexes. Missing treatment is REVIEW_REQUIRED, not complete aesthetic integration. Keep all edits in the audited v4 plan; no pre-audit apply_creative_preset.",
    },
    skillDependencies: AUTOPILOT_CONTRACT.skillDependencies,
    communityKnowledge: AUTOPILOT_CONTRACT.communityKnowledge,
    primaryExposureAutomation: {
      propose: "propose_auto_color_exposure", binding: "autoColor[{decisionSha256,commandIndex,clipId}]",
      scope: "Measured static primary exposure before creative looks; explicit editorial luminance target, not inferred correct exposure. WB, full shot matching and aesthetics remain unmeasured. Audit/apply revalidate source, configuration, baseline and exact command.",
    },
    referenceWhiteBalance: {
      propose: "propose_reference_white_balance", binding: "autoColor[{mode:reference_white_balance,decisionSha256,commandIndex,clipId}]",
      scope: "Caller-declared neutral ROIs in first/last upright source samples; source-derived FLOAT linear Rec709 gains before tone/look, not post-tone RGB8 or artistic temperature/tint. maxGainStops bounds the baseline-relative log2 change; command whiteBalanceRed/Green/Blue are absolute stops. Only applicable=true can pass audit/apply. Not automatic white-point discovery, Kelvin calibration, skin protection or final-frame aesthetics. Preserves exposure and creative controls; independent decisions on one clip cannot be stacked in one plan.",
      reviewRequired: true,
    },
    pluginAutomation: {
      discovery: "list_installed_plugins",
      inspect: "get_plugin_capability",
      compileReadOnly: "compile_plugin_application",
      policy: "Only automation-ready capabilities discovered during planning may be compiled read-only into the same v4 plan. Audit re-compiles exact command indexes and apply is the only mutation boundary.",
    },
    skillPackAutomation: {
      schemas: ["hao.editkin.skill-pack/v1", "hao.editkin.workflow-profile/v1", "hao.video-autopilot.skill-selection-receipt/v1"],
      discovery: "list_installed_editkin_skills",
      inspect: "get_editkin_skill_pack",
      resolve: "resolve_editkin_skill_workflow",
      policy: "Third-party packs are declarative planning data, require exact manifest/pack grants, cannot name tools or raw commands, and never mutate the Video Autopilot trunk.",
    },
    rotoKeyerAutomation: {
      schema: "hao.video-autopilot.roto-keyer-plan/v1",
      inspect: "inspect_roto_keyer_capabilities",
      evidence: "record_roto_keyer_evidence",
      bindManualNoOpOrKeyer: "build_autopilot_roto_keyer_decision",
      prepareSelfAuthoredAutoRoto: "prepare_autopilot_auto_roto",
      routes: ["no_op", "manual_mask", "self_authored_auto_roto", "self_authored_screen_keyer"],
      policy: "Only evidence-bound, product-eligible Editkin-owned routes may enter the v4 plan. Ambiguous/no-screen observations cannot auto-key; every result remains editable and review_required.",
    },
    modelRouting: {
      principle: "Model identity never bypasses schema or semantic audit. Unmeasured profiles cannot direct-apply; quality-critical work requires a second semantic pass.",
      contextProtocol: AUTOPILOT_CONTEXT_PROTOCOL,
      qualityClaim: "unmeasured_until_same-provenance_model-matrix",
    },
    boundary: "The current video-autopilot skill supplies dynamic decisions; Editkin validates and executes a bounded editorial contract. Private skill text and memory are never frozen into the installer.",
  };
}
