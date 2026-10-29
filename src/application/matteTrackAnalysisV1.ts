import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveMediaPath } from "../render/mediaProcess";
import { readBoundedFile } from "../shared/boundedFile";
import { verifyProductAutoRotoV2, type ProductAutoRotoAnalysisResultV2 } from "./autoRotoNativeProductV2";
import { matteTrackSourceV1, measureMatteFrameV1, prepareMatteTrackV1, type MatteTrackJobV1, type MatteTrackMeasurementV1 } from "./matteTrackV1";
import type { EditProject } from "../domain/types";
import type { RotoCutoutClipResultV1 } from "./rotoCutoutClipV1";
import { rotoMatteIdentitySchemaV1, verifyRotoMatteTrustV1, type RotoMatteTrustV1 } from "./rotoMatteTrustV1";
import { assertRotoV2IdentityUnchanged, assertRotoV2LocalPath, rotoV2Deadline } from "./rotoV2Workspace";

export interface MatteTrackArtifactsV1 { analysis: ProductAutoRotoAnalysisResultV2; cutout: RotoCutoutClipResultV1; trust: RotoMatteTrustV1; }
export interface MatteTrackRuntimeV1 {
  signal?: AbortSignal; timeoutMs?: number;
  onProgress?: (progress: { stage: "verify-inputs" | "measure" | "verified"; completed: number; total: number }) => void;
}
/** EG5 Node handler. Reuses EG3 physical/trust APIs; no decoder, model, analysis process,
 * generated matte or second apply owner. Only the caller's existing reviewed matte is measured. */
export async function analyzeMatteTrackV1(project: EditProject, job: MatteTrackJobV1, input: MatteTrackArtifactsV1,
  host: { assetBase: string }, requestedRuntime: MatteTrackRuntimeV1 = {}) {
  const selected = matteTrackSourceV1(project, job), runtime = Object.freeze({ ...requestedRuntime });
  if (!isAbsolute(host.assetBase) || resolve(host.assetBase) !== host.assetBase) throw Error("MATTE_TRACK_ABSOLUTE_ASSET_BASE_REQUIRED");
  if (selected.signal && runtime.signal && selected.signal !== runtime.signal) throw Error("MATTE_TRACK_SINGLE_OWNER_SIGNAL_REQUIRED");
  const signal = selected.signal ?? runtime.signal, check = rotoV2Deadline(signal, runtime.timeoutMs);
  check(); const { analysis, cutout, trust } = structuredClone(input);
  const expected = rotoMatteIdentitySchemaV1.parse({ schema: "editkin.roto-matte-identity/v1", sourceSha256: analysis.source.sha256,
    cutoutSha256: cutout.clip.sha256, alphaSha256: cutout.alphaSha256, analysisSha256: analysis.analysisSha256,
    nativeCoreSha256: analysis.tools.nativeCore.sha256, sourceStart: analysis.request.sourceStart, width: analysis.media.width,
    height: analysis.media.height, frameCount: analysis.media.frameCount, fps: analysis.media.fps, qualityState: "diagnostic" });
  const confirmation = verifyRotoMatteTrustV1(trust, expected); check();
  const sourcePath = resolve(resolveMediaPath(selected.asset.uri, host.assetBase)), m = analysis.media, n = analysis.native;
  const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const displayRatio = selected.asset.displayAspectRatio ?? selected.asset.width! / selected.asset.height!;
  if (!samePath(sourcePath, analysis.source.path) || !samePath(sourcePath, cutout.sourcePath)
    || (selected.asset.derivatives?.sourceSha256 !== undefined && selected.asset.derivatives.sourceSha256 !== analysis.source.sha256)
    || analysis.request.sourceStart !== selected.clip.sourceStart || Math.abs(analysis.request.duration - selected.clip.duration) > 1e-7
    || Math.abs(m.frameCount / m.fps - selected.clip.duration) > 1e-7 || m.width !== m.sourceDisplayWidth || m.height !== m.sourceDisplayHeight
    || !Number.isFinite(displayRatio) || Math.abs(displayRatio - m.width / m.height) > 1e-7
    || cutout.schema !== "editkin.roto-cutout-clip/v1" || cutout.qualityState !== "diagnostic" || cutout.subjectConfirmation !== "required" || cutout.benchmarkAccepted !== false
    || cutout.sourceSha256 !== analysis.source.sha256 || cutout.analysisSha256 !== analysis.analysisSha256
    || JSON.stringify(cutout.matteIdentity) !== JSON.stringify(expected)
    || cutout.alphaMode !== "straight" || cutout.codec !== "ffv1" || cutout.pixelFormat !== "gbrap16le"
    || cutout.width !== m.width || cutout.height !== m.height || cutout.frameCount !== m.frameCount || cutout.fps !== m.fps
    || Math.abs(cutout.duration - selected.clip.duration) > 1e-7 || cutout.inputAlphaBits !== (n.edgeSettings.alpha16 ? 16 : 8)
    || cutout.manifestPath !== join(dirname(cutout.clip.path), "cutout-v1.json")) throw Error("MATTE_TRACK_SOURCE_WINDOW_OR_MATTE_CHANGED");
  runtime.onProgress?.({ stage: "verify-inputs", completed: 0, total: n.frameCount }); check();
  await verifyProductAutoRotoV2(analysis, check);
  await assertRotoV2LocalPath(cutout.manifestPath);
  if (JSON.stringify(JSON.parse((await readBoundedFile(cutout.manifestPath, 65536)).toString("utf8"))) !== JSON.stringify(cutout)) throw Error("MATTE_TRACK_CUTOUT_MANIFEST_CHANGED");
  await assertRotoV2IdentityUnchanged(cutout.clip, check); matteTrackSourceV1(project, job); check();
  const artifact = analysis.artifacts.find(a => a.relativePath === n.alphaPath);
  if (!artifact || artifact.sha256 !== expected.alphaSha256 || artifact.bytes !== n.alphaBytes) throw Error("MATTE_TRACK_ALPHA_IDENTITY_CHANGED");
  await assertRotoV2LocalPath(artifact.path);
  const bits = n.alphaFormat === "gray16le" ? 16 : 8, frameBytes = n.width * n.height * bits / 8;
  const buffer = Buffer.alloc(frameBytes), frames: MatteTrackMeasurementV1["frames"] = [], hash = createHash("sha256");
  const file = await open(artifact.path, "r");
  try {
    if ((await file.stat()).size !== n.alphaBytes) throw Error("MATTE_TRACK_ALPHA_BYTE_COUNT");
    for (let i = 0; i < n.frameCount; i++) {
      check(); let read = 0;
      while (read < frameBytes) {
        check(); const r = await file.read(buffer, read, frameBytes - read, i * frameBytes + read);
        if (!r.bytesRead) throw Error("MATTE_TRACK_ALPHA_TRUNCATED"); read += r.bytesRead;
      }
      hash.update(buffer); const observation = measureMatteFrameV1(buffer, n.width, n.height, bits, selected.options.minimumAlpha, check);
      frames.push({ frame: i, time: i / m.fps, confidence: observation.foregroundPixels ? n.frames[i].confidence : 0, ...observation });
      runtime.onProgress?.({ stage: "measure", completed: i + 1, total: n.frameCount }); check();
    }
    if ((await file.stat()).size !== n.alphaBytes || hash.digest("hex") !== artifact.sha256) throw Error("MATTE_TRACK_STREAM_DIGEST_CHANGED");
  } finally { await file.close(); }
  // Re-admit actual inputs after all asynchronous reads; no cached client trust or metadata-only apply.
  await verifyProductAutoRotoV2(analysis, check); await assertRotoV2IdentityUnchanged(cutout.clip, check);
  await assertRotoV2LocalPath(cutout.manifestPath);
  if (JSON.stringify(JSON.parse((await readBoundedFile(cutout.manifestPath, 65536)).toString("utf8"))) !== JSON.stringify(cutout)) throw Error("MATTE_TRACK_CUTOUT_MANIFEST_CHANGED");
  verifyRotoMatteTrustV1(trust, expected); matteTrackSourceV1(project, job); check();
  const measurement: MatteTrackMeasurementV1 = { schema: "editkin.matte-track-measurement/v1", sourceSha256: expected.sourceSha256,
    alphaSha256: expected.alphaSha256, analysisSha256: expected.analysisSha256,
    subjectConfirmationSha256: createHash("sha256").update(JSON.stringify(confirmation)).digest("hex"),
    width: n.width, height: n.height, alphaBits: bits, fps: m.fps, frameCount: m.frameCount, sourceStart: expected.sourceStart,
    minimumAlpha: selected.options.minimumAlpha, frames };
  const plan = prepareMatteTrackV1(project, job, measurement, signal);
  runtime.onProgress?.({ stage: "verified", completed: n.frameCount, total: n.frameCount }); check(); matteTrackSourceV1(project, job);
  return { plan, measurement, source: { ...analysis.source }, alpha: { ...artifact }, peakAlphaFrameBytes: frameBytes,
    nativeOrFfmpegProcesses: 0 as const, qualityState: "diagnostic" as const, benchmarkAccepted: false as const };
}
