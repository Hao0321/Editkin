import type { GpuEngineDisplayTransform } from "./nativePreviewTypes";

export interface GpuCompositorStatus {
  available: boolean;
  path: string;
  engine?: string;
  receipt?: { status: "GREEN"; engine: "editkin-wgpu-compositor/v1"; adapter: string; backend: string; deviceType: string; blendModes: string[] };
}

export interface GpuCompositionResult {
  outputPath: string;
  outputUrl?: string;
  receipt: {
    engine: "editkin-wgpu-compositor/v1";
    adapterName: string;
    backend: string;
    deviceType: string;
    renderMilliseconds: number;
    outputSha256: string;
    engineGraph?: GpuEngineGraphCoverage | null;
    scene25d?: GpuEngineScene25dCoverage | null;
    vfxSimulation?: GpuEngineVfxSimulationCoverage | null;
  };
}

export interface GpuResidentEngineStatus {
  available: boolean;
  ready: { event: "ready"; engine: "editkin-wgpu-resident-engine/v1"; generation: number; adapter: string; backend: string; deviceType: string; videoInteropProtocol?: string };
  status: { engine: "editkin-wgpu-resident-engine/v1"; generation: number; residentSessions: number; residentVideoSessions?: number; adapter: string; backend: string; deviceType: string; videoBackend?: string };
}

export interface GpuEngineGraphCoverage {
  graphSchema: "editkin.engine-graph/v1";
  graphId: string;
  directExecution: true;
  requestedWorkingFormat: "rgba16_float" | "rgba32_float";
  executionFormat: "rgba32_float";
  artifactFormat: "rgba8" | "native_swap_chain";
  executedNodeIds: string[];
  blockedNodeIds: string[];
  ignoredNodeIds: string[];
}

export interface GpuEngineScene25dCoverage {
  sceneContract: "single_camera_textured_planes/v1";
  planeCount: number; videoPlaneCount: number; parentedPlaneCount: number;
  cameraNodeId: string;
  ambientLightCount: 1; directionalLightCount: 1;
  depthMode: "non_intersecting_plane_average_depth_back_to_front" | "per_pixel_opaque_plane_depth32float"; depthFormat: "none" | "depth32_float";
  depthTestedPlaneCount: number; depthPassCount: number;
  geometryExecutor: "hao-core-native-camera-matrix/v1" | "hao-core-native-camera-matrix-depth-plane/v1";
  pixelExecutor: "wgpu-projective-plane-compositor/v1" | "wgpu-projective-plane-depth-compositor/v1";
  cameraAnimationContract: "static/v1" | "timeline-keyframes/v1"; cameraKeyframeCount: number; sampledTimelineFrame: number;
  cameraPosition: [number, number, number]; cameraTarget: [number, number, number];
  cameraVerticalFovRadians: number;
  lightAnimationContract: "static/v1" | "timeline-keyframes/v1"; ambientLightKeyframeCount: number; directionalLightKeyframeCount: number; sampledLightTimelineFrame: number;
  ambientLightColor: [number, number, number]; ambientLightIntensity: number; directionalLightColor: [number, number, number]; directionalLightIntensity: number; directionalLightDirection: [number, number, number];
}

export type GpuEngineDepthOfFieldCoverage = { contract: "camera_depth_of_field/v1"; nodeId: string; focusDistance: number; aperture: number; maxBlurRadius: number; near: number; far: number; executionMode: "scene-linear-depth32f-gather-dof/v1"; depthSource: "depth32_float"; executor: "wgpu-depth-aware-gather/v1"; passCount: 1; animationContract: "static/v1" | "timeline-keyframes/v1"; keyframeCount: number; sampledTimelineFrame: number };

export interface GpuEngineVfxSimulationCoverage {
  simulationContract: "screen_space_analytic_particles/v1";
  emitterCount: number;
  particleCeiling: number;
  dimension: "screen_space_2d";
  seedMode: "fixed_u32_hash_per_birth";
  timeSource: "rational_node_local_frame";
  executor: "wgpu-bounded-particle-compute/v1" | "wgpu-resident-video-particle-overlay/v1";
}

export interface GpuEngineVideoVisualGraph {
  translateX: number;
  translateY: number;
  scale: number;
  rotation: number;
  opacity: number;
  projectiveH0: number;
  projectiveH1: number;
  projectiveH2: number;
  projectiveH3: number;
  projectiveH4: number;
  projectiveH5: number;
  projectiveH6: number;
  projectiveH7: number;
  projectiveEnabled: number;
  shadeR: number;
  shadeG: number;
  shadeB: number;
  sourceWidth: number;
  sourceHeight: number;
  effectKind: 0 | 1 | 2;
  shaderOpCount: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  exposure: number;
  temperature: number;
  tint: number;
  /** Legacy v1 zero-only receipts may omit these; v2 must report all channels. */
  whiteBalanceRed?: number;
  whiteBalanceGreen?: number;
  whiteBalanceBlue?: number;
  inputTransfer?: 0 | 1 | 2;
  pivot: number;
  shadows: number;
  highlights: number;
  blacks: number;
  whites: number;
  blendMode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  compositeOpacity: number;
  matteMode: 0 | 1 | 2 | 3 | 4;
  motionSampleCount: number;
  motionContractCode: 0 | 1 | 2;
  motionShutterAngle: number;
  motionSamples: Array<[number, number, number, number]>;
  motionSampleFrames: [[number, number, number, number], [number, number, number, number]];
}

export interface GpuEngineVideoMotionBlurReceipt {
  contract: "transform-shutter-accumulation/v1" | "decoded-temporal-shutter-accumulation/v1";
  nodeId: string;
  shutterAngle: number;
  sampleCount: number;
  sourceSampling: "current_frame" | "decoded_temporal";
  sampleFrames: number[];
  sampleTransforms: Array<[number, number, number, number]>;
}

export interface GpuEngineVideoTemporalSamplingReceipt {
  schema: "editkin.decoded-temporal-shutter-window/v1";
  contract: "decoded-temporal-shutter-accumulation/v1";
  sourceSampling: "decoded_temporal";
  sampleCount: number;
  sampleReceipts: Array<{
    targetSeconds: number;
    decodeTargetSeconds: number;
    decodedTimestampSeconds: number;
    sourceTimestampSeconds: number;
    slotIndex: number;
    cacheHit: boolean;
    clockWithinTolerance: boolean;
    gpuSubmissionSequence: number;
  }>;
  distinctDecodedTimestampCount: number;
  residentFrameRingSize: number;
  residentBytes: number;
  gpuCopyCount: number;
  cacheHitCount: number;
  requestedToleranceSeconds: number;
  effectiveToleranceSeconds: number;
  decodePathCpuPixelCopies: 0;
  stagingCpuPixelReadbacks: 0;
  productPathCpuPixelCopies: 0;
}

export interface GpuEngineVideoDecoder {
  resident: true;
  width: number;
  height: number;
  decodePathCpuPixelCopies: 0;
  gpuResidentStaging: true;
  stagingCpuPixelReadback: false;
  residentFrameRingSize: number;
  decodeDispatchMode?: "parallel-com-apartment/v1" | null;
  decoderInstanceId?: number;
  sourceCacheSchema?: "editkin.shared-source-frame-cache/v1" | null;
}

export interface GpuEngineVideoResourcePlan {
  schema: "editkin.resident-video-resource-plan/v1";
  width: number;
  height: number;
  pixelCount: number;
  videoLayerCount: number;
  overlayCount: number;
  particleCount: number;
  particleSnapshotCapacityPerEmitter: 2;
  adjustmentCount: number;
  matteCount: number;
  bytesPerVideoLayer: number;
  workingBytesPerPixel: 4 | 8;
  temporalSampleCount: number;
  temporalResidentRingSlots: number;
  temporalResidentBytes: number;
  compositorWorkingBytes: number;
  overlayBytes: number;
  particleSnapshotBytes: number;
  adjustmentWorkingBytes: number;
  sceneDepthAttachmentCount: 0 | 1; sceneDepthBytes: number; depthOfFieldPassCount: 0 | 1;
  depthOfFieldAdditionalWorkingBytes: 0; maximumFullFramePassesPerPresent: number;
  requiredBytes: number;
  budgetBytes: number;
  maxVideoLayers: number;
  remainingBytes: number;
}

export interface GpuEngineVideoDecodeSchedule {
  schema: "editkin.resident-video-decode-schedule/v1";
  fullRateLayerCount: number;
  adaptiveLayerCount: number;
  maximumDecodeCadenceDivisor: number;
  maximumReuseAgeFrames: number;
}

export interface GpuEngineVideoLayerLoadResult {
  sourceNodeId: string;
  assetId: string;
  decoder: GpuEngineVideoDecoder;
  visualGraph: GpuEngineVideoVisualGraph;
  motionBlur?: GpuEngineVideoMotionBlurReceipt | null;
  transformNodeId: string | null;
  parentTransformNodeId: string | null;
  parentLayerIndex: number | null;
  parentControllerIndex: number | null;
  parentDepth: number;
  blendMode: "normal" | "add" | "screen" | "multiply" | "overlay" | "soft_light" | "hard_light" | "difference" | "darken" | "lighten" | "color_dodge" | "color_burn";
  compositeOpacity: number;
  matteLayerIndex?: number;
  matteMode?: "alpha" | "alpha_inverted" | "luma" | "luma_inverted";
  precompositionNodeIds: string[];
  nestedGraphIds: string[];
  decodeCadenceDivisor: number;
  decodeCadencePhase: number;
  sharedDecoderLayerCount: number;
  initialFrame: { active: boolean; timelineFrame: number; sourceFrame?: number; sourceTimeSeconds?: number };
}

export interface GpuEngineVideoControllerReceipt {
  sourceNodeId: string;
  transformNodeId: string;
  timeline: {
    range: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
    timebaseNumerator: number;
    timebaseDenominator: number;
  };
  sampledFrame?: { active: boolean; timelineFrame: number; sourceFrame?: number; sourceTimeSeconds?: number };
  visualGraph: GpuEngineVideoVisualGraph;
  parentTransformNodeId: string | null;
  parentLayerIndex: number | null;
  parentControllerIndex: number | null;
  parentDepth: number;
}

export interface GpuEngineVideoCaptionReceipt {
  nodeId: string;
  cueId: string;
  timeline: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
  fontFamily: string;
  fontSha256: string;
  atlasSha256: string;
  glyphCount: number;
  missingGlyphCount: number;
  textureUploadCount: 1;
  textColor: string;
  singleTextColor: true;
}

export interface GpuEngineVideoMotionGraphicReceipt {
  nodeId: string;
  graphicId: string;
  graphicKind: "title" | "card" | "tag" | "counter";
  timeline: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  letterSpacing: number;
  outlineWidth: number;
  shadowDepth: number;
  cornerRadius: number;
  fontSha256: string;
  atlasSha256: string;
  glyphCount: number;
  missingGlyphCount: number;
  textureUploadCount: 1;
  textColor: string;
  backgroundColor: string;
  accentColor: string;
  visualStyle: "solid_panel" | "holo_scan_cyan" | "holo_grid_lime" | "target_lock_red" | "spectral_wire_violet" | "depth_glass_blue" | "telemetry_beam_amber" | "neon_extrude_white" | "quantum_label_magenta";
  animation: "fade" | "slide_up" | "pop" | "spring_soft";
  fadeInFrames: number;
  fadeOutFrames: number;
  trackId?: string | null;
  trackingMode?: "anchor" | "surface";
  trackingSampleCount: number;
  sampledOpacity?: number;
  sampledTranslateX?: number;
  sampledTranslateY?: number;
  sampledScale?: number;
  sampledRotationRadians?: number;
  sampledTrackingX?: number;
  sampledTrackingY?: number;
  sampledTrackingConfidence?: number;
  sampledTrackingStatus?: "tracked" | "held" | "manual";
  sampledTrackingRotationRadians?: number;
  sampledTrackingScale?: number;
  sampledDestinationQuad?: Array<{ x: number; y: number }> | null;
}

export interface GpuEngineVideoAdjustmentReceipt {
  nodeIds: string[];
  timeline: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
  visualGraph: GpuEngineVideoVisualGraph;
}

export interface GpuEngineVideoParticleReceipt {
  nodeId: string;
  timelineFrame: number;
  localFrame: number;
  timeline: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number };
  timeSeconds: number;
  seed: number;
  particleCeiling: number;
  executor: "wgpu-resident-video-particle-overlay/v1";
  gpuTextureWrites: number;
  uniformParameterWrites: number;
  cpuPixelUploads: 0;
  cpuPixelReadbacks: 0;
  queueSubmissionMode: "ordered-same-device/v1";
  snapshotCache: {
    schema: "editkin.resident-particle-seek-snapshot/v1";
    capacity: 2;
    hit: boolean;
    cachedLocalFrames: number[];
    computeTextureWrites: number;
    snapshotCopies: number;
    hits: number;
    misses: number;
    cpuPixelCopies: 0;
  };
}

export interface GpuEnginePreviewLoadResult {
  sessionId: string;
  resident: true;
  layers: number;
  generation: number;
  timelineFrame: number;
  engineGraph: GpuEngineGraphCoverage;
  scene25d?: GpuEngineScene25dCoverage | null;
  vfxSimulation?: GpuEngineVfxSimulationCoverage | null;
}

export interface GpuEngineVideoPreviewLoadResult {
  sessionId: string;
  resident: true;
  generation: number;
  executor: "media-foundation-d3d11-d3d12-wgpu/v1";
  displayTransform: GpuEngineDisplayTransform;
  decoder: GpuEngineVideoDecoder;
  engineGraph: GpuEngineGraphCoverage;
  resourcePlan: GpuEngineVideoResourcePlan;
  decodeSchedule: GpuEngineVideoDecodeSchedule;
  scene25d?: GpuEngineScene25dCoverage | null;
  depthOfField?: GpuEngineDepthOfFieldCoverage | null;
  vfxSimulation?: GpuEngineVfxSimulationCoverage | null;
  gpuEffects?: {
    runtime: "editkin.gpu-effect-graph/v1";
    resolved: true;
    count: number;
    programs: Array<{ nodeId: string; pluginIdentity: string; programSha256: string; shaderOpCount: number }>;
  };
  visualGraph: GpuEngineVideoVisualGraph;
  initialFrame: { active: boolean; timelineFrame: number; sourceFrame?: number; sourceTimeSeconds?: number };
  layerCount: number;
  matteCount: number;
  precompositionCount: number;
  parentCount: number;
  controllerCount: number;
  controllers: GpuEngineVideoControllerReceipt[];
  compositeMode: "single/v1" | "normal-source-over/v1" | "typed-blend-source-over/v1" | "typed-track-matte/v1" | "resolved-precomposition/v1" | "typed-parent-transform/v1" | "typed-controller-parent/v1" | "video-particle-source-over/v1" | "video-caption-source-over/v1" | "video-motion-graphic-source-over/v1" | "video-trailing-adjustment/v1";
  layers: GpuEngineVideoLayerLoadResult[];
  visualLayers: GpuEngineVideoVisualGraph[];
  captionCount: number;
  captionTextureUploads: number;
  captions: GpuEngineVideoCaptionReceipt[];
  activeCaptions: GpuEngineVideoCaptionReceipt[];
  motionGraphicCount: number;
  motionGraphicTextureUploads: number;
  motionGraphics: GpuEngineVideoMotionGraphicReceipt[];
  activeMotionGraphics: GpuEngineVideoMotionGraphicReceipt[];
  adjustmentCount: number;
  adjustments: GpuEngineVideoAdjustmentReceipt[];
  particleCount: number;
  particleTexturesResident: number;
}
