export interface NativeEffectRenderRuntime {
  ffmpegPath: string;
  nativeCorePath: string;
  gpuCompositorPath?: string;
  pluginRoots: string[];
  fontRoot?: string;
  workspace: string;
  timeoutMs: number;
  targetClipIds?: ReadonlySet<string>;
}

export interface NativeEffectPreviewRuntime extends Omit<NativeEffectRenderRuntime, "workspace" | "targetClipIds"> {
  cacheRoot: string;
  assetBase?: string;
}

export interface NativeEffectPreviewReceipt {
  schema: "editkin.native-effect-preview/v1";
  status: "GREEN";
  mode: "cached-cpu-native-sequence/v1";
  clipId: string;
  cacheKey: string;
  cacheHit: boolean;
  path: string;
  sha256: string;
  sourceStart: 0;
  duration: number;
  width: number;
  height: number;
  fps: number;
  audioSourceRetained: boolean;
  effectReceipt: NativeEffectRenderReceipt;
}

export interface NativeEffectRenderReceipt {
  schema: "editkin.project-native-effect-render/v1";
  status: "GREEN";
  projectRevision: number;
  clipCount: number;
  instanceCount: number;
  clips: Array<{
    clipId: string;
    frameCount: number;
    width: number;
    height: number;
    intermediateSha256: string;
    executionMode: "cpu-native-sequence/v1" | "resident-gpu-shader-sequence/v1";
    gpu?: {
      executableSha256: string;
      stackSha256: string;
      programs: Array<{
        nodeId: string;
        pluginIdentity: string;
        programSha256: string;
        shaderOpCount: number;
      }>;
      frameCount: number;
      firstFrameSha256: string;
      lastFrameSha256: string;
      productPathCpuPixelCopies: 0;
      verificationReadback: true;
      temporalSampling?: {
        contract: "decoded-temporal-shutter-accumulation/v1";
        sourceSampling: "decoded_temporal";
        framesWithReceipt: number;
        maximumDistinctDecodedTimestampCount: number;
        residentFrameRingSize: number;
        residentBytes: number;
        productPathCpuPixelCopies: 0;
      };
      composite?: {
        contract: "decoded-temporal-video-overlay/v1";
        layerCount: number;
        overlayClipIds: string[];
        timelineRanges: Array<{ clipId: string; timelineStartFrame: number; durationFrames: number; fullyMaterialized: boolean }>;
        framesWithReceipt: number;
        executionMode: "dirty-rect-ping-pong/v1" | "fused-four-layer/v1";
        productPathCpuPixelCopies: 0;
      };
      typography?: {
        contract: "decoded-temporal-typography-overlays/v1";
        captionCueIds: string[];
        motionGraphicIds: string[];
        captionTextureUploads: number;
        motionGraphicTextureUploads: number;
        framesWithActiveCaptions: number;
        framesWithActiveMotionGraphics: number;
        singleColourCaptions: true;
        productPathCpuPixelCopies: 0;
      };
      adjustment?: {
        contract: "decoded-temporal-trailing-adjustment/v1" | "decoded-temporal-pre-typography-adjustment/v1" | "decoded-temporal-pre-typography-multi-adjustment/v1";
        adjustmentClipIds: string[];
        nodeIdsByClip: Record<string, string[]>;
        timelineRanges: Array<{ clipId: string; timelineStartFrame: number; durationFrames: number }>;
        framesWithActiveAdjustments: number;
        totalAdjustmentPasses: number;
        minimumActiveAdjustmentCount: number;
        maximumActiveAdjustmentCount: number;
        executionMode: "trailing-full-frame/v1" | "pre-typography-full-frame/v1";
        baseLayerCount: number;
        minimumBaseLayerCount: number;
        maximumBaseLayerCount: number;
        productPathCpuPixelCopies: 0;
      };
      particle?: {
        contract: "decoded-temporal-particle-overlay/v1" | "decoded-temporal-multi-particle-overlay/v1";
        simulationContract: "screen_space_analytic_particles/v1";
        emitterNodeIds: string[];
        timelineRanges: Array<{ nodeId: string; timelineStartFrame: number; durationFrames: number }>;
        framesWithActiveParticles: number;
        totalParticleEmitterPasses: number;
        minimumActiveEmitterCount: number;
        maximumActiveEmitterCount: number;
        particleCeiling: number;
        maximumGpuTextureWrites: number;
        executionMode: "resident-analytic-overlay/v1";
        productPathCpuPixelCopies: 0;
      };
      matte?: {
        contract: "decoded-temporal-track-matte/v1";
        sourceClipId: string;
        targetClipIds: string[];
        sourceNodeId: string;
        targetNodeIds: Record<string, string>;
        mode: "alpha" | "alpha_inverted" | "luma" | "luma_inverted";
        framesWithActiveMatteTargets: number;
        executionMode: "sampled-track-matte/v1";
        productPathCpuPixelCopies: 0;
      };
    };
    instances: Array<{
      instanceId: string;
      pluginId: string;
      capabilityId: string;
      pluginVersion: string;
      manifestSha256: string;
      runtimeType?: "native_effect" | "gpu_effect_graph";
      worker: unknown;
    }>;
  }>;
}
