import type { EditComposition, EditProject, TimelineClip } from "../domain/types";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { resolveInputColorSpace } from "../color/primaryGrade";
import { selectReferencedCompositionsForRenderV1 } from "./referencedCompositionPrepassV1";
import { HIGH_BIT_DEPTH_ALPHA_PROFILE } from "./ffmpegContracts";
import { resolveMediaPath } from "./ffmpegMedia";
import { usesOpaqueAces16V1 } from "./acesOpaque16V1";
import { animatedPrimaryFieldsV1, primaryAnimatedFieldLabelsV1, primaryAnimationExceedsLimitV1, primaryAnimationPlanV1 } from "./animatedPrimaryColorV1";
import { MASK_TIMELINE_SAMPLE_LIMIT } from "./maskFilters";
import { scene25dExportPlanV1 } from "./scene25dNativeExportV1";
import { ExportFeatureRefusalErrorV1, exportRefusalClipLabelV1 } from "./exportFeatureRefusalV1";
import type { RenderOptions } from "./ffmpegTypes";

/**
 * Legacy effect IDs whose export must refuse because preview and export disagree (AREA_B L2). Empty on purpose:
 * scanline_focus exports a sharpen, which is what every saved and published project (23 of the 125, plus the gaming
 * profile and three short-form templates) has always delivered, so the export is the reference and the preview is the
 * side to fix (Claude, 2026-10-23). Keep the mechanism for an effect whose export is the wrong side.
 */
export const LEGACY_PREVIEW_MISMATCH_EFFECT_IDS_V1: ReadonlySet<string> = new Set<string>([]);

interface ClipOwner { tracks: EditProject["tracks"]; colorManagement?: EditProject["colorManagement"]; fps: number; nested: boolean }

function renderedVisualClips(owner: ClipOwner): TimelineClip[] {
  return owner.tracks.filter(track => track.kind === "video" && !track.hidden).flatMap(track => track.clips)
    .filter(clip => clip.layer?.enabled !== false);
}

function maskSampleCount(project: EditProject, clip: TimelineClip, mask: NonNullable<TimelineClip["masks"]>[number]): number {
  if (mask.fixedWindowV3 || mask.matteSequence) return 0;
  if (mask.trackId) return project.motionTracks.find(track => track.id === mask.trackId && track.clipId === clip.id)?.points.length ?? 0;
  return mask.keyframes.length;
}

function assertClipRenderable(project: EditProject, owner: ClipOwner, clip: TimelineClip, options: RenderOptions): void {
  const label = exportRefusalClipLabelV1(project.assets, clip);
  for (const id of clip.creative?.effectPresetIds ?? []) {
    if (LEGACY_PREVIEW_MISMATCH_EFFECT_IDS_V1.has(id)) throw new ExportFeatureRefusalErrorV1("legacyScanlineFocus", "legacyScanlineFocus", { clip: label }, clip.id);
  }
  const fields = animatedPrimaryFieldsV1(clip);
  if (fields.length) {
    if ((clip.layer?.role ?? "content") === "adjustment") {
      throw new ExportFeatureRefusalErrorV1("colorKeyframes", "colorKeyframesAdjustment", { clip: label, fields: primaryAnimatedFieldLabelsV1(fields) }, clip.id);
    }
    const asset = project.assets.find(candidate => candidate.id === clip.assetId);
    const management = owner.colorManagement ?? DEFAULT_COLOR_MANAGEMENT;
    let hdr = false;
    try { hdr = Boolean(asset) && management.mode !== "aces2" && ["hlg", "pq"].includes(resolveInputColorSpace(asset!)); } catch { hdr = false; }
    // Rec.709 HDR sources apply a static exposure inside their tone mapping (sourceColorFilters).
    if (hdr && fields.includes("exposure")) throw new ExportFeatureRefusalErrorV1("colorKeyframes", "colorKeyframesHdrExposure", { clip: label }, clip.id);
    const plan = primaryAnimationPlanV1(clip, owner.fps, Math.max(1, Math.round(clip.duration * owner.fps)));
    const highBitDepth = owner.nested || usesOpaqueAces16V1(management) || options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE;
    const over = plan && primaryAnimationExceedsLimitV1(plan, highBitDepth);
    if (over) throw new ExportFeatureRefusalErrorV1("colorKeyframes", "colorKeyframesTooLong", { clip: label, fields: primaryAnimatedFieldLabelsV1(fields), frames: over.frames, limit: over.limit }, clip.id);
  }
  for (const mask of clip.masks ?? []) {
    if (!mask.enabled) continue;
    const samples = maskSampleCount(project, clip, mask);
    if (samples > MASK_TIMELINE_SAMPLE_LIMIT) {
      throw new ExportFeatureRefusalErrorV1("trackedMask", "trackedMaskTooLong", { clip: label, mask: mask.name || mask.id, samples, limit: MASK_TIMELINE_SAMPLE_LIMIT }, clip.id);
    }
  }
}

function nestedSceneRefusal(composition: EditComposition, feature: string): ExportFeatureRefusalErrorV1 {
  return new ExportFeatureRefusalErrorV1("nestedScene", "nestedScene", { composition: composition.name || composition.id, feature });
}

/**
 * Export preflight: refuses, before any render work, every feature the selected route would silently drop or render
 * differently from the preview (AREA_B §4 #1): 2.5D and particles without a native route, keyframed primary colour
 * the export cannot animate, legacy effects whose preview disagrees with the export, and over-long mask timelines.
 * Projects that use none of them pass untouched.
 */
export function assertExportFeaturesRenderableV1(project: EditProject, options: RenderOptions = {}): void {
  const referenced = selectReferencedCompositionsForRenderV1(project).compositions;
  for (const composition of referenced) {
    if (composition.scene25d?.enabled) throw nestedSceneRefusal(composition, "2.5D 立體場景");
    if (composition.particleSimulation?.enabled) throw nestedSceneRefusal(composition, "粒子特效");
  }
  // A mesh scene replaces the visual tracks with its own render (mesh3dRender); its validation refuses 2.5D/particles.
  if (project.scene3d?.enabled) return;
  const plan = scene25dExportPlanV1(project, {
    gpuCompositorPath: options.gpuCompositorPath,
    resolveUri: uri => resolveMediaPath(uri, options.assetBase),
    alphaIntermediate: options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE,
  });
  if (plan.kind === "refuse") throw plan.error;
  const owners: ClipOwner[] = [
    { tracks: project.tracks, colorManagement: project.colorManagement, fps: project.fps, nested: false },
    ...referenced.map(composition => ({ tracks: composition.tracks, colorManagement: composition.colorManagement ?? project.colorManagement, fps: composition.fps, nested: true })),
  ];
  for (const owner of owners) for (const clip of renderedVisualClips(owner)) assertClipRenderable(project, owner, clip, options);
}
