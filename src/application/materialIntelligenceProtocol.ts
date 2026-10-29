import type { SceneCut } from "./sceneDetection";
import type { AutomaticCaptionCue, AutomaticCaptionRecognition, RawWhisperTranscript, AutomaticCaptionRuntime, CaptionScript, CaptionScriptConversion } from "./automaticCaptions";
import type { ColorManagementSettings, MediaColorMetadata } from "../domain/types";
import type { MaterialColorReceipt } from "./materialColorSamplingTypes";
import type { MaterialCacheSeal } from "./materialEvidenceCache";
import type { CaptionSegmentation } from "./segmentedCaptions";
import type { WhisperModelRuntimeFieldsV1, WhisperModelChoiceV1 } from "./whisperModelChoiceV1";
import type { MaterialKeyframeAnalysis, MaterialKeyframeDisplay } from "./materialKeyframeTypes";

export interface MaterialKeyframe {
  id: string;
  time: number;
  sceneIndex: number;
  sha256: string;
  bytes: number;
  mimeType: "image/jpeg";
  fileName: string;
  /** Absent only on historical, read-only evidence. */
  display?: MaterialKeyframeDisplay;
}

export interface MaterialIntelligencePacket {
  schema: "hao.editkin.material-intelligence/v1";
  materialId: string;
  cache?: MaterialCacheSeal;
  source: {
    assetId: string;
    clipId: string;
    sourceSha256: string;
    sourceStart: number;
    duration: number;
    kind: "video" | "audio" | "image";
    width?: number;
    height?: number;
    fps: number;
    hasAudio: boolean;
    color?: MediaColorMetadata;
    colorManagement?: ColorManagementSettings;
  };
  analysis: {
    keyframes?: MaterialKeyframeAnalysis;
    color?: MaterialColorReceipt;
    scene: { state: "ready" | "not_applicable" | "blocked"; engine?: string; cuts: SceneCut[]; reason?: string };
    transcript: {
      state: "ready" | "not_applicable" | "blocked";
      engine?: string;
      language?: string;
      cueCount: number;
      cues: AutomaticCaptionCue[];
      /** Cue text went through OpenCC s2twp; rawTranscript keeps the recognizer's text. */
      scriptConversion?: CaptionScriptConversion;
      reason?: string;
      recognition?: AutomaticCaptionRecognition;
      rawTranscript?: RawWhisperTranscript;
      segmentation?: CaptionSegmentation;
    };
  };
  keyframes: MaterialKeyframe[];
  createdAt: string;
}

export interface PrepareMaterialRequest {
  assetId: string;
  clipId: string;
  sourcePath: string;
  sourceStart: number;
  duration: number;
  fps: number;
  kind: "video" | "audio" | "image";
  sourceSha256?: string;
  language?: string;
  includeTranscript?: boolean;
  whisperModel?: WhisperModelChoiceV1;
  /** Written script for Chinese transcript cues; omitted means "zh-TW". */
  script?: CaptionScript;
  maxKeyframes?: number;
  /** Optional exact, increasing clip-relative source seconds for local event inspection. */
  keyframeTimes?: number[];
  color?: MediaColorMetadata;
  colorManagement?: ColorManagementSettings;
}

export interface MaterialRuntime extends WhisperModelRuntimeFieldsV1 {
  ffmpegPath: string;
  ffprobePath?: string;
  modelRoot: string;
  cacheRoot: string;
  modelPath?: string;
  whisperCliPath?: string;
  requireTranscriptCompletion?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: MaterialPreparationProgress) => void | Promise<void>;
}

export type MaterialPreparationProgress = { phase: "identity" | "scene" | "keyframes" | "color" | "finalizing" }
  | Parameters<NonNullable<AutomaticCaptionRuntime["onProgress"]>>[0];

