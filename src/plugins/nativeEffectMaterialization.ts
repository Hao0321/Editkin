import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, particleSimulationEmitters, type EditProject } from "../domain/types";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type { RenderPlan } from "../render/planner";
import { discoverInstalledPlugins, resolveGpuEffectGraphBindings, resolveNativeEffectBinding } from "./registry";
import {
  decodeClipToRgba8,
  encodePngSequenceIntermediate,
  encodeRgba8Intermediate,
  renderGpuEffectSequence,
  rgba32fToRgba8,
  rgba8ToRgba32f,
  runProcess,
  sha256File,
} from "./nativeEffectGpuSequence";
import { materializeConvergedTemporalLook } from "./nativeEffectTemporalLook";
import { rationalFps, replaceRenderSegmentRangeWithGap, safeId, videoSegments } from "./nativeEffectMaterializationSupport";
import type { NativeEffectRenderReceipt, NativeEffectRenderRuntime } from "./nativeEffectTypes";

export { videoSegments } from "./nativeEffectMaterializationSupport";


export async function materializeNativeEffectSegments(
  project: EditProject,
  plan: RenderPlan,
  runtime: NativeEffectRenderRuntime,
): Promise<NativeEffectRenderReceipt | undefined> {
  const allVideoSegments = videoSegments(plan);
  const targets = allVideoSegments.filter((segment) => (
    (!runtime.targetClipIds || runtime.targetClipIds.has(segment.clip.id))
    && segment.clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
  ));
  if (!targets.length) return undefined;
  if (project.colorManagement?.mode === "aces2") throw new Error("第三方效果尚未宣告 ACES scene-linear contract，已阻擋輸出");
  for (const segment of targets) {
    const enabled = segment.clip.creative?.nativeEffectInstances?.filter((instance) => instance.enabled) ?? [];
    if (enabled.some((instance) => instance.runtimeType === "gpu_effect_graph")
      && enabled.some((instance) => instance.runtimeType !== "gpu_effect_graph")) {
      throw new Error(`GPU effect graph 正式輸出不可混用 CPU ABI：${segment.clip.id}`);
    }
  }
  const externalInstances = targets.flatMap((segment) => segment.clip.creative?.nativeEffectInstances ?? [])
    .filter((instance) => instance.enabled && !isTransformMotionBlurInstance(instance));
  if (externalInstances.length && !runtime.pluginRoots.length) throw new Error("效果輸出缺少 Plugin runtime");
  const needsCpuRuntime = externalInstances.some((instance) => instance.runtimeType !== "gpu_effect_graph");
  const needsGpuRuntime = targets.some((segment) => segment.clip.creative?.nativeEffectInstances?.some((instance) => instance.enabled && instance.runtimeType === "gpu_effect_graph"));
  if (needsGpuRuntime && !runtime.gpuCompositorPath) throw new Error("GPU effect graph 正式輸出缺少 GPU compositor runtime");
  await Promise.all([
    access(runtime.ffmpegPath),
    ...(needsCpuRuntime ? [access(runtime.nativeCorePath)] : []),
    ...(needsGpuRuntime && runtime.gpuCompositorPath ? [access(runtime.gpuCompositorPath)] : []),
    mkdir(runtime.workspace, { recursive: true }),
  ]);
  const registry = externalInstances.some((instance) => instance.runtimeType !== "gpu_effect_graph")
    ? await discoverInstalledPlugins(runtime.pluginRoots) : { schema: "editkin.plugin-registry/v1" as const, plugins: [], diagnostics: [] };
  const fps = rationalFps(project.fps);
  const formalContentClips = project.tracks.filter((track) => track.kind === "video" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((candidate) => (candidate.layer?.role ?? "content") === "content" && candidate.layer?.enabled !== false);
  const formalAdjustmentClips = project.tracks.filter((track) => track.kind === "video" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((candidate) => candidate.layer?.role === "adjustment" && candidate.layer.enabled !== false);
  const receipts: NativeEffectRenderReceipt["clips"] = [];
  for (const segment of targets) {
    const clip = segment.clip;
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    if (!asset || asset.kind === "audio") throw new Error(`原生效果需要視訊或圖片素材：${clip.id}`);
    if (asset.color?.interpretation && !["auto", "rec709", "srgb"].includes(asset.color.interpretation)) {
      throw new Error(`原生效果 Rec.709 adapter 不接受未正規化來源：${asset.color.interpretation}`);
    }
    const enabledInstances = clip.creative!.nativeEffectInstances!.filter((instance) => instance.enabled);
    const motionBlurInstances = enabledInstances.filter(isTransformMotionBlurInstance);
    const gpuInstances = enabledInstances.filter((instance) => instance.runtimeType === "gpu_effect_graph" && !isTransformMotionBlurInstance(instance));
    const cpuInstances = enabledInstances.filter((instance) => instance.runtimeType !== "gpu_effect_graph" && !isTransformMotionBlurInstance(instance));
    if (motionBlurInstances.length > 1 || gpuInstances.length > 4 || ((gpuInstances.length || motionBlurInstances.length) && cpuInstances.length)) {
      throw new Error(`GPU effect graph 正式輸出每個片段最多 4 個，且不混用 CPU ABI：${clip.id}`);
    }
    const frameCount = Math.round(clip.duration * project.fps);
    if (frameCount <= 0 || Math.abs(frameCount / project.fps - clip.duration) > 1e-6) throw new Error(`原生效果片段未對齊專案 frame grid：${clip.id}`);
    const prefix = `${safeId(clip.id)}-${receipts.length}`;
    const overlayClips = formalContentClips.length >= 2 && formalContentClips.length <= 3 && formalContentClips[0].id === clip.id
      ? formalContentClips.slice(1) : [];
    const overlayClip = overlayClips.length === 1 ? overlayClips[0] : undefined;
    const overlaySegment = overlayClip ? allVideoSegments.find((candidate) => candidate.clip.id === overlayClip.id) : undefined;
    const timelineFrames = overlayClip ? [clip.timelineStart, clip.timelineStart + clip.duration, overlayClip.timelineStart, overlayClip.timelineStart + overlayClip.duration]
      .map((time) => ({ time, frame: Math.round(time * project.fps) })) : [];
    const timelineFramesAligned = timelineFrames.length === 4
      && timelineFrames.every(({ time, frame }) => Math.abs(frame / project.fps - time) <= 1e-6);
    const compositeTimelineRange = timelineFramesAligned ? {
      startFrame: Math.max(timelineFrames[0].frame, timelineFrames[2].frame),
      endFrame: Math.min(timelineFrames[1].frame, timelineFrames[3].frame),
    } : undefined;
    const temporalClipEnd = clip.timelineStart + clip.duration;
    const typographyWithinTemporalClip = project.captions.every((cue) => cue.start >= clip.timelineStart - 1e-6 && cue.start + cue.duration <= temporalClipEnd + 1e-6)
      && project.motionGraphics.every((graphic) => graphic.timelineStart >= clip.timelineStart - 1e-6 && graphic.timelineStart + graphic.duration <= temporalClipEnd + 1e-6);
    const adjustmentClip = formalAdjustmentClips.length === 1 ? formalAdjustmentClips[0] : undefined;
    const adjustmentSegment = adjustmentClip ? allVideoSegments.find((candidate) => candidate.clip.id === adjustmentClip.id) : undefined;
    const adjustmentStartFrame = adjustmentClip ? Math.round(adjustmentClip.timelineStart * project.fps) : 0;
    const adjustmentDurationFrames = adjustmentClip ? Math.round(adjustmentClip.duration * project.fps) : 0;
    const adjustmentFrameAligned = Boolean(adjustmentClip)
      && Math.abs(adjustmentStartFrame / project.fps - adjustmentClip!.timelineStart) <= 1e-6
      && Math.abs(adjustmentDurationFrames / project.fps - adjustmentClip!.duration) <= 1e-6;
    const temporalLookAdjustments = formalAdjustmentClips.map((candidate) => {
      const candidateSegment = allVideoSegments.find((item) => item.clip.id === candidate.id);
      const startFrame = Math.round(candidate.timelineStart * project.fps);
      const durationFrames = Math.round(candidate.duration * project.fps);
      const aligned = Math.abs(startFrame / project.fps - candidate.timelineStart) <= 1e-6
        && Math.abs(durationFrames / project.fps - candidate.duration) <= 1e-6;
      return candidateSegment ? { clip: candidate, segment: candidateSegment, startFrame, durationFrames, aligned } : undefined;
    }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    const temporalLookAdjustmentSetValid = temporalLookAdjustments.length === formalAdjustmentClips.length
      && temporalLookAdjustments.length <= 2
      && temporalLookAdjustments.every((candidate) => candidate.aligned
        && candidate.clip.timelineStart >= clip.timelineStart - 1e-6
        && candidate.clip.timelineStart + candidate.clip.duration <= temporalClipEnd + 1e-6);
    const temporalLookParticleEmitters = project.particleSimulation?.enabled === true
      ? particleSimulationEmitters(project.particleSimulation) : [];
    const temporalLookParticles = temporalLookParticleEmitters.length >= 1 && temporalLookParticleEmitters.length <= 4
      ? temporalLookParticleEmitters.map((emitter) => {
      const timelineStartFrame = Math.round((emitter.timeline?.start ?? 0) * project.fps);
      const durationFrames = Math.round((emitter.timeline?.duration ?? 0) * project.fps);
      const aligned = emitter.timeline !== undefined
        && Math.abs(timelineStartFrame / project.fps - emitter.timeline.start) <= 1e-6
        && Math.abs(durationFrames / project.fps - emitter.timeline.duration) <= 1e-6;
      const nodeId = emitter.id === "primary" ? "vfx:particles" : `vfx:particles:${safeId(emitter.id)}`;
      return { emitter, nodeId, timelineStartFrame, durationFrames, aligned };
    }) : [];
    const temporalLookParticleSetValid = temporalLookParticleEmitters.length === 0
      || (temporalLookParticles.length === temporalLookParticleEmitters.length
        && temporalLookParticles.every((particle) => particle.aligned
          && particle.durationFrames > 0
          && particle.timelineStartFrame >= Math.round(clip.timelineStart * project.fps)
          && particle.timelineStartFrame + particle.durationFrames <= Math.round(temporalClipEnd * project.fps)));
    if (await materializeConvergedTemporalLook({
      project, plan, runtime, allVideoSegments, formalContentClips, formalAdjustmentClips,
      segment, clip, enabledInstances, motionBlurInstances, frameCount, prefix, overlayClips,
      temporalClipEnd, typographyWithinTemporalClip, temporalLookAdjustments,
      temporalLookAdjustmentSetValid, temporalLookParticleEmitters, temporalLookParticles,
      temporalLookParticleSetValid, receipts,
    })) continue;
    const convergedTemporalAdjustment = runtime.targetClipIds === undefined
      && enabledInstances.length === 1 && motionBlurInstances.length === 1
      && formalContentClips.length === 1 && formalContentClips[0].id === clip.id
      && Boolean(adjustmentClip && adjustmentSegment && adjustmentFrameAligned)
      && adjustmentClip!.timelineStart >= clip.timelineStart - 1e-6
      && adjustmentClip!.timelineStart + adjustmentClip!.duration <= temporalClipEnd + 1e-6
      && project.captions.length === 0 && project.motionGraphics.length === 0
      ? buildGpuEngineVideoPreviewGraph(project, clip.timelineStart)
      : undefined;
    if (convergedTemporalAdjustment) {
      const timelineStartFrame = Math.round(clip.timelineStart * project.fps);
      if (Math.abs(timelineStartFrame / project.fps - clip.timelineStart) > 1e-6) throw new Error(`GPU temporal adjustment 起點未對齊專案 frame grid：${clip.id}`);
      const graph = convergedTemporalAdjustment.graph as unknown as Record<string, unknown>;
      const adjustmentNodeId = `adjustment:${safeId(adjustmentClip!.id)}`;
      const graphAdjustment = (graph.nodes as Array<Record<string, unknown>>).find((node) => node.id === adjustmentNodeId && node.kind === "adjustment");
      const graphAdjustmentTimeline = graphAdjustment?.timeline as Record<string, unknown> | undefined;
      if (graphAdjustmentTimeline?.timelineStartFrame !== adjustmentStartFrame || graphAdjustmentTimeline.durationFrames !== adjustmentDurationFrames) {
        throw new Error(`GPU temporal adjustment graph timeline 與專案不一致：${adjustmentClip!.id}`);
      }
      const effectBindings = await resolveGpuEffectGraphBindings(graph, runtime.pluginRoots);
      const frameDirectory = join(runtime.workspace, `${prefix}-gpu-temporal-adjustment-frames`);
      const gpu = await renderGpuEffectSequence(
        graph, { [clip.assetId]: segment.assetPath }, effectBindings, Object.keys(effectBindings.bindings).length,
        frameCount, frameDirectory, runtime, { timelineStartFrame, adjustment: {
          clipId: adjustmentClip!.id, adjustmentNodeId, timelineStartFrame: adjustmentStartFrame, durationFrames: adjustmentDurationFrames,
        } },
      );
      if (!gpu.temporalSampling || gpu.temporalSampling.framesWithReceipt !== frameCount
        || !gpu.adjustment || gpu.adjustment.framesWithActiveAdjustments !== adjustmentDurationFrames
        || gpu.adjustment.adjustmentClipIds.length !== 1 || gpu.adjustment.adjustmentClipIds[0] !== adjustmentClip!.id) {
        throw new Error(`GPU temporal adjustment 沒有完整 temporal／adjustment receipt：${clip.id}`);
      }
      const intermediate = join(runtime.workspace, `${prefix}-gpu-temporal-adjustment.mkv`);
      await encodePngSequenceIntermediate(join(frameDirectory, "frame-%08d.png"), intermediate, project, frameCount, runtime);
      segment.assetPath = intermediate;
      segment.clip = { ...structuredClone(clip), sourceStart: 0, transform: { ...DEFAULT_TRANSFORM }, keyframes: [], color: { ...DEFAULT_COLOR }, creative: { ...structuredClone(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: [], nativeEffectInstances: [] } };
      const adjustmentLayer = plan.videoLayers.find((layer) => layer.segments.includes(adjustmentSegment!));
      const adjustmentIndex = adjustmentLayer?.segments.indexOf(adjustmentSegment!);
      if (!adjustmentLayer || adjustmentIndex === undefined || adjustmentIndex < 0) throw new Error(`GPU temporal adjustment 無法封存 RenderPlan 片段：${adjustmentClip!.id}`);
      adjustmentLayer.segments.splice(adjustmentIndex, 1, { kind: "gap", start: adjustmentSegment!.start, duration: adjustmentSegment!.duration });
      receipts.push({
        clipId: clip.id, frameCount, width: project.width, height: project.height,
        intermediateSha256: await sha256File(intermediate), executionMode: "resident-gpu-shader-sequence/v1",
        gpu: { ...gpu, frameCount, productPathCpuPixelCopies: 0, verificationReadback: true },
        instances: enabledInstances.map((instance) => ({
          instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
          pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
          worker: { runtime: "decoded-temporal-shutter-accumulation/v1", ...transformMotionBlurParameters(instance), adjustmentContract: "decoded-temporal-trailing-adjustment/v1", adjustmentClipId: adjustmentClip!.id, adjustmentNodeIds: gpu.adjustment!.nodeIdsByClip[adjustmentClip!.id], productPathCpuPixelCopies: 0 },
        })),
      });
      continue;
    }
    const convergedTemporalTypography = runtime.targetClipIds === undefined
      && enabledInstances.length === 1 && motionBlurInstances.length === 1
      && formalContentClips.length === 1 && formalContentClips[0].id === clip.id
      && formalAdjustmentClips.length === 0
      && project.captions.length + project.motionGraphics.length > 0
      && typographyWithinTemporalClip
      ? buildGpuEngineVideoPreviewGraph(project, clip.timelineStart)
      : undefined;
    if (convergedTemporalTypography) {
      const timelineStartFrame = Math.round(clip.timelineStart * project.fps);
      if (Math.abs(timelineStartFrame / project.fps - clip.timelineStart) > 1e-6) throw new Error(`GPU temporal typography 起點未對齊專案 frame grid：${clip.id}`);
      const graph = convergedTemporalTypography.graph as unknown as Record<string, unknown>;
      const effectBindings = await resolveGpuEffectGraphBindings(graph, runtime.pluginRoots);
      const frameDirectory = join(runtime.workspace, `${prefix}-gpu-temporal-typography-frames`);
      const typography = {
        captionCueIds: project.captions.map((cue) => cue.id),
        motionGraphicIds: project.motionGraphics.map((graphic) => graphic.id),
      };
      const gpu = await renderGpuEffectSequence(
        graph, { [clip.assetId]: segment.assetPath }, effectBindings, Object.keys(effectBindings.bindings).length,
        frameCount, frameDirectory, runtime, { timelineStartFrame, typography },
      );
      if (!gpu.temporalSampling || gpu.temporalSampling.framesWithReceipt !== frameCount
        || !gpu.typography || gpu.typography.captionCueIds.length !== typography.captionCueIds.length
        || gpu.typography.motionGraphicIds.length !== typography.motionGraphicIds.length
        || (typography.captionCueIds.length > 0 && gpu.typography.framesWithActiveCaptions < 1)
        || (typography.motionGraphicIds.length > 0 && gpu.typography.framesWithActiveMotionGraphics < 1)) {
        throw new Error(`GPU temporal typography 沒有完整 temporal／typography receipt：${clip.id}`);
      }
      const intermediate = join(runtime.workspace, `${prefix}-gpu-temporal-typography.mkv`);
      await encodePngSequenceIntermediate(join(frameDirectory, "frame-%08d.png"), intermediate, project, frameCount, runtime);
      segment.assetPath = intermediate;
      segment.clip = { ...structuredClone(clip), sourceStart: 0, transform: { ...DEFAULT_TRANSFORM }, keyframes: [], color: { ...DEFAULT_COLOR }, creative: { ...structuredClone(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: [], nativeEffectInstances: [] } };
      const bakedCaptionIds = new Set(typography.captionCueIds);
      plan.captions = plan.captions.filter((cue) => !bakedCaptionIds.has(cue.id));
      receipts.push({
        clipId: clip.id, frameCount, width: project.width, height: project.height,
        intermediateSha256: await sha256File(intermediate), executionMode: "resident-gpu-shader-sequence/v1",
        gpu: { ...gpu, frameCount, productPathCpuPixelCopies: 0, verificationReadback: true },
        instances: enabledInstances.map((instance) => ({
          instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
          pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
          worker: { runtime: "decoded-temporal-shutter-accumulation/v1", ...transformMotionBlurParameters(instance), typographyContract: "decoded-temporal-typography-overlays/v1", ...typography, productPathCpuPixelCopies: 0 },
        })),
      });
      continue;
    }
    const convergedTemporalOverlay = runtime.targetClipIds === undefined
      && enabledInstances.length === 1 && motionBlurInstances.length === 1
      && Boolean(overlayClip && overlaySegment)
      && Boolean(compositeTimelineRange && compositeTimelineRange.endFrame > compositeTimelineRange.startFrame)
      && project.captions.length === 0 && project.motionGraphics.length === 0
      && !(overlayClip!.creative?.effectPresetIds.length)
      && !overlayClip!.creative?.nativeEffectInstances?.some((instance) => instance.enabled)
      && !overlayClip!.keyframes.length && !(overlayClip!.expressions && Object.keys(overlayClip!.expressions).length)
      ? buildGpuEngineVideoPreviewGraph(project, clip.timelineStart)
      : undefined;
    if (convergedTemporalOverlay) {
      const timelineStartFrame = Math.round(clip.timelineStart * project.fps);
      if (Math.abs(timelineStartFrame / project.fps - clip.timelineStart) > 1e-6) throw new Error(`GPU 雙影片合成起點未對齊專案 frame grid：${clip.id}`);
      const graph = convergedTemporalOverlay.graph as unknown as Record<string, unknown>;
      const effectBindings = await resolveGpuEffectGraphBindings(graph, runtime.pluginRoots);
      const assetBindings = Object.fromEntries(formalContentClips.map((candidate) => {
        const planned = allVideoSegments.find((item) => item.clip.id === candidate.id);
        if (!planned) throw new Error(`GPU 雙影片合成缺少 RenderPlan 片段：${candidate.id}`);
        return [candidate.assetId, planned.assetPath];
      }));
      const frameDirectory = join(runtime.workspace, `${prefix}-gpu-temporal-overlay-frames`);
      const gpu = await renderGpuEffectSequence(
        graph, assetBindings, effectBindings, Object.keys(effectBindings.bindings).length,
        frameCount, frameDirectory, runtime, { timelineStartFrame, compositeTimelineRange: { ...compositeTimelineRange!, overlayClipId: overlayClip!.id } },
      );
      const expectedCompositeFrames = compositeTimelineRange!.endFrame - compositeTimelineRange!.startFrame;
      if (!gpu.temporalSampling || gpu.temporalSampling.framesWithReceipt !== frameCount
        || !gpu.composite || gpu.composite.framesWithReceipt !== expectedCompositeFrames) {
        throw new Error(`GPU 雙影片合成沒有完整 temporal/composite receipt：${clip.id}`);
      }
      const intermediate = join(runtime.workspace, `${prefix}-gpu-temporal-overlay.mkv`);
      await encodePngSequenceIntermediate(join(frameDirectory, "frame-%08d.png"), intermediate, project, frameCount, runtime);
      segment.assetPath = intermediate;
      segment.clip = { ...structuredClone(clip), sourceStart: 0, transform: { ...DEFAULT_TRANSFORM }, keyframes: [], color: { ...DEFAULT_COLOR }, creative: { ...structuredClone(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: [], nativeEffectInstances: [] } };
      const overlayLayer = plan.videoLayers.find((layer) => layer.segments.includes(overlaySegment!));
      if (!overlayLayer) throw new Error(`GPU 雙影片合成無法封存 overlay RenderPlan 片段：${overlayClip!.id}`);
      const overlapStart = compositeTimelineRange!.startFrame / project.fps;
      const overlapEnd = compositeTimelineRange!.endFrame / project.fps;
      replaceRenderSegmentRangeWithGap(overlayLayer, overlaySegment!, overlapStart, overlapEnd);
      receipts.push({
        clipId: clip.id, frameCount, width: project.width, height: project.height,
        intermediateSha256: await sha256File(intermediate), executionMode: "resident-gpu-shader-sequence/v1",
        gpu: { ...gpu, frameCount, productPathCpuPixelCopies: 0, verificationReadback: true },
        instances: enabledInstances.map((instance) => ({
          instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
          pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
          worker: { runtime: "decoded-temporal-shutter-accumulation/v1", ...transformMotionBlurParameters(instance), compositeContract: "decoded-temporal-video-overlay/v1", overlayClipId: overlayClip!.id, productPathCpuPixelCopies: 0 },
        })),
      });
      continue;
    }
    if (gpuInstances.length >= 1 || motionBlurInstances.length === 1) {
      const sourceStartFrame = Math.round(clip.sourceStart * project.fps);
      if (Math.abs(sourceStartFrame / project.fps - clip.sourceStart) > 1e-6) throw new Error(`GPU effect 來源未對齊專案 frame grid：${clip.id}`);
      let tail = "color";
      const effectNodes: Array<Record<string, unknown>> = [];
      for (const effectPresetId of clip.creative?.effectPresetIds ?? []) {
        const id = `effect:preset:${safeId(effectPresetId)}`;
        effectNodes.push({ id, inputs: [tail], enabled: true, kind: "effect", pluginId: `editkin.builtin.${effectPresetId}`, abiVersion: 1, temporalRadius: 0, parameters: {} });
        tail = id;
      }
      for (const instance of enabledInstances) {
        if (isTransformMotionBlurInstance(instance)) {
          const id = "motion-blur";
          effectNodes.push({ id, inputs: [tail], enabled: true, kind: "motion_blur", ...transformMotionBlurParameters(instance) });
          tail = id;
        } else if (instance.runtimeType === "gpu_effect_graph") {
          const id = `effect:${gpuInstances.indexOf(instance)}`;
          effectNodes.push({ id, inputs: [tail], enabled: true, kind: "effect", pluginId: `${instance.pluginId}/${instance.capabilityId}@${instance.pluginVersion}#${instance.manifestSha256}`, abiVersion: 1, temporalRadius: 0, parameters: instance.parameters });
          tail = id;
        }
      }
      const graph = {
        schema: "editkin.engine-graph/v1", graphId: `formal-gpu-effect:${safeId(clip.id)}`,
        width: project.width, height: project.height, timebase: { numerator: fps.denominator, denominator: fps.numerator },
        workingFormat: "rgba16_float", cacheBudgetMb: Math.max(64, Math.ceil(project.width * project.height * (motionBlurInstances.length ? 108 : 48) / (1024 * 1024)) + 16),
        nodes: [
          { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame, durationFrames: frameCount } },
          { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: clip.transform.x, y: clip.transform.y, scaleX: clip.transform.scale, scaleY: clip.transform.scale, rotationRadians: clip.transform.rotation * Math.PI / 180, opacity: clip.transform.opacity,
            keyframes: clip.keyframes.map((keyframe) => ({ frame: Math.round(keyframe.time * project.fps), x: keyframe.transform.x, y: keyframe.transform.y, scaleX: keyframe.transform.scale, scaleY: keyframe.transform.scale, rotationRadians: keyframe.transform.rotation * Math.PI / 180, opacity: keyframe.transform.opacity, easing: keyframe.easing })) },
          { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: { ...clip.color } },
          ...effectNodes,
          { id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" },
        ],
        outputNode: "output",
      };
      const effectBindings = await resolveGpuEffectGraphBindings(graph, runtime.pluginRoots);
      const frameDirectory = join(runtime.workspace, `${prefix}-gpu-frames`);
      const gpu = await renderGpuEffectSequence(graph, { video: segment.assetPath }, effectBindings, gpuInstances.length, frameCount, frameDirectory, runtime);
      const intermediate = join(runtime.workspace, `${prefix}-gpu-effect.mkv`);
      await encodePngSequenceIntermediate(join(frameDirectory, "frame-%08d.png"), intermediate, project, frameCount, runtime);
      segment.assetPath = intermediate;
      segment.clip = { ...structuredClone(clip), sourceStart: 0, transform: { ...DEFAULT_TRANSFORM }, keyframes: [], color: { ...DEFAULT_COLOR }, creative: { ...structuredClone(clip.creative ?? { effectPresetIds: [] }), effectPresetIds: [], nativeEffectInstances: [] } };
      receipts.push({
        clipId: clip.id, frameCount, width: project.width, height: project.height,
        intermediateSha256: await sha256File(intermediate), executionMode: "resident-gpu-shader-sequence/v1",
        gpu: { ...gpu, frameCount, productPathCpuPixelCopies: 0, verificationReadback: true },
        instances: enabledInstances.map((instance) => isTransformMotionBlurInstance(instance) ? ({
          instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
          pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
          worker: { runtime: "decoded-temporal-shutter-accumulation/v1", ...transformMotionBlurParameters(instance), productPathCpuPixelCopies: 0 },
        }) : ({
          instanceId: instance.id, pluginId: instance.pluginId, capabilityId: instance.capabilityId,
          pluginVersion: instance.pluginVersion, manifestSha256: instance.manifestSha256, runtimeType: "gpu_effect_graph" as const,
          worker: { runtime: "editkin.gpu-effect-graph/v1", stackIndex: gpuInstances.indexOf(instance), ...gpu.programs[gpuInstances.indexOf(instance)] },
        })),
      });
      continue;
    }
    const instances = cpuInstances;
    const decodedRgba8 = join(runtime.workspace, `${prefix}-decoded.rgba8`);
    let currentFloat = join(runtime.workspace, `${prefix}-input.rgba32f`);
    await decodeClipToRgba8(clip, segment.assetPath, asset.kind, project, frameCount, decodedRgba8, runtime);
    await rgba8ToRgba32f(decodedRgba8, currentFloat);
    const instanceReceipts: NativeEffectRenderReceipt["clips"][number]["instances"] = [];
    for (const [index, instance] of instances.entries()) {
      const binding = resolveNativeEffectBinding(registry, instance);
      const runtimeLibrary = binding.capability.runtime.libraries[`${process.platform}-${process.arch}`]!;
      const manifestPath = join(runtime.workspace, `${prefix}-${index}-manifest.json`);
      const outputFloat = join(runtime.workspace, `${prefix}-${index}-output.rgba32f`);
      const requestPath = join(runtime.workspace, `${prefix}-${index}-request.json`);
      await writeFile(manifestPath, `${JSON.stringify({
        schema: "editkin.effect-plugin/v1",
        id: `${instance.pluginId}.${instance.capabilityId}`,
        version: instance.pluginVersion,
        abiVersion: binding.capability.runtime.abiVersion,
        librarySha256: runtimeLibrary.sha256,
        entrySymbol: binding.capability.runtime.entrySymbol,
        supportedFormats: ["rgba32_float"],
        maxTemporalRadius: binding.capability.runtime.maxTemporalRadius,
        timeoutMs: binding.capability.runtime.timeoutMs,
        deterministic: false,
      }, null, 2)}\n`, "utf8");
      const startFrameIndex = Math.round(clip.timelineStart * project.fps);
      await writeFile(requestPath, `${JSON.stringify({
        schema: "editkin.effect-plugin-sequence/v1",
        manifestPath,
        libraryPath: binding.libraryPath,
        inputPath: currentFloat,
        outputPath: outputFloat,
        width: project.width,
        height: project.height,
        frameCount,
        startFrameIndex,
        startTimeNumerator: startFrameIndex * fps.denominator,
        timeDenominator: fps.numerator,
        frameDurationNumerator: fps.denominator,
        frameDurationDenominator: fps.numerator,
        parameters: binding.numericParameters,
      }, null, 2)}\n`, "utf8");
      const result = await runProcess(runtime.nativeCorePath, ["effect-plugin-sequence-run", requestPath], runtime.timeoutMs);
      const supervisor = JSON.parse(result.stdout) as { status?: string; worker?: unknown };
      if (supervisor.status !== "GREEN") throw new Error(`原生效果未回傳 GREEN：${instance.id}`);
      instanceReceipts.push({
        instanceId: instance.id,
        pluginId: instance.pluginId,
        capabilityId: instance.capabilityId,
        pluginVersion: instance.pluginVersion,
        manifestSha256: instance.manifestSha256,
        runtimeType: instance.runtimeType ?? "native_effect",
        worker: supervisor.worker,
      });
      currentFloat = outputFloat;
    }
    const finalRgba8 = join(runtime.workspace, `${prefix}-final.rgba8`);
    const intermediate = join(runtime.workspace, `${prefix}-native-effects.mkv`);
    await rgba32fToRgba8(currentFloat, finalRgba8);
    await encodeRgba8Intermediate(finalRgba8, intermediate, project, frameCount, runtime);
    segment.assetPath = intermediate;
    segment.clip = { ...structuredClone(clip), sourceStart: 0 };
    receipts.push({
      clipId: clip.id,
      frameCount,
      width: project.width,
      height: project.height,
      intermediateSha256: await sha256File(intermediate),
      executionMode: "cpu-native-sequence/v1",
      instances: instanceReceipts,
    });
  }
  return {
    schema: "editkin.project-native-effect-render/v1",
    status: "GREEN",
    projectRevision: project.revision,
    clipCount: receipts.length,
    instanceCount: receipts.reduce((total, clip) => total + clip.instances.length, 0),
    clips: receipts,
  };
}

