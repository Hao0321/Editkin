import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { findAsset, findClip } from "../domain/editGraph";
import { DEFAULT_COLOR_MANAGEMENT, type ColorAdjustments, type EditProject, type TimelineClip } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { readMaterialIntelligence } from "./materialIntelligence";
import { verifyCurrentAutopilotMaterialEvidence } from "./autopilotMaterialEvidence";
import { colorDigest, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import type { MaterialColorRuntime } from "./materialColorSampling";
import { assertAutoColorCommandBinding, autoColorGoalSchema, referenceWhiteBalanceGoalSchema, type AutoColorBindings, type AutoColorGoal, type ReferenceWhiteBalanceGoal } from "./autoColorDecision";
import { evaluateAutoColorExposure } from "./autoColorExposure";
import { selectAutoColorCandidate } from "./autoColorScoring";
import { evaluateAutoWhiteBalance, selectAutoWhiteBalanceCandidate } from "./autoWhiteBalance";
import { assertAutoColorEvaluationBinding } from "./autoColorEvaluationBinding";
import { autoColorSourceAsset } from "./autoColorFrame";
import { assertReferenceWhiteBalanceInput } from "../render/sourceLinearWhiteBalance";

export interface AutoColorRuntime extends MaterialColorRuntime { cacheRoot: string; resolveSource: (assetId: string) => Promise<string> }
export interface AutoColorRequest { materialId: string; semanticReceiptSha256: string; goal: AutoColorGoal }
export interface AutoWhiteBalanceRequest { materialId: string; semanticReceiptSha256: string; goal: ReferenceWhiteBalanceGoal }
interface AutoColorReceiptBase {
  decisionSha256: string;
  projectId: string; projectRevision: number; materialId: string; semanticReceiptSha256: string;
  measurementSha256: string; assetId: string; sourceSha256: string;
  baselineSnapshot: ReturnType<typeof primarySnapshot>;
  humanReview: "required";
}
type AutoColorReceipt = AutoColorReceiptBase & (
  { schema: "editkin.auto-color-decision/v2"; mode: "exposure"; evaluation: Awaited<ReturnType<typeof evaluateAutoColorExposure>>; exposure: number; scope: "representative-primary-exposure-before-look" }
  | { schema: "editkin.auto-color-decision/v3"; mode: "reference_white_balance"; evaluation: Awaited<ReturnType<typeof evaluateAutoWhiteBalance>>;
    whiteBalanceRed: number; whiteBalanceGreen: number; whiteBalanceBlue: number; scope: "representative-source-linear-white-balance-before-tone-and-look" });

function primarySnapshot(project: EditProject, clip: TimelineClip) {
  const asset = findAsset(project, clip.assetId);
  return { assetId: asset.id, sourceStart: clip.sourceStart, duration: clip.duration, color: clip.color,
    keyframes: clip.keyframes, expressions: clip.expressions ?? {}, assetColor: asset.color ?? null,
    creative: clip.creative ?? null,
    management: project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT };
}
function requireStaticPrimary(project: EditProject, clip: TimelineClip) {
  if (clip.keyframes.length || Object.keys(clip.expressions ?? {}).length) throw Error("動畫調色需逐幀驗證，不能套用靜態曝光決策");
  if (clip.layer?.role === "adjustment" || clip.layer?.role === "controller") throw Error("自動曝光只作用於實拍素材片段");
  const overlap = project.tracks.filter(track => !track.muted).flatMap(track => track.clips).some(other => other.layer?.role === "adjustment"
    && other.timelineStart < clip.timelineStart + clip.duration && other.timelineStart + other.duration > clip.timelineStart);
  if (overlap) throw Error("重疊 adjustment layer 尚未納入自動曝光量測，請先處理疊加調色");
}
function receiptPath(cacheRoot: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("Invalid automatic colour decision ID");
  return join(cacheRoot, "auto-colour-decisions", `${digest}.json`);
}
async function verifiedMaterial(project: EditProject, request: Pick<AutoColorRequest, "materialId" | "semanticReceiptSha256">, runtime: AutoColorRuntime) {
  const packet = await readMaterialIntelligence(runtime.cacheRoot, request.materialId);
  await verifyCurrentAutopilotMaterialEvidence({ schema: "hao.editkin.material-intelligence/v1", receipts: [{
    materialId: request.materialId, semanticReceiptSha256: request.semanticReceiptSha256,
    sourceSha256: packet.source.sourceSha256, assetId: packet.source.assetId, clipId: packet.source.clipId,
  }] }, project, runtime);
  return packet;
}

export async function proposeAutoColorExposure(project: EditProject, input: AutoColorRequest, runtime: AutoColorRuntime) {
  const request = { ...input, goal: autoColorGoalSchema.parse(input.goal) };
  const packet = await verifiedMaterial(project, request, runtime), clip = findClip(project, packet.source.clipId);
  requireStaticPrimary(project, clip);
  const evaluation = await evaluateAutoColorExposure(packet, clip.color, request.goal, await runtime.resolveSource(clip.assetId), runtime);
  const receipt: AutoColorReceipt = { schema: "editkin.auto-color-decision/v2", mode: "exposure", decisionSha256: "",
    projectId: project.id, projectRevision: project.revision, materialId: packet.materialId,
    semanticReceiptSha256: request.semanticReceiptSha256, measurementSha256: packet.analysis.color!.receiptSha256,
    assetId: clip.assetId, sourceSha256: packet.source.sourceSha256, baselineSnapshot: structuredClone(primarySnapshot(project, clip)),
    evaluation, exposure: evaluation.candidates[evaluation.selection.selectedIndex].exposure,
    scope: "representative-primary-exposure-before-look", humanReview: "required" };
  assertAutoColorEvaluationBinding(receipt, packet);
  await persistReceipt(receipt, runtime);
  return { decisionSha256: receipt.decisionSha256, clipId: clip.id,
    command: { type: "set_clip_color", clipId: clip.id, patch: { exposure: receipt.exposure } } as EditorCommand,
    status: evaluation.selection.status, goal: request.goal, baselineExposure: clip.color.exposure, exposure: receipt.exposure,
    selected: evaluation.selection.candidates[evaluation.selection.selectedIndex], sampleCount: evaluation.candidates[0].measurements.frames.length,
    candidateCount: evaluation.candidates.length, scope: receipt.scope, whiteBalance: "unmeasured", aestheticQuality: "unmeasured", humanReview: "required" };
}

async function persistReceipt(receipt: AutoColorReceipt, runtime: AutoColorRuntime) {
  receipt.decisionSha256 = colorDigest({ ...receipt, decisionSha256: undefined });
  const path = receiptPath(runtime.cacheRoot, receipt.decisionSha256), bytes = `${canonicalJson(receipt)}\n`;
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error("Automatic colour evidence exceeds 1 MiB");
  await mkdir(join(runtime.cacheRoot, "auto-colour-decisions"), { recursive: true });
  try { await writeFile(path, bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== bytes) throw error; }
}

export async function proposeReferenceWhiteBalance(project: EditProject, input: AutoWhiteBalanceRequest, runtime: AutoColorRuntime) {
  const request = { ...input, goal: referenceWhiteBalanceGoalSchema.parse(input.goal) };
  const packet = await verifiedMaterial(project, request, runtime), clip = findClip(project, packet.source.clipId);
  requireStaticPrimary(project, clip);
  assertReferenceWhiteBalanceInput(autoColorSourceAsset(packet, findAsset(project, clip.assetId).uri));
  const evaluation = await evaluateAutoWhiteBalance(packet, clip.color, request.goal, await runtime.resolveSource(clip.assetId), runtime);
  const applicable = evaluation.selection.status === "candidate" || evaluation.selection.status === "unchanged";
  // A useful diagnostic improvement is not permission to apply a failed target.
  const selected = evaluation.candidates[applicable ? evaluation.selection.selectedIndex : evaluation.selection.baselineIndex];
  const receipt: AutoColorReceipt = { schema: "editkin.auto-color-decision/v3", mode: "reference_white_balance", decisionSha256: "",
    projectId: project.id, projectRevision: project.revision, materialId: packet.materialId, semanticReceiptSha256: request.semanticReceiptSha256,
    measurementSha256: packet.analysis.color!.receiptSha256, assetId: clip.assetId, sourceSha256: packet.source.sourceSha256,
    baselineSnapshot: structuredClone(primarySnapshot(project, clip)), evaluation,
    whiteBalanceRed: selected.whiteBalanceRed, whiteBalanceGreen: selected.whiteBalanceGreen, whiteBalanceBlue: selected.whiteBalanceBlue,
    scope: "representative-source-linear-white-balance-before-tone-and-look", humanReview: "required" };
  assertAutoColorEvaluationBinding(receipt, packet);
  await persistReceipt(receipt, runtime);
  return { decisionSha256: receipt.decisionSha256, mode: receipt.mode, clipId: clip.id,
    command: { type: "set_clip_color", clipId: clip.id, patch: { whiteBalanceRed: selected.whiteBalanceRed, whiteBalanceGreen: selected.whiteBalanceGreen, whiteBalanceBlue: selected.whiteBalanceBlue } } as EditorCommand,
    status: evaluation.selection.status, applicable, goal: request.goal,
    baseline: { whiteBalanceRed: clip.color.whiteBalanceRed, whiteBalanceGreen: clip.color.whiteBalanceGreen, whiteBalanceBlue: clip.color.whiteBalanceBlue },
    selected: evaluation.selection.candidates[evaluation.selection.selectedIndex], sampleCount: selected.frames.length,
    candidateCount: evaluation.candidates.length, scope: receipt.scope, referenceAuthority: "caller-declared-not-detected",
    whitePointVerification: "unmeasured", skinProtection: "unmeasured", aestheticQuality: "unmeasured", humanReview: "required" };
}

export async function verifyAutoColorDecisions(bindings: AutoColorBindings | undefined, commands: EditorCommand[],
  project: EditProject, runtime: AutoColorRuntime, materials: Array<{ materialId: string; semanticReceiptSha256: string }>) {
  assertAutoColorCommandBinding(bindings, commands);
  if (!bindings) return { decisionCount: 0, decisions: [] };
  const final = applyCommand(project, { type: "batch", commands });
  const decisions: Array<{ decisionSha256: string; clipId: string; mode: string; patch: Partial<ColorAdjustments>; status: string }> = [];
  const identity = await getMaterialColorRuntimeIdentity(runtime);
  for (const binding of bindings) {
    const path = receiptPath(runtime.cacheRoot, binding.decisionSha256);
    if ((await stat(path)).size > 1024 * 1024) throw Error("Automatic colour receipt oversized");
    const receipt = JSON.parse(await readFile(path, "utf8")) as AutoColorReceipt;
    if (receipt.schema !== (receipt.mode === "exposure" ? "editkin.auto-color-decision/v2" : "editkin.auto-color-decision/v3") || receipt.mode !== (binding.mode ?? "exposure") || receipt.decisionSha256 !== binding.decisionSha256
      || colorDigest({ ...receipt, decisionSha256: undefined }) !== binding.decisionSha256) throw Error("Automatic colour receipt integrity failed");
    if (receipt.projectId !== project.id || receipt.projectRevision !== project.revision) throw Error("Automatic colour project revision changed");
    if (!materials.some(material => material.materialId === receipt.materialId && material.semanticReceiptSha256 === receipt.semanticReceiptSha256)) throw Error("Automatic colour evidence is missing from the v4 plan");
    const packet = await verifiedMaterial(project, receipt, runtime);
    // Equal asset bytes/window do not authorise borrowing another clip's
    // semantic decision, including a clone inserted earlier in this batch.
    if (binding.clipId !== packet.source.clipId) throw Error("Automatic colour decision clip target mismatch; reanalyse the target clip");
    // Retained old PQ decisions are evidence, not authority to enable an
    // unversioned correction. This explicit boundary precedes runtime drift.
    if (receipt.mode === "reference_white_balance") {
      assertReferenceWhiteBalanceInput(autoColorSourceAsset(packet, findAsset(project, packet.source.assetId).uri));
    }
    assertAutoColorEvaluationBinding(receipt, packet);
    if (receipt.assetId !== packet.source.assetId || receipt.sourceSha256 !== packet.source.sourceSha256
      || receipt.measurementSha256 !== packet.analysis.color?.receiptSha256
      || identity.status !== "verified" || identity.identitySha256 !== receipt.evaluation.identitySha256) throw Error("Automatic colour source/measurement/runtime changed");
    const before = binding.commandIndex ? applyCommand(project, { type: "batch", commands: commands.slice(0, binding.commandIndex) }) : project;
    const target = findClip(before, binding.clipId), after = findClip(final, binding.clipId);
    requireStaticPrimary(before, target); requireStaticPrimary(final, after);
    if (canonicalJson(primarySnapshot(before, target)) !== canonicalJson(receipt.baselineSnapshot)) throw Error("Automatic colour target window/configuration/baseline changed");
    let patch: Partial<ColorAdjustments>, status: string;
    if (receipt.mode === "exposure") {
      const selection = selectAutoColorCandidate(receipt.evaluation.candidates, receipt.baselineSnapshot.color.exposure,
        autoColorGoalSchema.parse(receipt.evaluation.goal).medianLinearY);
      if (canonicalJson(selection) !== canonicalJson(receipt.evaluation.selection)
        || receipt.exposure !== receipt.evaluation.candidates[selection.selectedIndex].exposure) throw Error("Automatic colour selection/command mismatch");
      patch = { exposure: receipt.exposure }; status = selection.status;
    } else {
      referenceWhiteBalanceGoalSchema.parse(receipt.evaluation.goal);
      const selection = selectAutoWhiteBalanceCandidate(receipt.evaluation.candidates, receipt.baselineSnapshot.color);
      const chosen = receipt.evaluation.candidates[selection.selectedIndex];
      if (canonicalJson(selection) !== canonicalJson(receipt.evaluation.selection)
        || receipt.whiteBalanceRed !== chosen.whiteBalanceRed || receipt.whiteBalanceGreen !== chosen.whiteBalanceGreen || receipt.whiteBalanceBlue !== chosen.whiteBalanceBlue) throw Error("White balance selection/command mismatch");
      if (selection.status !== "candidate" && selection.status !== "unchanged") throw Error("白平衡尚未達標或參考無效；不能透過自動剪輯套用失敗的校正");
      patch = { whiteBalanceRed: receipt.whiteBalanceRed, whiteBalanceGreen: receipt.whiteBalanceGreen, whiteBalanceBlue: receipt.whiteBalanceBlue }; status = selection.status;
    }
    if (canonicalJson(commands[binding.commandIndex]) !== canonicalJson({ type: "set_clip_color", clipId: binding.clipId, patch })) throw Error("Automatic colour selection/command mismatch");
    if (canonicalJson(primarySnapshot(final, after)) !== canonicalJson({ ...receipt.baselineSnapshot,
      color: { ...receipt.baselineSnapshot.color, ...patch } })) throw Error("Automatic colour was modified again after its bound command");
    decisions.push({ decisionSha256: binding.decisionSha256, clipId: binding.clipId, mode: receipt.mode, patch, status });
  }
  return { decisionCount: decisions.length, scope: "representative-primary-correction-before-look", whitePointVerification: "unmeasured", aestheticQuality: "unmeasured", decisions };
}
