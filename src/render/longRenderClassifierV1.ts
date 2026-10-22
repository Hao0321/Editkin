// SHORT/LONG classifier (design C1; decision Q-L2: LONG means a plan duration of 30 minutes or more).
// classifyRenderV1 is pure and cheap: for a SHORT render it reads only the timeline duration, so SHORT renders
// keep today's exact path. collectLongRenderFactsV1 runs for LONG renders only.
import type { EditProject } from "../domain/types";
import { projectDuration } from "../domain/editGraph";
import { selectReferencedCompositionsForRenderV1 } from "./referencedCompositionPrepassV1";
import { buildRenderPlan } from "./planner";
import { resolveMediaPath } from "./ffmpegMedia";
import { containsSceneLinearMedia } from "./aces2SdrVideo";
import { isHdrOutput } from "./ffmpegComposite";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { HIGH_BIT_DEPTH_ALPHA_PROFILE } from "./ffmpegContracts";
import { estimateAudioBedBytes, estimateEncodedOutputBytes, estimateNativeEffectWorkBytes, estimatePngSequenceBytes, estimatePrepassWorkBytes, RENDER_WORK_FIXED_BYTES } from "./renderDiskSpace";
import { durationFrameCountV1, frameRateRationalV1 } from "./longRenderClockV1";
import { formalExportDerivativesV1 } from "./longRenderFormalOriginalsV1";
import { LongRenderRefusalV1, type LongRenderClassificationV1, type LongRenderFactsV1, type LongRenderOptionsV1, type LongRenderPolicyV1 } from "./longRenderContractsV1";
import type { RenderOptions } from "./ffmpegTypes";

export const DEFAULT_MIN_LONG_SECONDS_V1 = 1800;

/** Plan path resolver before prepasses: a composition asset keeps its virtual URI (it is materialized later), real media resolves. */
export function longRenderPlanPathResolverV1(assetBase?: string): (uri: string) => string {
  return uri => uri.startsWith("editkin-composition://") ? uri : resolveMediaPath(uri, assetBase);
}

/** SHORT or LONG. Never throws for an ordinary project: a duration it cannot read stays SHORT, where the legacy path reports its own error. */
export function classifyRenderV1(project: EditProject, options?: LongRenderOptionsV1): LongRenderClassificationV1 {
  if (options?.forceClass !== undefined && options.forceClass !== "long") {
    throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "forceClass accepts only \"long\"; a LONG render is never forced SHORT", { forceClass: options.forceClass });
  }
  const minLongSeconds = options?.policy?.minLongSeconds ?? DEFAULT_MIN_LONG_SECONDS_V1;
  if (!Number.isSafeInteger(minLongSeconds) || minLongSeconds < 1) throw new LongRenderRefusalV1("LONG_RENDER_POLICY_INVALID", "minLongSeconds must be a positive integer", { minLongSeconds });
  let durationSeconds = Number.NaN;
  try { durationSeconds = projectDuration(project); } catch { /* the legacy path reports invalid projects itself */ }
  const base = { schema: "editkin.long-render-classification/v1" as const, durationSeconds, minLongSeconds };
  if (options?.forceClass === "long") return { ...base, class: "long", reason: "forced-long" };
  if (!Number.isFinite(durationSeconds)) return { ...base, class: "short", reason: "duration-unavailable" };
  return durationSeconds >= minLongSeconds ? { ...base, class: "long", reason: "duration-at-least-threshold" } : { ...base, class: "short", reason: "duration-below-threshold" };
}

const MIB = 1024 ** 2;

/**
 * Conservative Q007 RAM estimate of the FFmpeg single graph: every decoder input stays open for the whole render.
 * Per input: 16 decoded source surfaces (yuv420p) plus 6 working planes at the project size and 8 bytes per pixel
 * (filter chain + overlay buffers); plus a 512 MiB process base. WP-D's RSS calibration replaces these constants.
 */
export function estimateLongCompositeRamBytesV1(project: EditProject, inputs: ReadonlyArray<{ width: number; height: number }>): number {
  const projectPlane = project.width * project.height * 8;
  return Math.ceil(512 * MIB + inputs.reduce((sum, input) => sum + 16 * input.width * input.height * 1.5 + 6 * projectPlane, 0));
}

function videoAssetDimensions(project: EditProject, assetId: string): { width: number; height: number } {
  const asset = project.assets.find(candidate => candidate.id === assetId);
  return { width: asset?.width ?? project.width, height: asset?.height ?? project.height };
}

/** Facts of a LONG render: route candidates, staging and RAM estimates. Pure; no I/O. */
export function collectLongRenderFactsV1(project: EditProject, options: RenderOptions, policy: LongRenderPolicyV1): LongRenderFactsV1 {
  const plan = buildRenderPlan(project, longRenderPlanPathResolverV1(options.assetBase));
  const frameRate = frameRateRationalV1(project.fps);
  const frameCount = durationFrameCountV1(plan.duration, frameRate);
  const sceneLinear = containsSceneLinearMedia(project);
  const alphaDelivery = options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE;
  const hdr = isHdrOutput(project);
  const shape = { width: project.width, height: project.height, fps: project.fps, durationSeconds: plan.duration };
  const clips = plan.videoLayers.flatMap(layer => layer.segments).flatMap(segment => segment.kind === "clip" ? [segment.clip] : []);
  const inputs = clips.flatMap(clip => [videoAssetDimensions(project, clip.assetId),
    ...(clip.layer?.trackMatte ? [{ width: project.width, height: project.height }] : []),
    ...(clip.masks ?? []).filter(mask => mask.enabled).map(() => ({ width: project.width, height: project.height }))]);
  const fixedMaskStagingBytes = clips.reduce((sum, clip) => sum + (clip.masks ?? []).filter(mask => mask.enabled && mask.fixedWindowV3).length
    * Math.round(clip.duration * project.fps) * project.width * project.height * 2, 0);
  const nativeEffectStagingBytes = estimateNativeEffectWorkBytes(plan);
  const floatingFrames = project.tracks.flatMap(track => track.clips).filter(clip => clip.floatingFrame).map(clip => Math.round(clip.duration * project.fps));
  const nativePaint = project.motionGraphics.some(graphic => graphic.paintV1 || graphic.visualStyle === "native_paint");
  const aces2Sdr = project.colorManagement?.mode === "aces2" && project.colorManagement.outputTransform === "rec709_sdr";
  let residentCandidate = false;
  if (!sceneLinear && !alphaDelivery && !hdr && aces2Sdr) {
    if (nativePaint || floatingFrames.length) residentCandidate = true;
    else {
      const clone = structuredClone(project);
      for (const asset of clone.assets.filter(candidate => candidate.kind === "video" && !candidate.compositionId)) {
        asset.uri = resolveMediaPath(asset.uri, options.assetBase);
        if (asset.derivatives) asset.derivatives = formalExportDerivativesV1(asset.derivatives);
      }
      try { residentCandidate = Boolean(buildGpuEngineVideoPreviewGraph(clone, 0)); } catch { residentCandidate = false; }
    }
  }
  const legacyStagingEstimateBytes = residentCandidate ? estimatePngSequenceBytes(shape, "rgba8") + estimateAudioBedBytes(plan.duration)
    : sceneLinear ? estimatePngSequenceBytes(shape, hdr ? "rgba16_unorm" : "rgba8") + estimateAudioBedBytes(plan.duration)
    : nativeEffectStagingBytes + fixedMaskStagingBytes + RENDER_WORK_FIXED_BYTES;
  return {
    durationSeconds: plan.duration, frameRate, frameCount,
    audioClipCount: plan.audioClips.length,
    videoInputCount: inputs.length,
    ramEstimateBytes: estimateLongCompositeRamBytesV1(project, inputs),
    legacyStagingEstimateBytes,
    prepassStagingBytes: estimatePrepassWorkBytes(selectReferencedCompositionsForRenderV1(project)),
    nativeEffectStagingBytes,
    fixedMaskStagingBytes,
    maxFloatingFramesPerClip: floatingFrames.length ? Math.max(...floatingFrames) : 0,
    finalOutputEstimateBytes: estimateEncodedOutputBytes(shape, alphaDelivery ? "prores_ks" : hdr || (sceneLinear && hdr) ? "libx265" : "libx264"),
    sceneLinear, residentCandidate, alphaDelivery,
  };
}
