import type {WhisperModelChoiceV1} from "./whisperModelChoiceV1";
/** Shared caption analysis contract. The recognizer and segmentation worker
 * both depend on this leaf module so their runtime dependency stays acyclic. */
export interface AutomaticCaptionRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  sourceSha256?: string;
  language?: string;
  translationTarget?: "en";
  whisperModel?: WhisperModelChoiceV1;
  /** Written script for Chinese cue text; omitted means "zh-TW". */
  script?: CaptionScript;
}

/** "zh-TW" converts Chinese cue text to Taiwan Traditional; "original" keeps the recognizer's characters. */
export type CaptionScript = "zh-TW" | "original";
export type CaptionScriptConversion = "s2twp";

export interface AutomaticCaptionCue {
  start: number;
  end: number;
  text: string;
  translation?: { text: string; language: "en" };
}

/** Why one recognizer SRT block was left out instead of failing the whole transcript. */
export type SkippedCaptionBlockReason =
  | "missing-timing" | "multiple-timing" | "invalid-index" | "invalid-time" | "non-positive-duration" | "empty-text"
  | "unparseable-window";

export interface SkippedCaptionBlock {
  /** 1-based block number in the recognizer's raw SRT (of that window, for segmented analysis). */
  block: number;
  reason: SkippedCaptionBlockReason;
  /** Segmented-analysis window whose raw transcript held the block. */
  window?: number;
}

export interface AutomaticCaptionResult {
  /** Present only when malformed recognizer blocks were skipped; every other cue was kept. */
  skippedCaptionBlocks?: SkippedCaptionBlock[];
  cues: AutomaticCaptionCue[];
  engine: string;
  modelId: string;
  modelSha256: string;
  language: string;
  translationTarget?: "en";
  /** Present when cue text went through OpenCC s2twp (Taiwan Traditional); rawTranscript keeps the recognizer's text. */
  scriptConversion?: CaptionScriptConversion;
  analyzedSeconds: number;
  elapsedMs: number;
  modelDownloaded: boolean;
  cacheHit: boolean;
  acceleration: "gpu" | "cpu";
}

export interface RawWhisperTranscript {
  format: "srt";
  text: string;
  sha256: string;
}

export interface AutomaticCaptionRecognition {
  status: "usable-cues" | "empty";
  /** Recognition is not VAD or verification of what is physically audible. */
  audioContent: "unverified";
  reason?: "recognition-completed-without-usable-cues";
  /** Malformed blocks left out of `cues`; the raw transcript keeps them verbatim. */
  skippedBlocks?: SkippedCaptionBlock[];
}

export interface CaptionWindow {
  index: number; coreStart: number; coreEnd: number; start: number; duration: number;
}

export interface CaptionWindowEvidence extends CaptionWindow {
  rawTranscript: RawWhisperTranscript;
  rawTranslation?: RawWhisperTranscript;
}

export interface CaptionSegmentation {
  schema: "editkin.segmented-caption-analysis/v1";
  coreSeconds: number; contextSeconds: number; windows: CaptionWindowEvidence[];
  boundaryCuesRequireReview: boolean;
}

export interface AutomaticCaptionAnalysisResult extends AutomaticCaptionResult {
  recognition: AutomaticCaptionRecognition;
  rawTranscript: RawWhisperTranscript;
  rawTranslation?: RawWhisperTranscript;
  segmentation?: CaptionSegmentation;
}

export interface AutomaticCaptionRuntime {
  ffmpegPath: string;
  modelRoot: string;
  cacheRoot?: string;
  modelPath?: string;
  whisperModel?: WhisperModelChoiceV1;
  mediumModelPath?: string;
  smallModelPath?: string;
  whisperCliPath?: string;
  signal?: AbortSignal;
  segmentTimeoutMs?: number;
  onProgress?: (progress: { phase: "transcript"; completedSegments: number; totalSegments: number; analyzedSeconds: number; totalSeconds: number; cachedSegments: number }) => void | Promise<void>;
}
