import {createHash, randomUUID} from "node:crypto";
import {mkdir, open, realpath, rename, rmdir, unlink, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join, resolve} from "node:path";
import type {EditProject, MediaAsset, TimelineClip} from "../domain/types";
import {projectDuration} from "../domain/editGraph";
import {probeMedia, resolveMediaPath} from "../render/mediaProcess";
import {buildMusicGainAutomation, gainDb, type PreviewAudioClip} from "./nativeAudioPreview";

export const AUDIO_CATALOG_LIMIT = 4096;
export const AUDIO_ACTIVE_LIMIT = 16;
const RATE = 48_000;
const MAX_FRAME = RATE * 86400;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
export interface AudioSourceIdentity {
  path: string;
  bytes: number;
  sha256: string;
  hasAudio: boolean;
}
export interface CatalogAudioSource {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  durationFrames: number;
  audioStreamIndex: number;
  bus: "voice" | "music";
  gainDb: number;
  gainAutomation?: {property: "gainDb"; points: {sample: number; value: number; interpolation: "linear"}[]};
}
interface GraphNode {
  id: string;
  inputs: string[];
  operation: Record<string, string | number>;
  automation: never[];
}
export interface NativeAudioProjectPlan {
  schema: "editkin.audio-codec-stream-plan/v2";
  generation: number;
  startFrame: number;
  frameCount: number;
  blockFrames: number;
  lookaheadFrames: number;
  limiterReleaseMs: number;
  limiterPolicy: "lookahead-sample-peak/v1";
  mediaRoots: string[];
  graph: {sampleRate: 48000; channels: 2; masterNode: string; nodes: GraphNode[]};
  sources: CatalogAudioSource[];
}
export interface AudioProjectPlanOptions {
  generation: number;
  timelineStartSeconds: number;
  resolveSource: (asset: MediaAsset) => Promise<AudioSourceIdentity>;
  /** Existing trusted local directory for an entirely silent project. */
  silentMediaRoot: string;
  signal?: AbortSignal;
}
function frame(seconds: number, label: string): number {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds * RATE > MAX_FRAME) {
    throw new Error(`原生音訊 ${label} 必須在 0～24 小時內`);
  }
  return Math.round(seconds * RATE);
}
function nativeBusGraph(ducking: boolean): NativeAudioProjectPlan["graph"] {
  const node = (id: string, inputs: string[], operation: GraphNode["operation"]): GraphNode => ({id, inputs, operation, automation: []});
  const nodes = [node("voice", [], {kind: "source", asset_id: "voice"}), node("music", [], {kind: "source", asset_id: "music"})];
  if (ducking) nodes.push(node("ducked-music", ["music", "voice"], {kind: "ducker", threshold_db: -32, floor_db: -18, attack_ms: 25, release_ms: 360}));
  nodes.push(node("sum", ["voice", ducking ? "ducked-music" : "music"], {kind: "bus"}));
  nodes.push(node("limit", ["sum"], {kind: "limiter", ceiling_db: -3}));
  nodes.push(node("output", ["limit"], {kind: "output"}));
  return {sampleRate: RATE, channels: 2, masterNode: "output", nodes};
}

/** One complete canonical timeline; there is no 30-second window or eight-clip truncation. */
export async function compileNativeAudioProjectPlan(project: EditProject, options: AudioProjectPlanOptions) {
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) throw new Error("音訊 generation 不合法");
  const startFrame = frame(options.timelineStartSeconds, "播放起點");
  const endFrame = frame(projectDuration(project), "專案長度");
  if (endFrame <= startFrame) throw new Error("播放頭後方沒有可播放的範圍");
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  if (assets.size !== project.assets.length) throw new Error("音訊專案包含重複素材 ID");
  const sources: CatalogAudioSource[] = [];
  const bindings: {sourceId: string; clipId: string; assetId: string; trackId: string}[] = [];
  const omitted: {clipId: string; reason: string}[] = [];
  const cache = new Map<string, Promise<AudioSourceIdentity>>();
  const roots = new Set<string>();
  const seenClips = new Set<string>();
  let considered = 0;
  for (const track of project.tracks) {
    if (track.kind !== "audio" && track.kind !== "video") continue;
    for (const clip of track.clips) {
      options.signal?.throwIfAborted();
      const skip = (reason: string) => {omitted.push({clipId: clip.id, reason});};
      if (seenClips.has(clip.id)) throw new Error("音訊專案包含重複片段 ID");
      seenClips.add(clip.id);
      if (track.muted || clip.volume === 0 || clip.layer?.enabled === false || (clip.layer?.role ?? "content") !== "content") {
        skip("muted-or-disabled"); continue;
      }
      if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 10 ** (48 / 20)) throw new Error("音訊片段音量不合法");
      const asset = assets.get(clip.assetId);
      if (!asset) throw new Error(`音訊片段找不到素材：${clip.id}`);
      if (asset.compositionId) throw new Error("原生音訊尚未支援巢狀合成；不能靜默略過合成中的聲音");
      if (asset.kind === "image") {skip("image-without-audio"); continue;}
      const begin = frame(clip.timelineStart, "片段起點");
      const end = frame(clip.timelineStart + clip.duration, "片段終點");
      const sourceStartFrame = frame(clip.sourceStart, "來源起點");
      if (!(clip.duration > 0) || end <= begin || sourceStartFrame + end - begin > MAX_FRAME) throw new Error("音訊片段範圍不合法");
      if (++considered > AUDIO_CATALOG_LIMIT) throw new Error(`音訊專案最多 ${AUDIO_CATALOG_LIMIT} 個候選片段`);
      let pending = cache.get(asset.uri);
      if (!pending) {pending = options.resolveSource(asset); cache.set(asset.uri, pending);}
      const identity = await pending;
      if (!identity.hasAudio) {skip("probe-no-audio"); continue;}
      if (!isAbsolute(identity.path) || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0 || identity.bytes > 32 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
        throw new Error("音訊來源缺少可信的本機檔案身分");
      }
      roots.add(dirname(identity.path));
      const id = `clip-${sources.length}`;
      const source: CatalogAudioSource = {id, path: identity.path, bytes: identity.bytes, sha256: identity.sha256,
        timelineStartFrame: begin, sourceStartFrame, durationFrames: end - begin, audioStreamIndex: 0,
        bus: asset.role === "background-music" ? "music" : "voice", gainDb: gainDb(clip.volume)};
      if (source.bus === "music") {
        // Use the existing native preview's single authoritative music fade rule,
        // but quantize the clip edges once so adjacent clips cannot gain a sample.
        const quantized: TimelineClip = {...clip, timelineStart: begin / RATE, duration: (end - begin) / RATE};
        const item: PreviewAudioClip = {clip: quantized, asset, assetPath: identity.path,
          overlapStart: begin / RATE, overlapDuration: quantized.duration, sourceStart: clip.sourceStart, localDelay: begin / RATE};
        source.gainAutomation = {property: "gainDb", points: buildMusicGainAutomation(item, end)
          .map(point => ({sample: Math.max(begin, Math.min(end - 1, point.sample)), value: point.valueDb, interpolation: "linear" as const}))};
      }
      sources.push(source);
      bindings.push({sourceId: id, clipId: clip.id, assetId: asset.id, trackId: track.id});
    }
  }
  const edges = sources.flatMap(source => [[source.timelineStartFrame, 1], [source.timelineStartFrame + source.durationFrames, -1]]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, peakActiveSources = 0;
  for (const [, delta] of edges) {
    active += delta; peakActiveSources = Math.max(active, peakActiveSources);
    if (active > AUDIO_ACTIVE_LIMIT) throw new Error(`目前原生音訊最多同時播放 ${AUDIO_ACTIVE_LIMIT} 個來源；不會自動刪減軌道`);
  }
  if (!roots.size) {
    if (!isAbsolute(options.silentMediaRoot)) throw new Error("靜音專案仍需要有效的本機工作目錄");
    roots.add(options.silentMediaRoot);
  }
  if (roots.size > 64) throw new Error("音訊來源資料夾超過 64 個；請先整理素材位置");
  const plan: NativeAudioProjectPlan = {schema: "editkin.audio-codec-stream-plan/v2", generation: options.generation,
    startFrame, frameCount: endFrame - startFrame, blockFrames: 2048, lookaheadFrames: 240,
    limiterReleaseMs: 80, limiterPolicy: "lookahead-sample-peak/v1", mediaRoots: [...roots].sort(),
    graph: nativeBusGraph(sources.some(s => s.bus === "voice") && sources.some(s => s.bus === "music")), sources};
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_BYTES) throw new Error("音訊專案計畫超過 4 MiB");
  options.signal?.throwIfAborted();
  return {plan, bindings, omitted, peakActiveSources};
}

export async function stageNativeAudioProjectPlan(project: EditProject, options: {
  cacheRoot: string; ffprobePath: string; assetBase?: string; generation: number; timelineStartSeconds: number; signal?: AbortSignal;
}) {
  const root = join(resolve(options.cacheRoot), "audio-sessions");
  await mkdir(root, {recursive: true});
  const cache = new Map<string, Promise<AudioSourceIdentity>>();
  const result = await compileNativeAudioProjectPlan(project, {...options, silentMediaRoot: await realpath(root),
    resolveSource: async asset => {
      const path = await realpath(resolveMediaPath(asset.uri, options.assetBase));
      let identity = cache.get(path);
      if (!identity) {
        identity = (async () => {
          const handle = await open(path, "r");
          try {
            const before = await handle.stat({bigint: true});
            if (!before.isFile() || before.size === 0n || before.size > 32n * 1024n ** 3n) throw new Error("音訊來源檔案大小不合法");
            const probe = await probeMedia(path, options.ffprobePath);
            const hash = createHash("sha256");
            for await (const chunk of handle.createReadStream({autoClose: false})) {options.signal?.throwIfAborted(); hash.update(chunk);}
            const after = await handle.stat({bigint: true});
            if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("驗證期間音訊來源被修改");
            return {path, bytes: Number(after.size), sha256: hash.digest("hex"), hasAudio: probe.hasAudio};
          } finally {await handle.close();}
        })();
        cache.set(path, identity);
      }
      return identity;
    }});
  const sessionRoot = join(root, randomUUID());
  options.signal?.throwIfAborted();
  await mkdir(sessionRoot);
  const planPath = join(sessionRoot, "project-audio.json");
  const temporaryPath = join(sessionRoot, "project-audio.pending");
  const bytes = Buffer.from(JSON.stringify(result.plan));
  try {
    await writeFile(temporaryPath, bytes, {flag: "wx"});
    options.signal?.throwIfAborted();
    await rename(temporaryPath, planPath);
  } catch (error) {
    // Only our exact newly-created pending file and empty UUID directory.
    await unlink(temporaryPath).catch(() => undefined);
    await rmdir(sessionRoot).catch(() => undefined);
    throw error;
  }
  return {schema: "editkin.native-audio-project-stage/v1" as const, status: "PREPARED" as const,
    projectId: project.id, projectRevision: project.revision, projectUpdatedAt: project.updatedAt,
    generation: options.generation, planPath, planSha256: createHash("sha256").update(bytes).digest("hex"),
    planBytes: bytes.length, sessionRoot, managedPaths: [planPath],
    startFrame: result.plan.startFrame, frameCount: result.plan.frameCount, sourceCount: result.plan.sources.length,
    peakActiveSources: result.peakActiveSources, uniqueSourceFiles: cache.size,
    audioFingerprintSha256: createHash("sha256").update(JSON.stringify({projectId: project.id, revision: project.revision, plan: result.plan})).digest("hex"),
    bindings: result.bindings, omitted: result.omitted, pcmStagingFiles: 0,
    boundary: "Prepared compressed-source plan; native validation/playback and installed renderer admission are separate."};
}
