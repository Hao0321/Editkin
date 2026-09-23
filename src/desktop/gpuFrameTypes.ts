import type {
  GpuEngineDepthOfFieldCoverage, GpuEngineGraphCoverage, GpuEngineScene25dCoverage,
  GpuEngineVfxSimulationCoverage, GpuEngineVideoAdjustmentReceipt, GpuEngineVideoCaptionReceipt,
  GpuEngineVideoControllerReceipt, GpuEngineVideoDecodeSchedule, GpuEngineVideoMotionBlurReceipt,
  GpuEngineVideoMotionGraphicReceipt, GpuEngineVideoParticleReceipt, GpuEngineVideoResourcePlan,
  GpuEngineVideoTemporalSamplingReceipt, GpuEngineVideoVisualGraph,
} from "./gpuTypes";
import type { GpuEngineDisplayTransform, GpuNativePreviewSurface } from "./nativePreviewTypes";

export interface GpuVideoPreviewFrame {
  endOfStream: boolean;
  outputPath?: string;
  outputUrl?: string;
  receipt: {
    sessionId: string;
    generation: number;
    endOfStream: boolean;
    frame?: {
      frameIndex: number;
      frameRingSlot: number;
      residentFrameRingSize: number;
      width: number;
      height: number;
      outputHash: string;
      timestampSeconds: number;
      producerHash: string;
      producerConsumerParity: boolean;
      decodePathCpuPixelCopies: 0;
      gpuProcessingPasses: 2;
      outputWritten: boolean;
      clockTargetSeconds?: number;
      clockToleranceSeconds?: number;
      clockDriftMilliseconds?: number;
      clockDroppedFrames?: number;
      totalClockDroppedFrames?: number;
      clockSeeked?: boolean;
      clockWithinTolerance?: boolean;
    };
  };
}

export interface GpuVideoStagedFrame {
  endOfStream: boolean;
  receipt: {
    sessionId: string;
    generation: number;
    endOfStream: boolean;
    frame?: {
      frameIndex: number;
      frameRingSlot: number;
      residentFrameRingSize: number;
      width: number;
      height: number;
      timestampSeconds: number;
      sourceTimestampSeconds: number;
      decodePathCpuPixelCopies: 0;
      stagingCpuPixelReadbacks: 0;
      verificationReadback: false;
      outputWritten: false;
      gpuProcessingPasses: 2;
      gpuSurfaceResident: true;
      gpuSubmissionSequence: number;
      gpuCopySubmissionMode?: "batched-copy/v1" | "source-cache-hit/v1";
      gpuCopySubmissionLayerCount?: number;
      decodeDispatchMode?: "parallel-com-apartment/v1" | null;
      decodeDispatchWidth?: number;
      decoderSourceCacheHit?: boolean;
      adaptiveFrameReused?: boolean;
      adaptiveFrameAgeFrames?: number;
      decodeCadenceDivisor?: number;
      decodeCadencePhase?: number;
      presentationTargetSeconds?: number;
      retiredSubmissionSequence: number | null;
      gpuFencePending: true;
      crossApiSharedFence: true;
      crossApiFenceValue: number;
      crossApiProducerCpuWaits: 0;
      nativeSurfacePresented: boolean;
      nativeSurfacePresentCount: number | null;
      nativeSurfaceCpuPixelReadbacks: 0;
      clockTargetSeconds: number;
      clockToleranceSeconds: number;
      clockDriftMilliseconds: number;
      clockDroppedFrames: number;
      totalClockDroppedFrames: number;
      clockSeeked: boolean;
      clockWithinTolerance: boolean;
    };
  };
}

export interface GpuVideoPresentedFrame extends GpuVideoStagedFrame {
  receipt: GpuVideoStagedFrame["receipt"] & { surface: GpuNativePreviewSurface };
}

export interface GpuEngineVideoPresentedFrame {
  endOfStream: boolean;
  receipt: {
    sessionId: string;
    generation: number;
    active: boolean;
    timelineFrame: number;
    sourceFrame: number | null;
    sourceTimeSeconds: number | null;
    temporalSampling?: GpuEngineVideoTemporalSamplingReceipt | null;
    nativeSurfaceCleared: boolean;
    endOfStream?: boolean;
    frame?: GpuVideoStagedFrame["receipt"]["frame"];
    surface: GpuNativePreviewSurface;
    productPathCpuPixelCopies: 0;
    sceneLinearExecution?: true;
    workingColorSpace?: "linear_rec709";
    workingFormat?: "rgba16_float";
    displayTransform?: "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1" | "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1";
    outputSpace?: "rec709_sdr" | "rec2100_pq_1000";
    lutSha256?: string;
    lutPayloadSha256?: string | null;
    inputTransform?: "editkin-srgb-to-linear-rec709-primary/v1" | "editkin-rec709-to-linear-rec709-primary/v2";
    ocioVersion?: "2.5.2";
    acesVersion?: "2.0";
    configSha256?: string;
    compositeExecutionMode?: "scene-linear-rgba16f-ping-pong/v1" | "scene-linear-depth32f-opaque-planes/v1" | "scene-linear-depth32f-gather-dof/v1";
    compositeLayerCount?: number;
    compositeFullFramePassCount?: number;
    compositeMaximumLayersPerPass?: number;
    depthExecutionMode?: "none" | "scene-linear-depth32f-opaque-planes/v1"; depthFormat?: "none" | "depth32_float"; depthTestedLayerCount?: number; depthPassCount?: number;
    depthOfFieldExecutionMode?: "none" | "scene-linear-depth32f-gather-dof/v1"; depthOfFieldDepthSource?: "none" | "depth32_float"; depthOfFieldPassCount?: number; depthOfField?: GpuEngineDepthOfFieldCoverage | null;
    effectExecutionMode?: "none" | "scene-linear-bounded-effect-stack/v1";
    shaderOperationCount?: number;
    builtInEffectCount?: number;
    temporalExecutionMode?: "none" | "decoded-temporal-shutter-scene-linear/v1";
    temporalLayerCount?: number;
    temporalSampleTextureCount?: number;
    matteExecutionMode?: "none" | "sampled-track-matte-scene-linear/v1" | null;
    mattePassCount?: number;
    adjustmentExecutionMode?: "none" | "pre-typography-scene-linear/v1" | "trailing-scene-linear/v1" | null;
    adjustmentBaseLayerCount?: number;
    engineGraph: GpuEngineGraphCoverage;
    resourcePlan: GpuEngineVideoResourcePlan;
    decodeSchedule: GpuEngineVideoDecodeSchedule;
    scene25d?: GpuEngineScene25dCoverage | null;
    vfxSimulation?: GpuEngineVfxSimulationCoverage | null;
    adaptiveDecodeStageMilliseconds?: number;
    compositePresentMilliseconds?: number;
    visualGraphApplied?: boolean;
    visualGraph?: GpuEngineVideoVisualGraph;
    visualLayersApplied?: boolean;
    visualLayers?: GpuEngineVideoVisualGraph[];
    layerFrames?: Array<NonNullable<GpuVideoStagedFrame["receipt"]["frame"]>>;
    layers?: Array<{
      sourceNodeId: string;
      assetId: string;
      active: true;
      sourceFrame: number;
      sourceTimeSeconds: number;
      frame: Pick<NonNullable<GpuVideoStagedFrame["receipt"]["frame"]>,
        | "frameRingSlot" | "gpuSubmissionSequence" | "timestampSeconds"
        | "decodePathCpuPixelCopies" | "stagingCpuPixelReadbacks"
        | "nativeSurfacePresented" | "nativeSurfaceCpuPixelReadbacks"
        | "clockTargetSeconds" | "clockDriftMilliseconds" | "clockWithinTolerance"
        | "gpuCopySubmissionMode" | "gpuCopySubmissionLayerCount"
        | "decodeDispatchMode" | "decodeDispatchWidth" | "decoderSourceCacheHit"
        | "adaptiveFrameReused" | "adaptiveFrameAgeFrames"
        | "decodeCadenceDivisor" | "decodeCadencePhase" | "presentationTargetSeconds"
      >;
      visualGraph: GpuEngineVideoVisualGraph;
      motionBlur?: GpuEngineVideoMotionBlurReceipt | null;
      transformNodeId: string | null;
      parentTransformNodeId: string | null;
      parentLayerIndex: number | null;
      parentControllerIndex: number | null;
      parentDepth: number;
      matteLayerIndex?: number;
      matteMode?: "alpha" | "alpha_inverted" | "luma" | "luma_inverted";
      precompositionNodeIds: string[];
      nestedGraphIds: string[];
    }>;
    controllers?: GpuEngineVideoControllerReceipt[];
    captionTextureUploads?: number;
    activeCaptions?: GpuEngineVideoCaptionReceipt[];
    motionGraphicTextureUploads?: number;
    activeMotionGraphics?: GpuEngineVideoMotionGraphicReceipt[];
    adjustmentPassCount?: number;
    activeAdjustments?: GpuEngineVideoAdjustmentReceipt[];
    activeParticles?: GpuEngineVideoParticleReceipt | null;
    /** All active emitters in graph order. `activeParticles` remains emitter one for v1 compatibility. */
    activeParticleEmitters?: GpuEngineVideoParticleReceipt[];
  };
}
