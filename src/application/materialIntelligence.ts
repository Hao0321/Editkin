import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { analyzeSceneCuts, type SceneCut } from "./sceneDetection";
import { analyzeAutomaticCaptionTranscript, automaticCaptionRuntimeSha256, configuredWhisperCliPath, type AutomaticCaptionCue, type AutomaticCaptionRecognition, type RawWhisperTranscript } from "./automaticCaptions";
import { inspectMedia } from "./inspectMedia";
import type { ColorManagementSettings, MediaColorMetadata } from "../domain/types";
import { getMaterialColorRuntimeIdentity, sampleMaterialColor, type MaterialColorReceipt } from "./materialColorSampling";
import { hashMaterialJson, hashMaterialSource, publishMaterialCache, readCompletedMaterialCache, sealMaterialPacket, verifyMaterialPacket, type MaterialCacheIdentity, type MaterialCacheSeal } from "./materialEvidenceCache";
import { materialColorReference, materialColorSummary } from "./materialColorContext";
import { materialColorCodeIdentity } from "./materialColorCodeIdentity";
import { extractMaterialKeyframes } from "./materialKeyframeExtraction";
import type { CaptionSegmentation } from "./segmentedCaptions";
import type { AutomaticCaptionRuntime } from "./automaticCaptions";
import { validateExplicitKeyframeTimes, type MaterialKeyframeAnalysis, type MaterialKeyframeDisplay } from "./materialKeyframeTypes";
import {
  AGENT_CONTEXT_MAX_TOKENS,
  MATERIAL_CONTEXT_DEFAULT_TOKENS,
  estimateAgentContextTokens,
} from "./agentContextBudget";

export const MATERIAL_INTELLIGENCE_SCHEMA = "hao.editkin.material-intelligence/v1" as const;
export const MATERIAL_SEMANTICS_SCHEMA = "hao.editkin.material-semantics/v1" as const;
const MATERIAL_ID = /^[a-f0-9]{64}$/;
const MAX_TRANSCRIPT_CUES = 2_000;

export interface MaterialKeyframe {
  id: string;
  time: number;
  sceneIndex: number;
  sha256: string;
  bytes: number;
  mimeType: "image/jpeg";
  fileName: string;
  /** Absent only on historical, read-only evidence. */
  display?: MaterialKeyframeDisplay;
}

export interface MaterialIntelligencePacket {
  schema: typeof MATERIAL_INTELLIGENCE_SCHEMA;
  materialId: string;
  cache?: MaterialCacheSeal;
  source: {
    assetId: string;
    clipId: string;
    sourceSha256: string;
    sourceStart: number;
    duration: number;
    kind: "video" | "audio" | "image";
    width?: number;
    height?: number;
    fps: number;
    hasAudio: boolean;
    color?: MediaColorMetadata;
    colorManagement?: ColorManagementSettings;
  };
  analysis: {
    keyframes?: MaterialKeyframeAnalysis;
    color?: MaterialColorReceipt;
    scene: { state: "ready" | "not_applicable" | "blocked"; engine?: string; cuts: SceneCut[]; reason?: string };
    transcript: {
      state: "ready" | "not_applicable" | "blocked";
      engine?: string;
      language?: string;
      cueCount: number;
      cues: AutomaticCaptionCue[];
      reason?: string;
      recognition?: AutomaticCaptionRecognition;
      rawTranscript?: RawWhisperTranscript;
      segmentation?: CaptionSegmentation;
    };
  };
  keyframes: MaterialKeyframe[];
  createdAt: string;
}

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

export interface PrepareMaterialRequest {
  assetId: string;
  clipId: string;
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  kind: "video" | "audio" | "image";
  sourceSha256?: string;
  language?: string;
  includeTranscript?: boolean;
  maxKeyframes?: number;
  /** Optional exact, increasing clip-relative source seconds for local event inspection. */
  keyframeTimes?: number[];
  color?: MediaColorMetadata;
  colorManagement?: ColorManagementSettings;
}

export interface MaterialRuntime {
  ffmpegPath: string;
  ffprobePath?: string;
  modelRoot: string;
  cacheRoot: string;
  modelPath?: string;
  whisperCliPath?: string;
  requireTranscriptCompletion?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: MaterialPreparationProgress) => void | Promise<void>;
}

export type MaterialPreparationProgress = { phase: "identity" | "scene" | "keyframes" | "color" | "finalizing" }
  | Parameters<NonNullable<AutomaticCaptionRuntime["onProgress"]>>[0];

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
  runtime = { ...runtime, whisperCliPath: configuredWhisperCliPath(runtime) };
  runtime.signal?.throwIfAborted();
  await runtime.onProgress?.({ phase: "identity" });
  await Promise.all([access(request.sourcePath), access(runtime.ffmpegPath)]);
  const sourceSha256 = await hashMaterialSource(request.sourcePath);
  if (request.sourceSha256 !== undefined && request.sourceSha256.toLowerCase() !== sourceSha256) throw new Error("來源 SHA-256 已變更，請重新匯入／分析");
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
      ? { transcriptRuntimeSha256: await automaticCaptionRuntimeSha256(runtime) } : {}),
  };
  const materialId = hashMaterialJson(identity);
  const directory = materialDirectory(runtime.cacheRoot, materialId);
  const cached = await readCompletedMaterialCache<MaterialIntelligencePacket>(directory, materialId);
  runtime.signal?.throwIfAborted();
  if (cached) {
    if (await hashMaterialSource(request.sourcePath) !== sourceSha256) throw new Error("來源 SHA-256 在 cache 驗證中改變");
    return { packet: publicPacket(cached), cacheHit: true };
  }
  const probe = await inspectMedia(request.sourcePath, runtime.ffprobePath);
  await mkdir(dirname(directory), { recursive: true });
  const staging = await mkdtemp(join(dirname(directory), `.pending-${materialId}-`));
  try {
    const packet = await prepareMaterialContent(request, runtime, probe, identity, materialId, staging);
    runtime.signal?.throwIfAborted();
    await runtime.onProgress?.({ phase: "finalizing" });
    if (await hashMaterialSource(request.sourcePath) !== sourceSha256) throw new Error("來源 SHA-256 在分析期間改變");
    runtime.signal?.throwIfAborted();
    verifyMaterialPacket(packet, materialId);
    await writeJsonAtomic(join(staging, "manifest.json"), packet);
    const winner = await publishMaterialCache<MaterialIntelligencePacket>(staging, directory, materialId);
    if (winner) return { packet: publicPacket(winner), cacheHit: true };
    return { packet: publicPacket(packet), cacheHit: false };
  } finally {
    // Only the exact generated private staging directory can be removed.
    if (dirname(resolve(staging)) !== dirname(resolve(directory))) throw new Error("素材 staging 邊界不合法");
    await rm(staging, { recursive: true, force: true });
  }
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
        ffmpegPath: runtime.ffmpegPath, modelRoot: runtime.modelRoot, modelPath: runtime.modelPath, cacheRoot: runtime.cacheRoot, whisperCliPath: runtime.whisperCliPath,
        signal: runtime.signal, onProgress: runtime.onProgress,
      });
      if (result.cues.length > MAX_TRANSCRIPT_CUES) throw new Error("逐字稿超過 2000 段，請分成較短素材分析；未將截斷結果標為完成");
      const cues = result.cues;
      transcript = {
        state: "ready", engine: result.engine, language: result.language, cueCount: cues.length, cues,
        recognition: result.recognition, rawTranscript: result.rawTranscript,
        ...(result.segmentation ? { segmentation: result.segmentation } : {}),
        ...(result.recognition.status === "empty" ? { reason: "辨識程序已完成，但沒有可用逐字稿；聲音內容尚未驗證，不代表素材沒有語音" } : {}),
      };
    } catch (error) { runtime.signal?.throwIfAborted(); if (runtime.requireTranscriptCompletion) throw error; transcript = { state: "blocked", cueCount: 0, cues: [], reason: cleanReason(error) }; }
  }

  const keyframes: MaterialKeyframe[] = [];
  const samples = request.kind === "audio" ? [] : selectMaterialKeyframeTimes(request.duration, scene.cuts, identity.maxKeyframes, identity.keyframeTimes)
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

export interface MaterialContextOptions {
  afterCueIndex?: number;
  maxTokens?: number;
  maxCuts?: number;
}

export function compactMaterialContext(
  packet: MaterialIntelligencePacket,
  start: number,
  end: number,
  maxCues: number,
  options: MaterialContextOptions = {},
) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || end > packet.source.duration + 1e-6) throw new Error("素材 context 時間窗不合法");
  const afterCueIndex = Math.max(-1, Math.floor(options.afterCueIndex ?? -1));
  const maxTokenBudget = clamp(Math.floor(options.maxTokens ?? MATERIAL_CONTEXT_DEFAULT_TOKENS), 200, AGENT_CONTEXT_MAX_TOKENS);
  const maximumCues = clamp(Math.floor(maxCues), 1, 200);
  const maximumCuts = clamp(Math.floor(options.maxCuts ?? 20), 1, 100);
  const cueCandidates = packet.analysis.transcript.cues
    .map((cue, index) => ({ ...cue, index }))
    .filter((cue) => cue.start < end && cue.end > start)
    .filter((cue) => cue.index > afterCueIndex);
  const allCuts = packet.analysis.scene.cuts.filter((cut) => cut.time >= start && cut.time <= end);
  const allKeyframes = packet.keyframes.filter((frame) => frame.time >= start && frame.time <= end)
    .map(({ fileName: _privateFileName, display, ...frame }) => ({ ...frame, ...(display ? { display: { receiptSha256: display.receiptSha256, transfer: display.normalization.transfer, requestedTime: display.requested.time, actualTime: display.decoded.relativeTime } } : {}) }));
  const cuts = allCuts.slice(0, maximumCuts);
  const keyframes = [...allKeyframes];
  const cues: typeof cueCandidates = [];
  const minimumColor = materialColorReference(packet.analysis.color);
  let color: ReturnType<typeof materialColorSummary> = minimumColor;

  const build = () => ({
    materialId: packet.materialId,
    sourceSha256: packet.source.sourceSha256,
    window: { start, end },
    transcript: {
      state: packet.analysis.transcript.state,
      recognition: packet.analysis.transcript.recognition,
      reason: packet.analysis.transcript.reason,
      rawTranscriptSha256: packet.analysis.transcript.rawTranscript?.sha256,
      cues,
      returnedCues: cues.length,
      remainingWindowCues: Math.max(0, cueCandidates.length - cues.length),
      hasMore: cueCandidates.length > cues.length,
      nextCueIndex: cueCandidates.length > cues.length ? (cues.at(-1)?.index ?? afterCueIndex) : undefined,
    },
    cuts,
    cutsHasMore: allCuts.length > cuts.length,
    keyframes,
    keyframesHasMore: allKeyframes.length > keyframes.length,
    color,
    budget: { maxTokens: maxTokenBudget, estimatedTokens: 0 },
  });
  const selectionBudget = Math.max(1, maxTokenBudget - 12);
  const metadataBudget = Math.max(160, Math.floor(selectionBudget * 0.45));
  const fits = (limit = selectionBudget) => estimateAgentContextTokens(JSON.stringify(build())) <= limit;
  // The separate keyframe tool owns visual detail. Keep this packet's metadata
  // small enough that transcript evidence still receives most of the budget.
  while (!fits(metadataBudget) && cuts.length) cuts.pop();
  while (!fits(metadataBudget) && keyframes.length) keyframes.pop();
  for (const cue of cueCandidates.slice(0, maximumCues)) {
    cues.push(cue);
    if (fits()) continue;
    cues.pop();
    break;
  }
  if (cueCandidates.length && !cues.length) throw new Error("素材 context 的單一逐字稿 cue 無法放入 Token 預算；請提高 maxTokens，不可跳過此 cue");
  // Rich colour detail only uses remaining space: never pop transcript evidence
  // or advance its cursor just to fit an observation summary.
  color = materialColorSummary(packet.analysis.color, start, end);
  if (!fits()) color = minimumColor;
  const response = build();
  response.budget.estimatedTokens = estimateAgentContextTokens(JSON.stringify(response));
  if (response.budget.estimatedTokens > maxTokenBudget) throw new Error("素材 context 基礎 metadata 超過 Token 預算，請縮小時間窗");
  return response;
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
