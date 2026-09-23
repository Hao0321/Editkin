import type { EngineNode, EngineRenderGraph } from "../render/engineGraph";
import type { GpuEnginePreviewGraph, GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { depthOfFieldGraphKeyframes, sampleDepthOfFieldNode } from "../render/depthOfFieldAnimation";
import { sampleScene25dCameraNode, scene25dCameraGraphKeyframes } from "../render/scene25dCameraAnimation";
import { sampleScene25dLightNode, scene25dLightGraphKeyframes } from "../render/scene25dLightAnimation";

interface NativePreviewBoundsLike {
  x: number;
  y: number;
  width: number;
  height: number;
  revision: number;
  surfaceColorSpace?: "srgb" | "rec2100_pq_1000";
}

export type NativeAces2PreviewOutput = "rec709_sdr" | "rec2100_pq_1000";

const ACES2_DISPLAY_CONTRACTS = {
  rec709_sdr: {
    processor: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1",
    loadTransform: "aces2_rec709_sdr",
    lutSha256: "0808837eb979b6f59e79db411f6bd861469456a89bf399ffe652a99bf0c454b3",
    lutPayloadSha256: null,
  },
  rec2100_pq_1000: {
    processor: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
    loadTransform: "aces2_rec2100_pq1000",
    lutSha256: "0cad3aecbc3c5e12aec4f0c489bea6eb5a3a4c0e322aa28010468b856b6b121f",
    lutPayloadSha256: "2c400e0cb185ba44ceecf19aae2ddbd5d90a976f39f43d324ff8bc118ef9f7e1",
  },
} as const;

export function sceneLinearAces2Output(graph: EngineRenderGraph): NativeAces2PreviewOutput | undefined {
  const processor = graph.nodes.find((node) => node.kind === "color")?.processor;
  return (Object.entries(ACES2_DISPLAY_CONTRACTS) as Array<[NativeAces2PreviewOutput, typeof ACES2_DISPLAY_CONTRACTS[NativeAces2PreviewOutput]]>)
    .find(([, contract]) => contract.processor === processor)?.[0];
}

export function nativeAces2PreviewLoadTransform(output: NativeAces2PreviewOutput): typeof ACES2_DISPLAY_CONTRACTS[NativeAces2PreviewOutput]["loadTransform"] {
  return ACES2_DISPLAY_CONTRACTS[output].loadTransform;
}

export function scene25dCoverageMatches(
  receipt: import("./types").GpuEngineScene25dCoverage | null | undefined,
  expected: GpuEnginePreviewGraph["scene25dExpectation"],
  graph?: EngineRenderGraph,
  timelineFrame = 0,
): boolean {
  if (!expected) return receipt == null;
  const camera = graph?.nodes.find((candidate) => candidate.id === expected.cameraNodeId && candidate.kind === "camera");
  if (!camera) return false;
  const cameraSample = sampleScene25dCameraNode(camera, timelineFrame);
  const cameraKeyframeCount = scene25dCameraGraphKeyframes(camera).length;
  const ambient = graph?.nodes.find((candidate) => candidate.kind === "light" && candidate.lightKind === "ambient");
  const directional = graph?.nodes.find((candidate) => candidate.kind === "light" && candidate.lightKind === "directional");
  if (!ambient || !directional) return false;
  const ambientSample = sampleScene25dLightNode(ambient, timelineFrame);
  const directionalSample = sampleScene25dLightNode(directional, timelineFrame);
  const ambientKeyframeCount = scene25dLightGraphKeyframes(ambient).length;
  const directionalKeyframeCount = scene25dLightGraphKeyframes(directional).length;
  const lightKeyframeCount = ambientKeyframeCount + directionalKeyframeCount;
  const residentVideoDepth = expected.videoPlaneCount !== undefined;
  return receipt?.sceneContract === "single_camera_textured_planes/v1"
    && receipt.planeCount === expected.planeCount
    && (expected.videoPlaneCount === undefined || receipt.videoPlaneCount === expected.videoPlaneCount)
    && receipt.parentedPlaneCount === expected.parentedPlaneCount
    && receipt.cameraNodeId === expected.cameraNodeId
    && receipt.cameraAnimationContract === (cameraKeyframeCount ? "timeline-keyframes/v1" : "static/v1")
    && receipt.cameraKeyframeCount === cameraKeyframeCount
    && receipt.sampledTimelineFrame === (cameraKeyframeCount ? timelineFrame : 0)
    && receipt.cameraPosition.every((value, index) => sameF32(value, cameraSample.position[index]))
    && receipt.cameraTarget.every((value, index) => sameF32(value, cameraSample.target[index]))
    && sameF32(receipt.cameraVerticalFovRadians, cameraSample.verticalFovRadians)
    && receipt.ambientLightCount === 1
    && receipt.directionalLightCount === 1
    && receipt.lightAnimationContract === (lightKeyframeCount ? "timeline-keyframes/v1" : "static/v1")
    && receipt.ambientLightKeyframeCount === ambientKeyframeCount && receipt.directionalLightKeyframeCount === directionalKeyframeCount
    && receipt.sampledLightTimelineFrame === (lightKeyframeCount ? timelineFrame : 0)
    && receipt.ambientLightColor.every((value, index) => sameF32(value, ambientSample.color[index]))
    && sameF32(receipt.ambientLightIntensity, ambientSample.intensity)
    && receipt.directionalLightColor.every((value, index) => sameF32(value, directionalSample.color[index]))
    && sameF32(receipt.directionalLightIntensity, directionalSample.intensity)
    && receipt.directionalLightDirection.every((value, index) => sameF32(value, directionalSample.direction[index]))
    && (residentVideoDepth
      ? receipt.depthMode === "per_pixel_opaque_plane_depth32float" && receipt.depthFormat === "depth32_float"
        && receipt.depthTestedPlaneCount === expected.planeCount && receipt.depthPassCount === 1
        && receipt.geometryExecutor === "hao-core-native-camera-matrix-depth-plane/v1"
        && receipt.pixelExecutor === "wgpu-projective-plane-depth-compositor/v1"
      : receipt.depthMode === "non_intersecting_plane_average_depth_back_to_front" && receipt.depthFormat === "none"
        && receipt.depthTestedPlaneCount === 0 && receipt.depthPassCount === 0
        && receipt.geometryExecutor === "hao-core-native-camera-matrix/v1"
        && receipt.pixelExecutor === "wgpu-projective-plane-compositor/v1");
}

export function depthOfFieldCoverageMatches(
  receipt: import("./types").GpuEngineDepthOfFieldCoverage | null | undefined,
  graph: EngineRenderGraph,
  timelineFrame = 0,
): boolean {
  const node = graph.nodes.find((candidate) => candidate.kind === "depth_of_field");
  if (!node) return receipt == null;
  const camera = graph.nodes.find((candidate) => candidate.id === node.inputs[1] && candidate.kind === "camera");
  const sample = sampleDepthOfFieldNode(node, timelineFrame);
  const keyframeCount = depthOfFieldGraphKeyframes(node).length;
  return Boolean(camera)
    && receipt?.contract === "camera_depth_of_field/v1" && receipt.nodeId === node.id
    && sameF32(receipt.focusDistance, sample.focusDistance) && sameF32(receipt.aperture, sample.aperture)
    && sameF32(receipt.maxBlurRadius, sample.maxBlurRadius) && sameF32(receipt.near, camera!.near) && sameF32(receipt.far, camera!.far)
    && receipt.animationContract === (keyframeCount ? "timeline-keyframes/v1" : "static/v1")
    && receipt.keyframeCount === keyframeCount && receipt.sampledTimelineFrame === timelineFrame
    && receipt.executionMode === "scene-linear-depth32f-gather-dof/v1" && receipt.depthSource === "depth32_float"
    && receipt.executor === "wgpu-depth-aware-gather/v1" && receipt.passCount === 1;
}

export function vfxSimulationCoverageMatches(
  receipt: import("./types").GpuEngineVfxSimulationCoverage | null | undefined,
  expected: GpuEnginePreviewGraph["vfxSimulationExpectation"],
): boolean {
  if (!expected) return receipt == null;
  return receipt?.simulationContract === "screen_space_analytic_particles/v1"
    && receipt.emitterCount === expected.emitterCount
    && receipt.particleCeiling === expected.particleCeiling
    && receipt.dimension === "screen_space_2d"
    && receipt.seedMode === "fixed_u32_hash_per_birth"
    && receipt.timeSource === "rational_node_local_frame"
    && receipt.executor === expected.executor;
}

export function videoParticleReceiptMatches(
  receipt: import("./types").GpuEngineVideoParticleReceipt | null | undefined,
  expected: EngineNode | undefined,
  graph: GpuEngineVideoPreviewGraph["graph"],
  timelineFrame: number,
): boolean {
  if (!expected) return receipt == null;
  const timeline = expected.timeline as { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number } | undefined;
  if (!timeline) return false;
  const localFrame = timelineFrame - timeline.timelineStartFrame;
  const expectedTime = localFrame * graph.timebase.numerator / graph.timebase.denominator;
  return receipt?.nodeId === expected.id
    && receipt.timelineFrame === timelineFrame
    && receipt.localFrame === localFrame
    && JSON.stringify(receipt.timeline) === JSON.stringify(timeline)
    && sameF32(receipt.timeSeconds, expectedTime)
    && receipt.seed === expected.seed
    && receipt.particleCeiling === expected.maxParticles
    && receipt.executor === "wgpu-resident-video-particle-overlay/v1"
    && receipt.gpuTextureWrites >= 1
    && receipt.uniformParameterWrites === receipt.gpuTextureWrites
    && receipt.cpuPixelUploads === 0 && receipt.cpuPixelReadbacks === 0
    && receipt.queueSubmissionMode === "ordered-same-device/v1"
    && receipt.snapshotCache?.schema === "editkin.resident-particle-seek-snapshot/v1"
    && receipt.snapshotCache.capacity === 2
    && typeof receipt.snapshotCache.hit === "boolean"
    && receipt.snapshotCache.computeTextureWrites === receipt.gpuTextureWrites
    && receipt.snapshotCache.snapshotCopies === receipt.snapshotCache.computeTextureWrites
    && receipt.snapshotCache.hits >= 0 && receipt.snapshotCache.misses >= 1
    && receipt.snapshotCache.hits + receipt.snapshotCache.misses >= 1
    && receipt.snapshotCache.cpuPixelCopies === 0
    && receipt.snapshotCache.cachedLocalFrames.length <= 2
    && receipt.snapshotCache.cachedLocalFrames.every((frame) => Number.isSafeInteger(frame) && frame >= 0);
}

export function particleActiveAt(expected: EngineNode | undefined, timelineFrame: number): boolean {
  const timeline = expected?.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
  return Boolean(timeline && timelineFrame >= timeline.timelineStartFrame
    && timelineFrame < timeline.timelineStartFrame + timeline.durationFrames);
}

export function boundsKey(bounds: NativePreviewBoundsLike): string {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${bounds.revision}:${bounds.surfaceColorSpace ?? "srgb"}`;
}

export function legacySdrNativeSurfaceValid(surface: import("./types").GpuNativePreviewSurface): boolean {
  return surface.bound === true
    && surface.backend === "Dx12"
    && surface.nativeSwapChain === true
    && surface.cpuPixelReadbacks === 0
    && surface.surfaceColorSpace === "Auto"
    && surface.requestedColorSpace === "srgb"
    && surface.pixelContract === "legacy-sdr-video/v1"
    && surface.hdrTransportConfigured === false
    && surface.legacyVideoPresentationAllowed === true
    && surface.dxgiColorSpaceConfiguration === "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1"
    && surface.physicalDisplayHdrVisibility === "advisory-unverified"
    && surface.displayHdrInfo?.advisoryOnly === true;
}

/** Session-wide profile follows the authored execution contract, including zero gains. */
export function graphRequiresRec709SdrV2(graph: EngineRenderGraph): boolean {
  return graph.nodes.some(node => node.kind === "color" && node.processor === "editkin-rec709-primary/v2");
}

export function legacyVideoFallbackAllowed(graph: EngineRenderGraph | undefined): boolean {
  return !graph || !graphRequiresRec709SdrV2(graph);
}

export function rec709SdrV2NativeSurfaceValid(surface: import("./types").GpuNativePreviewSurface): boolean {
  return surface.surfaceFormat === "Bgra8Unorm" && surface.pixelContract === "rec709-encoded-sdr-video/v2"
    && legacySdrNativeSurfaceValid({ ...surface, pixelContract: "legacy-sdr-video/v1" });
}

export function graphSdrNativeSurfaceValid(surface: import("./types").GpuNativePreviewSurface, graph: EngineRenderGraph): boolean {
  return graphRequiresRec709SdrV2(graph) ? rec709SdrV2NativeSurfaceValid(surface) : legacySdrNativeSurfaceValid(surface);
}

export function activeSceneLinearInputTransform(layers: import("./residentGpuPreviewExpectations").ExpectedEngineVideoLayer[], frame: number): "editkin-srgb-to-linear-rec709-primary/v1" | "editkin-rec709-to-linear-rec709-primary/v2" {
  const active = layers.filter(layer => { const t = layer.source.timeline as {timelineStartFrame:number;durationFrames:number}; return t && frame >= t.timelineStartFrame && frame < t.timelineStartFrame + t.durationFrames; });
  const participating = [...active, ...active.flatMap(layer => layer.matteLayerIndex === undefined ? [] : [layers[layer.matteLayerIndex]])];
  return participating.some(layer => layer?.grade.processor === "editkin-rec709-to-linear-rec709-primary/v2")
    ? "editkin-rec709-to-linear-rec709-primary/v2" : "editkin-srgb-to-linear-rec709-primary/v1";
}

export function pqHdrNativeSurfaceValid(surface: import("./types").GpuNativePreviewSurface): boolean {
  return surface.bound === true
    && surface.backend === "Dx12"
    && surface.nativeSwapChain === true
    && surface.cpuPixelReadbacks === 0
    && surface.surfaceFormat === "Rgb10a2Unorm"
    && surface.surfaceColorSpace === "Bt2100Pq"
    && (surface.requestedColorSpace === "rec2100_pq_1000" || surface.requestedColorSpace === "bt2100_pq")
    && surface.pixelContract === "rec2020-pq-encoded-rgb/v1"
    && surface.hdrTransportConfigured === true
    && surface.legacyVideoPresentationAllowed === false
    && surface.dxgiColorSpaceConfiguration === "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1"
    && surface.physicalDisplayHdrVisibility === "advisory-unverified"
    && surface.displayHdrInfo?.advisoryOnly === true;
}

export function nativeAces2PreviewSurfaceValid(
  surface: import("./types").GpuNativePreviewSurface,
  output: NativeAces2PreviewOutput,
): boolean {
  return output === "rec709_sdr" ? legacySdrNativeSurfaceValid(surface) : pqHdrNativeSurfaceValid(surface);
}

export function sceneLinearAces2PresentContractValid(
  receipt: import("./types").GpuEngineVideoPresentedFrame["receipt"],
  output: NativeAces2PreviewOutput = "rec709_sdr",
  expectedInputTransform: "editkin-srgb-to-linear-rec709-primary/v1" | "editkin-rec709-to-linear-rec709-primary/v2" = "editkin-srgb-to-linear-rec709-primary/v1",
): boolean {
  const display = ACES2_DISPLAY_CONTRACTS[output];
  const effectReceiptValid = (receipt.effectExecutionMode === "none" || receipt.effectExecutionMode === "scene-linear-bounded-effect-stack/v1")
    && Number.isInteger(receipt.shaderOperationCount) && receipt.shaderOperationCount! >= 0
    && Number.isInteger(receipt.builtInEffectCount) && receipt.builtInEffectCount! >= 0;
  const matteReceiptValid = (receipt.matteExecutionMode === "none" || receipt.matteExecutionMode === "sampled-track-matte-scene-linear/v1")
    && Number.isInteger(receipt.mattePassCount) && receipt.mattePassCount! >= 0;
  const temporalReceiptValid = (receipt.temporalExecutionMode === "none" || receipt.temporalExecutionMode === "decoded-temporal-shutter-scene-linear/v1")
    && Number.isInteger(receipt.temporalLayerCount) && receipt.temporalLayerCount! >= 0
    && Number.isInteger(receipt.temporalSampleTextureCount) && receipt.temporalSampleTextureCount! >= 0
    && (receipt.temporalExecutionMode === "none"
      ? receipt.temporalLayerCount === 0 && receipt.temporalSampleTextureCount === 0
      : receipt.temporalLayerCount! >= 1 && receipt.temporalSampleTextureCount! >= receipt.temporalLayerCount! * 2);
  const depthReceiptValid = receipt.depthExecutionMode === "none"
    ? receipt.depthFormat === "none" && receipt.depthTestedLayerCount === 0 && receipt.depthPassCount === 0
    : receipt.depthExecutionMode === "scene-linear-depth32f-opaque-planes/v1" && receipt.depthFormat === "depth32_float"
      && Number.isInteger(receipt.depthTestedLayerCount) && receipt.depthTestedLayerCount! > 0 && receipt.depthPassCount === 1;
  const dof = receipt.depthOfField;
  const depthOfFieldReceiptValid = receipt.depthOfFieldExecutionMode === "none"
    ? receipt.depthOfFieldDepthSource === "none" && receipt.depthOfFieldPassCount === 0 && dof == null
    : receipt.depthOfFieldExecutionMode === "scene-linear-depth32f-gather-dof/v1" && receipt.depthOfFieldDepthSource === "depth32_float"
      && receipt.depthOfFieldPassCount === 1 && receipt.depthExecutionMode === "scene-linear-depth32f-opaque-planes/v1"
      && dof?.contract === "camera_depth_of_field/v1" && dof.executionMode === receipt.depthOfFieldExecutionMode
      && dof.depthSource === "depth32_float" && dof.executor === "wgpu-depth-aware-gather/v1" && dof.passCount === 1
      && Number.isFinite(dof.focusDistance) && dof.focusDistance > dof.near && dof.focusDistance < dof.far
      && Number.isFinite(dof.aperture) && dof.aperture > 0 && dof.aperture <= 16
      && Number.isFinite(dof.maxBlurRadius) && dof.maxBlurRadius >= 1 && dof.maxBlurRadius <= 32;
  return receipt.sceneLinearExecution === true
    && receipt.workingColorSpace === "linear_rec709"
    && receipt.workingFormat === "rgba16_float"
    && receipt.displayTransform === display.processor
    && receipt.outputSpace === output
    && receipt.lutSha256 === display.lutSha256
    && receipt.lutPayloadSha256 === display.lutPayloadSha256
    && receipt.inputTransform === expectedInputTransform
    && receipt.ocioVersion === "2.5.2" && receipt.acesVersion === "2.0"
    && receipt.configSha256 === "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a"
    && receipt.productPathCpuPixelCopies === 0
    && nativeAces2PreviewSurfaceValid(receipt.surface, output)
    && effectReceiptValid && temporalReceiptValid && matteReceiptValid && depthReceiptValid && depthOfFieldReceiptValid;
}

export function sceneLinearCompositeReceiptMatches(
  receipt: import("./types").GpuEngineVideoPresentedFrame["receipt"], activeSurfaceLayerCount: number, adjustmentCount: number,
): boolean {
  if (receipt.compositeLayerCount !== activeSurfaceLayerCount) return false;
  if (receipt.compositeExecutionMode === "scene-linear-rgba16f-ping-pong/v1") {
    return receipt.compositeMaximumLayersPerPass === 1
      && receipt.compositeFullFramePassCount === activeSurfaceLayerCount + adjustmentCount + 1;
  }
  if (adjustmentCount !== 0 || receipt.compositeMaximumLayersPerPass !== activeSurfaceLayerCount
    || receipt.depthExecutionMode !== "scene-linear-depth32f-opaque-planes/v1"
    || receipt.depthFormat !== "depth32_float" || receipt.depthTestedLayerCount !== activeSurfaceLayerCount || receipt.depthPassCount !== 1) return false;
  return receipt.compositeExecutionMode === "scene-linear-depth32f-opaque-planes/v1"
    ? receipt.compositeFullFramePassCount === 2 && receipt.depthOfFieldExecutionMode === "none"
    : receipt.compositeExecutionMode === "scene-linear-depth32f-gather-dof/v1"
      && receipt.compositeFullFramePassCount === 3 && receipt.depthOfFieldExecutionMode === "scene-linear-depth32f-gather-dof/v1";
}

export function sceneLinearEffectReceiptMatches(receipt: import("./types").GpuEngineVideoPresentedFrame["receipt"]): boolean {
  const visuals = [
    ...(receipt.visualLayers ?? []),
    ...(receipt.activeAdjustments ?? []).map((adjustment) => adjustment.visualGraph),
  ];
  const shaderOperations = visuals.reduce((count, visual) => count + visual.shaderOpCount, 0);
  const builtInEffects = visuals.filter((visual) => visual.effectKind !== 0).length;
  return receipt.effectExecutionMode === (shaderOperations + builtInEffects > 0 ? "scene-linear-bounded-effect-stack/v1" : "none")
    && receipt.shaderOperationCount === shaderOperations
    && receipt.builtInEffectCount === builtInEffects;
}

export function matteExecutionReceiptMatches(receipt: import("./types").GpuEngineVideoPresentedFrame["receipt"], sceneLinearAces2: boolean): boolean {
  const matteCount = (receipt.layers ?? []).filter((layer) => layer.matteLayerIndex !== null && layer.matteLayerIndex !== undefined).length;
  if (sceneLinearAces2) return matteCount > 0
    ? receipt.matteExecutionMode === "sampled-track-matte-scene-linear/v1" && receipt.mattePassCount === matteCount
    : receipt.matteExecutionMode === "none" && receipt.mattePassCount === 0;
  return matteCount > 0
    ? receipt.surface.matteExecutionMode === "sampled-track-matte/v1" && receipt.surface.mattePassCount === matteCount
    : (receipt.surface.matteExecutionMode == null || receipt.surface.matteExecutionMode === "none") && (receipt.surface.mattePassCount ?? 0) === 0;
}

export function captionReceiptMatches(receipt: import("./types").GpuEngineVideoCaptionReceipt, expected: EngineNode): boolean {
  const timeline = expected.timeline as { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number } | undefined;
  const glyphCount = [...String(expected.text)].filter((character) => !/\s/u.test(character)).length;
  return receipt.nodeId === expected.id && receipt.cueId === expected.cueId
    && Boolean(timeline) && receipt.timeline.timelineStartFrame === timeline?.timelineStartFrame
    && receipt.timeline.sourceStartFrame === timeline?.sourceStartFrame && receipt.timeline.durationFrames === timeline?.durationFrames
    && receipt.fontFamily === expected.fontFamily && receipt.textColor === expected.textColor
    && receipt.singleTextColor === true && receipt.textureUploadCount === 1
    && receipt.glyphCount === glyphCount && receipt.missingGlyphCount === 0
    && /^[a-f0-9]{64}$/.test(receipt.fontSha256) && /^[a-f0-9]{64}$/.test(receipt.atlasSha256);
}

export function captionActiveAt(caption: EngineNode, timelineFrame: number): boolean {
  const timeline = caption.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
  return Boolean(timeline && timelineFrame >= timeline.timelineStartFrame && timelineFrame < timeline.timelineStartFrame + timeline.durationFrames);
}

type TrackingQuad = [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];

export function motionGraphicExpectedSample(graphic: EngineNode, graph: GpuEngineVideoPreviewGraph["graph"], timelineFrame: number): { opacity: number; translateX: number; translateY: number; scale: number; rotationRadians: number; trackingX?: number; trackingY?: number; trackingConfidence?: number; trackingStatus?: "tracked" | "held" | "manual"; trackingRotationRadians?: number; trackingScale?: number; destinationQuad?: TrackingQuad } | undefined {
  const timeline = graphic.timeline as { timelineStartFrame: number; durationFrames: number } | undefined;
  if (!timeline || timelineFrame < timeline.timelineStartFrame || timelineFrame >= timeline.timelineStartFrame + timeline.durationFrames) return undefined;
  const framesForMs = (milliseconds: number) => Math.round(milliseconds * graph.timebase.denominator / (1_000 * graph.timebase.numerator));
  const fadeInFrames = Math.min(framesForMs(180), Math.floor(timeline.durationFrames / 2));
  const fadeOutFrames = Math.min(framesForMs(140), Math.floor(timeline.durationFrames / 2));
  const local = timelineFrame - timeline.timelineStartFrame;
  const remaining = timeline.durationFrames - local;
  const fadeIn = Math.min(fadeInFrames ? local / fadeInFrames : 1, 1);
  const fadeOut = Math.min(fadeOutFrames ? remaining / fadeOutFrames : 1, 1);
  const opacity = Math.min(fadeIn, fadeOut, 1);
  const entryEaseOut = 1 - (1 - fadeIn) ** 3;
  const translateY = graphic.animation === "slide_up" ? (1 - entryEaseOut) * 48 - (1 - fadeOut) * 24 : 0;
  const exitScale = fadeOut >= 1 ? 1 : .94 + .06 * fadeOut;
  let scale = 1;
  if (graphic.animation === "pop") scale = (.7 + .3 * entryEaseOut) * exitScale;
  if (graphic.animation === "spring_soft") {
    const springScale = fadeIn >= 1 ? 1 : fadeIn <= .6
      ? .82 + .24 * (1 - (1 - fadeIn / .6) ** 3)
      : 1.06 - .06 * (1 - (1 - (fadeIn - .6) / .4) ** 3);
    scale = springScale * exitScale;
  }
  const tracking = graphic.tracking as { trackId: string; samples: Array<{ timelineFrame: number; x: number; y: number; confidence: number; status: "tracked" | "held" | "lost" | "manual"; rotationRadians: number; scale: number; destinationQuad?: TrackingQuad }> } | undefined;
  if (!tracking) return { opacity, translateX: 0, translateY, scale, rotationRadians: 0 };
  const nextIndex = tracking.samples.findIndex((sample) => sample.timelineFrame >= timelineFrame);
  const next = nextIndex < 0 ? tracking.samples.at(-1) : tracking.samples[nextIndex];
  if (!next) return undefined;
  let tracked = next;
  if (next.timelineFrame !== timelineFrame && nextIndex > 0) {
    const previous = tracking.samples[nextIndex - 1];
    if (previous.status === "lost") return undefined;
    if (next.status === "lost") tracked = { ...previous, timelineFrame, status: "held" };
    else {
      const ratio = (timelineFrame - previous.timelineFrame) / Math.max(1, next.timelineFrame - previous.timelineFrame);
      tracked = {
        timelineFrame, x: previous.x + (next.x - previous.x) * ratio, y: previous.y + (next.y - previous.y) * ratio,
        confidence: previous.confidence + (next.confidence - previous.confidence) * ratio,
        rotationRadians: previous.rotationRadians + (next.rotationRadians - previous.rotationRadians) * ratio,
        scale: previous.scale + (next.scale - previous.scale) * ratio,
        destinationQuad: previous.destinationQuad && next.destinationQuad
          ? previous.destinationQuad.map((corner, index) => ({ x: corner.x + (next.destinationQuad![index].x - corner.x) * ratio, y: corner.y + (next.destinationQuad![index].y - corner.y) * ratio })) as TrackingQuad
          : previous.destinationQuad,
        status: previous.status === "held" || next.status === "held" ? "held" : previous.status === "manual" && next.status === "manual" ? "manual" : "tracked",
      };
    }
  }
  if (tracked.status === "lost") return undefined;
  return {
    opacity,
    translateX: (tracked.x - Number(graphic.x)) * graph.width,
    translateY: (tracked.y - Number(graphic.y)) * graph.height + translateY,
    scale: scale * tracked.scale,
    rotationRadians: tracked.rotationRadians,
    trackingX: tracked.x,
    trackingY: tracked.y,
    trackingConfidence: tracked.confidence,
    trackingStatus: tracked.status,
    trackingRotationRadians: tracked.rotationRadians,
    trackingScale: tracked.scale,
    destinationQuad: tracked.destinationQuad,
  };
}

export function motionGraphicReceiptMatches(
  receipt: import("./types").GpuEngineVideoMotionGraphicReceipt,
  expected: EngineNode,
  graph: GpuEngineVideoPreviewGraph["graph"],
  timelineFrame?: number,
): boolean {
  const timeline = expected.timeline as { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number } | undefined;
  const glyphCount = [...String(expected.text)].filter((character) => !/\s/u.test(character)).length;
  const expectedSample = timelineFrame === undefined ? undefined : motionGraphicExpectedSample(expected, graph, timelineFrame);
  const expectedTracking = expected.tracking as { trackId: string; samples: unknown[] } | undefined;
  return receipt.nodeId === expected.id && receipt.graphicId === expected.graphicId && receipt.graphicKind === expected.graphicKind
    && Boolean(timeline) && receipt.timeline.timelineStartFrame === timeline?.timelineStartFrame
    && receipt.timeline.sourceStartFrame === timeline?.sourceStartFrame && receipt.timeline.durationFrames === timeline?.durationFrames
    && sameF32(receipt.x, expected.x) && sameF32(receipt.y, expected.y) && sameF32(receipt.width, expected.width)
    && sameF32(receipt.fontSize, expected.fontSize) && receipt.fontFamily === expected.fontFamily
    && receipt.fontWeight === expected.fontWeight && sameF32(receipt.letterSpacing, expected.letterSpacing)
    && sameF32(receipt.outlineWidth, expected.outlineWidth) && sameF32(receipt.shadowDepth, expected.shadowDepth)
    && sameF32(receipt.cornerRadius, expected.cornerRadius) && receipt.textColor === expected.textColor
    && receipt.backgroundColor === expected.backgroundColor && receipt.accentColor === expected.accentColor
    && receipt.visualStyle === ((expected.visualStyle as string | undefined) ?? "solid_panel")
    && receipt.animation === expected.animation && ["fade", "slide_up", "pop", "spring_soft"].includes(receipt.animation) && receipt.textureUploadCount === 1
    && (receipt.trackingMode ?? "anchor") === ((expected.trackingMode as string | undefined) ?? "anchor")
    && (receipt.trackId ?? null) === (expectedTracking?.trackId ?? null) && receipt.trackingSampleCount === (expectedTracking?.samples.length ?? 0)
    && receipt.glyphCount === glyphCount && receipt.missingGlyphCount === 0
    && /^[a-f0-9]{64}$/.test(receipt.fontSha256) && /^[a-f0-9]{64}$/.test(receipt.atlasSha256)
    && (timelineFrame === undefined || (expectedSample !== undefined
      && sameF32(receipt.sampledOpacity!, expectedSample.opacity)
      && sameF32(receipt.sampledTranslateX!, expectedSample.translateX)
      && sameF32(receipt.sampledTranslateY!, expectedSample.translateY)
      && sameF32(receipt.sampledScale!, expectedSample.scale)
      && sameF32(receipt.sampledRotationRadians!, expectedSample.rotationRadians)
      && (expectedTracking === undefined || (receipt.sampledTrackingStatus === expectedSample.trackingStatus
        && sameF32(receipt.sampledTrackingX!, expectedSample.trackingX)
        && sameF32(receipt.sampledTrackingY!, expectedSample.trackingY)
        && sameF32(receipt.sampledTrackingConfidence!, expectedSample.trackingConfidence)
        && sameF32(receipt.sampledTrackingRotationRadians!, expectedSample.trackingRotationRadians)
        && sameF32(receipt.sampledTrackingScale!, expectedSample.trackingScale)
        && sameTrackingQuad(receipt.sampledDestinationQuad, expectedSample.destinationQuad)))));
}

function sameTrackingQuad(observed: Array<{ x: number; y: number }> | null | undefined, expected: TrackingQuad | undefined): boolean {
  if (!expected) return observed == null;
  return observed?.length === 4 && observed.every((corner, index) => sameF32(corner.x, expected[index].x) && sameF32(corner.y, expected[index].y));
}

export function sameF32(observed: number, expected: unknown): boolean {
  if (typeof expected !== "number" || !Number.isFinite(observed) || !Number.isFinite(expected)) return false;
  // Graph JSON is authored with JS doubles, then parsed and evaluated as f32 by the native engine.
  // A project-pixel translation can accumulate a few f32 ULPs across subtract/multiply operations;
  // compare against that transport precision without accepting a visually meaningful receipt drift.
  const expectedF32 = Math.fround(expected);
  const tolerance = Math.max(0.000001, Math.max(Math.abs(observed), Math.abs(expectedF32)) * 2 ** -22);
  return Math.abs(observed - expectedF32) <= tolerance;
}
