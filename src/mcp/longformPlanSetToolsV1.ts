import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { summarizeProject } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { assertAutopilotProjectTimelineBinding, autopilotCommands, type CurrentAutopilotPlan } from "../application/autopilotPlan";
import { parseLowerThirdEvidenceReference } from "../application/editorialPlan";
import { verifyCurrentAutopilotMaterialEvidence } from "../application/autopilotMaterialEvidence";
import { readMaterialIntelligence, verifyMaterialSemanticsReceipt } from "../application/materialIntelligence";
import { assertProofStillPlanEvidenceV1, proofStillClipsInCommandsV1, type ProofStillVerifiedEvidenceV1 } from "../application/proofStillEvidenceV1";
import { summarizeInference } from "../application/inferencePolicy";
import {
  assertAutopilotPlanSourceCurrent, consumeAcceptedLongformAuditReceipt, createAcceptedLongformAuditReceipt, createAutopilotProjectAuditIdentity,
  longformAuditReceiptSchema, readLiveAutopilotIdentity, sha256Canonical, verifyAcceptedLongformAuditReceipt, type LiveAutopilotIdentity, type LongformAuditReceipt,
} from "../application/autopilotInvocationIdentity";
import {
  LONGFORM_PLAN_SET_SCHEMA_V1, LongformPlanSetRefusal, assertLongformChapterPlanVersionsV1, assertLongformEditorialRangesV1, assertLongformMaterialReceiptsV1,
  longformPlanSetSchemaV1, longformPlanSetSha256V1, parseLongformPlanSetV1, readLongformChapterPlansV1, type LongformChapterPlanV1, type LongformPlanSetV1,
} from "../application/longformPlanSetV1";
import { assertNoLongformOwnerProofsV1, mergeLongformPlanSetV1, type LongformMergeResultV1 } from "../application/longformPlanSetMergeV1";
import { assertOriginalAssetsKeptV1 } from "../application/generatedRenderAssetsV1";
import { assertCreatorReviewPolicyCurrent, assertProjectReviewPolicy } from "./creatorReviewPolicy";
import { verifyCurrentOriginalMotionEvidence } from "./originalMotionWorkflow";
import {
  applyVerificationCore, auditAutopilotPlanCore, loadAutopilotVerificationContext, materialCacheRoot, readCommittedAutopilotResponseReceipt,
  resolveAutopilotAssetSource, verifyCurrentMaterialEvidence, type AutopilotVerificationContext,
} from "./autopilotTools";
import { commitAutopilotReceipt, readProject, resolveWorkspaceMediaPath, writePendingAutopilotReceipt, writeProject } from "./storage";
import { textResult } from "./toolRuntime";

/** Outcome attribution skips committed receipts over 1 MiB; keep room for the commit fields and readback bound. */
export const LONGFORM_SET_RECEIPT_MAX_BYTES = 1024 * 1024 - 16 * 1024;

/** A refusal keeps its stable code and, when known, the conflicting keys and chapters. */
function longformErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LongformPlanSetRefusal ? error.code : /^(LONGFORM_SET_[A-Z_]+):/.exec(message)?.[1];
  const conflicts = error instanceof LongformPlanSetRefusal && error.conflicts.length ? { conflicts: error.conflicts } : {};
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", ...(code ? { code } : {}), error: message, ...conflicts }) }], isError: true };
}

interface PreparedSetV1 { set: LongformPlanSetV1; setSha256: string; chapters: LongformChapterPlanV1[]; materialCount: number }

/** Set shape, chapter files, plan versions, editorial ranges and material identity: everything decided before reading the project. */
async function prepareLongformPlanSet(inputSet: unknown, signal?: AbortSignal): Promise<PreparedSetV1> {
  signal?.throwIfAborted();
  const set = parseLongformPlanSetV1(inputSet);
  const chapters = await readLongformChapterPlansV1(set, { resolvePlanPath: resolveWorkspaceMediaPath, signal });
  assertLongformChapterPlanVersionsV1(chapters);
  for (const { chapter, plan } of chapters) assertLongformEditorialRangesV1(chapter, plan);
  return { set, setSha256: longformPlanSetSha256V1(set), chapters, materialCount: assertLongformMaterialReceiptsV1(chapters) };
}

function assertBaseProject(set: LongformPlanSetV1, project: EditProject): void {
  const actual = { id: project.id, revision: project.revision, contentSha256: sha256Canonical(project) };
  if (canonicalJson(actual) !== canonicalJson(set.baseProject)) {
    throw new LongformPlanSetRefusal("LONGFORM_SET_BASE_PROJECT_MISMATCH", actual.id !== set.baseProject.id || actual.revision !== set.baseProject.revision
      ? `the set was written for ${set.baseProject.id} revision ${set.baseProject.revision}; the project is ${actual.id} revision ${actual.revision}`
      : `project ${actual.id} revision ${actual.revision} no longer has the content the set was written for`);
  }
}

function assertSetSourceCurrent(prepared: PreparedSetV1, invocation: LiveAutopilotIdentity): void {
  try { assertAutopilotPlanSourceCurrent(prepared.chapters[0].plan.source, invocation); }
  catch (error) { throw new LongformPlanSetRefusal("LONGFORM_SET_SOURCE_STALE", error instanceof Error ? error.message : String(error)); }
}

function chapterBindings(prepared: PreparedSetV1): LongformAuditReceipt["chapters"] {
  return prepared.chapters.map(({ chapter, plan, planSha256 }) => ({ chapterId: chapter.chapterId, planSha256,
    materialEvidenceSha256: sha256Canonical(plan.materialEvidence), range: chapter.range }));
}

/**
 * Design E5 / decision (f)7: a materialId is verified (packet, semantic receipt and full source hash) once per audit
 * or apply, however many chapters cite it. Chapters that need the whole evidence set in one pass keep it: silent
 * media (coverage over every clip) and evidence-bound lower thirds (their cue must be read in the same pass).
 */
function createMaterialDeduplicator() {
  const verified = new Map<string, string>();
  const stats = { verifiedReceipts: 0, deduplicatedReceipts: 0 };
  const verify = async (plan: CurrentAutopilotPlan, project: EditProject, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    assertAutopilotProjectTimelineBinding(plan, project.fps);
    const evidence = plan.materialEvidence;
    if (evidence.schema !== "hao.editkin.material-intelligence/v1") throw new LongformPlanSetRefusal("LONGFORM_SET_ORIGINAL_MOTION_REFUSED", "a set chapter needs real material evidence");
    const silent = plan.editorial.audio.mode === "silent_media";
    const identityMaterials = new Set(plan.editorial.graphics
      .filter(event => event.kind === "lower_third_name" || event.kind === "lower_third_affiliation")
      .flatMap(event => event.evidenceRefs.map(reference => parseLowerThirdEvidenceReference(reference)?.materialId ?? "")));
    const receipts = evidence.receipts.filter(receipt => silent || identityMaterials.has(receipt.materialId) || verified.get(receipt.materialId) !== canonicalJson(receipt));
    // No plan commands in these per-receipt calls: a proof still's receipt may have been verified in an earlier
    // chapter's call, so assertSetProofStills checks every chapter's proof stills against the whole set's receipts.
    const measured = receipts.length ? await verifyCurrentAutopilotMaterialEvidence({ schema: evidence.schema, receipts }, project, {
      cacheRoot: materialCacheRoot(), resolveSource: assetId => resolveAutopilotAssetSource(project, assetId), ffprobePath: process.env.HAO_FFPROBE_PATH, signal,
    }, plan.editorial.graphics, silent ? { audio: plan.editorial.audio, commands: autopilotCommands(plan) } : undefined, undefined, []) : undefined;
    for (const receipt of receipts) verified.set(receipt.materialId, canonicalJson(receipt));
    stats.verifiedReceipts += receipts.length;
    stats.deduplicatedReceipts += evidence.receipts.length - receipts.length;
    signal?.throwIfAborted();
    return { receiptCount: evidence.receipts.length, materialIds: evidence.receipts.map(receipt => receipt.materialId),
      verifiedReceipts: receipts.length, deduplicatedReceipts: evidence.receipts.length - receipts.length,
      ...(measured?.silentMedia ? { silentMedia: measured.silentMedia } : {}) };
  };
  return { verify, stats };
}

/**
 * Design P5 across a set: after every material receipt was verified once, each chapter's proof stills and proof_freeze
 * frame citations are checked against the whole set's receipts, so a still in a later chapter may rest on a receipt
 * first verified for an earlier chapter, while a still with no image receipt anywhere in the set is refused. Each
 * chapter keeps its own editorial events, so an event id can never be matched to another chapter's clip.
 */
async function assertSetProofStills(prepared: PreparedSetV1, signal?: AbortSignal): Promise<number> {
  const commands = prepared.chapters.map(({ plan }) => autopilotCommands(plan));
  if (!prepared.chapters.some(({ plan }, index) => proofStillClipsInCommandsV1(commands[index]).length
    || plan.editorial.graphics.some(event => event.kind === "proof_freeze"))) return 0;
  const receipts = [...new Map(prepared.chapters.flatMap(({ plan }) => plan.materialEvidence.receipts).map(receipt => [receipt.materialId, receipt])).values()];
  const cacheRoot = materialCacheRoot();
  const verified = new Map<string, ProofStillVerifiedEvidenceV1>();
  for (const receipt of receipts) {
    signal?.throwIfAborted();
    const packet = await readMaterialIntelligence(cacheRoot, receipt.materialId);
    const semantic = await verifyMaterialSemanticsReceipt(cacheRoot, receipt.materialId, receipt.semanticReceiptSha256);
    if (packet.source.sourceSha256 !== receipt.sourceSha256 || packet.source.assetId !== receipt.assetId || packet.source.clipId !== receipt.clipId
      || semantic.materialId !== receipt.materialId || semantic.sourceSha256 !== receipt.sourceSha256) {
      throw new Error(`素材語意包已過期或引用錯誤：${receipt.materialId}`);
    }
    verified.set(`${receipt.materialId}:${receipt.semanticReceiptSha256}`, { packet, semantic });
  }
  let proofStills = 0;
  for (const [index, { plan }] of prepared.chapters.entries()) {
    proofStills += assertProofStillPlanEvidenceV1({ commands: commands[index], graphics: plan.editorial.graphics, receipts, verified }).proofStillCount;
  }
  return proofStills;
}

function merge(context: AutopilotVerificationContext, chapters: ReadonlyArray<{ chapter: LongformChapterPlanV1["chapter"]; plan: CurrentAutopilotPlan; candidate: EditProject }>): LongformMergeResultV1 {
  return mergeLongformPlanSetV1(context.project, chapters.map(({ chapter, plan, candidate }) => ({
    chapterId: chapter.chapterId, range: chapter.range, commands: autopilotCommands(plan), candidate })));
}

function commandCount(prepared: PreparedSetV1): number {
  return prepared.chapters.reduce((total, { plan }) => total + plan.commands.length, 0);
}

export function registerLongformPlanSetToolsV1(server: McpServer): void {
  server.registerTool("audit_longform_plan_set", {
    description: "長片 plan set：一次審核最多 16 章 v4 chapter plan（以工作區路徑＋canonical SHA-256 傳遞，每檔 ≤256 KiB），全部綁定同一個 base 專案 revision。每章跑與 audit_autopilot_plan 相同的驗證，再檢查章節範圍、各章 footprint 互不重疊、全域設定只由第一章決定、合併後與各章單獨套用一致（可交換）及專案上限。不修改專案；回 ACCEPTED、各章摘要、衝突與合併摘要，以及只供 apply_longform_plan_set 使用的單次 set receipt。v1 拒絕原創 Motion source、owner revision、模板換源與 relink。",
    inputSchema: z.object({ projectPath: z.string(), planSet: longformPlanSetSchemaV1 }),
  }, async ({ projectPath, planSet }, context) => {
    try { return await auditLongformPlanSetV1(projectPath, planSet, context.mcpReq.signal); }
    catch (error) { return longformErrorResult(error); }
  });

  server.registerTool("apply_longform_plan_set", {
    description: "只套用目前 Editkin 程序的 audit_longform_plan_set 簽發、十分鐘內且尚未使用的 set receipt。重新驗證每一章與合併結果後，整個 set 只原子寫入一次（revision+1，保留 .previous），並留下一張 committed receipt（planSha256＝set SHA）。字幕留在可編輯的 project.captions，只在最後 render_project 燒入一次；沒有逐章渲染。偽造、重播、過期、竄改或 drift 一律 fail-closed。",
    inputSchema: z.object({ projectPath: z.string(), planSet: longformPlanSetSchemaV1, auditReceipt: longformAuditReceiptSchema }),
  }, async ({ projectPath, planSet, auditReceipt }, context) => {
    try { return await applyLongformPlanSetV1(projectPath, planSet, auditReceipt, context.mcpReq.signal); }
    catch (error) { return longformErrorResult(error); }
  });
}

export async function auditLongformPlanSetV1(projectPath: string, inputSet: unknown, signal?: AbortSignal) {
  const prepared = await prepareLongformPlanSet(inputSet, signal);
  const context = await loadAutopilotVerificationContext(projectPath);
  assertBaseProject(prepared.set, context.project);
  assertSetSourceCurrent(prepared, context.invocation);
  const materials = createMaterialDeduplicator();
  const audited = [];
  for (const { chapter, plan, planBytes } of prepared.chapters) {
    signal?.throwIfAborted();
    const core = await auditAutopilotPlanCore(plan, context, signal, { verifyMaterialEvidence: materials.verify });
    assertNoLongformOwnerProofsV1(chapter.chapterId, core.ownerProofs);
    audited.push({ chapter, plan, planBytes, core, candidate: core.auditCandidate });
  }
  const proofStills = await assertSetProofStills(prepared, signal);
  const merged = merge(context, audited);
  assertProjectReviewPolicy(merged.merged, context.reviewPolicy);
  await assertCreatorReviewPolicyCurrent(context.reviewPolicy);
  assertAutopilotPlanSourceCurrent(prepared.chapters[0].plan.source, await readLiveAutopilotIdentity());
  signal?.throwIfAborted();
  const auditReceipt = createAcceptedLongformAuditReceipt({
    setSha256: prepared.setSha256,
    project: createAutopilotProjectAuditIdentity(context.absoluteProjectPath, context.project),
    invocation: context.invocation,
    chapters: chapterBindings(prepared),
  });
  const { skillSelection, skillCapabilities } = audited[0].core;
  return textResult({
    status: "ACCEPTED", planSchema: LONGFORM_PLAN_SET_SCHEMA_V1, planSha256: prepared.setSha256, setSha256: prepared.setSha256,
    coverage: { level: "longform_plan_set", legacy: false, chapterCount: prepared.chapters.length, materialCount: prepared.materialCount },
    commandCount: commandCount(prepared),
    chapters: audited.map(({ chapter, plan, planBytes, core }, index) => ({
      chapterId: chapter.chapterId, range: chapter.range, planSha256: core.planSha256, planBytes, commandCount: plan.commands.length,
      materialEvidence: core.materialEvidence, pluginApplications: core.pluginApplications, rotoKeyer: core.rotoKeyer, autoColor: core.autoColor, design: core.design,
      footprint: merged.chapters[index].footprint })),
    conflicts: [],
    merged: merged.summary,
    materialEvidence: { materialCount: prepared.materialCount, ...materials.stats, proofStills },
    skillSelection: { receiptSha256: skillSelection.receiptSha256, selected: skillSelection.selected.length, capabilityQueries: skillCapabilities.resolutions.length,
      capabilityCandidates: skillCapabilities.resolutions.reduce((total, resolution) => total + resolution.candidates.length, 0) },
    auditReceipt,
  });
}

export async function applyLongformPlanSetV1(projectPath: string, inputSet: unknown, inputAuditReceipt: unknown, signal?: AbortSignal) {
  const prepared = await prepareLongformPlanSet(inputSet, signal);
  const context = await loadAutopilotVerificationContext(projectPath);
  const { reviewPolicy, project: before, absoluteProjectPath, invocation } = context;
  assertBaseProject(prepared.set, before);
  assertSetSourceCurrent(prepared, invocation);
  const auditReceipt = verifyAcceptedLongformAuditReceipt(inputAuditReceipt, {
    setSha256: prepared.setSha256, project: createAutopilotProjectAuditIdentity(absoluteProjectPath, before), invocation, chapters: chapterBindings(prepared),
  });
  const materials = createMaterialDeduplicator();
  const verified: Array<{ chapter: LongformChapterPlanV1["chapter"]; plan: CurrentAutopilotPlan; core: Awaited<ReturnType<typeof applyVerificationCore<undefined>>>; candidate: EditProject }> = [];
  for (const { chapter, plan } of prepared.chapters) {
    signal?.throwIfAborted();
    const core = await applyVerificationCore(plan, context, signal, () => undefined, { verifyMaterialEvidence: materials.verify });
    assertNoLongformOwnerProofsV1(chapter.chapterId, core.ownerProofs);
    verified.push({ chapter, plan, core, candidate: core.candidate });
  }
  const proofStills = await assertSetProofStills(prepared, signal);
  const merged = merge(context, verified);
  const candidate = merged.merged;
  assertOriginalAssetsKeptV1(before, candidate, id => `Autopilot plan 改寫或移除原始素材：${id}`);
  assertProjectReviewPolicy(candidate, reviewPolicy);
  const source = prepared.chapters[0].plan.source;
  await assertCreatorReviewPolicyCurrent(reviewPolicy);
  assertAutopilotPlanSourceCurrent(source, await readLiveAutopilotIdentity());
  signal?.throwIfAborted();

  const first = verified[0];
  const { skillSelection, skillCapabilities } = first.core;
  // VA pins this block exactly; the per-chapter verification record sits beside it.
  const longformSet = { setSha256: prepared.setSha256, baseProject: prepared.set.baseProject,
    chapters: verified.map(({ chapter, core }) => ({ chapterId: chapter.chapterId, planSha256: core.planSha256 })) };
  const longformVerification = {
    chapters: verified.map(({ chapter, plan, core }, index) => ({
      chapterId: chapter.chapterId, range: chapter.range, commandCount: plan.commands.length,
      budget: plan.budget, inference: summarizeInference(plan.inference), materialEvidence: core.materialEvidence,
      pluginApplications: core.pluginApplications, rotoKeyer: core.rotoKeyer, autoColor: core.autoColor, design: core.design,
      footprint: merged.chapters[index].footprint })),
    merged: merged.summary,
  };
  const receiptFor = (createdAt: string) => ({
    schema: "hao.video-autopilot.execution-receipt/v1",
    projectRevisionBefore: before.revision,
    planSchema: LONGFORM_PLAN_SET_SCHEMA_V1,
    planSha256: prepared.setSha256,
    source,
    route: first.plan.route,
    materialEvidence: { materialCount: prepared.materialCount, ...materials.stats, proofStills },
    skillSelection: { receiptSha256: skillSelection.receiptSha256, selected: skillSelection.selected, profileSha256: skillSelection.profileSha256,
      capabilityResolution: { queryCount: skillCapabilities.resolutions.length, candidateCount: skillCapabilities.resolutions.reduce((total, resolution) => total + resolution.candidates.length, 0) } },
    audit: { receiptSha256: auditReceipt.receiptSha256, auditedAt: auditReceipt.auditedAt, invocationBindingSha256: invocation.bindingSha256 },
    coverage: { level: "longform_plan_set", legacy: false, chapterCount: prepared.chapters.length, commandCount: commandCount(prepared) },
    quality: { inputState: first.plan.quality.state, outputState: "review_required", certified: false },
    createdAt,
    longformSet,
    longformVerification,
  });
  // Refuse an oversized receipt before the one-use audit receipt is consumed or anything is written.
  const estimate = Buffer.byteLength(`${JSON.stringify({ ...receiptFor(new Date().toISOString()), receiptId: "0".repeat(64), state: "committed", projectRevisionAfter: before.revision + 1,
    projectIdentityAfter: createAutopilotProjectAuditIdentity(absoluteProjectPath, before), committedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  if (estimate > LONGFORM_SET_RECEIPT_MAX_BYTES) {
    throw new LongformPlanSetRefusal("LONGFORM_SET_RECEIPT_TOO_LARGE", `the committed set receipt would be about ${estimate} bytes; outcome attribution reads at most 1 MiB`);
  }
  consumeAcceptedLongformAuditReceipt(auditReceipt);

  const receiptBase = receiptFor(new Date().toISOString());
  signal?.throwIfAborted();
  const pending = await writePendingAutopilotReceipt(projectPath, receiptBase);
  const project = await writeProject(projectPath, candidate, before.revision, { beforeCommit: async () => {
    signal?.throwIfAborted();
    await assertCreatorReviewPolicyCurrent(reviewPolicy);
    if (sha256Canonical(await readProject(projectPath)) !== sha256Canonical(before)) throw new Error("LONGFORM_SET_BASE_PROJECT_MISMATCH: the project changed before the set was committed");
    // The same pre-commit re-verification each chapter would get from apply_autopilot_plan.
    for (const { plan } of verified) {
      if (plan.editorial.audio.mode === "silent_media") await verifyCurrentMaterialEvidence(plan, before, signal);
      else await verifyCurrentOriginalMotionEvidence(plan, before, signal);
    }
    assertAutopilotPlanSourceCurrent(source, await readLiveAutopilotIdentity());
    signal?.throwIfAborted();
  } });
  const committedReceipt = {
    ...receiptBase,
    receiptId: pending.receiptId,
    projectRevisionAfter: project.revision,
    projectIdentityAfter: createAutopilotProjectAuditIdentity(absoluteProjectPath, project),
    committedAt: new Date().toISOString(),
  };
  const receiptFile = await commitAutopilotReceipt(pending.pendingPath, committedReceipt);
  const responseReceipt = await readCommittedAutopilotResponseReceipt(pending.pendingPath, receiptFile, committedReceipt);
  return textResult({
    status: "REVIEW_REQUIRED",
    appliedCommandCount: commandCount(prepared),
    receipt: responseReceipt,
    summary: summarizeProject(project),
  });
}
