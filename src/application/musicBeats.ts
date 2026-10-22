import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { runAnalysisProcess } from "./analysisProcess";
import { withMediaCachePublishLock } from "./mediaCachePublishLock";
import { readBoundedFile } from "../shared/boundedFile";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { canonicalJson } from "../shared/canonicalJson";
import { probeMedia } from "../render/mediaProcess";
import { probeVolumeSpace } from "../render/renderDiskSpace";
import { MUSIC_BEATS_RESULT_BYTES_V1, musicBeatsRequestSchemaV1, validateMusicBeatsReceiptV1, type MusicBeatsRequestV1 } from "./musicBeatsTypesV1";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface MusicBeatsRuntimeV1 { ffmpegPath: string; ffprobePath: string; nativeCorePath: string; cacheRoot: string; timeoutMs?: number; signal?: AbortSignal }
export async function musicBeatFileShaV1(path: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  assertLocalMediaPath(path); signal?.throwIfAborted(); const before = await stat(path);
  if (!before.isFile() || !before.size || before.size > 64 * 1024 ** 3) throw Error("MUSIC_BEATS_FILE_INVALID");
  const hash = createHash("sha256"), stream = createReadStream(path), abort = () => stream.destroy(Error("MUSIC_BEATS_HASH_CANCELLED"));
  const timeout = setTimeout(() => stream.destroy(Error("MUSIC_BEATS_HASH_TIMEOUT")), 120_000); signal?.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  try { for await (const chunk of stream) { signal?.throwIfAborted(); bytes += chunk.length; if (bytes > before.size) throw Error("MUSIC_BEATS_FILE_CHANGED"); hash.update(chunk); }
    const after = await stat(path);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) throw Error("MUSIC_BEATS_FILE_CHANGED");
    return { sha256: hash.digest("hex"), bytes };
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); stream.destroy(); }
}
/** Source-only W2-4 orchestration; never uses a proxy or mutates the editor project. */
export async function analyzeMusicBeatsV1(input: MusicBeatsRequestV1, runtime: MusicBeatsRuntimeV1) {
  const request = musicBeatsRequestSchemaV1.parse(input); runtime.signal?.throwIfAborted();
  for (const path of [request.sourcePath, runtime.ffmpegPath, runtime.ffprobePath, runtime.nativeCorePath, runtime.cacheRoot]) {
    assertLocalMediaPath(path); if (!isAbsolute(path)) throw Error("MUSIC_BEATS_ABSOLUTE_PATH_REQUIRED");
  }
  const timeoutMs = runtime.timeoutMs ?? Math.max(120_000, request.durationSeconds * 2000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw Error("MUSIC_BEATS_TIMEOUT_INVALID");
  const started = Date.now(), deadline = started + timeoutMs;
  const active = () => { runtime.signal?.throwIfAborted(); if (Date.now() >= deadline) throw Error("MUSIC_BEATS_TOTAL_TIMEOUT"); };
  const [source, ffmpeg, ffprobe, core] = await Promise.all([request.sourcePath, runtime.ffmpegPath, runtime.ffprobePath, runtime.nativeCorePath].map(path => musicBeatFileShaV1(path, runtime.signal)));
  active(); const identity = { sourceSha256: source.sha256, sourceBytes: source.bytes, ffmpegSha256: ffmpeg.sha256 };
  const binding = { schema: "editkin.music-beats-cache-key/v1", source, ffmpeg, ffprobe, core,
    sourceStartSeconds: request.sourceStartSeconds, durationSeconds: request.durationSeconds, priorBpm: request.priorBpm ?? null, analysisRecipe: "spectral-flux-autocorrelation-dp-native/v1",
    ...(request.rhythmRefinementV2 ? { rhythmRefinementV2: true } : {}) };
  const key = digest(binding), parent = join(resolve(runtime.cacheRoot), "music-beats-v1");
  await mkdir(parent, { recursive: true });
  if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink() || (await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw Error("MUSIC_BEATS_CACHE_ROOT_INVALID");
  const cachePath = join(parent, `${key}.json`);
  const readCache = async () => {
    try { const cached = JSON.parse((await readBoundedFile(cachePath, MUSIC_BEATS_RESULT_BYTES_V1)).toString("utf8"));
      if (cached.schema !== "editkin.music-beats-cache/v1" || cached.key !== key || canonicalJson(cached.binding) !== canonicalJson(binding)
        || cached.receiptSha256 !== digest(cached.receipt)) return undefined;
      return validateMusicBeatsReceiptV1(cached.receipt, request, identity);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "EACCES") throw error; return undefined; }
  };
  const cached = await readCache(); active();
  if (cached) return { key, receiptSha256: digest(cached), binding, receipt: cached, cacheHit: true, elapsedMs: Date.now() - started };
  const probe = await probeMedia(request.sourcePath, runtime.ffprobePath); active();
  if (!probe.hasAudio || request.sourceStartSeconds + request.durationSeconds > probe.duration + 1 / 16_000) throw Error("MUSIC_BEATS_SOURCE_AUDIO_RANGE_INVALID");
  const volume = await probeVolumeSpace(parent);
  if (!volume || volume.availableBytes < 1024 ** 3 + MUSIC_BEATS_RESULT_BYTES_V1 * 2) throw Error("MUSIC_BEATS_CACHE_SPACE_SHORT_OR_UNKNOWN");
  const workspace = await mkdtemp(join(parent, "owned-analysis-")), resultPath = join(workspace, "native-result.json"), requestPath = join(workspace, "request.json");
  const owner = JSON.stringify({ schema: "editkin.music-beats-work-owner/v1", pid: process.pid, token: randomUUID() }), workspaceIdentity = await lstat(workspace);
  try {
    await writeFile(join(workspace, "owner.json"), owner, { flag: "wx" });
    await writeFile(requestPath, JSON.stringify({ schema: "editkin.music-beats-request/v1", inputPath: request.sourcePath, ...identity,
      ffmpegPath: runtime.ffmpegPath, sourceStartSeconds: request.sourceStartSeconds, durationSeconds: request.durationSeconds,
      priorBpm: request.priorBpm ?? null, ...(request.rhythmRefinementV2 ? { rhythmRefinementV2: true } : {}), outputPath: resultPath }), { flag: "wx" });
    const result = await runAnalysisProcess(runtime.nativeCorePath, ["audio-beats", requestPath], { timeoutMs: Math.max(1, deadline - Date.now()),
      label: "music-beats-native", signal: runtime.signal, maximumStdout: 8192, maximumStderr: 16_384 });
    active(); const command = JSON.parse(result.stdout.toString("utf8"));
    if (command.schema !== "editkin.music-beats-command/v1" || command.outputPath !== resultPath || command.decoderTreeClosed !== true
      || command.pcmStagedBytes !== 0 || command.decodedSamples !== Math.round(request.durationSeconds * 16_000)) throw Error("MUSIC_BEATS_COMMAND_RECEIPT_INVALID");
    const bytes = await readBoundedFile(resultPath, MUSIC_BEATS_RESULT_BYTES_V1);
    if (command.outputBytes !== bytes.length) throw Error("MUSIC_BEATS_RESULT_BYTES_INVALID");
    const receipt = validateMusicBeatsReceiptV1(JSON.parse(bytes.toString("utf8")), request, identity);
    const current = await Promise.all([request.sourcePath, runtime.ffmpegPath, runtime.ffprobePath, runtime.nativeCorePath].map(path => musicBeatFileShaV1(path, runtime.signal)));
    if (canonicalJson(current) !== canonicalJson([source, ffmpeg, ffprobe, core])) throw Error("MUSIC_BEATS_RUNTIME_OR_SOURCE_CHANGED");
    active(); const receiptSha256 = digest(receipt), cacheBytes = Buffer.from(JSON.stringify({ schema: "editkin.music-beats-cache/v1", key, binding, receiptSha256, receipt }));
    if (cacheBytes.length > MUSIC_BEATS_RESULT_BYTES_V1) throw Error("MUSIC_BEATS_CACHE_BYTES_EXCEEDED");
    const temporary = join(workspace, "cache.json"); await writeFile(temporary, cacheBytes, { flag: "wx" });
    await withMediaCachePublishLock(cachePath, async () => { active(); if (!(await readCache())) await rename(temporary, cachePath); });
    active(); return { key, receiptSha256, binding, receipt, cacheHit: false, elapsedMs: Date.now() - started };
  } finally {
    if (!workspace.startsWith(`${parent}${process.platform === "win32" ? "\\" : "/"}owned-analysis-`)) throw Error("MUSIC_BEATS_CLEANUP_PATH_INVALID");
    const now = await lstat(workspace);
    if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== workspaceIdentity.dev || now.ino !== workspaceIdentity.ino
      || (await realpath(parent)).toLowerCase() !== parent.toLowerCase()
      || (await readBoundedFile(join(workspace, "owner.json"), 1024)).toString("utf8") !== owner) throw Error("MUSIC_BEATS_CLEANUP_OWNER_CHANGED");
    await rm(workspace, { recursive: true, force: true });
  }
}
