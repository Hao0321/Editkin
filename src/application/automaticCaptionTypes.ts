/** Shared caption analysis contract. The recognizer and segmentation worker
 * both depend on this leaf module so their runtime dependency stays acyclic. */
export interface AutomaticCaptionRequest {
  sourcePath: string;
  sourceStart: number;
  duration: number;
  sourceSha256?: string;
  language?: string;
  translationTarget?: "en";
}

export interface AutomaticCaptionCue {
  start: number;
  end: number;
  text: string;
  translation?: { text: string; language: "en" };
}

export interface AutomaticCaptionResult {
  cues: AutomaticCaptionCue[];
  engine: string;
  modelId: string;
  modelSha256: string;
  language: string;
  translationTarget?: "en";
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
  whisperCliPath?: string;
  signal?: AbortSignal;
  segmentTimeoutMs?: number;
  onProgress?: (progress: { phase: "transcript"; completedSegments: number; totalSegments: number; analyzedSeconds: number; totalSeconds: number; cachedSegments: number }) => void | Promise<void>;
}
