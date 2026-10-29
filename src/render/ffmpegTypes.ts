import type { NativeEffectRenderReceipt } from "../plugins/nativeEffectTypes";
import type { SelectedNativeVideoRuntimeIdentity } from "../application/selectedNativeVideoRuntime";
import type { ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";
import type {
  HighBitDepthAlphaDeliveryReceipt,
  MediaProbe,
  RenderDeliveryProfile,
} from "./ffmpegContracts";

export type { MediaProbe, RenderDeliveryProfile } from "./ffmpegContracts";

export interface RenderOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  assetBase?: string;
  autoRotoCacheRoot?: string;
  nativeCorePath?: string;
  gpuCompositorPath?: string;
  selectedNativeVideoRuntime?: SelectedNativeVideoRuntimeIdentity;
  preferGpu?: boolean;
  /** Hard total deadline. Omit it: the default deadline scales with the rendered duration (no fixed cap). */
  timeoutMs?: number;
  /** How long a watched encoder may show no progress before the export is stopped (default 10 minutes). */
  stallTimeoutMs?: number;
  /** Directory for temporary work files; defaults to EDITKIN_RENDER_WORK_ROOT or a hidden folder next to the output. */
  workRoot?: string;
  signal?: AbortSignal;
  fontRoot?: string;
  colorRoot?: string;
  pluginRoots?: string[];
  deliveryProfile?: RenderDeliveryProfile;
  /** Resident SDR transport. SHORT renders never set it (legacy PNG sequence); the LONG router (>= 30 min) selects
   * stream v2, or v3 once WP-B provides it. An explicit caller may still opt in. */
  residentStreamVersion?: 2 | 3;
  /** LONG-render (>= 30 min) controls for tests and MCP; the desktop never sets it. */
  longRender?: import("./longRenderContractsV1").LongRenderOptionsV1;
}

export interface RenderResult {
  residentStreamV3Pipeline?: import("./residentSceneLinearVideoStreamV3").ResidentStreamPipelineV3;
  chunkedCompositePipeline?: import("./chunkedCompositeExportV1").ChunkedCompositeReceiptV1;
  chunkedSceneLinearPipeline?: import("./chunkedSceneLinearSequenceV1").ChunkedSceneLinearSequenceReceiptV1;
  mesh3dPipeline?: import("./mesh3dReceipt").Mesh3dRenderReceipt;
  /** Rec.709 2.5D / particle export through the native image engine graph (scene25dNativeExportV1). */
  nativeImageEngine?: import("./scene25dNativeExportV1").Scene25dImageEngineReceiptV1;
  /** Authored clip speeds/curves baked through the source-clock cache (timeRemapExportV1), with each clip's audio behaviour. */
  timeRemap?: import("./timeRemapExportV1").TimeRemapExportReceiptV1;
  artifactIdentity?: import("./renderArtifactIdentity").RenderArtifactIdentity;
  outputPath: string;
  duration: number;
  encoder: VideoEncoder;
  planner: string;
  ffmpegVersion: string;
  nativeEffects?: NativeEffectRenderReceipt;
  colorPipeline?: {
    schema: "editkin.ocio-display-sequence/v1";
    status: "GREEN";
    colorProcessor: string;
    ocioVersion: string;
    acesVersion: string;
    configSha256: string;
    lutSha256: string;
    lutPayloadSha256?: string;
    deviceCreationCount: number;
    frameCount: number;
    artifactFormat: "rgba8" | "rgba16_unorm";
    displayColorSpace: string;
    firstFrameSha256?: string;
    lastFrameSha256?: string;
  };
  residentVideoPipeline?: ResidentSceneLinearVideoSequenceReceipt;
  residentStreamPipeline?: import("./residentSceneLinearVideoProject").ResidentSceneLinearVideoProjectResult<VideoEncoder>["residentStreamPipeline"];
  nativeAudio?: NativeFinalAudioReceipt;
  alphaDelivery?: HighBitDepthAlphaDeliveryReceipt;
  /** Present only for LONG renders (>= 30 min): route, guard, journal, publish and per-stage receipts. */
  longRender?: import("./longRenderContractsV1").LongRenderReceiptV1;
}

export interface NativeFinalAudioReceipt {
  schema: "editkin.native-final-audio/v1";
  status: "GREEN";
  stageSchema: "editkin.native-audio-preview-stage/v2";
  mixSchema: "editkin.native-audio-preview-mix-receipt/v1";
  decoderExecutor: "ffmpeg-source-decode/v1";
  mixExecutor: "hao-core-native-dag/v1";
  nativeGraphExecution: true;
  manifestSha256: string;
  outputSha256: string;
  bindingSha256: string;
  outputBytes: number;
  durationSeconds: number;
  sourceCount: number;
  voiceClipCount: number;
  musicClipCount: number;
  postLimitPeak: number;
  limiterCeilingDb: number;
  claimBoundary: string;
}

export type VideoEncoder = "h264_nvenc" | "h264_videotoolbox" | "libx264" | "hevc_nvenc" | "hevc_videotoolbox" | "libx265" | "prores_ks" | "ffv1";
