import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { findAsset, findClip } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import type { OriginalSourceOwnerRevisionProof } from "../domain/originalSourceOwnerRevision";
import type { EditProject, MediaAsset } from "../domain/types";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import type { CurrentAutopilotPlan } from "./autopilotPlan";
import { parseLowerThirdEvidenceReference } from "./editorialPlan";
import { materialTranscriptCueSha256, readMaterialIntelligence, verifyMaterialSemanticsReceipt } from "./materialIntelligence";
import { inspectMedia } from "./inspectMedia";

export interface AutopilotMaterialEvidenceRuntime {
  cacheRoot: string;
  /** The caller must use its existing authorized workspace/creative resolver. */
  resolveSource: (assetId: string) => Promise<string>;
  ffprobePath?: string;
  /** Controlled probe injection is for source tests; production defaults to real inspectMedia. */
  inspectMedia?: typeof inspectMedia;
  signal?: AbortSignal;
  /** One shared verification lifetime; individual probes retain their existing process bound. */
  timeoutMs?: number;
}

export interface AutopilotSilentMediaIntent {
  audio: CurrentAutopilotPlan["editorial"]["audio"];
  commands: readonly EditorCommand[];
}

/** Host-only dependency from the independent actual source recompiler. This
 * is not part of a plan, material receipt, command or MCP input schema. */
export interface AutopilotMaterialPredictionAuthority {
  readonly batch: Extract<EditorCommand, { type: "batch" }>;
  readonly originalSourceOwnerRevisionProof: OriginalSourceOwnerRevisionProof;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Point-in-time full byte identity, not a lock held across project apply or rendering. */
async function currentSourceSha256(path: string, checkCurrent: () => void = () => {}) : Promise<string> {
  checkCurrent();
  const handle = await open(path, "r");
  try {
    checkCurrent();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("素材來源不是一般檔案");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) { checkCurrent(); hash.update(chunk); }
    const after = await handle.stat({ bigint: true });
    const currentPath = await stat(path, { bigint: true });
    if (!sameFileVersion(before, after) || !sameFileVersion(after, currentPath)) {
      throw new Error("素材在完整性驗證期間改變，請重新分析");
    }
    checkCurrent();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function assertSilentMediaCommands(commands: readonly EditorCommand[]): void {
  for (const command of commands) {
    if (command.type === "batch") assertSilentMediaCommands(command.commands);
    else if (command.type === "import_asset" || command.type === "relink_asset_source") {
      throw new Error("silent_media 不允許匯入或改寫素材來源；請先獨立準備新素材證據");
    } else if (command.type === "add_track" && command.track.kind === "audio") {
      throw new Error("silent_media 不允許新增音軌");
    }
  }
}

function assertOrdinarySilentSource(asset: MediaAsset): void {
  if (asset.kind === "audio" || asset.compositionId || asset.imageSequence) {
    throw new Error(`silent_media 僅驗證一般單檔非音訊素材，不支援 composition／imageSequence：${asset.id}`);
  }
}

type SilentSource = { assetIdentity: string; sourceSha256: string; path: string; canonicalPath: string; version: BigIntStats; windows: Array<{ start: number; duration: number }> };

function assertSilentClipCoverage(project: EditProject, sources: Map<string, SilentSource>): void {
  const containers = [{ tracks: project.tracks, fps: project.fps }, ...project.compositions];
  for (const container of containers) for (const track of container.tracks) for (const clip of track.clips) {
    const asset = findAsset(project, clip.assetId);
    assertOrdinarySilentSource(asset);
    const source = sources.get(asset.id);
    if (!source || source.assetIdentity !== canonicalJson(asset)) {
      throw new Error(`silent_media 來源未驗證或完整 asset identity 已改變：${clip.id}`);
    }
    const frameAligned = (seconds: number) => Number.isFinite(seconds) && Math.abs(seconds * container.fps - Math.round(seconds * container.fps)) <= 1e-7;
    if (!Number.isFinite(container.fps) || container.fps <= 0 || clip.sourceStart < 0 || clip.duration <= 0
      || !frameAligned(clip.sourceStart) || !frameAligned(clip.duration) || !frameAligned(clip.timelineStart)
      || !source.windows.some(window => clip.sourceStart >= window.start - 1e-7
        && clip.sourceStart + clip.duration <= window.start + window.duration + 1e-7)) {
      throw new Error(`silent_media clip 超出已驗證整格素材時間窗：${clip.id}`);
    }
  }
}

/** Shared audit/apply guard. Never treat derivative metadata as proof of current bytes. */
export async function verifyCurrentAutopilotMaterialEvidence(
  evidenceSet: Extract<CurrentAutopilotPlan["materialEvidence"], { schema: "hao.editkin.material-intelligence/v1" }>,
  project: EditProject,
  runtime: AutopilotMaterialEvidenceRuntime,
  identityGraphics: CurrentAutopilotPlan["editorial"]["graphics"] = [],
  silentMedia?: AutopilotSilentMediaIntent,
  predictionAuthority?: AutopilotMaterialPredictionAuthority,
) {
  if (silentMedia && runtime.timeoutMs !== undefined && (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs <= 0)) {
    throw new Error("silent_media 驗證時限不合法");
  }
  const projectIdentity = silentMedia ? canonicalJson(project) : undefined;
  const current = silentMedia ? structuredClone(project) : project;
  const deadline = Date.now() + Math.max(1, Math.min(120_000, runtime.timeoutMs ?? 120_000));
  const checkCurrent = () => {
    runtime.signal?.throwIfAborted();
    if (silentMedia && Date.now() >= deadline) throw new Error("silent_media 素材驗證逾時");
  };
  checkCurrent();
  let predicted: EditProject | undefined;
  if (silentMedia) {
    const audio = structuredClone(silentMedia.audio);
    if (audio.mode !== "silent_media" || audio.layers.length || audio.impactFrames.length || audio.breathFrames.length) {
      throw new Error("silent_media 必須明示模式，且不能宣稱音訊 layer 或重拍／換氣證據");
    }
    if (!evidenceSet.receipts.length) throw new Error("silent_media 缺少素材證據");
    const commands = structuredClone([...silentMedia.commands]);
    assertSilentMediaCommands(commands);
    for (const container of [current, ...current.compositions]) for (const track of container.tracks) for (const clip of track.clips) {
      assertOrdinarySilentSource(findAsset(current, clip.assetId));
    }
    const exactPlanBatch: Extract<EditorCommand, { type: "batch" }> = { type: "batch", commands };
    if (predictionAuthority && canonicalJson(predictionAuthority.batch) !== canonicalJson(exactPlanBatch)) {
      throw new Error("silent_media prediction authority batch differs from the complete current plan commands");
    }
    // Use the same complete host batch that the opaque issuer verified. The
    // domain checks its exact current project/batch identity before mutation;
    // a missing or JSON-shaped proof cannot authorize a raw owner revision.
    predicted = predictionAuthority
      ? applyCommand(current, predictionAuthority.batch, {
        originalSourceOwnerRevisionProof: predictionAuthority.originalSourceOwnerRevisionProof,
      })
      : applyCommand(current, exactPlanBatch);
  }
  const silentSources = new Map<string, SilentSource>();
  const verified = new Map<string, {
    packet: Awaited<ReturnType<typeof readMaterialIntelligence>>;
    semantic: Awaited<ReturnType<typeof verifyMaterialSemanticsReceipt>>;
  }>();
  for (const evidence of evidenceSet.receipts) {
    checkCurrent();
    const clip = findClip(current, evidence.clipId);
    const asset = findAsset(current, evidence.assetId);
    if (clip.assetId !== asset.id) throw new Error(`素材語意 receipt 的 clip／asset 不一致：${evidence.clipId}`);
    const packet = await readMaterialIntelligence(runtime.cacheRoot, evidence.materialId);
    if (packet.source.clipId !== evidence.clipId || packet.source.assetId !== evidence.assetId || packet.source.sourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材語意包已過期或引用錯誤：${evidence.materialId}`);
    }
    if (!Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
      || !Number.isFinite(clip.duration) || clip.duration <= 0
      || !Number.isFinite(current.fps) || current.fps <= 0
      || packet.source.sourceStart !== clip.sourceStart || packet.source.duration !== clip.duration
      || packet.source.fps !== current.fps || packet.source.kind !== asset.kind) {
      throw new Error(`素材分析時間窗／fps／類型已改變，請重新分析：${evidence.clipId}`);
    }
    if (asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材已在分析後改變：${evidence.assetId}`);
    }
    if (packet.cache && (canonicalJson(packet.source.color ?? null) !== canonicalJson(asset.color ?? null)
      || canonicalJson(packet.source.colorManagement ?? DEFAULT_COLOR_MANAGEMENT) !== canonicalJson(current.colorManagement ?? DEFAULT_COLOR_MANAGEMENT))) {
      throw new Error(`素材色彩解讀／管理設定已改變，請重新分析：${evidence.clipId}`);
    }
    const semantic = await verifyMaterialSemanticsReceipt(runtime.cacheRoot, evidence.materialId, evidence.semanticReceiptSha256);
    if (semantic.materialId !== evidence.materialId || semantic.sourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材語意 receipt 的 materialId／來源 hash 不一致：${evidence.materialId}`);
    }
    if (silentMedia && (semantic.segments.some(segment => segment.transcriptCueIndexes.length)
      || semantic.transcriptEvidence?.length)) {
      throw new Error(`silent_media 素材語意不能含語音逐字稿證據：${evidence.materialId}`);
    }
    verified.set(`${evidence.materialId}:${evidence.semanticReceiptSha256}`, { packet, semantic });
    // Keep path authority in the existing workspace/creative resolver. No URI fallback.
    const path = await runtime.resolveSource(asset.id);
    const interval = silentMedia ? { canonicalPath: await realpath(path), version: await stat(path, { bigint: true }) } : undefined;
    const actualSourceSha256 = await currentSourceSha256(path, checkCurrent);
    if (actualSourceSha256 !== evidence.sourceSha256) {
      throw new Error(`素材實際來源 SHA-256 已改變，請重新分析：${evidence.assetId}`);
    }
    if (silentMedia) {
      assertOrdinarySilentSource(asset);
      if (!packet.cache || packet.source.hasAudio !== false) throw new Error(`silent_media 需要完整性封存且明示 hasAudio=false 的素材包：${evidence.materialId}`);
      const transcript = packet.analysis.transcript;
      if (transcript.state !== "not_applicable" || transcript.cueCount !== 0 || transcript.cues.length
        || transcript.recognition || transcript.rawTranscript || transcript.segmentation) {
        throw new Error(`silent_media 無音訊素材不能製造逐字稿／語音證據：${evidence.materialId}`);
      }
      let source = silentSources.get(asset.id);
      if (!source) {
        // Cache integrity is not authenticity. Silence is independently observed
        // by the normal authorized-source media probe, never by the cached flag alone.
        const probe = await (runtime.inspectMedia ?? inspectMedia)(path, runtime.ffprobePath);
        checkCurrent();
        if (probe.hasAudio !== false || probe.imageSequence || (asset.kind === "video" && probe.hasVideo !== true)) {
          throw new Error(`silent_media 實際來源 probe 並未確認無音訊：${asset.id}`);
        }
        if ((asset.kind === "video" && (!Number.isFinite(probe.duration) || Math.abs(probe.duration - asset.duration) > 1e-7))
          || (asset.width !== undefined && asset.width !== probe.width) || (asset.height !== undefined && asset.height !== probe.height)
          || (asset.displayAspectRatio !== undefined && asset.displayAspectRatio !== probe.displayAspectRatio)
          || (packet.source.width !== undefined && packet.source.width !== probe.width)
          || (packet.source.height !== undefined && packet.source.height !== probe.height)) {
          throw new Error(`silent_media 實際來源 probe 幾何／duration 與素材不一致：${asset.id}`);
        }
        if (await currentSourceSha256(path, checkCurrent) !== actualSourceSha256) throw new Error(`silent_media 來源在 probe 期間改變：${asset.id}`);
        if (await realpath(path) !== interval!.canonicalPath || !sameFileVersion(interval!.version, await stat(path, { bigint: true }))) {
          throw new Error(`silent_media 來源檔案版本在 probe 期間改變：${asset.id}`);
        }
        source = { assetIdentity: canonicalJson(asset), sourceSha256: actualSourceSha256, path, ...interval!, windows: [] };
        silentSources.set(asset.id, source);
      } else if (source.path !== path || source.sourceSha256 !== actualSourceSha256 || source.assetIdentity !== canonicalJson(asset)) {
        throw new Error(`silent_media 同一 asset 的素材來源 identity 不一致：${asset.id}`);
      }
      source.windows.push({ start: packet.source.sourceStart, duration: packet.source.duration });
    }
  }
  if (silentMedia) {
    assertSilentClipCoverage(current, silentSources);
    for (const [assetId, source] of silentSources) if (canonicalJson(findAsset(predicted!, assetId)) !== source.assetIdentity) {
      throw new Error(`silent_media 不能改寫已驗證素材的完整 asset identity：${assetId}`);
    }
    assertSilentClipCoverage(predicted!, silentSources);
    if (canonicalJson(predicted!.colorManagement ?? DEFAULT_COLOR_MANAGEMENT) !== canonicalJson(current.colorManagement ?? DEFAULT_COLOR_MANAGEMENT)) {
      throw new Error("silent_media 不能改寫素材分析所綁定的色彩管理");
    }
    for (const [assetId, source] of silentSources) {
      if (await runtime.resolveSource(assetId) !== source.path || await realpath(source.path) !== source.canonicalPath
        || await currentSourceSha256(source.path, checkCurrent) !== source.sourceSha256
        || !sameFileVersion(source.version, await stat(source.path, { bigint: true }))) {
        throw new Error(`silent_media 素材在驗證完成前改變：${assetId}`);
      }
    }
    checkCurrent();
    if (canonicalJson(project) !== projectIdentity) throw new Error("silent_media 專案在素材驗證期間改變");
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
  return { receiptCount: evidenceSet.receipts.length, materialIds: evidenceSet.receipts.map((receipt) => receipt.materialId),
    ...(silentMedia ? { silentMedia: { mode: "silent_media" as const, independentlyProbedSourceCount: silentSources.size, currentAndPredictedClipCoverage: true, pointInTimeOnly: true } } : {}) };
}
