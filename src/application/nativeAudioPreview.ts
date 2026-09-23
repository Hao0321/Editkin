import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { probeMedia, resolveMediaPath } from "../render/mediaProcess";

export const NATIVE_AUDIO_PREVIEW_SAMPLE_RATE = 48_000;
export const NATIVE_AUDIO_PREVIEW_CHANNELS = 2;
export const NATIVE_AUDIO_PREVIEW_MAX_SECONDS = 30;
export const NATIVE_AUDIO_PREVIEW_MAX_SOURCES = 8;

export interface PreviewAudioClip {
  clip: TimelineClip;
  asset: MediaAsset;
  assetPath: string;
  overlapStart: number;
  overlapDuration: number;
  sourceStart: number;
  localDelay: number;
}

export interface PreviewGainPoint {
  sample: number;
  valueDb: number;
}

export interface NativeAudioPreviewSourceReceipt {
  id: string;
  clipId: string;
  assetId: string;
  role: "voice" | "music";
  path: string;
  bytes: number;
  sha256: string;
  startFrame: number;
  gainDb: number;
  gainAutomation: PreviewGainPoint[];
}

export interface NativeAudioPreviewStageReceipt {
  schema: "editkin.native-audio-preview-stage/v2";
  status: "GREEN";
  manifestPath: string;
  sessionRoot: string;
  managedPaths: string[];
  manifestBytes: number;
  manifestSha256: string;
  projectId: string;
  projectRevision: number;
  projectUpdatedAt: string;
  audioFingerprintSha256: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  sampleRate: 48_000;
  channels: 2;
  clipCount: number;
  voiceClipCount: number;
  musicClipCount: number;
  sourceIds: string[];
  sourcePcm: NativeAudioPreviewSourceReceipt[];
  decoderExecutor: "ffmpeg-source-decode/v1";
  decodeMode: "independent-source-pcm";
  mixExecutor: "hao-core-native-dag/v1";
  nativeGraphExecution: true;
  claimBoundary: string;
}

export interface StageNativeAudioPreviewOptions {
  ffmpegPath: string;
  ffprobePath: string;
  cacheRoot: string;
  assetBase?: string;
  timelineStartSeconds: number;
  maxDurationSeconds?: number;
  timeoutMs?: number;
}

function finite(value: number): string {
  if (!Number.isFinite(value)) throw new Error("原生音訊預覽參數必須是有限數字");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function gainDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return -144;
  return Math.max(-144, Math.min(48, 20 * Math.log10(value)));
}

function previewDuration(project: EditProject, timelineStart: number, maxDuration: number): number {
  const projectEnd = project.tracks.flatMap((track) => track.clips)
    .reduce((end, clip) => Math.max(end, clip.timelineStart + clip.duration), 0);
  return Math.max(0, Math.min(maxDuration, projectEnd - timelineStart));
}

function candidatePreviewAudioClips(
  project: EditProject,
  timelineStart: number,
  duration: number,
  assetBase?: string,
): PreviewAudioClip[] {
  const timelineEnd = timelineStart + duration;
  return project.tracks
    .filter((track) => (track.kind === "audio" || track.kind === "video") && !track.muted)
    .flatMap((track) => track.clips)
    .flatMap((clip): PreviewAudioClip[] => {
      const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
      const clipEnd = clip.timelineStart + clip.duration;
      const overlapStart = Math.max(timelineStart, clip.timelineStart);
      const overlapEnd = Math.min(timelineEnd, clipEnd);
      if (!asset || asset.kind === "image" || clip.volume <= 0 || clip.layer?.enabled === false
        || (clip.layer?.role ?? "content") !== "content" || overlapEnd <= overlapStart) return [];
      return [{
        clip,
        asset,
        assetPath: resolveMediaPath(asset.uri, assetBase),
        overlapStart,
        overlapDuration: overlapEnd - overlapStart,
        sourceStart: clip.sourceStart + overlapStart - clip.timelineStart,
        localDelay: overlapStart - timelineStart,
      }];
    });
}

function musicGain(item: PreviewAudioClip, localSeconds: number): number {
  const fade = Math.min(1.2, item.clip.duration / 5);
  if (fade <= 0) return item.clip.volume;
  const clipPosition = item.overlapStart - item.clip.timelineStart + localSeconds;
  const envelope = Math.max(0, Math.min(1, clipPosition / fade, (item.clip.duration - clipPosition) / fade));
  return item.clip.volume * envelope;
}

export function buildMusicGainAutomation(
  item: PreviewAudioClip,
  durationFrames: number,
): PreviewGainPoint[] {
  const startFrame = Math.round(item.localDelay * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE);
  const decodedFrames = Math.max(1, Math.ceil(item.overlapDuration * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE));
  const lastLocalFrame = decodedFrames - 1;
  const fade = Math.min(1.2, item.clip.duration / 5);
  const clipOffset = item.overlapStart - item.clip.timelineStart;
  const maximumLocalSeconds = lastLocalFrame / NATIVE_AUDIO_PREVIEW_SAMPLE_RATE;
  const candidates = [
    0,
    fade - clipOffset,
    item.clip.duration - fade - clipOffset,
    item.clip.duration - clipOffset,
    maximumLocalSeconds,
  ].filter((seconds) => seconds >= 0 && seconds <= maximumLocalSeconds);
  candidates.push(0, maximumLocalSeconds);
  const bySample = new Map<number, PreviewGainPoint>();
  for (const seconds of candidates) {
    const sample = Math.min(durationFrames - 1, startFrame + Math.round(seconds * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE));
    bySample.set(sample, { sample, valueDb: gainDb(musicGain(item, seconds)) });
  }
  return [...bySample.values()].sort((left, right) => left.sample - right.sample);
}

export function buildNativeAudioPreviewDecoderArgs(
  item: PreviewAudioClip,
  outputPath: string,
): string[] {
  if (!isAbsolute(outputPath)) throw new Error("原生音訊來源輸出必須是絕對路徑");
  if (!(item.overlapDuration > 0 && item.overlapDuration <= NATIVE_AUDIO_PREVIEW_MAX_SECONDS)) {
    throw new Error(`原生音訊來源視窗必須在 0..=${NATIVE_AUDIO_PREVIEW_MAX_SECONDS} 秒內`);
  }
  const frameCount = Math.max(1, Math.ceil(item.overlapDuration * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE));
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", finite(item.sourceStart), "-t", finite(item.overlapDuration), "-i", item.assetPath,
    "-map", "0:a:0", "-vn",
    "-af", `aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,atrim=duration=${finite(item.overlapDuration)}`,
    "-frames:a", String(frameCount),
    "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", "-f", "f32le", outputPath,
  ];
}

async function runFfmpeg(executable: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("原生音訊來源解碼逾時"));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `FFmpeg audio source decode exit ${code}`)));
  });
}

async function cleanupSession(managedPaths: string[], sessionRoot: string): Promise<void> {
  for (const path of [...managedPaths].reverse()) await rm(path, { force: true }).catch(() => undefined);
  await rmdir(sessionRoot).catch(() => undefined);
}

export async function stageNativeAudioPreview(
  project: EditProject,
  options: StageNativeAudioPreviewOptions,
): Promise<NativeAudioPreviewStageReceipt> {
  const timelineStart = options.timelineStartSeconds;
  const maxDuration = Math.min(
    NATIVE_AUDIO_PREVIEW_MAX_SECONDS,
    Math.max(0.25, options.maxDurationSeconds ?? NATIVE_AUDIO_PREVIEW_MAX_SECONDS),
  );
  if (!Number.isFinite(timelineStart) || timelineStart < 0) throw new Error("原生音訊預覽起點不合法");
  const duration = previewDuration(project, timelineStart, maxDuration);
  if (duration <= 0) throw new Error("播放頭後方沒有可預覽的音訊範圍");
  const candidates = candidatePreviewAudioClips(project, timelineStart, duration, options.assetBase);
  const uniquePaths = [...new Set(candidates.map((item) => item.assetPath))];
  const probeEntries = await Promise.all(uniquePaths.map(async (path) => [path, await probeMedia(path, options.ffprobePath)] as const));
  const audioPaths = new Set(probeEntries.filter(([, probe]) => probe.hasAudio).map(([path]) => path));
  const clips = candidates.filter((item) => audioPaths.has(item.assetPath));
  if (!clips.length) throw new Error("目前預覽視窗沒有可解碼的音訊軌");
  if (clips.length > NATIVE_AUDIO_PREVIEW_MAX_SOURCES) {
    throw new Error(`原生音訊預覽一次最多 ${NATIVE_AUDIO_PREVIEW_MAX_SOURCES} 個重疊來源`);
  }

  const previewRoot = join(resolve(options.cacheRoot), "audio-preview");
  await mkdir(previewRoot, { recursive: true });
  const sessionRoot = join(previewRoot, randomUUID());
  await mkdir(sessionRoot);
  const manifestPath = join(sessionRoot, "mix-manifest.json");
  const managedPaths: string[] = [];
  try {
    const durationFrames = Math.max(1, Math.round(duration * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE));
    const sourcePcm: NativeAudioPreviewSourceReceipt[] = [];
    for (const [index, item] of clips.entries()) {
      const outputPath = join(sessionRoot, `source-${String(index).padStart(2, "0")}.f32le`);
      managedPaths.push(outputPath);
      await runFfmpeg(options.ffmpegPath, buildNativeAudioPreviewDecoderArgs(item, outputPath), options.timeoutMs ?? 45_000);
      const bytes = (await stat(outputPath)).size;
      const maximumBytes = Math.ceil(item.overlapDuration * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE)
        * NATIVE_AUDIO_PREVIEW_CHANNELS * Float32Array.BYTES_PER_ELEMENT;
      if (bytes <= 0 || bytes > maximumBytes || bytes % (NATIVE_AUDIO_PREVIEW_CHANNELS * Float32Array.BYTES_PER_ELEMENT) !== 0) {
        throw new Error(`原生音訊來源 PCM bytes 不合法：${bytes}/${maximumBytes}`);
      }
      const content = await readFile(outputPath);
      const role = item.asset.role === "background-music" ? "music" : "voice";
      sourcePcm.push({
        id: `source-${index}`,
        clipId: item.clip.id,
        assetId: item.asset.id,
        role,
        path: outputPath,
        bytes,
        sha256: createHash("sha256").update(content).digest("hex"),
        startFrame: Math.round(item.localDelay * NATIVE_AUDIO_PREVIEW_SAMPLE_RATE),
        gainDb: gainDb(item.clip.volume),
        gainAutomation: role === "music" ? buildMusicGainAutomation(item, durationFrames) : [],
      });
    }
    const voiceClipCount = sourcePcm.filter((source) => source.role === "voice").length;
    const musicClipCount = sourcePcm.length - voiceClipCount;
    const manifest = {
      schema: "editkin.native-audio-preview-mix/v1",
      sampleRate: NATIVE_AUDIO_PREVIEW_SAMPLE_RATE,
      channels: NATIVE_AUDIO_PREVIEW_CHANNELS,
      durationFrames,
      decoderExecutor: "ffmpeg-source-decode/v1",
      sources: sourcePcm,
      ducking: { enabled: voiceClipCount > 0 && musicClipCount > 0, thresholdDb: -32, floorDb: -18, attackMs: 25, releaseMs: 360 },
      master: { limiterCeilingDb: -3 },
    };
    const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    managedPaths.push(manifestPath);
    await writeFile(manifestPath, manifestContent);
    const sourceIds = [...new Set(clips.map((item) => item.asset.id))].sort();
    const audioFingerprintSha256 = createHash("sha256").update(JSON.stringify({
      projectId: project.id,
      revision: project.revision,
      updatedAt: project.updatedAt,
      timelineStart,
      duration,
      decoderSources: sourcePcm.map(({ path: _path, ...source }) => source),
    })).digest("hex");
    return {
      schema: "editkin.native-audio-preview-stage/v2",
      status: "GREEN",
      manifestPath,
      sessionRoot,
      managedPaths,
      manifestBytes: manifestContent.length,
      manifestSha256: createHash("sha256").update(manifestContent).digest("hex"),
      projectId: project.id,
      projectRevision: project.revision,
      projectUpdatedAt: project.updatedAt,
      audioFingerprintSha256,
      timelineStartSeconds: timelineStart,
      durationSeconds: durationFrames / NATIVE_AUDIO_PREVIEW_SAMPLE_RATE,
      sampleRate: NATIVE_AUDIO_PREVIEW_SAMPLE_RATE,
      channels: NATIVE_AUDIO_PREVIEW_CHANNELS,
      clipCount: clips.length,
      voiceClipCount,
      musicClipCount,
      sourceIds,
      sourcePcm,
      decoderExecutor: "ffmpeg-source-decode/v1",
      decodeMode: "independent-source-pcm",
      mixExecutor: "hao-core-native-dag/v1",
      nativeGraphExecution: true,
      claimBoundary: "FFmpeg independently decodes bounded source PCM only; it does not receive filter_complex, amix, volume, delay, fade, ducking, normalization or limiter instructions. hao-core validates this manifest and executes timeline placement, gain/fade automation, voice/music buses, sidechain ducking, master limiting and output summing in Rust.",
    };
  } catch (error) {
    await cleanupSession(managedPaths, sessionRoot);
    throw error;
  }
}
