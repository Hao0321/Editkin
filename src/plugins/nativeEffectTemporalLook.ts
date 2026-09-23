import { join } from "node:path";
import {
  DEFAULT_COLOR,
  DEFAULT_TRANSFORM,
  type EditProject,
  type NativeEffectInstance,
  type ParticleEmitterSettings,
  type TimelineClip,
} from "../domain/types";
import { transformMotionBlurParameters } from "../domain/transformMotionBlur";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type { RenderPlan, RenderSegment } from "../render/planner";
import { resolveGpuEffectGraphBindings } from "./registry";
import {
  encodePngSequenceIntermediate,
  renderGpuEffectSequence,
  sha256File,
  type GpuAdjustmentExecution,
  type GpuParticleExecution,
} from "./nativeEffectGpuSequence";
import { replaceRenderSegmentRangeWithGap, safeId } from "./nativeEffectMaterializationSupport";
import type { NativeEffectRenderReceipt, NativeEffectRenderRuntime } from "./nativeEffectTypes";

type ClipSegment = Extract<RenderSegment, { kind: "clip" }>;
interface TemporalAdjustment {
  clip: TimelineClip;
  segment: ClipSegment;
  startFrame: number;
  durationFrames: number;
  aligned: boolean;
}
interface TemporalParticle {
  emitter: ParticleEmitterSettings;
  nodeId: string;
  timelineStartFrame: number;
  durationFrames: number;
  aligned: boolean;
}
export interface TemporalMaterializationContext {
  project: EditProject;
  plan: RenderPlan;
  runtime: NativeEffectRenderRuntime;
  allVideoSegments: ClipSegment[];
  formalContentClips: TimelineClip[];
  formalAdjustmentClips: TimelineClip[];
  segment: ClipSegment;
  clip: TimelineClip;
  enabledInstances: NativeEffectInstance[];
  motionBlurInstances: NativeEffectInstance[];
  frameCount: number;
  prefix: string;
  overlayClips: TimelineClip[];
  temporalClipEnd: number;
  typographyWithinTemporalClip: boolean;
  temporalLookAdjustments: TemporalAdjustment[];
  temporalLookAdjustmentSetValid: boolean;
  temporalLookParticleEmitters: ParticleEmitterSettings[];
  temporalLookParticles: TemporalParticle[];
  temporalLookParticleSetValid: boolean;
  receipts: NativeEffectRenderReceipt["clips"];
}

export async function materializeConvergedTemporalLook(context: TemporalMaterializationContext): Promise<boolean> {
  const {
    project, plan, runtime, allVideoSegments, formalContentClips, formalAdjustmentClips,
    segment, clip, enabledInstances, motionBlurInstances, frameCount, prefix, overlayClips,
    temporalClipEnd, typographyWithinTemporalClip, temporalLookAdjustments,
    temporalLookAdjustmentSetValid, temporalLookParticleEmitters, temporalLookParticles,
    temporalLookParticleSetValid, receipts,
  } = context;
  const matteTargetClip = formalContentClips.length === 2
    && formalContentClips[0].id === clip.id
    && formalContentClips[1].layer?.trackMatte?.sourceClipId === clip.id
    ? formalContentClips[1] : undefined;
  const matteTargetSegment = matteTargetClip ? allVideoSegments.find((candidate) => candidate.clip.id === matteTargetClip.id) : undefined;
  const matteTargetStartFrame = matteTargetClip ? Math.round(matteTargetClip.timelineStart * project.fps) : 0;
  const matteTargetDurationFrames = matteTargetClip ? Math.round(matteTargetClip.duration * project.fps) : 0;
  const matteTargetFrameAligned = Boolean(matteTargetClip)
    && Math.abs(matteTargetStartFrame / project.fps - matteTargetClip!.timelineStart) <= 1e-6
    && Math.abs(matteTargetDurationFrames / project.fps - matteTargetClip!.duration) <= 1e-6;
  const convergedTemporalMatte = runtime.targetClipIds === undefined
    && enabledInstances.length === 1 && motionBlurInstances.length === 1
    && formalAdjustmentClips.length === 0
    && Boolean(matteTargetClip && matteTargetSegment && matteTargetFrameAligned)
    && matteTargetClip!.timelineStart >= clip.timelineStart - 1e-6
    && matteTargetClip!.timelineStart + matteTargetClip!.duration <= temporalClipEnd + 1e-6
    && project.captions.length === 0 && project.motionGraphics.length === 0
    && !(matteTargetClip!.creative?.effectPresetIds.length)
    && !matteTargetClip!.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
    && !matteTargetClip!.keyframes.length
    && !(matteTargetClip!.expressions && Object.keys(matteTargetClip!.expressions).length)
    ? buildGpuEngineVideoPreviewGraph(project, clip.timelineStart)
    : undefined;
  if (convergedTemporalMatte) {
    const timelineStartFrame = Math.round(clip.timelineStart * project.fps);
    if (Math.abs(timelineStartFrame / project.fps - clip.timelineStart) > 1e-6) throw new Error(`GPU temporal matte 起點未對齊專案 frame grid：${clip.id}`);
    const graph = convergedTemporalMatte.graph as unknown as Record<string, unknown>;
    const sourceNodeId = `source:${safeId(clip.id)}`;
    const targetNodeId = `source:${safeId(matteTargetClip!.id)}`;
    const mode = matteTargetClip!.layer!.trackMatte!.mode;
    const graphMatte = (graph.nodes as Array<Record<string, unknown>>).find((node) => node.kind === "composite" && node.matteMode === mode);
    if (typeof graphMatte?.matteInput !== "string") throw new Error(`GPU temporal matte graph 缺少 typed matte input：${matteTargetClip!.id}`);
    const effectBindings = await resolveGpuEffectGraphBindings(graph, runtime.pluginRoots);
    const assetBindings = Object.fromEntries(formalContentClips.map((candidate) => {
      const planned = allVideoSegments.find((item) => item.clip.id === candidate.id);
      if (!planned) throw new Error(`GPU temporal matte 缺少 RenderPlan 片段：${candidate.id}`);
      return [candidate.assetId, planned.assetPath];
    }));
    const frameDirectory = join(runtime.workspace, `${prefix}-gpu-temporal-matte-frames`);
    const gpu = await renderGpuEffectSequence(
      graph, assetBindings, effectBindings, Object.keys(effectBindings.bindings).length,
      frameCount, frameDirectory, runtime, { timelineStartFrame, matte: {
        sourceClipId: clip.id, targetClipId: matteTargetClip!.id, sourceNodeId, targetNodeId, mode,
        targetTimelineStartFrame: matteTargetStartFrame, targetDurationFrames: matteTargetDurationFrames,
      } },
    );
    if (!gpu.temporalSampling || gpu.temporalSampling.framesWithReceipt !== frameCount
      || !gpu.matte || gpu.matte.framesWithActiveMatteTargets !== matteTargetDurationFrames
      || gpu.matte.targetClipIds.length !== 1 || gpu.matte.targetClipIds[0] !== matteTargetClip!.id) {
      throw new Error(`GPU temporal matte 沒有完整 temporal／matte receipt：${clip.id}`);
    }
    const intermediate = join(runtime.workspace, `${prefix}-gpu-temporal-matte.mkv`);
    await encodePngSequenceIntermediate(join(frameDirectory, "frame-%08d.png"), intermediate, project, frameCount, runtime);
    segment.assetPath = intermediate;
    segment.clip = { ...structuredClone(clip), sourceStart: 0, transform: { ...DEFAULT_TRANSFORM }, keyframes: [], color: { ...DEFAULT_COLOR }, creative: { ...structuredClone(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: [], nativeEffectInstances: [] } };
    const targetLayer = plan.videoLayers.find((layer) => layer.segments.includes(matteTargetSegment!));
    const targetIndex = targetLayer?.segments.indexOf(matteTargetSegment!);
    if (!targetLayer || targetIndex === undefined || targetIndex < 0) throw new Error(`GPU temporal matte 無法封存 target RenderPlan 片段：${matteTargetClip!.id}`);
    targetLayer.segments.splice(targetIndex, 1, { kind: "gap", start: matteTargetSegment!.start, duration: matteTargetSegment!.duration });
    receipts.push({
      clipId: clip.id, frameCount, width: project.width, height: project.height,
      intermediateSha256: await sha256File(intermediate), executionMode: "resident-gpu-shader-sequence/v1",
      gpu: { ...gpu, frameCount, productPathCpuPixelCopies: 0, verificationReadback: true },
      instances: enabledInstances.map((instance) => ({
        instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
        pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
        worker: { runtime: "decoded-temporal-shutter-accumulation/v1", ...transformMotionBlurParameters(instance), matteContract: "decoded-temporal-track-matte/v1", matteSourceClipId: clip.id, matteTargetClipId: matteTargetClip!.id, matteMode: mode, productPathCpuPixelCopies: 0 },
      })),
    });
    return true;
  }
  const temporalLookOverlays = overlayClips.map((candidate) => {
    const candidateSegment = allVideoSegments.find((item) => item.clip.id === candidate.id);
    const frameTimes = [clip.timelineStart, clip.timelineStart + clip.duration, candidate.timelineStart, candidate.timelineStart + candidate.duration]
      .map((time) => ({ time, frame: Math.round(time * project.fps) }));
    const aligned = frameTimes.every(({ time, frame }) => Math.abs(frame / project.fps - time) <= 1e-6);
    const range = aligned ? { startFrame: Math.max(frameTimes[0].frame, frameTimes[2].frame), endFrame: Math.min(frameTimes[1].frame, frameTimes[3].frame) } : undefined;
    const structurallySafe = Boolean(candidateSegment && range && range.endFrame > range.startFrame
      && !(candidate.creative?.effectPresetIds.length)
      && !candidate.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
      && !(candidate.expressions && Object.keys(candidate.expressions).length)
      && !candidate.layer?.trackMatte
      && (candidate.layer?.blendMode ?? "normal") === "normal"
      && candidate.layer?.enabled !== false);
    const fullyMaterialized = Boolean(structurallySafe
      && Math.abs(candidate.timelineStart - clip.timelineStart) <= 1e-6
      && Math.abs(candidate.duration - clip.duration) <= 1e-6
      && range!.startFrame === Math.round(clip.timelineStart * project.fps)
      && range!.endFrame === Math.round(temporalClipEnd * project.fps));
    const animationSafe = candidate.keyframes.length === 0 || Boolean(
      temporalLookParticles.length > 0 && overlayClips.length === 1
      && formalAdjustmentClips.length <= 2
      && candidate.keyframes.length >= 1 && candidate.keyframes.length <= 2,
    );
    const safe = structurallySafe && animationSafe;
    return safe ? { clip: candidate, segment: candidateSegment!, range: range!, fullyMaterialized, animated: candidate.keyframes.length > 0 } : undefined;
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  const temporalLookOverlaySetValid = temporalLookOverlays.length === overlayClips.length
    && (overlayClips.length <= 1 || temporalLookOverlays.every((candidate) => candidate.fullyMaterialized));
  const temporalTimelineStartFrame = Math.round(clip.timelineStart * project.fps);
  const activeTemporalLookAdjustmentFrames = Array.from({ length: frameCount }, (_, frame) => {
    const absoluteFrame = temporalTimelineStartFrame + frame;
    const activeCount = temporalLookAdjustments.filter((candidate) => absoluteFrame >= candidate.startFrame
      && absoluteFrame < candidate.startFrame + candidate.durationFrames).length;
    return { absoluteFrame, activeCount };
  }).filter((frame) => frame.activeCount > 0);
  const adjustmentBaseLayerCounts = activeTemporalLookAdjustmentFrames.map(({ absoluteFrame }) =>
    1
    + temporalLookOverlays.filter((candidate) => absoluteFrame >= candidate.range.startFrame && absoluteFrame < candidate.range.endFrame).length
    + temporalLookParticles.filter((particle) => absoluteFrame >= particle.timelineStartFrame
      && absoluteFrame < particle.timelineStartFrame + particle.durationFrames).length);
  const adjustmentMinimumBaseLayerCount = adjustmentBaseLayerCounts.length ? Math.min(...adjustmentBaseLayerCounts) : 1;
  const adjustmentMaximumBaseLayerCount = adjustmentBaseLayerCounts.length ? Math.max(...adjustmentBaseLayerCounts) : 1;
  const adjustmentMinimumActiveCount = activeTemporalLookAdjustmentFrames.length ? Math.min(...activeTemporalLookAdjustmentFrames.map((frame) => frame.activeCount)) : 0;
  const adjustmentMaximumActiveCount = activeTemporalLookAdjustmentFrames.length ? Math.max(...activeTemporalLookAdjustmentFrames.map((frame) => frame.activeCount)) : 0;
  const temporalLookAdjustmentFrameCount = activeTemporalLookAdjustmentFrames.length;
  const temporalLookAdjustmentPassCount = temporalLookAdjustments.reduce((sum, candidate) => sum + candidate.durationFrames, 0);
  const temporalLookCompositeFrameCount = Array.from({ length: frameCount }, (_, frame) => {
    const absoluteFrame = Math.round(clip.timelineStart * project.fps) + frame;
    return temporalLookOverlays.some((candidate) => absoluteFrame >= candidate.range.startFrame && absoluteFrame < candidate.range.endFrame);
  }).filter(Boolean).length;
  const typographyPresent = project.captions.length + project.motionGraphics.length > 0;
  const resourceGovernedParticleLook = temporalLookParticles.length >= 1 && temporalLookParticles.length <= 4
    && (formalContentClips.length === 1
      || (formalContentClips.length === 2 && temporalLookOverlays.length === 1 && temporalLookOverlaySetValid))
    && temporalLookAdjustments.length <= 2;
  const legacyTemporalLook = temporalLookParticleEmitters.length === 0
    && temporalLookAdjustments.length >= 1 && temporalLookAdjustments.length <= 2
    && typographyPresent
    && (formalContentClips.length === 1 || (overlayClips.length >= 1 && overlayClips.length <= 2 && temporalLookOverlaySetValid))
    && (temporalLookAdjustments.length === 1 || formalContentClips.length === 1);
  const convergedTemporalLook = runtime.targetClipIds === undefined
    && enabledInstances.length === 1 && motionBlurInstances.length === 1
    && formalContentClips[0]?.id === clip.id
    && temporalLookAdjustmentSetValid
    && temporalLookParticleSetValid
    && (resourceGovernedParticleLook || legacyTemporalLook)
    && typographyWithinTemporalClip
    ? buildGpuEngineVideoPreviewGraph(project, clip.timelineStart)
    : undefined;
  if (convergedTemporalLook) {
    const timelineStartFrame = Math.round(clip.timelineStart * project.fps);
    if (Math.abs(timelineStartFrame / project.fps - clip.timelineStart) > 1e-6) throw new Error(`GPU temporal look 起點未對齊專案 frame grid：${clip.id}`);
    const graph = convergedTemporalLook.graph as unknown as Record<string, unknown>;
    const graphNodes = graph.nodes as Array<Record<string, unknown>>;
    const overlayAnimations = temporalLookOverlays.filter((candidate) => candidate.animated).map((candidate) => {
      const transformNodeId = `transform:${safeId(candidate.clip.id)}`;
      const graphTransform = graphNodes.find((node) => node.id === transformNodeId && node.kind === "transform2d");
      const expectedKeyframes = candidate.clip.keyframes.map((keyframe) => ({
        frame: Math.round(keyframe.time * project.fps), x: keyframe.transform.x, y: keyframe.transform.y,
        scaleX: keyframe.transform.scale, scaleY: keyframe.transform.scale,
        rotationRadians: keyframe.transform.rotation * Math.PI / 180,
        opacity: keyframe.transform.opacity, easing: keyframe.easing,
      }));
      if (JSON.stringify(graphTransform?.keyframes) !== JSON.stringify(expectedKeyframes)) {
        throw new Error(`GPU temporal look overlay animation graph 與專案不一致：${candidate.clip.id}`);
      }
      return { clipId: candidate.clip.id, transformNodeId, keyframeCount: expectedKeyframes.length };
    });
    const adjustmentContract = temporalLookAdjustments.length === 2
      ? "decoded-temporal-pre-typography-multi-adjustment/v1" as const
      : typographyPresent
        ? "decoded-temporal-pre-typography-adjustment/v1" as const
        : "decoded-temporal-trailing-adjustment/v1" as const;
    const adjustmentExecutionMode = typographyPresent ? "pre-typography-full-frame/v1" as const : "trailing-full-frame/v1" as const;
    const adjustmentExecutions: GpuAdjustmentExecution[] = temporalLookAdjustments.map((candidate) => {
      const adjustmentNodeId = `adjustment:${safeId(candidate.clip.id)}`;
      const graphAdjustment = graphNodes.find((node) => node.id === adjustmentNodeId && node.kind === "adjustment");
      const graphAdjustmentTimeline = graphAdjustment?.timeline as Record<string, unknown> | undefined;
      if (graphAdjustmentTimeline?.timelineStartFrame !== candidate.startFrame || graphAdjustmentTimeline.durationFrames !== candidate.durationFrames) {
        throw new Error(`GPU temporal look adjustment timeline 與專案不一致：${candidate.clip.id}`);
      }
      return {
        clipId: candidate.clip.id, adjustmentNodeId, timelineStartFrame: candidate.startFrame, durationFrames: candidate.durationFrames,
        contract: adjustmentContract, executionMode: adjustmentExecutionMode, baseLayerCount: adjustmentMaximumBaseLayerCount,
        baseLayerCountByCompositeActivity: temporalLookOverlays.length > 0 || temporalLookParticles.length > 0,
      };
    });
    const particleExecutions = temporalLookParticles.map((particle) => {
      const graphParticle = graphNodes.find((node) => node.id === particle.nodeId && node.kind === "particle_emitter");
      const graphTimeline = graphParticle?.timeline as Record<string, unknown> | undefined;
      if (graphTimeline?.timelineStartFrame !== particle.timelineStartFrame
        || graphTimeline.sourceStartFrame !== 0
        || graphTimeline.durationFrames !== particle.durationFrames
        || graphParticle?.seed !== particle.emitter.seed
        || graphParticle.maxParticles !== particle.emitter.maxParticles) {
        throw new Error(`GPU temporal look particle graph 與專案不一致：${particle.nodeId}`);
      }
      return {
        nodeId: particle.nodeId,
        timelineStartFrame: particle.timelineStartFrame,
        durationFrames: particle.durationFrames,
        particleCeiling: particle.emitter.maxParticles,
        seed: particle.emitter.seed,
      } satisfies GpuParticleExecution;
    });
    const typography = {
      captionCueIds: project.captions.map((cue) => cue.id),
      motionGraphicIds: project.motionGraphics.map((graphic) => graphic.id),
    };
    const graphCaptionIds = graphNodes.filter((node) => node.kind === "caption").map((node) => String(node.cueId));
    const graphMotionGraphicIds = graphNodes.filter((node) => node.kind === "motion_graphic").map((node) => String(node.graphicId));
    if (graphCaptionIds.join() !== typography.captionCueIds.join() || graphMotionGraphicIds.join() !== typography.motionGraphicIds.join()) {
      throw new Error(`GPU temporal look typography graph 與專案不一致：${clip.id}`);
    }
    const effectBindings = await resolveGpuEffectGraphBindings(graph, runtime.pluginRoots);
    const assetBindings = Object.fromEntries(formalContentClips.map((candidate) => {
      const planned = allVideoSegments.find((item) => item.clip.id === candidate.id);
      if (!planned) throw new Error(`GPU temporal look 缺少 RenderPlan 片段：${candidate.id}`);
      return [candidate.assetId, planned.assetPath];
    }));
    const frameDirectory = join(runtime.workspace, `${prefix}-gpu-temporal-look-frames`);
    const gpu = await renderGpuEffectSequence(
      graph, assetBindings, effectBindings, Object.keys(effectBindings.bindings).length,
      frameCount, frameDirectory, runtime, {
        timelineStartFrame,
        compositeTimelineRanges: temporalLookOverlays.map((candidate) => ({
          ...candidate.range, overlayClipId: candidate.clip.id, suppressOverlayClipInProject: candidate.fullyMaterialized,
        })),
        ...(typographyPresent ? { typography } : {}),
        ...(adjustmentExecutions.length ? { adjustments: adjustmentExecutions } : {}),
        particles: particleExecutions,
      },
    );
    const typographyReceiptValid = typographyPresent
      ? Boolean(gpu.typography && gpu.typography.captionCueIds.join() === typography.captionCueIds.join()
        && gpu.typography.motionGraphicIds.join() === typography.motionGraphicIds.join())
      : gpu.typography === undefined;
    const adjustmentReceiptValid = adjustmentExecutions.length
      ? Boolean(gpu.adjustment
        && gpu.adjustment.framesWithActiveAdjustments === temporalLookAdjustmentFrameCount
        && gpu.adjustment.totalAdjustmentPasses === temporalLookAdjustmentPassCount
        && gpu.adjustment.minimumActiveAdjustmentCount === adjustmentMinimumActiveCount
        && gpu.adjustment.maximumActiveAdjustmentCount === adjustmentMaximumActiveCount
        && gpu.adjustment.contract === adjustmentContract
        && gpu.adjustment.executionMode === adjustmentExecutionMode
        && gpu.adjustment.maximumBaseLayerCount === adjustmentMaximumBaseLayerCount
        && gpu.adjustment.minimumBaseLayerCount === adjustmentMinimumBaseLayerCount
        && gpu.adjustment.adjustmentClipIds.join() === temporalLookAdjustments.map((candidate) => candidate.clip.id).join())
      : gpu.adjustment === undefined;
    if (!gpu.temporalSampling || gpu.temporalSampling.framesWithReceipt !== frameCount
      || !typographyReceiptValid || !adjustmentReceiptValid
      || (particleExecutions.length ? (!gpu.particle
        || gpu.particle.contract !== (particleExecutions.length === 1 ? "decoded-temporal-particle-overlay/v1" : "decoded-temporal-multi-particle-overlay/v1")
        || gpu.particle.simulationContract !== "screen_space_analytic_particles/v1"
        || gpu.particle.emitterNodeIds.join() !== particleExecutions.map((particle) => particle.nodeId).join()
        || gpu.particle.timelineRanges.length !== particleExecutions.length
        || particleExecutions.some((particle, index) => gpu.particle!.timelineRanges[index]?.nodeId !== particle.nodeId
          || gpu.particle!.timelineRanges[index]?.timelineStartFrame !== particle.timelineStartFrame
          || gpu.particle!.timelineRanges[index]?.durationFrames !== particle.durationFrames)
        || gpu.particle.framesWithActiveParticles !== Array.from({ length: frameCount }, (_, frame) => timelineStartFrame + frame)
          .filter((frame) => particleExecutions.some((particle) => frame >= particle.timelineStartFrame && frame < particle.timelineStartFrame + particle.durationFrames)).length
        || gpu.particle.totalParticleEmitterPasses !== particleExecutions.reduce((sum, particle) => sum + particle.durationFrames, 0)
        || gpu.particle.minimumActiveEmitterCount !== Math.min(...Array.from({ length: frameCount }, (_, frame) => timelineStartFrame + frame)
          .map((frame) => particleExecutions.filter((particle) => frame >= particle.timelineStartFrame && frame < particle.timelineStartFrame + particle.durationFrames).length).filter((count) => count > 0))
        || gpu.particle.maximumActiveEmitterCount !== Math.max(...Array.from({ length: frameCount }, (_, frame) => timelineStartFrame + frame)
          .map((frame) => particleExecutions.filter((particle) => frame >= particle.timelineStartFrame && frame < particle.timelineStartFrame + particle.durationFrames).length))
        || gpu.particle.particleCeiling !== particleExecutions.reduce((sum, particle) => sum + particle.particleCeiling, 0)
        || gpu.particle.maximumGpuTextureWrites < 1
        || gpu.particle.executionMode !== "resident-analytic-overlay/v1") : gpu.particle !== undefined)
      || (temporalLookOverlays.length > 0 && (!gpu.composite
        || gpu.composite.layerCount !== 1 + temporalLookOverlays.length
        || gpu.composite.framesWithReceipt !== temporalLookCompositeFrameCount
        || gpu.composite.overlayClipIds.join() !== temporalLookOverlays.filter((candidate) => candidate.fullyMaterialized).map((candidate) => candidate.clip.id).join()
        || gpu.composite.timelineRanges.length !== temporalLookOverlays.length
        || temporalLookOverlays.some((candidate, index) => gpu.composite!.timelineRanges[index]?.clipId !== candidate.clip.id
          || gpu.composite!.timelineRanges[index]?.timelineStartFrame !== candidate.range.startFrame
          || gpu.composite!.timelineRanges[index]?.durationFrames !== candidate.range.endFrame - candidate.range.startFrame
          || gpu.composite!.timelineRanges[index]?.fullyMaterialized !== candidate.fullyMaterialized)))) {
      throw new Error(`GPU temporal look 沒有完整 resource-governed receipt：${clip.id}`);
    }
    const intermediate = join(runtime.workspace, `${prefix}-gpu-temporal-look.mkv`);
    await encodePngSequenceIntermediate(join(frameDirectory, "frame-%08d.png"), intermediate, project, frameCount, runtime);
    segment.assetPath = intermediate;
    segment.clip = { ...structuredClone(clip), sourceStart: 0, transform: { ...DEFAULT_TRANSFORM }, keyframes: [], color: { ...DEFAULT_COLOR }, creative: { ...structuredClone(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: [], nativeEffectInstances: [] } };
    const bakedCaptionIds = new Set(typography.captionCueIds);
    plan.captions = plan.captions.filter((cue) => !bakedCaptionIds.has(cue.id));
    for (const candidate of temporalLookAdjustments) {
      const adjustmentLayer = plan.videoLayers.find((layer) => layer.segments.includes(candidate.segment));
      const adjustmentIndex = adjustmentLayer?.segments.indexOf(candidate.segment);
      if (!adjustmentLayer || adjustmentIndex === undefined || adjustmentIndex < 0) throw new Error(`GPU temporal look 無法封存 adjustment RenderPlan 片段：${candidate.clip.id}`);
      adjustmentLayer.segments.splice(adjustmentIndex, 1, { kind: "gap", start: candidate.segment.start, duration: candidate.segment.duration });
    }
    for (const candidate of temporalLookOverlays) {
      const overlayLayer = plan.videoLayers.find((layer) => layer.segments.includes(candidate.segment));
      if (!overlayLayer) throw new Error(`GPU temporal look 無法封存 overlay RenderPlan 片段：${candidate.clip.id}`);
      replaceRenderSegmentRangeWithGap(overlayLayer, candidate.segment, candidate.range.startFrame / project.fps, candidate.range.endFrame / project.fps);
    }
    receipts.push({
      clipId: clip.id, frameCount, width: project.width, height: project.height,
      intermediateSha256: await sha256File(intermediate), executionMode: "resident-gpu-shader-sequence/v1",
      gpu: { ...gpu, frameCount, productPathCpuPixelCopies: 0, verificationReadback: true },
      instances: enabledInstances.map((instance) => ({
        instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
        pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
        worker: {
          runtime: "decoded-temporal-shutter-accumulation/v1", ...transformMotionBlurParameters(instance),
          lookContract: resourceGovernedParticleLook ? "decoded-temporal-resource-governed-look/v1"
            : temporalLookAdjustments.length === 2 ? "decoded-temporal-typography-multi-adjustment/v1"
            : temporalLookOverlays.length
            ? temporalLookOverlays.length === 2 ? "decoded-temporal-multi-video-overlay-typography-adjustment/v1"
              : temporalLookOverlays[0].fullyMaterialized ? "decoded-temporal-video-overlay-typography-adjustment/v1" : "decoded-temporal-partial-video-overlay-typography-adjustment/v1"
            : "decoded-temporal-typography-adjustment/v1",
          compositeContract: temporalLookOverlays.length ? "decoded-temporal-video-overlay/v1" : undefined,
          overlayClipId: temporalLookOverlays[0]?.clip.id,
          overlayClipIds: temporalLookOverlays.map((candidate) => candidate.clip.id),
          overlayAnimationContract: overlayAnimations.length ? "decoded-temporal-video-overlay-transform-animation/v1" : undefined,
          overlayAnimationClipIds: overlayAnimations.map((candidate) => candidate.clipId),
          overlayAnimationTransformNodeIds: overlayAnimations.map((candidate) => candidate.transformNodeId),
          overlayAnimationKeyframeCounts: Object.fromEntries(overlayAnimations.map((candidate) => [candidate.clipId, candidate.keyframeCount])),
          ...(typographyPresent ? {
            typographyContract: "decoded-temporal-typography-overlays/v1" as const,
            ...typography,
          } : {}),
          particleContract: gpu.particle?.contract,
          particleNodeIds: particleExecutions.map((particle) => particle.nodeId),
          particleTimelineRanges: gpu.particle?.timelineRanges ?? [],
          adjustmentContract: adjustmentExecutions.length ? adjustmentContract : undefined,
          adjustmentClipId: temporalLookAdjustments[0]?.clip.id,
          adjustmentClipIds: temporalLookAdjustments.map((candidate) => candidate.clip.id),
          adjustmentNodeIds: temporalLookAdjustments[0] ? gpu.adjustment?.nodeIdsByClip[temporalLookAdjustments[0].clip.id] : undefined,
          adjustmentNodeIdsByClip: gpu.adjustment?.nodeIdsByClip ?? {},
          productPathCpuPixelCopies: 0,
        },
      })),
    });
    return true;
  }
  return false;
}

