import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { dirname, resolve } from "node:path";
import { analyzeMusicBeatsV1, type MusicBeatsRuntimeV1 } from "../application/musicBeats";
import { resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { creativeAssetIdFromUri } from "../shared/creativeAssetUri";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { resolveMediaPath } from "../render/mediaProcess";
import { readProject, workspaceRoot } from "./storage";
import { creativePackRoot, personalMusicRoot, personalVisualRoot, errorResult, textResult } from "./toolRuntime";

export const musicBeatsToolInputSchemaV1 = z.strictObject({
  projectPath: z.string().min(1).max(1024), assetId: z.string().min(1).max(160),
  sourceStartSeconds: z.number().finite().min(0).max(604_800).default(0), durationSeconds: z.number().finite().positive().max(86_400),
  priorBpm: z.number().finite().min(30).max(300).optional(),
  include: z.enum(["summary", "beats", "onsets", "sections"]).default("summary"),
  offset: z.number().int().nonnegative().max(1_000_000).default(0), limit: z.number().int().min(1).max(200).default(100),
  expectedResultId: z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/).optional(),
});
type Dependencies = {
  readProject: typeof readProject;
  analyze: typeof analyzeMusicBeatsV1;
  creative: typeof resolveCreativeLibraryAsset;
  runtime: () => MusicBeatsRuntimeV1;
};
function defaultRuntime(): MusicBeatsRuntimeV1 {
  const root = resolve(import.meta.dirname, "../..");
  return { ffmpegPath: process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath: process.env.HAO_FFPROBE_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
    nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? resolve(root, "native/bin/win32-x64/hao-core.exe"),
    cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models"), "../media-cache") };
}
export async function analyzeMusicBeatsToolV1(input: z.input<typeof musicBeatsToolInputSchemaV1>, signal?: AbortSignal,
  dependencies: Dependencies = { readProject, analyze: analyzeMusicBeatsV1, creative: resolveCreativeLibraryAsset, runtime: defaultRuntime }) {
  const parsed = musicBeatsToolInputSchemaV1.parse(input); signal?.throwIfAborted();
  const project = await dependencies.readProject(parsed.projectPath), projectSha256 = sha256Canonical(project);
  const asset = project.assets.find(item => item.id === parsed.assetId);
  if (!asset || asset.kind === "image" || asset.compositionId) throw Error("MUSIC_BEATS_AUDIO_ASSET_REQUIRED");
  const creativeId = creativeAssetIdFromUri(asset.uri), library = creativeId
    ? await dependencies.creative(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot()) : undefined;
  const sourcePath = library?.absolutePath ?? resolveMediaPath(asset.uri, dirname(resolve(workspaceRoot(), parsed.projectPath)));
  const metadataPrior = library?.asset.bpm ?? asset.bpm;
  const priorBpm = parsed.priorBpm ?? (Number.isFinite(metadataPrior) && metadataPrior! >= 30 && metadataPrior! <= 300 ? metadataPrior : undefined);
  const result = await dependencies.analyze({ sourcePath, sourceStartSeconds: parsed.sourceStartSeconds, durationSeconds: parsed.durationSeconds,
    ...(priorBpm !== undefined ? { priorBpm } : {}) }, { ...dependencies.runtime(), signal });
  signal?.throwIfAborted();
  if (sha256Canonical(await dependencies.readProject(parsed.projectPath)) !== projectSha256) throw Error("MUSIC_BEATS_PROJECT_CHANGED");
  if (library && result.receipt.sourceSha256 !== library.sha256) throw Error("MUSIC_BEATS_LIBRARY_SOURCE_CHANGED");
  const resultId = `${result.key}:${result.receiptSha256}`;
  if (parsed.expectedResultId && parsed.expectedResultId !== resultId) throw Error("MUSIC_BEATS_RESULT_CHANGED");
  const analysis = result.receipt.analysis;
  const events = parsed.include === "summary" ? undefined : analysis[parsed.include];
  const response = { status: "AUDIO_ANALYSIS_CANDIDATE" as const, mutationPerformed: false,
    projectBinding: { projectId: project.id, projectRevision: project.revision, projectSha256 }, assetId: asset.id, resultId, cacheHit: result.cacheHit,
    sourceBinding: result.binding, analyzedSeconds: analysis.durationSeconds, sourceStartSeconds: analysis.sourceStartSeconds,
    tempoBpm: analysis.tempoBpm, tempoConfidence: analysis.tempoConfidence, meterHypothesis: analysis.meterHypothesis,
    priorOrigin: parsed.priorBpm !== undefined ? "caller_hint" : library?.asset.bpm !== undefined ? "verified_library_metadata" : priorBpm !== undefined ? "project_metadata_hint" : "none",
    counts: { onsets: analysis.onsets.length, beats: analysis.beats.length, downbeats: analysis.beats.filter(b => b.downbeat).length, sections: analysis.sections.length },
    ...(events ? { eventKind: parsed.include, events: events.slice(parsed.offset, parsed.offset + parsed.limit),
      nextOffset: parsed.offset + parsed.limit < events.length ? parsed.offset + parsed.limit : null } : {}),
    qualityState: analysis.qualityState, boundary: "analysis_only_not_montage_apply_or_template_certification", pcmStagedBytes: result.receipt.pcmStagedBytes };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > 20 * 1024) throw Error("MUSIC_BEATS_RESPONSE_BUDGET_EXCEEDED");
  return response;
}
export function registerMusicBeatsToolsV1(server: McpServer) {
  server.registerTool("analyze_music_beats", {
    description: "唯讀以Rust spectral-flux、自相關及動態規劃分析原始音樂，回起音、拍點、四拍重拍假設與段落novelty；音樂庫BPM作先驗，結果依來源、工具及選項SHA快取。summary為預設，beats/onsets/sections可分頁並綁resultId；不修改專案、不自動套蒙太奇或認證真音樂品質。",
    inputSchema: musicBeatsToolInputSchemaV1,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    try { return textResult(await analyzeMusicBeatsToolV1(input, extra.mcpReq.signal)); }
    catch (error) { return errorResult(error); }
  });
}
