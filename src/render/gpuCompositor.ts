import { animatedClipState, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, particleSimulationEmitters } from "../domain/types";
import type { ColorAdjustments, EditProject, LayerBlendMode, MediaAsset, TimelineClip, Transform2D } from "../domain/types";
import { buildEngineRenderGraph, motionGraphicTracking, type EngineNode, type EngineRenderGraph } from "./engineGraph";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";
export * from "./gpuCompositorAdmission";
import type { GpuEnginePreviewGraph, GpuEngineVideoPreviewGraph, GpuVideoPreviewSource } from "./gpuCompositorAdmission";
import {
  applyResolvedPrecompositionMarkers, canPresentGpuVideoOnNativeSurface, commonGpuEffectsSupported,
  commonVideoAnimationSupported, commonVideoCaptionsSupported, commonVideoEffectStackSupported,
  commonVideoGradeSupported, commonVideoMotionGraphicsSupported, commonVideoParentingSupported,
  commonVideoTransformMotionBlurSupported, commonVideoTransformSupported, coveredByCommonVideoRange,
  defaultColor, enabledGpuEffectGraphs, estimateGpuEngineVideoResources, hasEnabledCpuNativeEffect,
  hasEnabledTransformMotionBlur, nativeMediaPath,
  resolveNativeVideoPrecompositions,
} from "./gpuCompositorAdmission";


export type GpuLayerSource =
  | { kind: "solid"; color: [number, number, number, number] }
  | { kind: "image"; path: string };

/** Resident video currently consumes only SDR Rec.709. Missing legacy tags keep
 * their existing compatibility, but declared unsupported metadata never becomes
 * Rec.709 merely because the interpretation selector is still `auto`. */
function nativeSdrVideoMetadataSupported(asset: MediaAsset): boolean {
  const metadata = asset.color;
  if (metadata && !["auto", "rec709"].includes(metadata.interpretation)) return false;
  const supported = (value: string | undefined, allowed: readonly string[]) => value === undefined
    || (typeof value === "string" && allowed.includes(value.trim().toLowerCase()));
  return supported(metadata?.transfer, ["bt709"])
    && supported(metadata?.primaries, ["bt709"])
    && supported(metadata?.matrix, ["bt709"])
    && supported(metadata?.range, ["tv", "pc", "limited", "full"]);
}

export interface GpuRenderLayer {
  id: string;
  source: GpuLayerSource;
  blendMode: LayerBlendMode;
  opacity: number;
  transform: { x: number; y: number; scale: number; rotation: number };
  enabled: boolean;
}

export interface GpuRenderGraph {
  schema: "hao.gpu-render-graph/v1";
  width: number;
  height: number;
  layers: GpuRenderLayer[];
}

export interface GpuLayerPropertyBuffer {
  opacity: number;
  translateX: number;
  translateY: number;
  scale: number;
  rotation: number;
  blendMode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  enabled: 0 | 1;
}

export function gpuLayerPropertyBuffer(graph: GpuRenderGraph): GpuLayerPropertyBuffer[] {
  const blendCodes: Record<LayerBlendMode, GpuLayerPropertyBuffer["blendMode"]> = {
    normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, soft_light: 5,
    hard_light: 6, difference: 7, darken: 8, lighten: 9, color_dodge: 10, color_burn: 11,
  };
  return graph.layers.map((layer) => ({
    opacity: layer.opacity,
    translateX: layer.transform.x,
    translateY: layer.transform.y,
    scale: layer.transform.scale,
    rotation: layer.transform.rotation,
    blendMode: blendCodes[layer.blendMode],
    enabled: layer.enabled ? 1 : 0,
  }));
}

export function buildGpuEnginePreviewGraph(project: EditProject, playhead: number): GpuEnginePreviewGraph | undefined {
  if (project.colorManagement?.mode === "aces2" || project.captions.length || project.motionGraphics.length || !commonGpuEffectsSupported(project)) return undefined;
  const scene25d = project.scene25d?.enabled === true;
  const particleSimulation = project.particleSimulation?.enabled === true;
  if (scene25d || particleSimulation) {
    // The product validator is the single admission authority for this deliberately bounded
    // image-only scene executor. Invalid camera/light/parenting or mixed 2D/VFX projects must
    // fall back instead of repeatedly feeding a graph that native correctly rejects.
    try { validateProject(project); } catch { return undefined; }
  }
  const clips = project.tracks.filter((track) => track.kind === "video" && !track.muted).flatMap((track) => track.clips);
  if (!clips.length) return undefined;
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const unsupported = clips.some((clip) => {
    const asset = assets.get(clip.assetId);
    return asset?.kind !== "image" || Boolean(asset.compositionId) || !nativeMediaPath(asset.uri)
      || !defaultColor(clip.color) || Boolean(clip.layout) || Boolean(clip.masks?.some((mask) => mask.enabled)) || Boolean(clip.chromaKey?.enabled)
      || Boolean(clip.keyframes.length) || Boolean(clip.expressions && Object.keys(clip.expressions).length)
      || (clip.layer?.role ?? "content") !== "content"
      || Boolean((!scene25d && clip.layer?.parentClipId) || clip.layer?.trackMatte)
      || Boolean(clip.creative?.lookPresetId || clip.creative?.transitionIn || clip.creative?.transitionOut);
  });
  if (unsupported) return undefined;
  const graph = buildEngineRenderGraph(project);
  if (graph.audio) return undefined;
  const assetBindings = Object.fromEntries(clips.map((clip) => [clip.assetId, nativeMediaPath(assets.get(clip.assetId)!.uri)!]));
  const timelineFrame = Math.max(0, Math.round(playhead * graph.timebase.denominator / graph.timebase.numerator));
  return {
    structureKey: `${graph.graphId}:${JSON.stringify(assetBindings)}`,
    graph,
    assetBindings,
    timelineFrame,
    scene25dExpectation: scene25d ? {
      planeCount: clips.length,
      parentedPlaneCount: clips.filter((clip) => Boolean(clip.layer?.parentClipId)).length,
      cameraNodeId: "scene25d:camera",
    } : undefined,
    vfxSimulationExpectation: particleSimulation ? {
      emitterCount: particleSimulationEmitters(project.particleSimulation!).length,
      particleCeiling: particleSimulationEmitters(project.particleSimulation!).reduce((sum, emitter) => sum + emitter.maxParticles, 0),
      executor: "wgpu-bounded-particle-compute/v1",
    } : undefined,
  };
}

/**
 * Selects the resource-admitted multi-source visual graph that the Windows native-video executor can preserve.
 * The returned graph remains the shared engine contract (including clip range/source offset);
 * Multiple sources preserve all twelve typed blend modes and independent static visual branches. Only the
 * independent audio graph is omitted because this hook owns visual preview only.
 */
export function buildGpuEngineVideoPreviewGraph(project: EditProject, playhead: number): GpuEngineVideoPreviewGraph | undefined {
  const sceneLinearAces2 = project.colorManagement?.mode === "aces2";
  if ((sceneLinearAces2 && (!(["rec709_sdr", "rec2100_pq_1000"] as const).includes(project.colorManagement?.outputTransform as "rec709_sdr" | "rec2100_pq_1000")
      || project.colorManagement?.configId !== "studio-config-v4.0.0_aces-v2.0_ocio-v2.5"))
    || !commonVideoCaptionsSupported(project) || !commonVideoMotionGraphicsSupported(project)) return undefined;
  const resolved = resolveNativeVideoPrecompositions(project);
  if (!resolved || (sceneLinearAces2 && resolved.markers.length > 0)) return undefined;
  const executionProject = resolved.project;
  const scene25d = executionProject.scene25d?.enabled === true;
  if (scene25d) {
    try { validateProject(executionProject); } catch { return undefined; }
  }
  for (const asset of executionProject.assets) {
    if (asset.kind !== "video") continue;
    if (!nativeSdrVideoMetadataSupported(asset)) return undefined;
    const interpretation = asset.color?.interpretation ?? "rec709";
    // `auto` is the persisted import boundary for ordinary SDR video. The resident
    // executor consumes an explicit display contract, so resolve that boundary on
    // the execution clone instead of leaking `auto` into the typed native graph.
    if (interpretation !== "rec709" && interpretation !== "auto") return undefined;
    if (interpretation === "auto") asset.color = { ...asset.color, interpretation: "rec709" };
  }
  const clips = executionProject.tracks.filter((track) => track.kind === "video" && !track.muted).flatMap((track) => track.clips);
  if (clips.length < 1) return undefined;
  const contentClips = clips.filter((clip) => (clip.layer?.role ?? "content") === "content");
  const controllerClips = clips.filter((clip) => clip.layer?.role === "controller");
  const adjustmentClips = clips.filter((clip) => clip.layer?.role === "adjustment");
  if (!contentClips.length || adjustmentClips.length > 4
    || (sceneLinearAces2 && controllerClips.length > 0)) return undefined;
  let adjustmentPhase = false;
  for (const clip of clips) {
    if (clip.layer?.role === "adjustment") adjustmentPhase = true;
    else if (clip.layer?.role === "controller") continue;
    else if (adjustmentPhase) return undefined;
  }
  const assets = new Map(executionProject.assets.map((asset) => [asset.id, asset]));
  const assetBindings: Record<string, string> = {};
  const decoderDimensions: GpuEngineVideoPreviewGraph["decoderDimensions"] = {};
  for (const clip of clips) {
    const role = clip.layer?.role ?? "content";
    const creative = clip.creative;
    const effects = creative?.effectPresetIds ?? [];
    if (role === "adjustment") {
      const gpuEffects = enabledGpuEffectGraphs(clip);
      const safeAdjustment = (clip.layer?.enabled ?? true)
        && commonVideoGradeSupported(clip.color)
        && commonVideoEffectStackSupported(effects, gpuEffects.length)
        && (!sceneLinearAces2 || !hasEnabledTransformMotionBlur(clip))
        && !clip.layout && !clip.masks?.some((mask) => mask.enabled) && !clip.chromaKey?.enabled
        && !clip.layer?.parentClipId && !clip.layer?.trackMatte
        && !clip.keyframes.length && !(clip.expressions && Object.keys(clip.expressions).length)
        && !hasEnabledCpuNativeEffect(clip)
        && !creative?.lookPresetId && !creative?.transitionIn && !creative?.transitionOut
        && [clip.timelineStart, clip.duration].every(Number.isFinite) && clip.timelineStart >= 0 && clip.duration > 0;
      if (!safeAdjustment) return undefined;
      continue;
    }
    if (role === "controller") {
      const safeController = (clip.layer?.enabled ?? true)
        && commonVideoTransformSupported(clip.transform)
        && commonVideoAnimationSupported(clip, executionProject.fps)
        && defaultColor(clip.color)
        && !clip.layout && !clip.masks?.some((mask) => mask.enabled) && !clip.chromaKey?.enabled
        && !clip.layer?.trackMatte && !creative?.lookPresetId
        && !creative?.nativeEffectInstances?.some((instance) => instance.enabled)
        && !effects.length && !creative?.transitionIn && !creative?.transitionOut;
      if (!safeController) return undefined;
      continue;
    }
    const asset = assets.get(clip.assetId);
    const originalPath = asset?.kind === "video" && !asset.compositionId ? nativeMediaPath(asset.uri) : undefined;
    const proxyPath = asset?.derivatives?.proxyUri ? nativeMediaPath(asset.derivatives.proxyUri) : undefined;
    const proxyWidth = asset?.derivatives?.proxyWidth; const proxyHeight = asset?.derivatives?.proxyHeight;
    const proxyAspectValid = Number.isSafeInteger(proxyWidth) && Number.isSafeInteger(proxyHeight) && proxyWidth! > 0 && proxyHeight! > 0
      && Math.abs(proxyWidth! / proxyHeight! - project.width / project.height) <= .002
      && proxyWidth! <= (asset?.width ?? project.width) && proxyHeight! <= (asset?.height ?? project.height);
    const transform = clip.transform;
    const maximumScale = clip.keyframes.reduce((maximum, keyframe) => Math.max(maximum, Math.abs(keyframe.transform.scale)), Math.abs(transform.scale));
    const overlayProxyPath = asset?.derivatives?.overlayProxyUri ? nativeMediaPath(asset.derivatives.overlayProxyUri) : undefined;
    const overlayProxyWidth = asset?.derivatives?.overlayProxyWidth; const overlayProxyHeight = asset?.derivatives?.overlayProxyHeight;
    const overlayProxyValid = Boolean(overlayProxyPath)
      && asset?.derivatives?.overlayProxyProfile === "editkin-small-overlay-performance/v1"
      && asset.derivatives.overlayProxyFrameRateNumerator === 15 && asset.derivatives.overlayProxyFrameRateDenominator === 1
      && Number.isSafeInteger(overlayProxyWidth) && Number.isSafeInteger(overlayProxyHeight) && overlayProxyWidth! > 0 && overlayProxyHeight! > 0
      && overlayProxyHeight! <= 216
      && Math.abs(overlayProxyWidth! / overlayProxyHeight! - project.width / project.height) <= .002
      && overlayProxyWidth! <= (asset.width ?? project.width) && overlayProxyHeight! <= (asset.height ?? project.height);
    const useOverlayProxy = contentClips.length >= 6 && contentClips.indexOf(clip) > 0 && maximumScale <= .25
      && Math.abs(executionProject.fps - 30) <= .05 && overlayProxyValid;
    const inputPath = useOverlayProxy ? overlayProxyPath : proxyPath && proxyAspectValid ? proxyPath : originalPath;
    const gpuEffects = enabledGpuEffectGraphs(clip);
    const safeVisual = commonVideoTransformSupported(transform)
      && commonVideoEffectStackSupported(effects, gpuEffects.length)
      && commonVideoGradeSupported(clip.color) && !clip.layout && !clip.masks?.some((mask) => mask.enabled) && !clip.chromaKey?.enabled
      && (clip.layer?.enabled ?? true)
      && (contentClips.indexOf(clip) > 0 || (clip.layer?.blendMode ?? "normal") === "normal")
      && commonVideoAnimationSupported(clip, executionProject.fps)
      && commonVideoTransformMotionBlurSupported(clip)
      && !hasEnabledCpuNativeEffect(clip)
      && !creative?.lookPresetId
      && !creative?.transitionIn && !creative?.transitionOut;
    if (!asset || !inputPath || asset.width !== project.width || asset.height !== project.height || !safeVisual) return undefined;
    if (assetBindings[asset.id] && assetBindings[asset.id] !== inputPath) return undefined;
    assetBindings[asset.id] = inputPath;
    decoderDimensions[asset.id] = useOverlayProxy
      ? { width: overlayProxyWidth!, height: overlayProxyHeight!, source: "overlay-proxy" }
      : proxyPath && proxyAspectValid
      ? { width: proxyWidth!, height: proxyHeight!, source: "proxy" }
      : { width: asset.width, height: asset.height, source: "original" };
  }
  for (const target of contentClips.filter((clip) => clip.layer?.trackMatte)) {
    const source = contentClips.find((clip) => clip.id === target.layer!.trackMatte!.sourceClipId);
    if (!source || source.id === target.id
      || source.timelineStart > target.timelineStart + 1e-6
      || source.timelineStart + source.duration + 1e-6 < target.timelineStart + target.duration) return undefined;
  }
  if (!commonVideoParentingSupported([...contentClips, ...controllerClips])) return undefined;
  const completeGraph = applyResolvedPrecompositionMarkers(buildEngineRenderGraph(executionProject,
    !sceneLinearAces2 && !scene25d ? { rec709PrimaryVersion: 2 } : undefined), resolved.markers);
  const graph: EngineRenderGraph = { ...completeGraph, audio: undefined };
  const particleNodes = graph.nodes.filter((node) => node.kind === "particle_emitter");
  const particleCount = particleNodes.length;
  const particleCeiling = particleNodes.reduce((sum, node) => sum + Number(node.maxParticles ?? 0), 0);
  if (particleCount > 4 || particleCeiling > 192) return undefined;
  const overlayCount = graph.nodes.filter((node) => node.kind === "particle_emitter" || node.kind === "caption" || node.kind === "motion_graphic").length;
  const matteCount = contentClips.filter((clip) => clip.layer?.trackMatte).length;
  const decodedTemporalNodes = graph.nodes.filter((node) => node.kind === "motion_blur" && node.sourceSampling === "decoded_temporal");
  if (decodedTemporalNodes.length > 1) return undefined;
  if (decodedTemporalNodes.length === 1) {
    const temporalClip = contentClips.find((clip) => decodedTemporalNodes[0].id.startsWith(`motion-blur:${clip.id}:`));
    const temporalAdjustmentCovered = temporalClip && adjustmentClips.every((adjustment) =>
      adjustment.timelineStart >= temporalClip.timelineStart - 1e-6
      && adjustment.timelineStart + adjustment.duration <= temporalClip.timelineStart + temporalClip.duration + 1e-6);
    const matteTarget = matteCount === 1 ? contentClips.find((clip) => clip.layer?.trackMatte) : undefined;
    const matteSource = matteTarget ? contentClips.find((clip) => clip.id === matteTarget.layer!.trackMatte!.sourceClipId) : undefined;
    // A decoded-temporal layer can consume a separate static matte texture in the same
    // resident RGBA16F pass. A decoded-temporal matte *source* remains fail-closed because
    // the matte binding owns one resident source texture, not an eight-frame shutter ring.
    const resourceGovernedTemporalMatte = matteCount === 1
      && contentClips.length === 2 && contentClips[0] === matteSource && contentClips[1] === matteTarget
      && temporalClip === matteTarget && temporalClip !== matteSource
      && adjustmentClips.length === 0 && project.captions.length === 0 && project.motionGraphics.length === 0;
    const legacyPackedTemporalMatteSource = !sceneLinearAces2 && matteCount === 1
      && contentClips.length === 2 && contentClips[0] === matteSource && contentClips[1] === matteTarget
      && temporalClip === matteSource && adjustmentClips.length === 0 && particleCount === 0
      && project.captions.length === 0 && project.motionGraphics.length === 0;
    const boundedMultiAdjustmentLook = adjustmentClips.length === 2
      && contentClips.length === 1 && project.captions.length + project.motionGraphics.length > 0;
    const temporalStartFrame = temporalClip ? Math.round(temporalClip.timelineStart * project.fps) : -1;
    const temporalEndFrame = temporalClip ? Math.round((temporalClip.timelineStart + temporalClip.duration) * project.fps) : -1;
    const particleTimelineCovered = particleNodes.every((node) => {
      const timeline = node.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
      return timeline && timeline.timelineStartFrame >= temporalStartFrame
        && timeline.timelineStartFrame + timeline.durationFrames <= temporalEndFrame;
    });
    const particleVideoOverlay = contentClips.length === 2 ? contentClips[1] : undefined;
    const staticParticleVideoOverlay = Boolean(particleVideoOverlay && temporalClip
      && particleVideoOverlay.timelineStart < temporalClip.timelineStart + temporalClip.duration - 1e-6
      && particleVideoOverlay.timelineStart + particleVideoOverlay.duration > temporalClip.timelineStart + 1e-6
      && !particleVideoOverlay.keyframes.length
      && !(particleVideoOverlay.expressions && Object.keys(particleVideoOverlay.expressions).length)
      && !(particleVideoOverlay.creative?.effectPresetIds.length)
      && !particleVideoOverlay.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
      && !particleVideoOverlay.layer?.trackMatte
      && (particleVideoOverlay.layer?.blendMode ?? "normal") === "normal");
    const animatedParticleVideoOverlay = Boolean(particleVideoOverlay && temporalClip
      && particleVideoOverlay.timelineStart < temporalClip.timelineStart + temporalClip.duration - 1e-6
      && particleVideoOverlay.timelineStart + particleVideoOverlay.duration > temporalClip.timelineStart + 1e-6
      && particleVideoOverlay.keyframes.length >= 1
      && particleVideoOverlay.keyframes.length <= 2
      && !(particleVideoOverlay.expressions && Object.keys(particleVideoOverlay.expressions).length)
      && !(particleVideoOverlay.creative?.effectPresetIds.length)
      && !particleVideoOverlay.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
      && !particleVideoOverlay.layer?.trackMatte
      && (particleVideoOverlay.layer?.blendMode ?? "normal") === "normal");
    const resourceGovernedParticleLook = particleCount >= 1 && particleCount <= 4
      && (contentClips.length === 1
        || (contentClips.length === 2 && (staticParticleVideoOverlay || animatedParticleVideoOverlay))
        || resourceGovernedTemporalMatte)
      && adjustmentClips.length <= 2
      && (matteCount === 0 || resourceGovernedTemporalMatte)
      && temporalAdjustmentCovered && particleTimelineCovered;
    if (!temporalClip || (temporalClip !== contentClips[0] && !resourceGovernedTemporalMatte) || contentClips.length > 3
      || (particleCount !== 0 && !resourceGovernedParticleLook)
      || (matteCount === 0 && (adjustmentClips.length > 2 || !temporalAdjustmentCovered || (adjustmentClips.length === 2 && !boundedMultiAdjustmentLook && !resourceGovernedParticleLook)))
      || (matteCount > 0 && !resourceGovernedTemporalMatte && !legacyPackedTemporalMatteSource)) return undefined;
  }
  const temporalSampleCount = decodedTemporalNodes.length ? Number(decodedTemporalNodes[0].samples) : 0;
  const resources = estimateGpuEngineVideoResources(graph.width, graph.height, graph.cacheBudgetMb, contentClips.length, overlayCount, adjustmentClips.length, matteCount, particleCount, temporalSampleCount, sceneLinearAces2 ? 8 : 4);
  if (!resources || resources.requiredBytes > resources.budgetBytes || contentClips.length > resources.maxVideoLayers) return undefined;
  const timelineFrame = Math.max(0, Math.round(playhead * graph.timebase.denominator / graph.timebase.numerator));
  return {
    structureKey: `${graph.graphId}:${JSON.stringify(assetBindings)}`,
    graph,
    assetBindings,
    decoderDimensions,
    timelineFrame,
    scene25dExpectation: scene25d ? {
      planeCount: contentClips.length,
      videoPlaneCount: contentClips.length,
      parentedPlaneCount: contentClips.filter((clip) => Boolean(clip.layer?.parentClipId)).length,
      cameraNodeId: "scene25d:camera",
    } : undefined,
    vfxSimulationExpectation: particleCount > 0
      ? { emitterCount: particleCount, particleCeiling, executor: "wgpu-resident-video-particle-overlay/v1" }
      : undefined,
  };
}

export function buildGpuRenderGraph(project: EditProject, playhead: number): GpuRenderGraph | undefined {
  // The packed RGBA8 compositor does not yet execute the generated OCIO stages. Routing an
  // ACES project through it would silently display unmanaged pixels, so use the WebGL2 OCIO
  // preview until the native float compositor owns the same processor contract.
  if (project.colorManagement?.mode === "aces2") return undefined;
  const clips = project.tracks
    .filter((track) => track.kind === "video" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => (clip.layer?.enabled ?? true) && (clip.layer?.role ?? "content") === "content" && playhead >= clip.timelineStart && playhead < clip.timelineStart + clip.duration);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  if (!clips.length || clips.some((clip) => {
    const asset = assets.get(clip.assetId);
    const state = animatedClipState(clip, playhead - clip.timelineStart, project.fps);
    return asset?.kind !== "image" || !nativeMediaPath(asset.uri) || !defaultColor(state.color) || Boolean(clip.layout) || Boolean(clip.masks?.some((mask) => mask.enabled)) || Boolean(clip.chromaKey?.enabled)
      || Boolean(clip.creative?.lookPresetId || clip.creative?.effectPresetIds.length || clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled) || clip.creative?.transitionIn || clip.creative?.transitionOut);
  })) return undefined;
  const layers: GpuRenderLayer[] = [{
    id: "editkin-background", source: { kind: "solid", color: [0, 0, 0, 255] }, blendMode: "normal", opacity: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }, enabled: true,
  }];
  for (const clip of clips) {
    const asset = assets.get(clip.assetId)!;
    const state = animatedClipState(clip, playhead - clip.timelineStart, project.fps);
    layers.push({
      id: clip.id,
      source: { kind: "image", path: nativeMediaPath(asset.uri)! },
      blendMode: clip.layer?.blendMode ?? "normal",
      opacity: state.transform.opacity,
      transform: { x: state.transform.x, y: state.transform.y, scale: state.transform.scale, rotation: state.transform.rotation * Math.PI / 180 },
      enabled: clip.layer?.enabled ?? true,
    });
  }
  return { schema: "hao.gpu-render-graph/v1", width: project.width, height: project.height, layers };
}

/**
 * Selects the deliberately narrow subset that the resident hardware-video path can display
 * without lying about visual parity. Effects, masks, transforms and multi-layer composition
 * continue through the compatible preview until the native graph consumes video textures.
 */
export function buildGpuVideoPreviewSource(project: EditProject, playhead: number): GpuVideoPreviewSource | undefined {
  if (project.colorManagement?.mode === "aces2") return undefined;
  const activeClips = project.tracks
    .filter((track) => track.kind === "video" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => (clip.layer?.enabled ?? true) && playhead >= clip.timelineStart && playhead < clip.timelineStart + clip.duration);
  if (activeClips.length !== 1) return undefined;
  const clip = activeClips[0];
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const state = animatedClipState(clip, playhead - clip.timelineStart, project.fps);
  const creative = clip.creative;
  const visuallyUnmodified = state.transform.x === 0 && state.transform.y === 0
    && state.transform.scale === 1 && state.transform.rotation === 0 && state.transform.opacity === 1
    && defaultColor(state.color) && !clip.layout && !clip.masks?.some((mask) => mask.enabled) && !clip.chromaKey?.enabled
    && (clip.layer?.blendMode ?? "normal") === "normal" && (clip.layer?.role ?? "content") === "content"
    && !clip.layer?.parentClipId && !clip.layer?.trackMatte
    && !creative?.lookPresetId && !(creative?.effectPresetIds.length)
    && !creative?.nativeEffectInstances?.some((instance) => instance.enabled)
    && !creative?.transitionIn && !creative?.transitionOut;
  const inputPath = asset?.kind === "video" && !asset.compositionId ? nativeMediaPath(asset.uri) : undefined;
  if (!asset || !inputPath || !nativeSdrVideoMetadataSupported(asset) || asset.width !== project.width || asset.height !== project.height || !visuallyUnmodified) return undefined;
  return {
    structureKey: `${clip.id}:${inputPath}`,
    inputPath,
    sourceTime: clip.sourceStart + Math.max(0, playhead - clip.timelineStart),
  };
}
