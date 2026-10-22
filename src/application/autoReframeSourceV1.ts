import { createHash } from "node:crypto";
import { open, lstat, mkdtemp, realpath, unlink, rmdir, type FileHandle } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { EditProject } from "../domain/types";
import { findClip, findAsset } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { clipTimeRemapClockV1 } from "../domain/clipTimeRemapV1";
import { withRenderLifetime, renderLifetimeSignal, assertRenderActive, fullDecodeTimeoutMs } from "../render/renderLifetime";
import { runProcess } from "../render/mediaProcess";
import { buildDecodedPtsIndexV1 } from "../render/decodedPtsIndexV1";
import { createTimeRemapFrameConsumerV2 } from "../render/timeRemapFrameConsumerV2";
import { verifyFrozenRotoMatte } from "../render/autoRotoMatteIntegrity";
import { compileAutoReframeV1, observeReframePixelsV1, reframeSceneChangeV1, type ReframeObservationV1 } from "./autoReframeV1";
import { assertAutoReframeSparseSinkV2, type AutoReframeSparseSinkV2 } from "./autoReframeSparseV2";
import { assertReframeReviewedMatteV1, claimReframeReviewedMatteV1, reframeReviewedMatteSubjectV1, verifyReframeReviewedMatteV1, reframeReviewedMatteReceiptV1, closeReframeReviewedMatteV1, type ReframeReviewedMatteV1 } from "./autoReframeReviewedMatteV1";
async function digest(handle: FileHandle) {
  const size = (await handle.stat()).size, scratch = Buffer.allocUnsafe(1024 ** 2), hash = createHash("sha256");
  if (!Number.isSafeInteger(size) || size < 1) throw Error("REFRAME_SOURCE_SIZE_INVALID");
  for (let at = 0; at < size;) { assertRenderActive(); const read = await handle.read(scratch, 0, Math.min(scratch.length, size - at), at); if (!read.bytesRead) throw Error("REFRAME_SOURCE_TRUNCATED"); hash.update(scratch.subarray(0, read.bytesRead)); at += read.bytesRead; }
  return hash.digest("hex");
}
/** Read-only source analysis and editable command preparation. No model/native/VA activation or project writes. */
export async function prepareAutoReframeSourceV1(project: EditProject, input: { clipId: string; outputWidth: number; outputHeight: number; expectedSourceSha256: string;
  matteMaskId?: string; maximumCommands?: number; deadZone?: number; maximumPanSpeed?: number; springFrequency?: number }, runtime: {
    sourcePath: string; ffmpegPath: string; ffprobePath: string; cacheRoot: string; productCacheRoot?: string; signal?: AbortSignal; timeoutMs?: number;
    onFrame?: (frame: number) => Promise<void>; sparseCameraV2?: AutoReframeSparseSinkV2; reviewedMatteV1?: ReframeReviewedMatteV1;
  }) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSourceSha256)) throw Error("REFRAME_SOURCE_SHA_INVALID");
  const clip = findClip(project, input.clipId), asset = findAsset(project, clip.assetId), before = canonicalJson(project);
  if (clip.timeRemap || clip.speed !== undefined && clip.speed !== 1 || asset.clipRetime) throw Error("REFRAME_RETIMED_MATTE_CLOCK_REQUIRES_CONSUMER");
  // Preflight compilation validates locks/camera/other-content/cap before launching source producers.
  const count = Math.round(clip.duration * project.fps);
  if (!Number.isSafeInteger(count) || count < 1 || !runtime.sparseCameraV2 && count > (input.maximumCommands ?? 4096)) throw Error("REFRAME_CLOCK_OR_BUDGET_INVALID");
  if (runtime.sparseCameraV2) assertAutoReframeSparseSinkV2(runtime.sparseCameraV2, project, input);
  else {
    const placeholder = Array.from({ length: count }, (_, frame) => ({ frame, time: frame / project.fps, sceneCut: !frame, pixelSha256: "0".repeat(64) }));
    compileAutoReframeV1(project, { ...input, sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height, observations: placeholder });
  }
  const sourcePath = resolve(runtime.sourcePath), cache = resolve(runtime.cacheRoot);
  if (runtime.reviewedMatteV1) assertReframeReviewedMatteV1(runtime.reviewedMatteV1, project, input, sourcePath);
  for (const path of [sourcePath, cache]) { const info = await lstat(path); if (info.isSymbolicLink() || await realpath(path) !== path) throw Error("REFRAME_LINKED_SOURCE_OR_CACHE"); }
  const source = await open(sourcePath, "r"), identity = await source.stat({ bigint: true });
  let work: string | undefined, metadata: FileHandle | undefined, alphaHandle: FileHandle | undefined, consumer: ReturnType<typeof createTimeRemapFrameConsumerV2> | undefined;
  let workIdentity: { dev: number; ino: number } | undefined, metadataIdentity: { dev: number; ino: number } | undefined;
  let reviewedMatteClaimed = false;
  const stable = async () => { const named = await lstat(sourcePath, { bigint: true }), pinned = await source.stat({ bigint: true });
    if (!named.isFile() || [named, pinned].some(v => v.dev !== identity.dev || v.ino !== identity.ino || v.size !== identity.size || v.mtimeNs !== identity.mtimeNs || v.ctimeNs !== identity.ctimeNs)) throw Error("REFRAME_SOURCE_CHANGED"); };
  try {
    return await withRenderLifetime({ signal: runtime.signal, timeoutMs: runtime.timeoutMs ?? fullDecodeTimeoutMs(asset.duration), workSeconds: asset.duration }, async () => {
      if (runtime.reviewedMatteV1) { claimReframeReviewedMatteV1(runtime.reviewedMatteV1, project, input, sourcePath); reviewedMatteClaimed = true; }
      await stable(); if (await digest(source) !== input.expectedSourceSha256) throw Error("REFRAME_SOURCE_SHA_CHANGED");
      const probe = JSON.parse((await runProcess(runtime.ffprobePath, ["-v", "error", "-show_streams", "-show_data", "-of", "json", sourcePath], 30000, { completeStdoutMaxChars: 65536 })).stdout);
      const videos = (probe.streams as Record<string, any>[]).filter(s => s.codec_type === "video"), video = videos[0];
      if (videos.length !== 1 || !["yuv420p", "rgba", "bgra", "rgb24", "bgr0"].includes(video.pix_fmt) || video.side_data_list?.length || !["1:1", "1/1"].includes(video.sample_aspect_ratio)
        || ![video.width, video.height].every(v => Number.isSafeInteger(v) && v > 0) || video.width * video.height * 4 > 64 * 1024 ** 2) throw Error("REFRAME_SOURCE_GEOMETRY_UNSUPPORTED");
      const tb = String(video.time_base).split("/").map(Number); if (tb.length !== 2 || !tb.every(v => Number.isSafeInteger(v) && v > 0)) throw Error("REFRAME_SOURCE_CLOCK_UNKNOWN");
      runtime.sparseCameraV2?.initialize(video.width, video.height);
      let matte: NonNullable<typeof clip.masks>[number]["matteSequence"], alpha: Buffer | undefined;
      if (input.matteMaskId) {
        const mask = clip.masks?.find(v => v.id === input.matteMaskId); matte = mask?.matteSequence;
        if (!mask?.enabled || mask.inverted || mask.mode !== "add" || !matte || matte.stale || matte.staleReason || matte.width * matte.height > 16 * 1024 ** 2) throw Error("REFRAME_MATTE_UNAVAILABLE_OR_STALE");
        await verifyFrozenRotoMatte(matte, matte.sequenceUri, matte.manifestUri, runtime.productCacheRoot);
        alphaHandle = await open(matte.sequenceUri, "r"); alpha = Buffer.allocUnsafe(matte.width * matte.height);
      }
      work = await mkdtemp(join(cache, ".editkin-reframe-")); const wi = await lstat(work); workIdentity = { dev: wi.dev, ino: wi.ino };
      metadata = await open(join(work, "pts.bin"), "wx+"); const mi = await metadata.stat(); metadataIdentity = { dev: mi.dev, ino: mi.ino };
      const indexed = await buildDecodedPtsIndexV1({ ffprobePath: runtime.ffprobePath, sourcePath, source, sourceBytes: Number(identity.size), metadata,
        timeBase: { numerator: tb[0], denominator: tb[1] }, h264FourByteNals: video.codec_name === "h264" && video.is_avc === "true" && video.nal_length_size === "4",
        timeoutMs: runtime.timeoutMs ?? fullDecodeTimeoutMs(asset.duration), maximumMetadataBytes: 512 * 1024 ** 2 });
      const clock = clipTimeRemapClockV1(project, { ...clip, speed: 1 }, asset); if (!clock) throw Error("REFRAME_FRAME_CLOCK_UNAVAILABLE");
      consumer = createTimeRemapFrameConsumerV2({ clock, index: indexed.index, width: video.width, height: video.height, ffmpegPath: runtime.ffmpegPath, sourcePath, timeoutMs: runtime.timeoutMs ?? fullDecodeTimeoutMs(asset.duration), signal: renderLifetimeSignal() });
      const observations: ReframeObservationV1[] = []; let histogram: Float64Array | undefined;
      for (let frame = 0; frame < clock.totalOutputFrames; frame++) {
        assertRenderActive(); const sample = await consumer.sample(frame);
        if (matte && alpha && alphaHandle) { const index = Math.min(matte.frameCount - 1, Math.floor(frame / project.fps * matte.analysisFps)); let at = 0;
          while (at < alpha.length) { const read = await alphaHandle.read(alpha, at, alpha.length - at, index * alpha.length + at); if (!read.bytesRead) throw Error("REFRAME_MATTE_TRUNCATED"); at += read.bytesRead; } }
        const observation = observeReframePixelsV1({ rgba: sample.bytes, width: video.width, height: video.height, alpha, alphaWidth: matte?.width, alphaHeight: matte?.height });
        const row = { frame, time: frame / project.fps, subject: runtime.reviewedMatteV1 ? reframeReviewedMatteSubjectV1(runtime.reviewedMatteV1, frame) : observation.subject, sceneCut: reframeSceneChangeV1(histogram, observation.histogram), pixelSha256: observation.pixelSha256 };
        if (runtime.sparseCameraV2) runtime.sparseCameraV2.consume(row); else observations.push(row); histogram = observation.histogram;
        await runtime.onFrame?.(frame);
      }
      await consumer.finish(); await indexed.index.assertIdentity(); await stable(); if (await digest(source) !== input.expectedSourceSha256 || canonicalJson(project) !== before) throw Error("REFRAME_SOURCE_OR_GRAPH_CHANGED");
      if (matte) await verifyFrozenRotoMatte(matte, matte.sequenceUri, matte.manifestUri, runtime.productCacheRoot);
      if (runtime.reviewedMatteV1) await verifyReframeReviewedMatteV1(runtime.reviewedMatteV1, project, input, sourcePath);
      const sparseResult = runtime.sparseCameraV2?.finish();
      const result = sparseResult ?? compileAutoReframeV1(project, { ...input, sourceWidth: video.width, sourceHeight: video.height, observations });
      return { ...result, sourceSha256: input.expectedSourceSha256, observations: sparseResult?.observations ?? observations, analysis: { sourcePixelSpace: "encoded_rgba8_candidate", decoder: consumer.receipt, decoderTerminals: consumer.decoderReceipts,
        sourceIndex: { frames: indexed.index.decodedFrameCount, metadataBytes: indexed.index.metadataBytes, sha256: indexed.index.metadataSha256 },
        matte: runtime.reviewedMatteV1 ? reframeReviewedMatteReceiptV1(runtime.reviewedMatteV1) : matte ? { sequenceSha256: matte.sequenceSha256, artifactVerified: true, sourceBinding: "current_project_mask_receipt", semanticQuality: "diagnostic_unmeasured" } : null,
        saliency: "bounded_color_contrast_heuristic_not_semantic_detection", modelsDownloaded: 0, rawMoviePixelFiles: 0 }, ordinaryUiIntegrated: false };
    });
  } finally {
    if (runtime.reviewedMatteV1 && reviewedMatteClaimed) closeReframeReviewedMatteV1(runtime.reviewedMatteV1);
    await consumer?.close(); await alphaHandle?.close(); await metadata?.close(); await source.close();
    if (work && metadataIdentity && workIdentity) {
      const wi = await lstat(work), file = join(work, "pts.bin"), mi = await lstat(file);
      if (wi.dev !== workIdentity.dev || wi.ino !== workIdentity.ino || wi.isSymbolicLink() || mi.dev !== metadataIdentity.dev || mi.ino !== metadataIdentity.ino || mi.isSymbolicLink()) throw Error("REFRAME_OWNED_WORK_IDENTITY_CHANGED");
      await unlink(file); await rmdir(work);
    }
  }
}
