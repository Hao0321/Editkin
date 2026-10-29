import { createTimeRemapSourceStageV1 } from "./timeRemapSourceStageV1";
import { clipTimeRemapMuteReasonV1 } from "../domain/clipTimeRemapV1";
import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { resolveMediaPath, runProcess } from "./mediaProcess";
import { withRenderLifetime, renderLifetimeAbort, renderLifetimeSignal, assertRenderActive } from "./renderLifetime";
import { createLongRenderSpaceGuardV2, ownedTreeBytesV2 } from "./longRenderGuardV2";
import { defaultLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { createOwnedDirectoryV1, openLongRenderJournalV1, replayLongRenderJournalsV1 } from "./longRenderOwnerJournalV1";
import type { DiskSpaceProbe } from "./renderDiskSpace";
import { renderTimeRemapSourceProjectV1, SOURCE_CLOCK_RENDER_POLICY_V1, SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 } from "./timeRemapSourceRenderV1";
import { admitTimeRemapCacheClipV1, TIME_REMAP_CACHE_POLICY_V1, TIME_REMAP_CACHE_MAX_BYTES_V1, timeRemapCacheKeyV1,
  timeRemapCacheDigestV1, parseTimeRemapCacheReceiptV1, type TimeRemapCacheKeyV1, type TimeRemapCacheReceiptV1 } from "./timeRemapCacheContractV1";
import { assertTimeRemapLocalPathV1, timeRemapFingerprintV1, timeRemapSha256V1, timeRemapToolIdentityV1, timeRemapCacheImplementationV1 } from "./timeRemapCacheIdentityV1";
import { timeRemapCacheRootV1, withTimeRemapCacheProducerV1, pinTimeRemapCacheEntryV1, readTimeRemapCacheJsonV1, timeRemapCacheProducerIdentityV1 } from "./timeRemapCacheStoreV1";
import { ensureTimeRemapCacheCapacityV1, TIME_REMAP_CACHE_EVICTION_POLICY_V1, TimeRemapCacheCapacityErrorV1, type TimeRemapCacheCapacityReceiptV1 } from "./timeRemapCacheCapacityV1";
import { retireTimeRemapCacheEntryUnderLeaseV1 } from "./timeRemapCacheRetirementV1";

export interface TimeRemapCacheRuntimeV1 {
  policy: typeof TIME_REMAP_CACHE_POLICY_V1; ffmpegPath: string; ffprobePath: string;
  /** Host-created helper process TEMP/TMP, on the project volume. This function never mutates process.env. */
  helperTemporaryRoot: string; signal?: AbortSignal; timeoutMs?: number;
  maximumStoredBytes?: number; maximumOutputBytes?: number; maximumDecodedCacheBytes?: number; volumeProbe?: DiskSpaceProbe;
  /** Omit to retain quota-full refusal; opt in to verified, unpinned oldest-entry reclamation. */
  cacheEvictionPolicy?: typeof TIME_REMAP_CACHE_EVICTION_POLICY_V1;
  onCacheCapacity?: (receipt: TimeRemapCacheCapacityReceiptV1) => void;
  onFrame?: (value: { clipId: string; index: number; frames: number }) => void;
  onProducer?: (receipt: Awaited<ReturnType<typeof renderTimeRemapSourceProjectV1>>) => void;
  onWarning?: (message: string) => void;
}
export interface TimeRemapCacheArtifactV1 {
  state: "ready"; cacheHit: boolean; root: string; mediaPath: string; receipt: TimeRemapCacheReceiptV1;
  capacity?: TimeRemapCacheCapacityReceiptV1;
  /** Hold this until every preview/encoder consumer has closed the cached source. */
  release(): Promise<void>;
}
export interface TimeRemapCacheRequestV1 {
  project: EditProject; clipId: string; projectRoot: string; assetBase?: string; expectedSourceSha256: string;
}
function selected(input: TimeRemapCacheRequestV1) {
  const clip = input.project.tracks.flatMap(t => t.clips).find(c => c.id === input.clipId), asset = input.project.assets.find(a => a.id === clip?.assetId);
  if (!clip || !asset || !/^[a-f0-9]{64}$/.test(input.expectedSourceSha256)) throw Error("TIME_REMAP_CACHE_SELECTED_SOURCE_AND_SHA_REQUIRED");
  return { clip, asset, ...admitTimeRemapCacheClipV1(input.project, clip, asset) };
}
async function sourceProbe(sourcePath: string, runtime: TimeRemapCacheRuntimeV1) {
  const data = JSON.parse((await runProcess(runtime.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", sourcePath], 30000, { completeStdoutMaxChars: 262144 })).stdout);
  if (!Array.isArray(data.streams)) throw Error("TIME_REMAP_CACHE_SOURCE_PROBE_INVALID");
  const video = data.streams.filter((s: Record<string, unknown>) => s.codec_type === "video");
  if (video.length !== 1 || video[0].disposition?.attached_pic || video[0].side_data_list?.length || video[0].tags?.rotate
    || !["1:1", "1/1"].includes(video[0].sample_aspect_ratio) || !["yuv420p", "rgba", "bgra", "rgb24", "bgr0"].includes(video[0].pix_fmt)
    || (video[0].color_transfer !== undefined && !["bt709", "unknown", "unspecified"].includes(video[0].color_transfer))
    || (video[0].color_primaries !== undefined && !["bt709", "unknown", "unspecified"].includes(video[0].color_primaries))) throw Error("TIME_REMAP_CACHE_REQUIRES_UNROTATED_SQUARE_PIXEL_SDR_RGB8");
  return { width: Number(video[0].width), height: Number(video[0].height), audioStreams: data.streams.filter((s: Record<string, unknown>) => s.codec_type === "audio").length };
}
async function admitHit(root: string, key: string, inputs: TimeRemapCacheKeyV1, sourcePath: string, runtime: TimeRemapCacheRuntimeV1) {
  const directory = join(root, key); await assertTimeRemapLocalPathV1(directory);
  const exists = await lstat(directory).catch(e => { if (e.code === "ENOENT") return undefined; throw e; }); if (!exists) return undefined;
  if (!exists.isDirectory() || (await readdir(directory)).sort().join() !== ".editkin-long-owner.json,clip.mkv,receipt.json") throw Error("TIME_REMAP_CACHE_ENTRY_PARTIAL_OR_FOREIGN");
  const receipt = parseTimeRemapCacheReceiptV1(await readTimeRemapCacheJsonV1(join(directory, "receipt.json")));
  if (receipt.key !== key || canonicalJson(receipt.keyInputs) !== canonicalJson(inputs)) throw Error("TIME_REMAP_CACHE_KEY_MISMATCH");
  // A normal unchanged local identity permits a fast source hit; a copy/rewrite must prove its SHA again.
  const current = await timeRemapFingerprintV1(sourcePath);
  if (canonicalJson(current) !== canonicalJson(receipt.sourceFingerprint) && await timeRemapSha256V1(sourcePath, runtime.signal) !== inputs.sourceSha256) throw Error("TIME_REMAP_CACHE_SOURCE_CHANGED");
  const mediaPath = join(directory, "clip.mkv"), identity = await timeRemapFingerprintV1(mediaPath);
  if (Number(identity.size) !== receipt.media.bytes || await timeRemapSha256V1(mediaPath, runtime.signal) !== receipt.media.sha256) throw Error("TIME_REMAP_CACHE_MEDIA_CHANGED");
  const release = await pinTimeRemapCacheEntryV1(root, key); return { state: "ready" as const, cacheHit: true, root, mediaPath, receipt, release };
}
/** Executable source API; H8/H13 still own ordinary export/preview integration. No 1x fallback. */
export async function getTimeRemapRenderCacheV1(input: TimeRemapCacheRequestV1, runtime: TimeRemapCacheRuntimeV1): Promise<TimeRemapCacheArtifactV1> {
  const { clip, asset, clock, width, height, fps } = selected(input), snapshot = canonicalJson(input.project);
  if (runtime.policy !== TIME_REMAP_CACHE_POLICY_V1) throw Error("TIME_REMAP_CACHE_EXPLICIT_POLICY_REQUIRED");
  if (runtime.cacheEvictionPolicy !== undefined && runtime.cacheEvictionPolicy !== TIME_REMAP_CACHE_EVICTION_POLICY_V1) throw Error("TIME_REMAP_CACHE_EVICTION_POLICY_INVALID");
  const quota = runtime.maximumStoredBytes ?? TIME_REMAP_CACHE_MAX_BYTES_V1, outputCap = runtime.maximumOutputBytes ?? quota;
  if (![quota, outputCap].every(n => Number.isSafeInteger(n) && n >= 1024 ** 2 && n <= TIME_REMAP_CACHE_MAX_BYTES_V1) || outputCap > quota) throw Error("TIME_REMAP_CACHE_QUOTA_INVALID");
  return withRenderLifetime({ signal: runtime.signal, timeoutMs: runtime.timeoutMs, workSeconds: asset.duration + clip.duration }, async () => {
    const signal = renderLifetimeSignal(); let unreturnedRelease: (() => Promise<void>) | undefined;
    const root = await timeRemapCacheRootV1(input.projectRoot, runtime.helperTemporaryRoot), sourcePath = resolve(resolveMediaPath(asset.uri, input.assetBase ?? input.projectRoot));
    const sourceFingerprint = await timeRemapFingerprintV1(sourcePath);
    const [ffmpeg, ffprobe, implementationSha256] = await Promise.all([timeRemapToolIdentityV1(runtime.ffmpegPath, signal), timeRemapToolIdentityV1(runtime.ffprobePath, signal), timeRemapCacheImplementationV1()]);
    const probe = await sourceProbe(sourcePath, runtime);
    if (probe.width !== width || probe.height !== height) throw Error("TIME_REMAP_CACHE_SOURCE_RASTER_CHANGED");
    // A named mute (freeze, a muted curve, a silent clip, a constant speed outside the pitch-preserving 0.5–4x range)
    // bakes no sound; otherwise one audio stream follows a constant speed with its pitch kept (shared-phase vocoder).
    const muteReason = clipTimeRemapMuteReasonV1(clip), muted = muteReason !== undefined;
    if (!muted && probe.audioStreams && (clip.timeRemap || (clip.speed ?? 1) < .5 || (clip.speed ?? 1) > 4 || probe.audioStreams !== 1)) throw Error("TIME_REMAP_CACHE_VARIABLE_OR_EXTREME_FOLLOW_AUDIO_REQUIRES_DSP");
    const audio = !probe.audioStreams ? "absent" : muted ? "muted" : "shared-phase-pcm";
    const keyInputs: TimeRemapCacheKeyV1 = { policy: TIME_REMAP_CACHE_POLICY_V1, sourceSha256: input.expectedSourceSha256,
      sourceStart: clip.sourceStart, duration: clip.duration, speed: clip.speed ?? null, timeRemap: clip.timeRemap ?? null, fps, width, height, audio,
      implementationSha256, ffmpegSha256: ffmpeg.sha256, ffprobeSha256: ffprobe.sha256 }, key = timeRemapCacheKeyV1(keyInputs);
    try {
    const result = await withTimeRemapCacheProducerV1(root, signal, async () => {
      assertRenderActive(); const hit = await admitHit(root, key, keyInputs, sourcePath, { ...runtime, signal });
      if (hit) { unreturnedRelease = hit.release; assertRenderActive(); if (canonicalJson(input.project) !== snapshot) throw Error("TIME_REMAP_CACHE_PROJECT_CHANGED"); return hit; }
      await replayLongRenderJournalsV1({ registryRoot: join(root, ".journals"), retryMs: 1000 });
      const requested = Math.min(outputCap, Math.ceil(width * height * 4 * clock.totalOutputFrames * 1.2 + clock.totalOutputFrames * 4096 + 2 * 1024 ** 2));
      const capacity = runtime.cacheEvictionPolicy ? await ensureTimeRemapCacheCapacityV1({ root, keepKey: key, quotaBytes: quota, requestedOutputBytes: requested, signal }) : undefined;
      const limit = capacity ? capacity.availableOutputBytes : Math.min(outputCap, quota - await ownedTreeBytesV2([root]) - 1024 ** 2);
      if (capacity) {
        try { runtime.onCacheCapacity?.(capacity); }
        catch (error) { throw new TimeRemapCacheCapacityErrorV1("TIME_REMAP_CACHE_CAPACITY_OBSERVER_FAILED", capacity, error); }
      }
      if (limit < 1024 ** 2) throw Error("TIME_REMAP_CACHE_QUOTA_FULL");
      const estimated = Math.min(limit, Math.ceil(width * height * 4 * clock.totalOutputFrames * 1.2 + clock.totalOutputFrames * 4096 + 2 * 1024 ** 2));
      const runId = randomUUID(), work = join(root, `.build-${runId}`);
      const guard = createLongRenderSpaceGuardV2({ rows: [{ path: root, role: "output" }, { path: runtime.helperTemporaryRoot, role: "work" }, { path: process.env.SystemRoot ?? root, role: "system" }],
        policy: defaultLongRenderPolicyV1(), stagingRoots: [runtime.helperTemporaryRoot], outputRoots: [work],
        remainingOutputBytes: written => Math.max(0, estimated - written), onFailure: e => renderLifetimeAbort()?.(e), onWarning: runtime.onWarning, probe: runtime.volumeProbe });
      let journal: Awaited<ReturnType<typeof openLongRenderJournalV1>> | undefined;
      let published = false, completed: { mediaPath: string; receipt: TimeRemapCacheReceiptV1 } | undefined;
      try {
        await guard.admit({ outputBytes: estimated, workBytes: 512 * 1024 ** 2 }); guard.start();
        journal = await openLongRenderJournalV1({ workRoot: root, runId, registryRoot: join(root, ".journals") });
        await createOwnedDirectoryV1(work, runId); await journal.recordCreated(work, "run-work-dir");
        const record = async (path: string, kind: "file" | "dir") => {
          const r = relative(work, path); if (!r || r === ".." || r.startsWith(`..${sep}`)) throw Error("TIME_REMAP_CACHE_CHILD_PATH_ESCAPE");
          await assertTimeRemapLocalPathV1(path); await journal!.recordCreated(path, kind);
        };
        const stage = createTimeRemapSourceStageV1(input.project, clip, asset, sourcePath, { muteAudio: muted && probe.audioStreams > 0 });
        const rendered = await renderTimeRemapSourceProjectV1(stage, join(work, "clip.mkv"), { ffmpegPath: ffmpeg.path, ffprobePath: ffprobe.path,
          assetBase: input.assetBase ?? input.projectRoot, expectedSourceSha256: input.expectedSourceSha256,
          policy: audio === "shared-phase-pcm" ? SOURCE_CLOCK_SHARED_PHASE_PCM_POLICY_V3 : SOURCE_CLOCK_RENDER_POLICY_V1,
          maximumOutputBytes: limit, maximumCacheBytes: runtime.maximumDecodedCacheBytes, signal: renderLifetimeSignal(), timeoutMs: runtime.timeoutMs, volumeProbe: runtime.volumeProbe,
          onOwnedPath: record, onFrame: async f => { runtime.onFrame?.({ clipId: clip.id, index: f.index, frames: clock.totalOutputFrames }); } });
        runtime.onProducer?.(rendered);
        if (canonicalJson(await timeRemapFingerprintV1(sourcePath)) !== canonicalJson(sourceFingerprint) || canonicalJson(input.project) !== snapshot) throw Error("TIME_REMAP_CACHE_SOURCE_OR_PROJECT_CHANGED");
        const media = await timeRemapFingerprintV1(join(work, "clip.mkv"));
        if (rendered.frames !== clock.totalOutputFrames || rendered.duration !== clip.duration || rendered.outputPixels.sha256 !== rendered.sampledPixelSha256
          || await timeRemapSha256V1(join(work, "clip.mkv"), signal) !== rendered.outputSha256 || rendered.bytes !== Number(media.size)
          || !["absent", "explicitly_muted", "pitch_preserving_constant_pcm_f32", "shared_phase_constant_pcm_f32_candidate"].includes(rendered.originalAudio)) throw Error("TIME_REMAP_CACHE_RENDER_RECEIPT_INVALID");
        const body = { schema: "editkin.time-remap-cache/v1" as const, key, policy: TIME_REMAP_CACHE_POLICY_V1, keyInputs,
          qualityState: "source-clock-diagnostic" as const, ordinaryEditorPreviewReady: false as const, wholePixelQualityCertified: false as const, audioQualityCertified: false as const,
          sourceFingerprint, width, height, fps: input.project.fps, frames: rendered.frames, duration: rendered.duration,
          media: { name: "clip.mkv" as const, sha256: rendered.outputSha256, bytes: rendered.bytes, dev: media.dev, ino: media.ino },
          pixels: { sha256: rendered.outputPixels.sha256, bytes: rendered.outputPixels.bytes, frames: rendered.outputPixels.frames },
          audio: rendered.originalAudio as TimeRemapCacheReceiptV1["audio"],
          producer: { schema: "editkin.source-clock-render/v1" as const, sampledPixelSha256: rendered.sampledPixelSha256, outputPixelSha256: rendered.outputPixels.sha256,
            originalAudio: rendered.originalAudio, rawMoviePixelsStaged: 0 as const, sceneLinearHdrReady: false as const }, createdAt: new Date().toISOString() };
        const receipt = parseTimeRemapCacheReceiptV1({ ...body, digest: timeRemapCacheDigestV1(body) });
        await writeFile(join(work, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx" }); await record(join(work, "receipt.json"), "file");
        if (await ownedTreeBytesV2([root]) > quota) throw Error("TIME_REMAP_CACHE_QUOTA_EXCEEDED");
        const destination = join(root, key); await assertTimeRemapLocalPathV1(destination);
        if (await lstat(destination).catch(e => { if (e.code === "ENOENT") return undefined; throw e; })) throw Error("TIME_REMAP_CACHE_PUBLICATION_COLLISION");
        assertRenderActive(); await rename(work, destination); published = true;
        completed = { mediaPath: join(destination, "clip.mkv"), receipt };
      } finally {
        await guard.stop();
        if (journal) {
          // The exact source producer removes its own child directories, and publication renames
          // the entire build directory. Retire these factually absent paths before generic replay,
          // whose ancestry guard otherwise (correctly) refuses a missing ancestor.
          for (const item of journal.live()) {
            await assertTimeRemapLocalPathV1(item.path);
            if (!await lstat(item.path).catch(e => { if (e.code === "ENOENT") return undefined; throw e; })) await journal.recordRemoved(item.path, "producer-removed-or-directory-published");
          }
          const cleanup = await journal.cleanup({ releaseMs: 1000 });
          if (cleanup.leftovers.length) throw Error(`TIME_REMAP_CACHE_CLEANUP_LEFTOVERS:${cleanup.leftovers.map(x => x.path).join("|")}`);
        }
        // Successful directory rename leaves only missing old staging paths in the journal;
        // no persistent cache entry is ever a replay cleanup target.
        if (!published) runtime.signal?.throwIfAborted();
      }
      assertRenderActive();
      if (!completed) throw Error("TIME_REMAP_CACHE_COMMIT_MISSING");
      const release = await pinTimeRemapCacheEntryV1(root, key); unreturnedRelease = release; assertRenderActive();
      return { state: "ready" as const, cacheHit: false, root, ...completed, release, ...(capacity ? { capacity } : {}) };
    });
    unreturnedRelease = undefined; return result;
    } catch (e) { await unreturnedRelease?.(); throw e; }
  });
}

/** Explicit cache retirement, never a source/project delete or an unverified name-pattern sweep. */
export async function retireTimeRemapRenderCacheV1(projectRoot: string, helperTemporaryRoot: string, key: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("TIME_REMAP_CACHE_KEY_INVALID");
  const root = await timeRemapCacheRootV1(projectRoot, helperTemporaryRoot);
  return withTimeRemapCacheProducerV1(root, signal, async () => {
    const outcome = await retireTimeRemapCacheEntryUnderLeaseV1(root, key, await timeRemapCacheProducerIdentityV1(root), { signal });
    return { retired: outcome.retired, bytes: outcome.bytes };
  });
}
