import type { NativeEffectRenderReceipt } from "../plugins/nativeEffectTypes";
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
  preferGpu?: boolean;
  timeoutMs?: number;
  fontRoot?: string;
  colorRoot?: string;
  pluginRoots?: string[];
  deliveryProfile?: RenderDeliveryProfile;
}

export interface RenderResult {
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
  nativeAudio?: NativeFinalAudioReceipt;
  alphaDelivery?: HighBitDepthAlphaDeliveryReceipt;
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

export type VideoEncoder = "h264_nvenc" | "h264_videotoolbox" | "libx264" | "hevc_nvenc" | "hevc_videotoolbox" | "libx265" | "prores_ks";
