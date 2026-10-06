import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { summarizeProject } from "../domain/editGraph";
import { findAsset } from "../domain/editGraph";
import { basename, resolve } from "node:path";
import { readBoundedFile } from "../shared/boundedFile";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { applyCommand } from "../domain/commands";
import { readCreatorReviewPolicy, assertCreatorReviewPolicyCurrent, assertProjectReviewPolicy } from "./creatorReviewPolicy";
import {
  autopilotCommands,
  autopilotPlanCoverage,
  autopilotPlanSchema,
  autopilotPlanSha256,
  assertAutopilotProjectTimelineBinding,
  getPlanOriginalMotionSources,
  compactAutopilotContract,
  type CurrentAutopilotPlan,
  parseAutopilotPlan,
} from "../application/autopilotPlan";
import {
  assertAutopilotPlanSourceCurrent,
  autopilotAuditReceiptSchema,
  autopilotPlanSourceFromIdentity,
  consumeAcceptedAutopilotAuditReceipt,
  createAcceptedAutopilotAuditReceipt,
  createAutopilotProjectAuditIdentity,
  readLiveAutopilotIdentity,
  verifyAcceptedAutopilotAuditReceipt,
  sha256Canonical,
} from "../application/autopilotInvocationIdentity";
import { prepareOriginalMotionCommitAuthority, verifyOriginalMotionCommitAuthority } from "../application/originalMotionCommitAuthority";
import {
  inferencePrioritySchema,
  inferenceRouterSha256,
  inferenceTaskClassSchema,
  recommendInferenceRoute,
  renderInferenceRouterMarkdown,
  summarizeInference,
} from "../application/inferencePolicy";
import { autopilotOutcomeSchema, learningHandoff } from "../application/autopilotEvidence";
import { verifyCurrentAutopilotMaterialEvidence } from "../application/autopilotMaterialEvidence";
import { listCommunityKnowledge, readCommunityKnowledge } from "../application/communityKnowledge";
import { defaultRotoKeyerRuntimePaths, verifyRotoKeyerPlanForProject } from "../application/rotoKeyerAutopilot";
import {
  discoverInstalledPlugins,
  installedSkillPackCandidates,
  pluginRegistryIdentity,
  resolveSkillCapabilityQueries,
  verifyPluginAutomationApplications,
} from "../plugins/registry";
import { editkinSkillFormatForAutopilotRoute, verifyEditkinSkillSelectionReceipt } from "../plugins/skillPack";
import { assertSelectionUsesHostWorkflowProfile, readHostWorkflowProfile } from "../plugins/workflowProfileFileStore";
import {
  commitAutopilotReceipt,
  readAutopilotExecutionAttribution,
  readProject,
  resolveProjectPath,
  writeAutopilotLearningEvent,
  writePendingAutopilotReceipt,
  writeProject,
  resolveWorkspaceMediaPath,
  workspaceRoot,
} from "./storage";
import { creativePackRoot, personalMusicRoot, personalVisualRoot } from "./toolRuntime";
import { verifyAutoColorDecisions } from "../application/autoColorEvidence";
import { autoColorRuntime } from "./autoColorTools";
import { registerAutopilotDesignTools, verifyAutopilotDesign } from "./autopilotDesignTools";
import { verifyCurrentOriginalMotionEvidence } from "./originalMotionWorkflow";
import type { OriginalSourceOwnerRevisionProof } from "../domain/originalSourceOwnerRevision";
import type { EditorCommand } from "../domain/commandTypes";

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  };
}

/** A successful project write is not itself a committed execution receipt.
 * Read the exact file returned by the commit, and keep the response projection
 * equal to its persisted content. The issuer seal remains an internal proof. */
async function readCommittedAutopilotResponseReceipt(
  pendingPath: string,
  receiptFile: string,
  expected: Record<string, unknown>,
) {
  if (!pendingPath.endsWith(".pending.json")) throw new Error("Autopilot response requires an owned pending receipt path");
  const committedPath = pendingPath.replace(/\.pending\.json$/, ".committed.json");
  if (receiptFile !== basename(committedPath)) throw new Error("Autopilot committed receipt filename differs from the pending receipt");
  const path = await resolveWorkspaceMediaPath(committedPath);
  // The writer has no fixed document ceiling. Bound this read by the exact
  // expected serialization, with room for only its fixed-size original seal
  // (strict schema/scope, key identity and fixed-size hex proofs), not a new plan cap.
  const expectedCommitted = { ...expected, state: "committed" };
  const maxBytes = Buffer.byteLength(`${JSON.stringify(expectedCommitted, null, 2)}\n`, "utf8") + (expected.originalMotionBinding ? 512 : 0);
  const observed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(path, maxBytes)));
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) throw new Error("Autopilot committed receipt is not an object");
  const persisted = observed as Record<string, unknown>;
  if (persisted.schema !== "hao.video-autopilot.execution-receipt/v1" || persisted.state !== "committed") {
    throw new Error("Autopilot persisted receipt must have committed state");
  }
  const { issuerSeal: _issuerSeal, ...responseReceipt } = persisted;
  if (sha256Canonical(responseReceipt) !== sha256Canonical(expectedCommitted)) {
    throw new Error("Autopilot persisted receipt differs from the committed response identity or content");
  }
  if (expected.originalMotionBinding) await verifyOriginalMotionCommitAuthority(persisted);
  return { ...responseReceipt, receiptFile };
}

export function materialCacheRoot(): string {
  const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models");
  return process.env.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache");
}

async function resolveAutopilotAssetSource(project: Awaited<ReturnType<typeof readProject>>, assetId: string): Promise<string> {
  const asset = findAsset(project, assetId);
  const creativeId = creativeAssetIdFromUri(asset.uri);
  if (creativeId) return (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath;
  return resolveWorkspaceMediaPath(asset.uri);
}

function parseProductAutopilotPlan(input: unknown): CurrentAutopilotPlan {
  const plan = parseAutopilotPlan(input);
  if (plan.schema !== "hao.video-autopilot.edit-plan/v4") {
    throw new Error(`${plan.schema} 僅供匯入相容；產品 audit/apply 只接受 hao.video-autopilot.edit-plan/v4`);
  }
  autopilotCommands(plan);
  return plan;
}

async function verifyCurrentMaterialEvidence(plan: CurrentAutopilotPlan, project: Awaited<ReturnType<typeof readProject>>, signal?: AbortSignal,
  revisionAuthority?: { batch: EditorCommand; capture: (proof: OriginalSourceOwnerRevisionProof) => void }) {
  signal?.throwIfAborted();
  assertAutopilotProjectTimelineBinding(plan, project.fps);
  const exactPlanBatch: Extract<EditorCommand, { type: "batch" }> = { type: "batch", commands: autopilotCommands(plan) };
  if (revisionAuthority && sha256Canonical(revisionAuthority.batch) !== sha256Canonical(exactPlanBatch)) {
    throw new Error("Original revision host authority must use this exact plan batch");
  }
  const prediction: { proof?: OriginalSourceOwnerRevisionProof } = {};
  const original = await verifyCurrentOriginalMotionEvidence(plan, project, signal, { batch: exactPlanBatch,
    capture: proof => { prediction.proof = proof; revisionAuthority?.capture(proof); } });
  const media = plan.materialEvidence.schema === "hao.editkin.material-intelligence/v1" ? await verifyCurrentAutopilotMaterialEvidence(plan.materialEvidence, project, {
    cacheRoot: materialCacheRoot(),
    resolveSource: (assetId) => resolveAutopilotAssetSource(project, assetId),
    ffprobePath: process.env.HAO_FFPROBE_PATH, signal,
  }, plan.editorial.graphics, plan.editorial.audio.mode === "silent_media" ? { audio: plan.editorial.audio, commands: autopilotCommands(plan) } : undefined,
    prediction.proof ? { batch: exactPlanBatch, originalSourceOwnerRevisionProof: prediction.proof } : undefined) : undefined;
  signal?.throwIfAborted();
  return original ? { original, ...(media ? { media } : {}), receiptCount: media?.receiptCount ?? 0 } : media!;
}

export function registerAutopilotTools(server: McpServer): void {
  registerAutopilotDesignTools(server);
  server.registerTool("get_autopilot_contract", {
    description: "取得 Editkin 與目前 video-autopilot skill 的低 Token 整合契約；回傳規則族、最新版 model-adaptive editorial schema 與邊界，不載入私人規則全文或整個記憶庫。",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const liveIdentity = await readLiveAutopilotIdentity();
      return textResult({
        status: "GREEN",
        contract: compactAutopilotContract(),
        liveInvocation: liveIdentity,
        requiredPlanSource: autopilotPlanSourceFromIdentity(liveIdentity),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("list_community_editing_knowledge", {
    description: "分頁列出 Editkin 內建的匿名剪輯知識模組。包含節奏、演算法、美感、調色、字幕、Tracking、音訊、題材與負面案例；每次最多 16 筆 metadata，不一次塞入全文。",
    inputSchema: z.object({
      tags: z.array(z.string()).max(6).default([]),
      query: z.string().max(80).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(16).default(16),
    }),
  }, async ({ tags, query, offset, limit }) => textResult({ status: "GREEN", ...listCommunityKnowledge({ tags, query, offset, limit }) }));

  server.registerTool("read_community_editing_knowledge", {
    description: "分頁讀取一個匿名剪輯知識模組；除字元上限外另有 900 estimated-token 硬上限，供 Codex／Claude Session 低 Token 規劃。",
    inputSchema: z.object({
      moduleId: z.string().min(1).max(96),
      offset: z.number().int().nonnegative().default(0),
      maxChars: z.number().int().min(500).max(6000).default(4000),
      maxTokens: z.number().int().min(200).max(900).default(700),
    }),
  }, async ({ moduleId, offset, maxChars, maxTokens }) => {
    try { return textResult({ status: "GREEN", page: readCommunityKnowledge(moduleId, offset, maxChars, maxTokens) }); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("resolve_autopilot_inference_route", {
    description: "依剪輯任務與品質優先級回傳模型／reasoning effort 建議、第二次複核要求，以及 hash-bound Markdown 小型路由。這是官方定位加本地政策，不冒充模型品質實測；JSON plan 與語意 gate 才是執行真相。",
    inputSchema: z.object({ taskClass: inferenceTaskClassSchema, priority: inferencePrioritySchema, preferredModelId: z.string().trim().regex(/^[a-zA-Z0-9._:/-]{1,128}$/).optional() }),
  }, async ({ taskClass, priority, preferredModelId }) => {
    const route = recommendInferenceRoute(taskClass, priority, preferredModelId);
    const markdown = renderInferenceRouterMarkdown(taskClass, priority, preferredModelId);
    return textResult({ status: "GREEN", route, context: { protocol: "markdown-router+json-contract/v1", markdown, markdownRouterSha256: inferenceRouterSha256(markdown) } });
  });

  server.registerTool("audit_autopilot_plan", {
    description: "在不修改專案的情況下驗證當次 v4 plan，並綁定目前專案 revision、啟用中的 Video Autopilot Skill、workflow contract、匿名 knowledge 與已發現 plugin registry；v3/v2/v1 僅可匯入，產品路徑一律拒絕。",
    inputSchema: z.object({ projectPath: z.string(), plan: autopilotPlanSchema }),
  }, async ({ projectPath, plan: inputPlan }, context) => {
    try { return await auditAutopilotPlan(projectPath, inputPlan, context.mcpReq.signal); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("apply_autopilot_plan", {
    description: "只套用已由目前 Editkin 程序的 audit_autopilot_plan 簽發、十分鐘內且尚未使用的 v4 receipt。apply 會重算專案、啟用中的 Skill、workflow、knowledge、plugin registry 與素材 identity；任何偽造、重播、過期、竄改或 drift 都 fail-closed，通過後才單次原子寫入。",
    inputSchema: z.object({ projectPath: z.string(), plan: autopilotPlanSchema, auditReceipt: autopilotAuditReceiptSchema }),
  }, async ({ projectPath, plan: inputPlan, auditReceipt: inputAuditReceipt }, context) => {
    try { return await applyAutopilotPlan(projectPath, inputPlan, inputAuditReceipt, context.mcpReq.signal); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("record_autopilot_outcome", {
    description: "保存人工審片或 D2/D7/D28 成效為不可變 learning event，交由當次最新 video-autopilot Learn/Outcome 流程評估；單一事件不會自動升格記憶規則。",
    inputSchema: z.object({ projectPath: z.string(), outcome: autopilotOutcomeSchema }),
  }, async ({ projectPath, outcome: inputOutcome }) => {
    try {
      await readProject(projectPath);
      const outcome = autopilotOutcomeSchema.parse(inputOutcome);
      const attribution = await readAutopilotExecutionAttribution(projectPath, outcome.planSha256);
      const eventFile = await writeAutopilotLearningEvent(projectPath, { ...outcome, attribution });
      return textResult({ status: "RECORDED", eventFile, handoff: learningHandoff(outcome, attribution) });
    } catch (error) { return errorResult(error); }
  });
}

export async function auditAutopilotPlan(projectPath: string, inputPlan: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const plan = parseProductAutopilotPlan(inputPlan);
  const reviewPolicy = await readCreatorReviewPolicy();
  const [project, absoluteProjectPath, invocation, pluginRegistry, hostWorkflowProfile] = await Promise.all([
    readProject(projectPath),
    resolveProjectPath(projectPath),
    readLiveAutopilotIdentity(),
    discoverInstalledPlugins(),
    readHostWorkflowProfile(),
  ]);
  assertAutopilotPlanSourceCurrent(plan.source, invocation);
  let nativePaintOwnerRevisionProof: object | undefined;
  const design = await verifyAutopilotDesign(plan, project, undefined, { reviewPolicy: reviewPolicy.policy }, proof => { nativePaintOwnerRevisionProof = proof; });
  if (pluginRegistryIdentity(pluginRegistry).sha256 !== invocation.plugins.sha256) throw new Error("Autopilot audit 的 plugin registry snapshot 已漂移");
  const skillSelection = verifyEditkinSkillSelectionReceipt(
    plan.extensions.skillSelection,
    installedSkillPackCandidates(pluginRegistry),
    { format: editkinSkillFormatForAutopilotRoute(plan.route.format), domain: plan.route.domain, semanticRoles: plan.extensions.skillSelection.context.semanticRoles },
    invocation.plugins.sha256,
    hostWorkflowProfile.profile,
  );
  const skillCapabilities = resolveSkillCapabilityQueries(pluginRegistry, skillSelection);
  const authorizedProfile = assertSelectionUsesHostWorkflowProfile(hostWorkflowProfile, skillSelection.profileSha256, pluginRegistry);
  const pluginApplications = verifyPluginAutomationApplications(plan.extensions.pluginApplications, pluginRegistry, autopilotCommands(plan), authorizedProfile, skillSelection.compiled.guardrails);
  const auditBatch: EditorCommand = { type: "batch", commands: structuredClone(autopilotCommands(plan)) };
  let originalSourceOwnerRevisionProof: object | undefined;
  const materialEvidence = await verifyCurrentMaterialEvidence(plan, project, signal, { batch: auditBatch,
    capture: proof => { originalSourceOwnerRevisionProof = proof; } });
  const autoColor = await verifyAutoColorDecisions(plan.autoColor, autopilotCommands(plan), project, autoColorRuntime(project), plan.materialEvidence.receipts);
  const rotoKeyer = await verifyRotoKeyerPlanForProject(
    plan.rotoKeyer,
    autopilotCommands(plan),
    plan.quality.state,
    plan.budget.contextTokens,
    project,
    materialCacheRoot(),
    { ...defaultRotoKeyerRuntimePaths(), cacheRoot: materialCacheRoot() },
    (assetId) => resolveAutopilotAssetSource(project, assetId),
  );
  // applyCommand may normalize nested clip payloads; keep the sealed plan
  // untouched so the audit hash is exactly what apply will verify.
  const auditCandidate = applyCommand(project, auditBatch, { nativePaintOwnerRevisionProof, originalSourceOwnerRevisionProof });
  const originalAssets = new Map(project.assets.map((asset) => [asset.id, asset.uri]));
  for (const [id, uri] of originalAssets) {
    const current = auditCandidate.assets.find((asset) => asset.id === id);
    if (!current || current.uri !== uri) throw new Error(`Autopilot audit 發現原始素材將被改寫或移除：${id}`);
  }
  const planSha256 = autopilotPlanSha256(plan);
  const planBytes = Buffer.byteLength(JSON.stringify(plan), "utf8");
  assertProjectReviewPolicy(auditCandidate, reviewPolicy);
  await assertCreatorReviewPolicyCurrent(reviewPolicy);
  assertAutopilotPlanSourceCurrent(plan.source, await readLiveAutopilotIdentity());
  signal?.throwIfAborted();
  const auditReceipt = createAcceptedAutopilotAuditReceipt({
    planSha256,
    project: createAutopilotProjectAuditIdentity(absoluteProjectPath, project),
    invocation,
    materialEvidence: plan.materialEvidence,
    originalSourceEvidence: getPlanOriginalMotionSources(plan),
  });
  return textResult({ status: "ACCEPTED", planSha256, planBytes, coverage: autopilotPlanCoverage(plan), commandCount: plan.commands.length, materialEvidence, skillSelection: { receiptSha256: skillSelection.receiptSha256, selected: skillSelection.selected.length, capabilityQueries: skillCapabilities.resolutions.length, capabilityCandidates: skillCapabilities.resolutions.reduce((total, resolution) => total + resolution.candidates.length, 0) }, pluginApplications, rotoKeyer, autoColor, design, auditReceipt });
}

export async function applyAutopilotPlan(projectPath: string, inputPlan: unknown, inputAuditReceipt: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const plan = parseProductAutopilotPlan(inputPlan);
  const reviewPolicy = await readCreatorReviewPolicy();
  const [before, absoluteProjectPath, invocation, pluginRegistry, hostWorkflowProfile] = await Promise.all([
    readProject(projectPath),
    resolveProjectPath(projectPath),
    readLiveAutopilotIdentity(),
    discoverInstalledPlugins(),
    readHostWorkflowProfile(),
  ]);
  assertAutopilotPlanSourceCurrent(plan.source, invocation);
  let nativePaintOwnerRevisionProof: object | undefined;
  const design = await verifyAutopilotDesign(plan, before, undefined, { reviewPolicy: reviewPolicy.policy }, proof => { nativePaintOwnerRevisionProof = proof; });
  if (pluginRegistryIdentity(pluginRegistry).sha256 !== invocation.plugins.sha256) throw new Error("Autopilot apply 的 plugin registry snapshot 已漂移");
  const skillSelection = verifyEditkinSkillSelectionReceipt(
    plan.extensions.skillSelection,
    installedSkillPackCandidates(pluginRegistry),
    { format: editkinSkillFormatForAutopilotRoute(plan.route.format), domain: plan.route.domain, semanticRoles: plan.extensions.skillSelection.context.semanticRoles },
    invocation.plugins.sha256,
    hostWorkflowProfile.profile,
  );
  const skillCapabilities = resolveSkillCapabilityQueries(pluginRegistry, skillSelection);
  const authorizedProfile = assertSelectionUsesHostWorkflowProfile(hostWorkflowProfile, skillSelection.profileSha256, pluginRegistry);
  const pluginApplications = verifyPluginAutomationApplications(plan.extensions.pluginApplications, pluginRegistry, autopilotCommands(plan), authorizedProfile, skillSelection.compiled.guardrails);
  const planSha256 = autopilotPlanSha256(plan);
  const auditReceipt = verifyAcceptedAutopilotAuditReceipt(inputAuditReceipt, {
    planSha256,
    project: createAutopilotProjectAuditIdentity(absoluteProjectPath, before),
    invocation,
    materialEvidence: plan.materialEvidence,
    originalSourceEvidence: getPlanOriginalMotionSources(plan),
  });
  const applyBatch: EditorCommand = { type: "batch", commands: structuredClone(autopilotCommands(plan)) };
  let originalSourceOwnerRevisionProof: object | undefined;
  const materialEvidence = await verifyCurrentMaterialEvidence(plan, before, signal, { batch: applyBatch,
    capture: proof => { originalSourceOwnerRevisionProof = proof; } });
  const autoColor = await verifyAutoColorDecisions(plan.autoColor, autopilotCommands(plan), before, autoColorRuntime(before), plan.materialEvidence.receipts);
  const rotoKeyer = await verifyRotoKeyerPlanForProject(
    plan.rotoKeyer,
    autopilotCommands(plan),
    plan.quality.state,
    plan.budget.contextTokens,
    before,
    materialCacheRoot(),
    { ...defaultRotoKeyerRuntimePaths(), cacheRoot: materialCacheRoot() },
    (assetId) => resolveAutopilotAssetSource(before, assetId),
  );
  const originalAssets = new Map(before.assets.map((asset) => [asset.id, asset.uri]));
  const candidate = applyCommand(before, applyBatch, { nativePaintOwnerRevisionProof, originalSourceOwnerRevisionProof });
  for (const [id, uri] of originalAssets) {
    const current = candidate.assets.find((asset) => asset.id === id);
    if (!current || current.uri !== uri) throw new Error(`Autopilot plan 改寫或移除原始素材：${id}`);
  }
  assertProjectReviewPolicy(candidate, reviewPolicy);
  const originalMotionEvidence = getPlanOriginalMotionSources(plan);
  // A missing/unavailable authority must fail before consuming the audit or
  // writing either the project or a pending execution receipt.
  const originalCommitKey = originalMotionEvidence ? await prepareOriginalMotionCommitAuthority() : undefined;
  await assertCreatorReviewPolicyCurrent(reviewPolicy);
  assertAutopilotPlanSourceCurrent(plan.source, await readLiveAutopilotIdentity());
  signal?.throwIfAborted();
  consumeAcceptedAutopilotAuditReceipt(auditReceipt);

  const coverage = autopilotPlanCoverage(plan);
  const createdAt = new Date().toISOString();
  const receiptBase = {
    schema: "hao.video-autopilot.execution-receipt/v1",
    projectRevisionBefore: before.revision,
    planSchema: plan.schema,
    planSha256,
    source: plan.source,
    route: plan.route,
    budget: plan.budget,
    inference: summarizeInference(plan.inference),
    materialEvidence,
    skillSelection: { receiptSha256: skillSelection.receiptSha256, selected: skillSelection.selected, profileSha256: skillSelection.profileSha256, capabilityResolution: { queryCount: skillCapabilities.resolutions.length, candidateCount: skillCapabilities.resolutions.reduce((total, resolution) => total + resolution.candidates.length, 0) } },
    pluginApplications,
    rotoKeyer,
    autoColor,
    design,
    audit: { receiptSha256: auditReceipt.receiptSha256, auditedAt: auditReceipt.auditedAt, invocationBindingSha256: invocation.bindingSha256 },
    coverage,
    quality: { inputState: plan.quality.state, outputState: "review_required", certified: false },
    createdAt,
  };
  signal?.throwIfAborted();
  const pending = await writePendingAutopilotReceipt(projectPath, receiptBase);
  const project = await writeProject(projectPath, candidate, before.revision, { beforeCommit: async () => {
    signal?.throwIfAborted();
    await assertCreatorReviewPolicyCurrent(reviewPolicy);
    if (plan.editorial.audio.mode === "silent_media" || plan.originalMotionEvidence?.schema === "editkin.original-motion-source/v3") await verifyCurrentMaterialEvidence(plan, before, signal);
    else await verifyCurrentOriginalMotionEvidence(plan, before, signal);
    assertAutopilotPlanSourceCurrent(plan.source, await readLiveAutopilotIdentity());
    signal?.throwIfAborted();
  } });
  const committedAt = new Date().toISOString();
  const originalCommit = originalMotionEvidence ? { originalMotionEvidence, originalMotionBinding: {
    schema: "editkin.original-motion-render-binding/v1", originalSourceEvidenceSha256: sha256Canonical(originalMotionEvidence),
    sceneProjectSha256: sha256Canonical({ motionScenes: project.motionScenes ?? [], motionGraphics: project.motionGraphics }), renderContentSha256: sha256Canonical(project),
  } } : {};
  const committedReceipt = {
    ...receiptBase,
    receiptId: pending.receiptId,
    projectRevisionAfter: project.revision,
    projectIdentityAfter: createAutopilotProjectAuditIdentity(absoluteProjectPath, project),
    committedAt,
    ...originalCommit,
  };
  const receiptFile = await commitAutopilotReceipt(pending.pendingPath, committedReceipt, originalCommitKey);
  const responseReceipt = await readCommittedAutopilotResponseReceipt(pending.pendingPath, receiptFile, committedReceipt);
  return textResult({
    status: "REVIEW_REQUIRED",
    appliedCommandCount: plan.commands.length,
    receipt: responseReceipt,
    summary: summarizeProject(project),
  });
}
