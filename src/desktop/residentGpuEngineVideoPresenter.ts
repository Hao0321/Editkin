import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import {
  expectedEngineVideoAdjustments,
  expectedEngineVideoCaptions,
  expectedEngineVideoControllers,
  expectedEngineVideoLayers,
  expectedEngineVideoMotionGraphics,
  expectedEngineVideoNativeMotionPaints,
  expectedEngineVideoParticles,
} from "./residentGpuPreviewExpectations";
import {
  adjustmentActiveAt,
  adjustmentReceiptMatches,
  controllerReceiptMatches,
  engineVisualMatches,
  motionBlurReceiptMatches,
  temporalSamplingReceiptMatches,
} from "./residentGpuPreviewValidation";
import {
  boundsKey,
  captionActiveAt,
  captionReceiptMatches,
  depthOfFieldCoverageMatches,
  legacySdrNativeSurfaceValid,
  graphSdrNativeSurfaceValid,
  rec709SdrV2NativeSurfaceValid,
  activeSceneLinearInputTransform,
  matteExecutionReceiptMatches,
  motionGraphicExpectedSample,
  motionGraphicReceiptMatches,
  nativeAces2PreviewLoadTransform,
  nativeAces2PreviewSurfaceValid,
  particleActiveAt,
  sceneLinearAces2Output,
  sameF32,
  sceneLinearAces2PresentContractValid,
  sceneLinearCompositeReceiptMatches,
  sceneLinearEffectReceiptMatches,
  scene25dCoverageMatches,
  vfxSimulationCoverageMatches,
  videoParticleReceiptMatches,
} from "./residentGpuPreviewReceipts";
import { engineVideoDecodeCadence, engineVideoDecodeScheduleMatches, engineVideoResourcePlanMatches } from "./residentGpuPreviewResources";
import type { NativePreviewBounds } from "./residentGpuPreviewTypes";
import type { GpuPreviewApi } from "./gpuPreviewApiTypes";
import type { GpuEngineVideoPresentedFrame } from "./gpuFrameTypes";
import { prepareNativeMotionPaintReceiptExpectations, assertNativeMotionPaintLoadReceipt, assertNativeMotionPaintFrameReceipt,
  type PreparedNativeMotionPaintReceiptExpectations } from "../motion/nativeMotionPaintReceipt";
import { assertNativeFloatingLoadReceipt, assertNativeFloatingFrameReceipt, nativeFloatRuntimeMatches } from "../render/nativeFloatingVideoFrameReceipt";
import type { EngineRenderGraph } from "../render/engineGraph";

interface MutableRef<T> { current: T }
const nativePaintReceipts = new WeakMap<MutableRef<string>, PreparedNativeMotionPaintReceiptExpectations>();
const nativeFloatingReceiptGraphs = new WeakMap<MutableRef<string>, EngineRenderGraph>();
export interface ResidentEngineVideoBakedIds {
  readonly motionGraphicIds: readonly string[];
  readonly captionIds: readonly string[];
}
export interface EngineVideoPendingFrame {
  kind: "engine-video";
  preview: GpuEngineVideoPreviewGraph;
  token: number;
  fps: number;
  nativeBounds: NativePreviewBounds;
}
export interface EngineVideoPreviewContext {
  next: EngineVideoPendingFrame;
  desktop: GpuPreviewApi;
  imageSessionRef: MutableRef<string>;
  videoSessionRef: MutableRef<string>;
  engineVideoSessionRef: MutableRef<string>;
  loadedImageStructureRef: MutableRef<string | undefined>;
  loadedVideoStructureRef: MutableRef<string | undefined>;
  loadedEngineVideoStructureRef: MutableRef<string | undefined>;
  surfaceBoundsKeyRef: MutableRef<string | undefined>;
  surfaceColorSpaceRef: MutableRef<"srgb" | "rec2100_pq_1000" | undefined>;
  surfaceBoundRef: MutableRef<boolean>;
  tokenRef: MutableRef<number>;
  releaseSurface: () => Promise<void>;
  setFrameUrl: (value: string | undefined) => void;
  setNativeSurfaceActive: (value: boolean) => void;
  setFallbackReason: (value: string | undefined) => void;
}

export async function presentResidentEngineVideo(context: EngineVideoPreviewContext): Promise<ResidentEngineVideoBakedIds | undefined> {
  const {
    next, desktop, imageSessionRef, videoSessionRef, engineVideoSessionRef,
    loadedImageStructureRef, loadedVideoStructureRef, loadedEngineVideoStructureRef,
    surfaceBoundsKeyRef, surfaceColorSpaceRef, surfaceBoundRef, tokenRef,
    releaseSurface, setFrameUrl, setNativeSurfaceActive, setFallbackReason,
  } = context;
if (loadedImageStructureRef.current && desktop!.releaseGpuPreviewSession) {
  await desktop!.releaseGpuPreviewSession(imageSessionRef.current).catch(() => undefined);
  loadedImageStructureRef.current = undefined;
}
if (loadedVideoStructureRef.current && desktop!.releaseGpuVideoPreviewSession) {
  await desktop!.releaseGpuVideoPreviewSession(videoSessionRef.current).catch(() => undefined);
  loadedVideoStructureRef.current = undefined;
}
const structureKey = `engine-video:${next.preview.structureKey}`;
if (loadedEngineVideoStructureRef.current !== structureKey) {
  if (loadedEngineVideoStructureRef.current) {
    await desktop!.releaseGpuEngineVideoPreviewSession!(engineVideoSessionRef.current).catch(() => undefined);
  }
  nativePaintReceipts.delete(engineVideoSessionRef);
  nativeFloatingReceiptGraphs.delete(engineVideoSessionRef);
  const hasFloating = next.preview.graph.nodes.some(node => node.kind === "floating_video_frame_2d");
  if (hasFloating) {
    if (!desktop.gpuEngineStatus) throw new Error("浮空影片預覽缺少 current native runtime 能力讀回，不能使用舊 renderer");
    const status = await desktop.gpuEngineStatus();
    if (next.token !== tokenRef.current) return undefined;
    if (!status.available || !nativeFloatRuntimeMatches(status.ready)) {
      throw new Error("浮空影片預覽需要 editkin.native-floating-frame-material/v1 的 matching native runtime");
    }
  }
  const paintExpected = await prepareNativeMotionPaintReceiptExpectations(next.preview.graph);
  const loaded = await desktop!.loadGpuEngineVideoPreviewSession!(
    engineVideoSessionRef.current,
    next.preview.graph,
    next.preview.assetBindings,
    next.preview.timelineFrame,
  );
  // Once native creation succeeds, every later validation failure must be able
  // to release this exact session. Do not leave it invisible to invalidation.
  loadedEngineVideoStructureRef.current = structureKey;
  assertNativeFloatingLoadReceipt(next.preview.graph, loaded);
  if (hasFloating) nativeFloatingReceiptGraphs.set(engineVideoSessionRef, next.preview.graph);
  assertNativeMotionPaintLoadReceipt(paintExpected, next.preview.timelineFrame, loaded);
  nativePaintReceipts.set(engineVideoSessionRef, paintExpected);
  const required = next.preview.graph.nodes.map((node) => node.id);
  const expectedLayers = expectedEngineVideoLayers(next.preview.graph);
  const expectedControllers = expectedEngineVideoControllers(next.preview.graph);
  const expectedCaptions = expectedEngineVideoCaptions(next.preview.graph);
  const expectedMotionGraphics = expectedEngineVideoMotionGraphics(next.preview.graph);
  const expectedNativePaints = expectedEngineVideoNativeMotionPaints(next.preview.graph);
  const expectedParticles = expectedEngineVideoParticles(next.preview.graph);
  const expectedAdjustments = expectedEngineVideoAdjustments(next.preview.graph);
  const expectedMatteCount = expectedLayers.filter((layer) => layer.matteLayerIndex !== undefined).length;
  const expectedPrecompositionCount = expectedLayers.reduce((sum, layer) => sum + layer.precompositionNodeIds.length, 0);
  const expectedParentCount = expectedLayers.filter((layer) => layer.parentLayerIndex !== undefined || layer.parentControllerIndex !== undefined).length
    + expectedControllers.filter((controller) => controller.parentLayerIndex !== undefined || controller.parentControllerIndex !== undefined).length;
  const expectedTypedBlend = expectedLayers.slice(1).some((layer) => layer.blendMode !== "normal" || Math.abs(layer.compositeOpacity - 1) > .000001);
  const expectedCompositeMode = expectedAdjustments.length && expectedCaptions.length + expectedMotionGraphics.length + expectedNativePaints.length > 0 ? "video-pre-typography-adjustment/v1"
    : expectedAdjustments.length ? "video-trailing-adjustment/v1"
    : expectedMatteCount ? "typed-track-matte/v1"
    : expectedPrecompositionCount ? "resolved-precomposition/v1"
    : expectedControllers.length ? "typed-controller-parent/v1"
    : expectedParentCount ? "typed-parent-transform/v1"
    : expectedNativePaints.length ? "video-native-motion-paint-source-over/v1"
    : expectedMotionGraphics.length ? "video-motion-graphic-source-over/v1"
    : expectedCaptions.length ? "video-caption-source-over/v1"
    : expectedParticles.length ? "video-particle-source-over/v1"
    : expectedTypedBlend ? "typed-blend-source-over/v1"
    : expectedLayers.length > 1 ? "normal-source-over/v1" : "single/v1";
  const loadedCaptionsValid = loaded.captionCount === expectedCaptions.length
    && loaded.captionTextureUploads === expectedCaptions.length
    && loaded.captions.length === expectedCaptions.length
    && loaded.captions.every((caption, index) => captionReceiptMatches(caption, expectedCaptions[index]))
    && loaded.activeCaptions.length === expectedCaptions.filter((caption) => captionActiveAt(caption, next.preview.timelineFrame)).length;
  const expectedActiveMotionGraphics = expectedMotionGraphics
    .filter((graphic) => motionGraphicExpectedSample(graphic, next.preview.graph, next.preview.timelineFrame) !== undefined);
  const loadedMotionGraphicsValid = loaded.motionGraphicCount === expectedMotionGraphics.length
    && loaded.motionGraphicTextureUploads === expectedMotionGraphics.length
    && loaded.motionGraphics.length === expectedMotionGraphics.length
    && loaded.motionGraphics.every((graphic, index) => motionGraphicReceiptMatches(graphic, expectedMotionGraphics[index], next.preview.graph))
    && loaded.activeMotionGraphics.length === expectedActiveMotionGraphics.length
    && loaded.activeMotionGraphics.every((graphic, index) => motionGraphicReceiptMatches(graphic, expectedActiveMotionGraphics[index], next.preview.graph, next.preview.timelineFrame));
  const loadedParticlesValid = loaded.particleCount === expectedParticles.length
    && loaded.particleTexturesResident === expectedParticles.length
    && vfxSimulationCoverageMatches(loaded.vfxSimulation, next.preview.vfxSimulationExpectation);
  const loadedAdjustmentsValid = loaded.adjustmentCount === expectedAdjustments.length
    && loaded.adjustments.length === expectedAdjustments.length
    && loaded.adjustments.every((adjustment, index) => adjustmentReceiptMatches(adjustment, expectedAdjustments[index], next.preview.graph));
  const loadedControllersValid = loaded.controllerCount === expectedControllers.length
    && loaded.controllers.length === expectedControllers.length
    && loaded.controllers.every((controller, index) => controllerReceiptMatches(controller, expectedControllers[index], expectedLayers, expectedControllers, next.preview.graph, next.preview.timelineFrame));
  const sceneLinearAces2OutputTransform = sceneLinearAces2Output(next.preview.graph);
  const loadedDisplayTransformValid = loaded.displayTransform === (sceneLinearAces2OutputTransform
    ? nativeAces2PreviewLoadTransform(sceneLinearAces2OutputTransform) : "scene_linear_preview");
  const expectedGpuEffects = next.preview.graph.nodes.filter((node) => node.kind === "effect"
    && typeof node.pluginId === "string" && !node.pluginId.startsWith("editkin.builtin."));
  const loadedGpuEffectsValid = loaded.gpuEffects?.runtime === "editkin.gpu-effect-graph/v1"
    && loaded.gpuEffects.resolved === true
    && loaded.gpuEffects.count === expectedGpuEffects.length
    && loaded.gpuEffects.programs.length === expectedGpuEffects.length
    && loaded.gpuEffects.programs.every((program) => {
      const expected = expectedGpuEffects.find((node) => node.id === program.nodeId);
      return expected?.pluginId === program.pluginIdentity
        && /^[a-f0-9]{64}$/.test(program.programSha256)
        && program.shaderOpCount >= 1 && program.shaderOpCount <= 4;
    });
  const expectedDecoderGroupKeys = expectedLayers.map((expected, index) => {
    if (expected.motionBlur?.sourceSampling === "decoded_temporal") return undefined;
    const cadence = engineVideoDecodeCadence(expected, index, expectedLayers.length);
    const path = next.preview.assetBindings[expected.assetId] ?? expected.assetId;
    return cadence.divisor === 1 ? `${path}\u0000full:${expected.sourceNodeId}` : `${path}\u0000adaptive-small-layer-cache`;
  });
  const expectedDecoderGroupCounts = expectedDecoderGroupKeys.reduce((counts, key) => {
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const decoderIdByGroup = new Map<string, number>();
  const groupByDecoderId = new Map<number, string>();
  let loadedDecoderGroupingValid = true;
  if (expectedLayers.length > 1) {
    loaded.layers.forEach((actual, index) => {
      const key = expectedDecoderGroupKeys[index];
      if (key === undefined) return;
      const groupCount = expectedDecoderGroupCounts.get(key) ?? 0;
      const decoderId = actual.decoder.decoderInstanceId;
      const priorDecoderId = decoderIdByGroup.get(key);
      const priorGroup = typeof decoderId === "number" ? groupByDecoderId.get(decoderId) : undefined;
      loadedDecoderGroupingValid &&= Number.isInteger(decoderId)
        && actual.decoder.sourceCacheSchema === "editkin.shared-source-frame-cache/v1"
        && actual.sharedDecoderLayerCount === groupCount
        && actual.decoder.residentFrameRingSize === groupCount * 3
        && (priorDecoderId === undefined || priorDecoderId === decoderId)
        && (priorGroup === undefined || priorGroup === key);
      if (typeof decoderId === "number") { decoderIdByGroup.set(key, decoderId); groupByDecoderId.set(decoderId, key); }
    });
    loadedDecoderGroupingValid &&= decoderIdByGroup.size === expectedDecoderGroupCounts.size;
  }
  const loadedLayersValid = expectedLayers.length === loaded.layerCount
    && loaded.matteCount === expectedMatteCount
    && loaded.precompositionCount === expectedPrecompositionCount
    && loaded.parentCount === expectedParentCount
    && loaded.layers.length === expectedLayers.length
    && loaded.visualLayers.length === expectedLayers.length
    && loaded.compositeMode === expectedCompositeMode
    && expectedLayers.every((expected, index) => {
      const actual = loaded.layers[index];
      const cadence = engineVideoDecodeCadence(expected, index, expectedLayers.length);
      const decodedTemporal = expected.motionBlur?.sourceSampling === "decoded_temporal";
      const expectedRingSize = expected.motionBlur?.sourceSampling === "decoded_temporal"
        ? Math.max(3, Number(expected.motionBlur.samples)) : 3;
      return actual?.sourceNodeId === expected.sourceNodeId && actual.assetId === expected.assetId
        && actual.transformNodeId === expected.transformNodeId
        && motionBlurReceiptMatches(actual.motionBlur, expected)
        && (actual.parentTransformNodeId ?? undefined) === expected.parentTransformNodeId
        && (actual.parentLayerIndex ?? undefined) === expected.parentLayerIndex
        && (actual.parentControllerIndex ?? undefined) === expected.parentControllerIndex
        && actual.parentDepth === expected.parentDepth
        && actual.blendMode === expected.blendMode && sameF32(actual.compositeOpacity, expected.compositeOpacity)
        && (actual.matteLayerIndex ?? undefined) === expected.matteLayerIndex && (actual.matteMode ?? undefined) === expected.matteMode
        && JSON.stringify(actual.precompositionNodeIds) === JSON.stringify(expected.precompositionNodeIds)
        && JSON.stringify(actual.nestedGraphIds) === JSON.stringify(expected.nestedGraphIds)
        && actual.decodeCadenceDivisor === cadence.divisor && actual.decodeCadencePhase === cadence.phase
        && actual.decoder.decodePathCpuPixelCopies === 0
        && (decodedTemporal ? actual.decoder.residentFrameRingSize === expectedRingSize : expectedLayers.length > 1 || actual.decoder.residentFrameRingSize === expectedRingSize)
        && (expectedLayers.length === 1 || decodedTemporal
          ? actual.decoder.decodeDispatchMode == null
          : actual.decoder.decodeDispatchMode === "parallel-com-apartment/v1")
        && actual.decoder.width === next.preview.decoderDimensions[expected.assetId]?.width
        && actual.decoder.height === next.preview.decoderDimensions[expected.assetId]?.height
        && engineVisualMatches(actual.visualGraph, expected, expectedLayers, expectedControllers, next.preview.graph, next.preview.timelineFrame)
        && engineVisualMatches(loaded.visualLayers[index], expected, expectedLayers, expectedControllers, next.preview.graph, next.preview.timelineFrame);
    });
  const loadedResourcePlanValid = engineVideoResourcePlanMatches(
    loaded.resourcePlan,
    next.preview.graph,
    expectedLayers.length,
    expectedParticles.length + expectedCaptions.length + expectedMotionGraphics.length + expectedNativePaints.length,
    expectedAdjustments.length,
    expectedMatteCount,
    expectedParticles.length,
  );
  const loadedDecodeScheduleValid = engineVideoDecodeScheduleMatches(loaded.decodeSchedule, expectedLayers);
  const loadChecks = {
    executor: loaded.executor === "media-foundation-d3d11-d3d12-wgpu/v1",
    layers: loadedLayersValid,
    decoderGrouping: loadedDecoderGroupingValid,
    resourcePlan: loadedResourcePlanValid,
    decodeSchedule: loadedDecodeScheduleValid,
    gpuEffects: loadedGpuEffectsValid,
    captions: loadedCaptionsValid,
    motionGraphics: loadedMotionGraphicsValid,
    particles: loadedParticlesValid,
    adjustments: loadedAdjustmentsValid,
    controllers: loadedControllersValid,
    displayTransform: loadedDisplayTransformValid,
    scene25d: scene25dCoverageMatches(loaded.scene25d, next.preview.scene25dExpectation, next.preview.graph, next.preview.timelineFrame),
    depthOfField: depthOfFieldCoverageMatches(loaded.depthOfField, next.preview.graph, next.preview.timelineFrame),
    directExecution: loaded.engineGraph.directExecution === true,
    noBlockedNodes: loaded.engineGraph.blockedNodeIds.length === 0,
    noIgnoredNodes: loaded.engineGraph.ignoredNodeIds.length === 0,
    allNodesExecuted: required.every((id) => loaded.engineGraph.executedNodeIds.includes(id)),
  };
  const failedLoadChecks = Object.entries(loadChecks).filter(([, valid]) => !valid).map(([name]) => name);
  if (failedLoadChecks.length) {
    throw new Error(`共同影片 Engine Graph 沒有完整進入 native GPU executor：${failedLoadChecks.join(", ")}`);
  }
}
const sceneLinearAces2OutputTransform = sceneLinearAces2Output(next.preview.graph);
// Superseding a queue item is distinct from retiring its whole owner. Skip it
// without dropping the latest pending item or recovering a healthy device.
if (next.token !== tokenRef.current) return undefined;
const surfaceRequest = {
  ...next.nativeBounds,
  surfaceColorSpace: sceneLinearAces2OutputTransform === "rec2100_pq_1000" ? "rec2100_pq_1000" as const : "srgb" as const,
};
const nextBoundsKey = boundsKey(surfaceRequest);
if (surfaceBoundRef.current && surfaceColorSpaceRef.current !== surfaceRequest.surfaceColorSpace) {
  await releaseSurface();
}
let rebound = false;
if (!surfaceBoundRef.current || surfaceBoundsKeyRef.current !== nextBoundsKey) {
  const surface = await desktop!.bindGpuPreviewSurface!(surfaceRequest);
  const surfaceValid = sceneLinearAces2OutputTransform
    ? nativeAces2PreviewSurfaceValid(surface, sceneLinearAces2OutputTransform)
    : legacySdrNativeSurfaceValid(surface) || rec709SdrV2NativeSurfaceValid(surface);
  if (!surfaceValid) throw new Error("原生預覽表面沒有維持 Engine Graph 指定的色彩傳輸契約");
  surfaceBoundRef.current = true;
  surfaceBoundsKeyRef.current = nextBoundsKey;
  surfaceColorSpaceRef.current = surfaceRequest.surfaceColorSpace;
  rebound = true;
}
if (next.token !== tokenRef.current) {
  // Repositioning an existing native surface does not hide its actual window.
  // Retire that exact surface before the latest queue item binds again.
  if (rebound) await releaseSurface();
  return undefined;
}
const tolerance = Math.min(.25, .5 / Math.max(1, next.fps));
const presented = await desktop!.presentGpuEngineVideoPreviewFrame!(
  engineVideoSessionRef.current,
  next.preview.timelineFrame,
  tolerance,
);
const bakedIds = validateResidentEngineVideoFrame(next.preview, presented, nativePaintReceipts.get(engineVideoSessionRef),
  nativeFloatingReceiptGraphs.get(engineVideoSessionRef));
if (next.token === tokenRef.current) {
  setFrameUrl(undefined);
  setNativeSurfaceActive(true);
  setFallbackReason(undefined);
}
return bakedIds;
}

/** The same detailed receipt checks serve manual presentation and bounded
 * diagnostic sampling of native-autonomous playback. Never issue a new frame
 * request merely to inspect the frame the native producer already presented. */
export function validateResidentEngineVideoFrame(preview: GpuEngineVideoPreviewGraph, presented: GpuEngineVideoPresentedFrame,
  paintExpected?: PreparedNativeMotionPaintReceiptExpectations, floatingReceiptGraph?: EngineRenderGraph): ResidentEngineVideoBakedIds {
const next = { preview };
const sceneLinearAces2OutputTransform = sceneLinearAces2Output(preview.graph);
const receipt = presented.receipt;
if (receipt.timelineFrame !== preview.timelineFrame) throw new Error("原生預覽回執不是指定影格");
if (preview.graph.nodes.some(node => node.kind === "floating_video_frame_2d") && floatingReceiptGraph !== preview.graph) {
  throw new Error("原生浮空影片影格缺少此 session 的同 graph 載入收據 owner");
}
assertNativeFloatingFrameReceipt(preview.graph, preview.timelineFrame, receipt);
const frame = receipt.frame;
const coverageComplete = receipt.engineGraph.directExecution === true
  && !receipt.engineGraph.blockedNodeIds.length && !receipt.engineGraph.ignoredNodeIds.length
  && preview.graph.nodes.every(node => receipt.engineGraph.executedNodeIds.includes(node.id));
const expectedLayers = expectedEngineVideoLayers(next.preview.graph);
const expectedControllers = expectedEngineVideoControllers(next.preview.graph);
const expectedCaptions = expectedEngineVideoCaptions(next.preview.graph);
const expectedActiveCaptions = expectedCaptions.filter((caption) => captionActiveAt(caption, next.preview.timelineFrame));
const expectedMotionGraphics = expectedEngineVideoMotionGraphics(next.preview.graph);
const expectedNativePaints = expectedEngineVideoNativeMotionPaints(next.preview.graph);
if (expectedNativePaints.length && !paintExpected) throw new Error("原生 paint 影格缺少此 session 的載入收據 owner");
const nativePaintWork = paintExpected ? assertNativeMotionPaintFrameReceipt(paintExpected, preview.timelineFrame, receipt) : undefined;
const expectedParticles = expectedEngineVideoParticles(next.preview.graph);
const expectedActiveMotionGraphics = expectedMotionGraphics
  .filter((graphic) => motionGraphicExpectedSample(graphic, next.preview.graph, next.preview.timelineFrame) !== undefined);
const expectedAdjustments = expectedEngineVideoAdjustments(next.preview.graph);
const sceneLinearAces2 = sceneLinearAces2OutputTransform !== undefined;
const expectedMatteCount = expectedLayers.filter((layer) => layer.matteLayerIndex !== undefined).length;
const expectedActiveAdjustments = expectedAdjustments
  .filter((adjustment) => adjustmentActiveAt(adjustment, next.preview.timelineFrame));
const activeCaptionsValid = receipt.captionTextureUploads === expectedCaptions.length
  && (receipt.activeCaptions?.length ?? 0) === expectedActiveCaptions.length
  && (receipt.activeCaptions ?? []).every((caption, index) => captionReceiptMatches(caption, expectedActiveCaptions[index]));
const activeMotionGraphicsValid = receipt.motionGraphicTextureUploads === expectedMotionGraphics.length
  && (receipt.activeMotionGraphics?.length ?? 0) === expectedActiveMotionGraphics.length
  && (receipt.activeMotionGraphics ?? []).every((graphic, index) => motionGraphicReceiptMatches(graphic, expectedActiveMotionGraphics[index], next.preview.graph, next.preview.timelineFrame));
const activeAdjustmentsValid = (receipt.adjustmentPassCount ?? 0) === expectedActiveAdjustments.length
  && (receipt.activeAdjustments?.length ?? 0) === expectedActiveAdjustments.length
  && (receipt.activeAdjustments ?? []).every((adjustment, index) => adjustmentReceiptMatches(adjustment, expectedActiveAdjustments[index], next.preview.graph));
const expectedActiveParticles = receipt.active
  ? expectedParticles.filter((particle) => particleActiveAt(particle, next.preview.timelineFrame))
  : [];
const activeParticleReceipts = receipt.activeParticleEmitters
  ?? (receipt.activeParticles ? [receipt.activeParticles] : []);
const activeParticlesValid = vfxSimulationCoverageMatches(receipt.vfxSimulation, next.preview.vfxSimulationExpectation)
  && activeParticleReceipts.length === expectedActiveParticles.length
  && activeParticleReceipts.every((particle, index) => videoParticleReceiptMatches(particle, expectedActiveParticles[index], next.preview.graph, next.preview.timelineFrame))
  && videoParticleReceiptMatches(receipt.activeParticles, expectedActiveParticles[0], next.preview.graph, next.preview.timelineFrame);
const activeControllersValid = (receipt.controllers?.length ?? 0) === expectedControllers.length
  && (receipt.controllers ?? []).every((controller, index) => controllerReceiptMatches(controller, expectedControllers[index], expectedLayers, expectedControllers, next.preview.graph, next.preview.timelineFrame));
const temporalSamplingValid = temporalSamplingReceiptMatches(
  receipt.temporalSampling,
  expectedLayers,
  next.preview.graph,
  next.preview.timelineFrame,
);
const scheduledLayerFrames = (receipt.layerFrames ?? [])
  .map((layerFrame, index) => ({ layerFrame, expected: expectedLayers[index] }))
  .filter(({ layerFrame, expected }) => layerFrame.adaptiveFrameReused === false && expected?.motionBlur?.sourceSampling !== "decoded_temporal");
const sourceCacheCopyCount = Math.max(0, ...scheduledLayerFrames.map(({ layerFrame }) => layerFrame.gpuCopySubmissionLayerCount ?? 0));
const sourceCacheMissCount = scheduledLayerFrames.filter(({ layerFrame }) => layerFrame.decoderSourceCacheHit === false).length;
const sourceCacheFrameValid = (receipt.layers?.length ?? 0) <= 1 || (
  sourceCacheMissCount === sourceCacheCopyCount
  && scheduledLayerFrames.every(({ layerFrame }) => layerFrame.decodeDispatchMode === "parallel-com-apartment/v1"
    && (layerFrame.decoderSourceCacheHit === true
      ? layerFrame.gpuCopySubmissionMode === "source-cache-hit/v1" && layerFrame.gpuCopySubmissionLayerCount === 0
      : layerFrame.decoderSourceCacheHit === false && layerFrame.gpuCopySubmissionMode === "batched-copy/v1" && layerFrame.gpuCopySubmissionLayerCount === sourceCacheCopyCount))
);
const activeLayersValid = Boolean(receipt.visualLayersApplied)
  && receipt.layers?.length === receipt.layerFrames?.length
  && receipt.layers?.length === receipt.visualLayers?.length
  && Boolean(receipt.layers?.length)
  && receipt.layers!.every((layer, index) => {
    const expected = expectedLayers.find((candidate) => candidate.sourceNodeId === layer.sourceNodeId && candidate.assetId === layer.assetId);
    const layerFrame = receipt.layerFrames?.[index];
    const expectedIndex = expected ? expectedLayers.indexOf(expected) : -1;
    const cadence = expectedIndex >= 0 ? engineVideoDecodeCadence(expected!, expectedIndex, expectedLayers.length) : undefined;
    const decodedTemporal = expected?.motionBlur?.sourceSampling === "decoded_temporal";
    const adaptiveReceiptValid = cadence !== undefined
      && layerFrame?.decodeCadenceDivisor === cadence.divisor
      && layerFrame.decodeCadencePhase === cadence.phase
      && Number.isInteger(layerFrame.adaptiveFrameAgeFrames)
      && layerFrame.adaptiveFrameAgeFrames! >= 0
      && layerFrame.adaptiveFrameAgeFrames! <= cadence.divisor - 1
      && layerFrame.adaptiveFrameReused === (layerFrame.adaptiveFrameAgeFrames! > 0)
      && sameF32(layerFrame.presentationTargetSeconds!, layer.sourceTimeSeconds);
    return Boolean(expected) && layerFrame?.frameRingSlot === layer.frame.frameRingSlot
      && layerFrame?.gpuSubmissionSequence === layer.frame.gpuSubmissionSequence
      && (receipt.layers!.length === 1 || decodedTemporal
        ? layerFrame?.decodeDispatchMode == null
        : layerFrame?.decodeDispatchMode === "parallel-com-apartment/v1")
      && layerFrame?.clockTargetSeconds === layer.frame.clockTargetSeconds
      && adaptiveReceiptValid
      && layerFrame?.decodePathCpuPixelCopies === 0 && layerFrame.stagingCpuPixelReadbacks === 0
      && layerFrame.nativeSurfacePresented === true && layerFrame.nativeSurfaceCpuPixelReadbacks === 0
      && layer.transformNodeId === expected!.transformNodeId
      && (layer.parentTransformNodeId ?? undefined) === expected!.parentTransformNodeId
      && (layer.parentLayerIndex ?? undefined) === expected!.parentLayerIndex
      && (layer.parentControllerIndex ?? undefined) === expected!.parentControllerIndex
      && layer.parentDepth === expected!.parentDepth
      && (layer.matteLayerIndex ?? undefined) === expected!.matteLayerIndex && (layer.matteMode ?? undefined) === expected!.matteMode
      && JSON.stringify(layer.precompositionNodeIds) === JSON.stringify(expected!.precompositionNodeIds)
      && JSON.stringify(layer.nestedGraphIds) === JSON.stringify(expected!.nestedGraphIds)
      && motionBlurReceiptMatches(layer.motionBlur, expected!)
      && engineVisualMatches(layer.visualGraph, expected!, expectedLayers, expectedControllers, next.preview.graph, next.preview.timelineFrame, true)
      && engineVisualMatches(receipt.visualLayers![index], expected!, expectedLayers, expectedControllers, next.preview.graph, next.preview.timelineFrame, true);
  });
const activeSurfaceLayerCount = (receipt.layers?.length ?? 0) + activeParticleReceipts.length + (receipt.activeCaptions?.length ?? 0)
  + (receipt.activeMotionGraphics?.length ?? 0) + (nativePaintWork?.activeGraphicIds.length ?? 0);
const fusedCompositeValid = receipt.surface.compositeExecutionMode === "fused-four-layer/v1"
  && receipt.surface.compositeLayerCount === activeSurfaceLayerCount
  && receipt.surface.compositeDirtyRectLayerCount === 0
  && receipt.surface.compositeTextureCopyCount === 0
  && receipt.surface.compositeMaximumLayersPerPass === 4
  && receipt.surface.compositeFullFramePassCount === Math.ceil(activeSurfaceLayerCount / 4);
const dirtyRectCompositeValid = receipt.surface.compositeExecutionMode === "dirty-rect-ping-pong/v1"
  && receipt.surface.compositeLayerCount === activeSurfaceLayerCount
  && Number.isInteger(receipt.surface.compositeDirtyRectLayerCount)
  && receipt.surface.compositeDirtyRectLayerCount! >= 0
  && receipt.surface.compositeDirtyRectLayerCount! < activeSurfaceLayerCount
  && receipt.surface.compositeTextureCopyCount === receipt.surface.compositeDirtyRectLayerCount
  && receipt.surface.compositeMaximumLayersPerPass === 1
  && receipt.surface.compositeFullFramePassCount === activeSurfaceLayerCount - receipt.surface.compositeDirtyRectLayerCount! + 1;
const compositeExecutionValid = sceneLinearAces2
  ? sceneLinearCompositeReceiptMatches(receipt, activeSurfaceLayerCount, expectedActiveAdjustments.length)
  : activeSurfaceLayerCount <= 1 || fusedCompositeValid || dirtyRectCompositeValid;
const matteExecutionValid = matteExecutionReceiptMatches(receipt, sceneLinearAces2);
const effectExecutionValid = !sceneLinearAces2 || sceneLinearEffectReceiptMatches(receipt);
const sceneLinearAdjustmentMode = expectedActiveAdjustments.length === 0 ? "none"
  : expectedActiveCaptions.length + expectedActiveMotionGraphics.length + (nativePaintWork?.activeGraphicIds.length ?? 0) > 0
  ? "pre-typography-scene-linear/v1" : "trailing-scene-linear/v1";
const adjustmentExecutionValid = sceneLinearAces2
  ? receipt.adjustmentExecutionMode === sceneLinearAdjustmentMode
    && (receipt.adjustmentPassCount ?? 0) === expectedActiveAdjustments.length
    && (receipt.adjustmentBaseLayerCount ?? activeSurfaceLayerCount) === (sceneLinearAdjustmentMode === "pre-typography-scene-linear/v1" ? receipt.layers?.length ?? 0 : activeSurfaceLayerCount)
  : expectedActiveAdjustments.length > 0
  ? receipt.surface.adjustmentExecutionMode === "trailing-full-frame/v1"
    && receipt.surface.adjustmentPassCount === expectedActiveAdjustments.length
  : (receipt.surface.adjustmentExecutionMode == null || receipt.surface.adjustmentExecutionMode === "none")
    && (receipt.surface.adjustmentPassCount ?? 0) === 0;
const sceneLinearContractValid = !sceneLinearAces2
  || sceneLinearAces2PresentContractValid(receipt, sceneLinearAces2OutputTransform, activeSceneLinearInputTransform(expectedLayers, next.preview.timelineFrame), nativePaintWork?.cpuPixelCopies ?? 0);
const activeFrameValid = receipt.active && !presented.endOfStream
  && frame?.decodePathCpuPixelCopies === 0 && frame.stagingCpuPixelReadbacks === 0
  && frame.nativeSurfacePresented === true && frame.nativeSurfaceCpuPixelReadbacks === 0
  && receipt.visualGraphApplied === true
  && activeLayersValid && activeParticlesValid && activeCaptionsValid && activeMotionGraphicsValid && activeAdjustmentsValid && activeControllersValid
  && scene25dCoverageMatches(receipt.scene25d, next.preview.scene25dExpectation, next.preview.graph, next.preview.timelineFrame)
  && depthOfFieldCoverageMatches(receipt.depthOfField, next.preview.graph, next.preview.timelineFrame)
  && compositeExecutionValid && adjustmentExecutionValid && matteExecutionValid && effectExecutionValid && sceneLinearContractValid && sourceCacheFrameValid && temporalSamplingValid;
const inactiveFrameValid = !receipt.active && receipt.nativeSurfaceCleared === true
  && activeParticlesValid && activeCaptionsValid && activeMotionGraphicsValid && activeAdjustmentsValid && activeControllersValid && adjustmentExecutionValid;
const resourcePlanValid = engineVideoResourcePlanMatches(
  receipt.resourcePlan,
  next.preview.graph,
  expectedLayers.length,
  expectedParticles.length + expectedCaptions.length + expectedMotionGraphics.length + expectedNativePaints.length,
  expectedAdjustments.length,
  expectedMatteCount,
  expectedParticles.length,
);
const decodeScheduleValid = engineVideoDecodeScheduleMatches(receipt.decodeSchedule, expectedLayers);
const presentChecks = {
  coverage: coverageComplete,
  resourcePlan: resourcePlanValid,
  decodeSchedule: decodeScheduleValid,
  surface: sceneLinearAces2OutputTransform
    ? nativeAces2PreviewSurfaceValid(receipt.surface, sceneLinearAces2OutputTransform)
    : graphSdrNativeSurfaceValid(receipt.surface, next.preview.graph),
  sceneLinear: sceneLinearContractValid,
  activeOrClearedFrame: activeFrameValid || inactiveFrameValid,
};
const failedPresentChecks = Object.entries(presentChecks).filter(([, valid]) => !valid).map(([name]) => name);
if (failedPresentChecks.length) {
  throw new Error(`共同影片 Engine Graph 沒有完成可驗證的 swap-chain 呈現：${failedPresentChecks.join(", ")}`);
}
// Legacy resources are verified at load for the entire resident timeline. Their
// IDs prevent DOM duplicates during autonomous playback between diagnostics.
// Native paint IDs describe only the exact frame just validated above.
const compositedMotionIds = new Set([...expectedMotionGraphics.map(node => String(node.graphicId)), ...(nativePaintWork?.activeGraphicIds ?? [])]);
return {
  motionGraphicIds: preview.graph.nodes.filter(node => (node.kind === "motion_graphic" || node.kind === "native_motion_paint") && compositedMotionIds.has(String(node.graphicId)))
    .map(node => String(node.graphicId)),
  captionIds: expectedCaptions.map(node => String(node.cueId)),
};
}
