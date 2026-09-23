import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { findAsset, findClip } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import type { CurrentAutopilotPlan } from "./autopilotPlan";
import { parseLowerThirdEvidenceReference } from "./editorialPlan";
import { materialTranscriptCueSha256, readMaterialIntelligence, verifyMaterialSemanticsReceipt } from "./materialIntelligence";

export interface AutopilotMaterialEvidenceRuntime {
  cacheRoot: string;
  /** The caller must use its existing authorized workspace/creative resolver. */
  resolveSource: (assetId: string) => Promise<string>;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Point-in-time full byte identity, not a lock held across project apply or rendering. */
async function currentSourceSha256(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("素材來源不是一般檔案");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    const currentPath = await stat(path, { bigint: true });
    if (!sameFileVersion(before, after) || !sameFileVersion(after, currentPath)) {
      throw new Error("素材在完整性驗證期間改變，請重新分析");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Shared audit/apply guard. Never treat derivative metadata as proof of current bytes. */
export async function verifyCurrentAutopilotMaterialEvidence(
  evidenceSet: CurrentAutopilotPlan["materialEvidence"],
  project: EditProject,
  runtime: AutopilotMaterialEvidenceRuntime,
  identityGraphics: CurrentAutopilotPlan["editorial"]["graphics"] = [],
) {
  const verified = new Map<string, {
    packet: Awaited<ReturnType<typeof readMaterialIntelligence>>;
    semantic: Awaited<ReturnType<typeof verifyMaterialSemanticsReceipt>>;
  }>();
  for (const evidence of evidenceSet.receipts) {
    const clip = findClip(project, evidence.clipId);
    const asset = findAsset(project, evidence.assetId);
    if (clip.assetId !== asset.id) throw new Error(`素材語意 receipt 的 clip／asset 不一致：${evidence.clipId}`);
    const packet = await readMaterialIntelligence(runtime.cacheRoot, evidence.materialId);
    if (packet.source.clipId !== evidence.clipId || packet.source.assetId !== evidence.assetId || packet.source.sourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材語意包已過期或引用錯誤：${evidence.materialId}`);
    }
    if (!Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
      || !Number.isFinite(clip.duration) || clip.duration <= 0
      || !Number.isFinite(project.fps) || project.fps <= 0
      || packet.source.sourceStart !== clip.sourceStart || packet.source.duration !== clip.duration
      || packet.source.fps !== project.fps || packet.source.kind !== asset.kind) {
      throw new Error(`素材分析時間窗／fps／類型已改變，請重新分析：${evidence.clipId}`);
    }
    if (asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材已在分析後改變：${evidence.assetId}`);
    }
    if (packet.cache && (canonicalJson(packet.source.color ?? null) !== canonicalJson(asset.color ?? null)
      || canonicalJson(packet.source.colorManagement ?? DEFAULT_COLOR_MANAGEMENT) !== canonicalJson(project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT))) {
      throw new Error(`素材色彩解讀／管理設定已改變，請重新分析：${evidence.clipId}`);
    }
    const semantic = await verifyMaterialSemanticsReceipt(runtime.cacheRoot, evidence.materialId, evidence.semanticReceiptSha256);
    if (semantic.materialId !== evidence.materialId || semantic.sourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材語意 receipt 的 materialId／來源 hash 不一致：${evidence.materialId}`);
    }
    verified.set(`${evidence.materialId}:${evidence.semanticReceiptSha256}`, { packet, semantic });
    // Keep path authority in the existing workspace/creative resolver. No URI fallback.
    const actualSourceSha256 = await currentSourceSha256(await runtime.resolveSource(asset.id));
    if (actualSourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材實際來源 SHA-256 已改變，請重新分析：${evidence.assetId}`);
    }
  }
  for (const event of identityGraphics) {
    if (event.kind !== "lower_third_name" && event.kind !== "lower_third_affiliation") continue;
    let supported = false;
    for (const reference of event.evidenceRefs) {
      const parsed = parseLowerThirdEvidenceReference(reference);
      if (!parsed) throw new Error(`人物字幕條 ${event.id} 含非 canonical identity evidence ref`);
      const evidence = verified.get(`${parsed.materialId}:${parsed.semanticReceiptSha256}`);
      if (!evidence) throw new Error(`人物字幕條 ${event.id} 的 evidence ref 沒有解析到已驗證 material semantic receipt`);
      if (evidence.packet.analysis.transcript.state !== "ready") throw new Error(`人物字幕條 ${event.id} 引用的逐字稿不是 ready 狀態`);
      const cue = evidence.packet.analysis.transcript.cues[parsed.transcriptCueIndex];
      if (!cue) throw new Error(`人物字幕條 ${event.id} 引用不存在的 transcript cue`);
      if (!evidence.semantic.segments.some((segment) => segment.transcriptCueIndexes.includes(parsed.transcriptCueIndex))) {
        throw new Error(`人物字幕條 ${event.id} 引用的 transcript cue 不在 semantic receipt 證據範圍內`);
      }
      const sealedCue = evidence.semantic.transcriptEvidence?.find((candidate) => candidate.cueIndex === parsed.transcriptCueIndex);
      if (!sealedCue || sealedCue.start !== cue.start || sealedCue.end !== cue.end || sealedCue.textSha256 !== materialTranscriptCueSha256(cue)) {
        throw new Error(`人物字幕條 ${event.id} 引用的 transcript cue 沒有 receipt-sealed 文字證據`);
      }
      const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("und")
        .replace(/[\p{White_Space}\p{Punctuation}]+/gu, "");
      const claim = normalize(event.message);
      if (claim && normalize(cue.text).includes(claim)) supported = true;
    }
    if (!supported) throw new Error(`人物字幕條 ${event.id} 的可見 identity 文字沒有逐字稿證據支持`);
  }
  return { receiptCount: evidenceSet.receipts.length, materialIds: evidenceSet.receipts.map((receipt) => receipt.materialId) };
}
