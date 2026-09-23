export interface NativeAudioPreviewStageReceipt {
  schema: "editkin.native-audio-preview-stage/v2";
  status: "GREEN";
  manifestBytes: number;
  manifestSha256: string;
  projectId: string;
  projectRevision: number;
  projectUpdatedAt: string;
  audioFingerprintSha256: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  sampleRate: 48_000;
  channels: 2;
  clipCount: number;
  voiceClipCount: number;
  musicClipCount: number;
  sourceIds: string[];
  sourcePcm: Array<{
    id: string;
    clipId: string;
    assetId: string;
    role: "voice" | "music";
    bytes: number;
    sha256: string;
    startFrame: number;
    gainDb: number;
    gainAutomation: Array<{ sample: number; valueDb: number }>;
  }>;
  decoderExecutor: "ffmpeg-source-decode/v1";
  decodeMode: "independent-source-pcm";
  mixExecutor: "hao-core-native-dag/v1";
  nativeGraphExecution: true;
  claimBoundary: string;
}

export interface NativeAudioPreviewPlaybackEvent {
  schema: "editkin.native-audio-preview-event/v1" | "editkin.native-audio-preview-receipt/v1";
  event: "started" | "progress" | "recovering" | "recovered" | "ended";
  backend?: "WASAPI shared event-driven";
  timelineStartSeconds: number;
  timelineSeconds: number;
  presentedFrame?: number;
  sampleMasterFrame?: number;
  sampleMasterRate?: number;
  sourceFrame?: number;
  deviceGeneration?: number;
  recoveryGeneration?: number;
  reason?: "endpoint-notification" | "device-invalidated";
  callbackCount?: number;
  clockQpc100ns?: number;
}

export interface NativeAudioPreviewStartResult {
  native: true;
  generation: number;
  stage: NativeAudioPreviewStageReceipt;
  playback: NativeAudioPreviewPlaybackEvent;
}

export interface NativeAudioPreviewStatus {
  generation?: number;
  active: boolean;
  failed?: boolean;
  error?: string;
  stage?: NativeAudioPreviewStageReceipt;
  playback?: NativeAudioPreviewPlaybackEvent;
}
