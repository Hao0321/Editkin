import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { analyzeSceneCuts, type SceneCut } from "./sceneDetection";
import { analyzeAutomaticCaptionTranscript, automaticCaptionRuntimeSha256, captionScriptTarget, configuredWhisperCliPath, type AutomaticCaptionCue } from "./automaticCaptions";
import { inspectMedia } from "./inspectMedia";
import { PINNED_WHISPER_MODEL } from "./automaticCaptions";
import { selectedWhisperModelV1, withWhisperModelRuntimeV1 } from "./whisperModelChoiceV1";
import { ensurePinnedModelFileV1 } from "./whisperPinnedDownloadV1";
import { getMaterialColorRuntimeIdentity, sampleMaterialColor } from "./materialColorSampling";
import { hashMaterialJson, hashMaterialSource, publishMaterialCache, readCompletedMaterialCache, sealMaterialPacket, verifyMaterialPacket, type MaterialCacheIdentity, MaterialPreparationWorkPool } from "./materialEvidenceCache";
import { withMediaCachePublishLock } from "./mediaCachePublishLock";
import { createMaterialCacheStagingDirectoryV1 } from "./materialCacheStagingDirectoryV1";
import { materialColorCodeIdentity } from "./materialColorCodeIdentity";
import { extractMaterialKeyframes } from "./materialKeyframeExtraction";
import { validateExplicitKeyframeTimes } from "./materialKeyframeTypes";

import type { MaterialKeyframe, MaterialIntelligencePacket, PrepareMaterialRequest, MaterialRuntime, MaterialPreparationProgress } from "./materialIntelligenceProtocol";
export type { MaterialKeyframe, MaterialIntelligencePacket, PrepareMaterialRequest, MaterialRuntime, MaterialPreparationProgress } from "./materialIntelligenceProtocol";
export { compactMaterialContext, type MaterialContextOptions } from "./materialIntelligenceContext";

export const MATERIAL_INTELLIGENCE_SCHEMA = "hao.editkin.material-intelligence/v1" as const;
export const MATERIAL_SEMANTICS_SCHEMA = "hao.editkin.material-semantics/v1" as const;
const MATERIAL_ID = /^[a-f0-9]{64}$/;
const MAX_TRANSCRIPT_CUES = 2_000;

const semanticSegmentSchema = z.strictObject({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  summary: z.string().trim().min(1).max(500),
  subjects: z.array(z.string().trim().min(1).max(100)).max(16).default([]),
  actions: z.array(z.string().trim().min(1).max(120)).max(16).default([]),
  objects: z.array(z.string().trim().min(1).max(100)).max(16).default([]),
  emotion: z.string().trim().max(80).optional(),
  importance: z.number().min(0).max(1),
  evidenceFrameIds: z.array(z.string()).max(12).default([]),
  transcriptCueIndexes: z.array(z.number().int().nonnegative()).max(80).default([]),
  uncertainty: z.string().trim().max(300).optional(),
});

export const materialSemanticsInputSchema = z.strictObject({
  materialId: z.string().regex(MATERIAL_ID),
  sourceSha256: z.string().regex(MATERIAL_ID),
  overallTopic: z.string().trim().min(1).max(500),
  contentType: z.string().trim().min(1).max(100),
  language: z.string().trim().min(1).max(32),
  people: z.array(z.string().trim().min(1).max(100)).max(32).default([]),
  locations: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
  segments: z.array(semanticSegmentSchema).min(1).max(256),
});

export type MaterialSemanticsInput = z.infer<typeof materialSemanticsInputSchema>;

export interface MaterialSemanticsReceipt extends MaterialSemanticsInput {
  schema: typeof MATERIAL_SEMANTICS_SCHEMA;
  /**
   * Copied by Editkin from the prepared material packet, never accepted from
   * the model. Historical receipts may omit it and remain readable, but they
   * cannot authorize an identity lower third.
   */
  transcriptEvidence?: Array<{
    cueIndex: number;
    start: number;
    end: number;
    textSha256: string;
  }>;
  semanticReceiptSha256: string;
  createdAt: string;
}

export function materialTranscriptCueSha256(cue: Pick<AutomaticCaptionCue, "start" | "end" | "text">): string {
  return createHash("sha256").update(JSON.stringify({ start: cue.start, end: cue.end, text: cue.text })).digest("hex");
}

function cleanReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[A-Za-z]:\\[^\n\r]+|\/(?:[^\s/]+\/)+[^\s]+/g, "[local-path]").slice(0, 500);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function selectMaterialKeyframeTimes(duration: number, cuts: SceneCut[], maximum: number, requestedTimes?: number[]): number[] {
  if (requestedTimes !== undefined) return validateExplicitKeyframeTimes(requestedTimes, duration, clamp(Math.floor(maximum), 1, 12));
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const maxFrames = clamp(Math.floor(maximum), 1, 12);
  const boundaries = [0, ...cuts.map((cut) => clamp(cut.time, 0, duration)), duration]
    .filter((time, index, all) => index === 0 || Math.abs(time - all[index - 1]) > 1e-3);
  // A continuous take can contain many editorial events without a camera cut.
  // Do not reduce a seven-minute recording to just first/middle/last. Fill the
  // existing caller budget over time, while retaining the cheap short-clip path.
  // These are coverage samples, not proof that every event has been inspected.
  if (boundaries.length === 2 && duration > 60 && maxFrames > 3) {
    const count = Math.min(maxFrames, Math.ceil(duration / 30) + 1);
    const first = 0.1, last = duration - 0.1;
    return Array.from({ length: count }, (_, index) => Number((first + (last - first) * index / (count - 1)).toFixed(3)));
  }
  const sceneMiddles = boundaries.slice(0, -1).map((start, index) => (start + boundaries[index + 1]) / 2);
  const candidates = [Math.min(0.1, duration / 2), ...sceneMiddles, Math.max(0, duration - 0.1)];
  const unique = [...new Set(candidates.map((time) => Number(clamp(time, 0, Math.max(0, duration - 0.001)).toFixed(3))))];
  if (unique.length <= maxFrames) return unique.sort((left, right) => left - right);
  return Array.from({ length: maxFrames }, (_, index) => unique[Math.round(index * (unique.length - 1) / Math.max(1, maxFrames - 1))])
    .filter((time, index, all) => index === 0 || time !== all[index - 1]);
}

function materialDirectory(cacheRoot: string, materialId: string): string {
  if (!MATERIAL_ID.test(materialId)) throw new Error("materialId 不合法");
  return join(resolve(cacheRoot), "material-intelligence", materialId);
}

function publicPacket(packet: MaterialIntelligencePacket): MaterialIntelligencePacket {
  return structuredClone(packet);
}

type PreparedMaterialResult = { packet: MaterialIntelligencePacket; cacheHit: boolean };
const preparationWork = new MaterialPreparationWorkPool<PreparedMaterialResult, MaterialPreparationProgress>();
/** Logical process-local preparation resources; does not count OS/native handles. */
export const materialPreparationWorkSnapshot = () => preparationWork.snapshot();

export async function prepareMaterialIntelligence(
  request: PrepareMaterialRequest,
  runtime: MaterialRuntime,
): Promise<{ packet: MaterialIntelligencePacket; cacheHit: boolean }> {
  if (!request.assetId.trim() || !request.clipId.trim()) throw new Error("素材或片段 id 不可空白");
  if (!Number.isFinite(request.sourceStart) || request.sourceStart < 0 || !Number.isFinite(request.duration) || request.duration <= 0) {
    throw new Error("素材時間範圍不合法");
  }
  if (!Number.isFinite(request.fps) || request.fps <= 0 || (request.maxKeyframes !== undefined && !Number.isFinite(request.maxKeyframes))) throw new Error("素材幀率／抽幀預算不合法");
  if (request.keyframeTimes !== undefined) {
    if (request.kind !== "video") throw Error("explicit-keyframe-times-require-video");
    request = { ...request, keyframeTimes: validateExplicitKeyframeTimes(request.keyframeTimes, request.duration, clamp(Math.floor(request.maxKeyframes ?? 8), 1, 12)) };
  }
  runtime = { ...withWhisperModelRuntimeV1(runtime, request.whisperModel, PINNED_WHISPER_MODEL), whisperCliPath: configuredWhisperCliPath(runtime) };
  runtime.signal?.throwIfAborted();
  await runtime.onProgress?.({ phase: "identity" });
  await Promise.all([access(request.sourcePath), access(runtime.ffmpegPath)]);
  const sourceSha256 = await hashMaterialSource(request.sourcePath, { signal: runtime.signal });
  if (request.sourceSha256 !== undefined && request.sourceSha256.toLowerCase() !== sourceSha256) throw new Error("來源 SHA-256 已變更，請重新匯入／分析");
  if (runtime.whisperModel === "medium" && request.includeTranscript !== false && request.kind !== "image") {
    const selectedModel = selectedWhisperModelV1(runtime.whisperModel, PINNED_WHISPER_MODEL), expectedPath = resolve(runtime.modelRoot, selectedModel.fileName);
    const selectedPath = runtime.modelPath ? resolve(runtime.modelPath) : expectedPath;
    const isDefaultPath = process.platform === "win32" ? selectedPath.toLowerCase() === expectedPath.toLowerCase() : selectedPath === expectedPath;
    await ensurePinnedModelFileV1({ ...runtime, modelPath: isDefaultPath ? undefined : runtime.modelPath }, selectedModel);
  }
  const colorRuntime = await getMaterialColorRuntimeIdentity(runtime);
  const preparation = materialColorCodeIdentity().implementations.find(item => item.name === "materialIntelligence.ts");
  if (!preparation) throw new Error("material-preparation-implementation-missing");
  const identity: MaterialCacheIdentity = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA, assetId: request.assetId, clipId: request.clipId,
    sourceSha256, sourceStart: request.sourceStart, duration: request.duration, fps: request.fps, kind: request.kind,
    language: request.language ?? "auto", includeTranscript: request.includeTranscript !== false,
    maxKeyframes: clamp(Math.floor(request.maxKeyframes ?? 8), 1, 12), engineRevision: 4,
    ...(request.keyframeTimes !== undefined ? { keyframeTimes: request.keyframeTimes } : {}),
    color: request.color, colorManagement: request.colorManagement, colorRuntime,
    preparationSha256: preparation.sha256,
    ...(runtime.requireTranscriptCompletion ? { transcriptPolicy: "required" as const } : {}),
    ...(request.includeTranscript !== false && request.kind !== "image"
      // Packets hold script-converted cue text, so the target script is part of the material identity.
      ? { transcriptRuntimeSha256: await automaticCaptionRuntimeSha256(runtime), captionScript: captionScriptTarget(request.script) } : {}),
  };
  const materialId = hashMaterialJson(identity);
  const directory = materialDirectory(runtime.cacheRoot, materialId);
  const workKey = process.platform === "win32" ? directory.toLowerCase() : directory;
  const lease = preparationWork.acquire(workKey, async (signal, onProgress) => {
    const sharedRuntime = { ...runtime, signal, onProgress };
    const cached = await readCompletedMaterialCache<MaterialIntelligencePacket>(directory, materialId);
    sharedRuntime.signal?.throwIfAborted();
    if (cached) {
      return { packet: cached, cacheHit: true };
    }
    const probe = await inspectMedia(request.sourcePath, runtime.ffprobePath, [], { signal, shared: true });
    signal.throwIfAborted();
    await mkdir(dirname(directory), { recursive: true });
    const staging = await createMaterialCacheStagingDirectoryV1(dirname(directory), materialId);
    try {
      const packet = await prepareMaterialContent(request, sharedRuntime, probe, identity, materialId, staging);
      sharedRuntime.signal?.throwIfAborted();
      await sharedRuntime.onProgress?.({ phase: "finalizing" });
      if (await hashMaterialSource(request.sourcePath, { signal }) !== sourceSha256) throw new Error("來源 SHA-256 在分析期間改變");
      sharedRuntime.signal?.throwIfAborted();
      verifyMaterialPacket(packet, materialId);
      await writeJsonAtomic(join(staging, "manifest.json"), packet);
      const winner = await withMediaCachePublishLock(directory, () => {
        signal.throwIfAborted();
        return publishMaterialCache<MaterialIntelligencePacket>(staging, directory, materialId);
      });
      if (winner) return { packet: winner, cacheHit: true };
      return { packet, cacheHit: false };
    } finally {
      // Only the exact generated private staging directory can be removed.
      if (dirname(resolve(staging)) !== dirname(resolve(directory))) throw new Error("素材 staging 邊界不合法");
      await rm(staging, { recursive: true, force: true });
    }
  }, { signal: runtime.signal, onProgress: runtime.onProgress });
  try {
    const result = await lease.result;
    runtime.signal?.throwIfAborted();
    // Every caller rechecks its own source, even when another path produced the result.
    if (await hashMaterialSource(request.sourcePath, { signal: runtime.signal }) !== sourceSha256) throw new Error("來源 SHA-256 在 cache 驗證中改變");
    runtime.signal?.throwIfAborted();
    return { packet: publicPacket(result.packet), cacheHit: result.cacheHit || lease.coalesced };
  } finally { await lease.release(); }
}

async function prepareMaterialContent(
  request: PrepareMaterialRequest, runtime: MaterialRuntime,
  probe: Awaited<ReturnType<typeof inspectMedia>>, identity: MaterialCacheIdentity,
  materialId: string, directory: string,
): Promise<MaterialIntelligencePacket> {
  const sourceSha256 = identity.sourceSha256;
  let scene: MaterialIntelligencePacket["analysis"]["scene"] = { state: "not_applicable", cuts: [] };
  if (request.kind === "video") {
    runtime.signal?.throwIfAborted();
    await runtime.onProgress?.({ phase: "scene" });
    try {
      const result = await analyzeSceneCuts({ ...request, sourceSha256 }, { ffmpegPath: runtime.ffmpegPath, cacheRoot: runtime.cacheRoot, signal: runtime.signal });
      scene = { state: "ready", engine: result.engine, cuts: result.cuts };
    } catch (error) { runtime.signal?.throwIfAborted(); scene = { state: "blocked", cuts: [], reason: cleanReason(error) }; }
  }

  let transcript: MaterialIntelligencePacket["analysis"]["transcript"] = {
    state: request.includeTranscript === false || !probe.hasAudio ? "not_applicable" : "blocked", cueCount: 0, cues: [],
  };
  if (request.includeTranscript !== false && probe.hasAudio) {
    runtime.signal?.throwIfAborted();
    try {
      const result = await analyzeAutomaticCaptionTranscript({ ...request, sourceSha256 }, {
        ffmpegPath: runtime.ffmpegPath, modelRoot: runtime.modelRoot, modelPath: runtime.modelPath, whisperModel: runtime.whisperModel, mediumModelPath: runtime.mediumModelPath, smallModelPath: runtime.smallModelPath, cacheRoot: runtime.cacheRoot, whisperCliPath: runtime.whisperCliPath,
        signal: runtime.signal, onProgress: runtime.onProgress,
      });
      if (result.cues.length > MAX_TRANSCRIPT_CUES) throw new Error("逐字稿超過 2000 段，請分成較短素材分析；未將截斷結果標為完成");
      const cues = result.cues;
      transcript = {
        state: "ready", engine: result.engine, language: result.language, cueCount: cues.length, cues,
        ...(result.scriptConversion ? { scriptConversion: result.scriptConversion } : {}),
        recognition: result.recognition, rawTranscript: result.rawTranscript,
        ...(result.segmentation ? { segmentation: result.segmentation } : {}),
        ...(result.recognition.status === "empty" ? { reason: "辨識程序已完成，但沒有可用逐字稿；聲音內容尚未驗證，不代表素材沒有語音" } : {}),
      };
    } catch (error) { runtime.signal?.throwIfAborted(); if (runtime.requireTranscriptCompletion) throw error; transcript = { state: "blocked", cueCount: 0, cues: [], reason: cleanReason(error) }; }
  }

  const keyframes: MaterialKeyframe[] = [];
  // A still image has exactly one decodable frame: sample it once, at t=0.
  const samples = request.kind === "audio" ? [] : (request.kind === "image" ? [0] : selectMaterialKeyframeTimes(request.duration, scene.cuts, identity.maxKeyframes, identity.keyframeTimes))
    .map((time, index) => ({ id: `kf-${index + 1}`, time, sceneIndex: scene.cuts.filter(cut => cut.time <= time).length }));
  const visualRequest = {
    sourcePath: request.sourcePath, sourceSha256, sourceStart: request.sourceStart, duration: request.duration,
    kind: request.kind, color: request.color, colorManagement: request.colorManagement, samples,
    sceneCount: request.kind === "audio" ? 0 : scene.cuts.length + 1,
    sceneCountVerified: scene.state === "ready" || request.kind === "image",
    sceneCuts: scene.state === "ready" ? scene.cuts.map(cut => cut.time) : request.kind === "image" ? [] : undefined,
  };
  runtime.signal?.throwIfAborted();
  await runtime.onProgress?.({ phase: "keyframes" });
  const display = await extractMaterialKeyframes(visualRequest, runtime, identity.colorRuntime);
  runtime.signal?.throwIfAborted();
  for (const frame of display.frames) {
    const fileName = `frame-${String(samples.findIndex(sample => sample.id === frame.id) + 1).padStart(2, "0")}.jpg`;
    await writeFile(join(directory, fileName), frame.data, { flag: "wx" });
    keyframes.push({ id: frame.id, time: frame.time, sceneIndex: frame.sceneIndex, sha256: frame.display.jpeg.sha256, bytes: frame.data.length, mimeType: "image/jpeg", fileName, display: frame.display });
  }

  await runtime.onProgress?.({ phase: "color" });
  const color = await sampleMaterialColor(visualRequest, runtime, identity.colorRuntime);
  runtime.signal?.throwIfAborted();
  const packet: MaterialIntelligencePacket = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA,
    materialId,
    source: {
      assetId: request.assetId, clipId: request.clipId, sourceSha256, sourceStart: request.sourceStart,
      duration: request.duration, kind: request.kind, width: probe.width, height: probe.height,
      fps: request.fps, hasAudio: probe.hasAudio,
      color: request.color, colorManagement: request.colorManagement,
    },
    analysis: { scene, transcript, keyframes: display.analysis, color },
    keyframes,
    createdAt: new Date().toISOString(),
  };
  return sealMaterialPacket(packet, identity);
}

export async function readMaterialIntelligence(cacheRoot: string, materialId: string): Promise<MaterialIntelligencePacket> {
  const packet = JSON.parse(await readFile(join(materialDirectory(cacheRoot, materialId), "manifest.json"), "utf8")) as MaterialIntelligencePacket;
  verifyMaterialPacket(packet, materialId);
  return packet;
}

export async function readMaterialKeyframe(cacheRoot: string, materialId: string, frameId: string): Promise<{ frame: MaterialKeyframe; data: Buffer }> {
  const packet = await readMaterialIntelligence(cacheRoot, materialId);
  const frame = packet.keyframes.find((candidate) => candidate.id === frameId);
  if (!frame || !/^frame-\d{2}\.jpg$/.test(frame.fileName)) throw new Error(`找不到關鍵幀：${frameId}`);
  const data = await readFile(join(materialDirectory(cacheRoot, materialId), frame.fileName));
  if (createHash("sha256").update(data).digest("hex") !== frame.sha256) throw new Error(`關鍵幀完整性驗證失敗：${frameId}`);
  return { frame, data };
}

export async function recordMaterialSemantics(cacheRoot: string, input: MaterialSemanticsInput): Promise<MaterialSemanticsReceipt> {
  const parsed = materialSemanticsInputSchema.parse(input);
  const packet = await readMaterialIntelligence(cacheRoot, parsed.materialId);
  if (packet.source.sourceSha256 !== parsed.sourceSha256.toLowerCase()) throw new Error("語意判讀的素材 SHA-256 已失效，請重新分析");
  const frameIds = new Set(packet.keyframes.map((frame) => frame.id));
  for (const segment of parsed.segments) {
    if (segment.end <= segment.start || segment.end > packet.source.duration + 1e-6) throw new Error("語意片段時間範圍不合法");
    if (segment.evidenceFrameIds.some((id) => !frameIds.has(id))) throw new Error("語意片段引用不存在的關鍵幀");
    if (segment.transcriptCueIndexes.some((index) => index >= packet.analysis.transcript.cueCount || !packet.analysis.transcript.cues[index])) throw new Error("語意片段引用不存在的逐字稿 cue");
    if (!segment.evidenceFrameIds.length && !segment.transcriptCueIndexes.length) throw new Error("每個語意片段至少需要一項關鍵幀或逐字稿證據");
  }
  const transcriptEvidence = [...new Set(parsed.segments.flatMap((segment) => segment.transcriptCueIndexes))]
    .sort((left, right) => left - right)
    .map((cueIndex) => {
      const cue = packet.analysis.transcript.cues[cueIndex];
      return { cueIndex, start: cue.start, end: cue.end, textSha256: materialTranscriptCueSha256(cue) };
    });
  const normalized = { schema: MATERIAL_SEMANTICS_SCHEMA, ...parsed, transcriptEvidence };
  const semanticReceiptSha256 = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const receipt: MaterialSemanticsReceipt = { ...normalized, semanticReceiptSha256, createdAt: new Date().toISOString() };
  await writeJsonAtomic(join(materialDirectory(cacheRoot, parsed.materialId), "semantics", `${semanticReceiptSha256}.json`), receipt);
  return receipt;
}

export async function verifyMaterialSemanticsReceipt(cacheRoot: string, materialId: string, receiptSha256: string): Promise<MaterialSemanticsReceipt> {
  if (!MATERIAL_ID.test(receiptSha256)) throw new Error("semantic receipt SHA-256 不合法");
  const receipt = JSON.parse(await readFile(join(materialDirectory(cacheRoot, materialId), "semantics", `${receiptSha256}.json`), "utf8")) as MaterialSemanticsReceipt;
  const normalized = {
    schema: receipt.schema, materialId: receipt.materialId, sourceSha256: receipt.sourceSha256,
    overallTopic: receipt.overallTopic, contentType: receipt.contentType, language: receipt.language,
    people: receipt.people, locations: receipt.locations, segments: receipt.segments,
    ...(receipt.transcriptEvidence ? { transcriptEvidence: receipt.transcriptEvidence } : {}),
  };
  const actual = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  if (receipt.schema !== MATERIAL_SEMANTICS_SCHEMA || receipt.semanticReceiptSha256 !== receiptSha256 || actual !== receiptSha256) throw new Error("素材語意 receipt 完整性驗證失敗");
  if (receipt.transcriptEvidence) {
    const packet = await readMaterialIntelligence(cacheRoot, materialId);
    const referenced = [...new Set(receipt.segments.flatMap((segment) => segment.transcriptCueIndexes))].sort((left, right) => left - right);
    if (receipt.transcriptEvidence.length !== referenced.length) throw new Error("素材語意 receipt 的逐字稿證據清冊不完整");
    for (const [position, sealed] of receipt.transcriptEvidence.entries()) {
      if (!Number.isSafeInteger(sealed.cueIndex) || sealed.cueIndex !== referenced[position]
        || !Number.isFinite(sealed.start) || !Number.isFinite(sealed.end) || sealed.end <= sealed.start
        || !/^[a-f0-9]{64}$/.test(sealed.textSha256)) throw new Error("素材語意 receipt 的逐字稿證據清冊不合法");
      const cue = packet.analysis.transcript.cues[sealed.cueIndex];
      if (!cue || cue.start !== sealed.start || cue.end !== sealed.end || materialTranscriptCueSha256(cue) !== sealed.textSha256) {
        throw new Error("素材語意 receipt 的逐字稿證據已漂移");
      }
    }
  }
  return receipt;
}
