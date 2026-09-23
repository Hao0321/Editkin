import type { AutomaticCaptionAnalysisResult, AutomaticCaptionCue, AutomaticCaptionRequest, AutomaticCaptionRuntime } from "./automaticCaptions";

export const CAPTION_WINDOW_SECONDS = 30;
const CONTEXT_SECONDS = 2;
export interface CaptionWindow {
  index: number; coreStart: number; coreEnd: number; start: number; duration: number;
}
export interface CaptionWindowEvidence extends CaptionWindow {
  rawTranscript: AutomaticCaptionAnalysisResult["rawTranscript"];
  rawTranslation?: AutomaticCaptionAnalysisResult["rawTranslation"];
}
export interface CaptionSegmentation {
  schema: "editkin.segmented-caption-analysis/v1";
  coreSeconds: number; contextSeconds: number; windows: CaptionWindowEvidence[];
  boundaryCuesRequireReview: boolean;
}
export function captionWindows(duration: number): CaptionWindow[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error("字幕分段時長不合法");
  return Array.from({ length: Math.ceil(duration / CAPTION_WINDOW_SECONDS) }, (_, index) => {
    const coreStart = index * CAPTION_WINDOW_SECONDS, coreEnd = Math.min(duration, coreStart + CAPTION_WINDOW_SECONDS);
    const start = Math.max(0, coreStart - CONTEXT_SECONDS);
    return { index, coreStart, coreEnd, start, duration: Math.min(duration, coreEnd + CONTEXT_SECONDS) - start };
  });
}
function timestamp(seconds: number): string {
  const value = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(value / 3600000)).padStart(2,"0")}:${String(Math.floor(value / 60000) % 60).padStart(2,"0")}:${String(Math.floor(value / 1000) % 60).padStart(2,"0")},${String(value % 1000).padStart(3,"0")}`;
}
function srt(cues: AutomaticCaptionCue[], translation = false): string {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${translation ? cue.translation?.text : cue.text}\n`).join("\n");
}

/** The recognizer's exact per-window SRT is retained separately. The aggregate
 * SRT is a deterministic derived view, never a claim of one continuous decode.
 * Context-window boundaries still need editorial review, not fake confidence.
 */
export async function analyzeSegmentedCaptions(
  request: AutomaticCaptionRequest, runtime: AutomaticCaptionRuntime,
  analyzeWindow: (request: AutomaticCaptionRequest, runtime: AutomaticCaptionRuntime) => Promise<AutomaticCaptionAnalysisResult>,
  parse: (srt: string, duration: number) => Pick<AutomaticCaptionAnalysisResult, "cues" | "recognition" | "rawTranscript">,
): Promise<AutomaticCaptionAnalysisResult> {
  const started = Date.now(), windows = captionWindows(request.duration), evidence: CaptionWindowEvidence[] = [];
  const cues: AutomaticCaptionCue[] = [];
  let first: AutomaticCaptionAnalysisResult | undefined, cacheHit = true, downloaded = false, cachedSegments = 0, boundary = false, usedCpu = false;
  for (const window of windows) {
    runtime.signal?.throwIfAborted();
    await runtime.onProgress?.({ phase: "transcript", completedSegments: window.index, totalSegments: windows.length, analyzedSeconds: window.coreStart, totalSeconds: request.duration, cachedSegments });
    const result = await analyzeWindow({ ...request, sourceStart: request.sourceStart + window.start, duration: window.duration }, { ...runtime, onProgress: undefined });
    runtime.signal?.throwIfAborted();
    first ??= result; cacheHit &&= result.cacheHit; downloaded ||= result.modelDownloaded; cachedSegments += result.cacheHit ? 1 : 0; usedCpu ||= result.acceleration === "cpu";
    if (result.modelSha256 !== first.modelSha256 || result.language !== first.language || result.translationTarget !== first.translationTarget) throw new Error("字幕分段模型／語言身分不一致");
    evidence.push({ ...window, rawTranscript: result.rawTranscript, ...(result.rawTranslation ? { rawTranslation: result.rawTranslation } : {}) });
    for (const cue of result.cues) {
      const start = cue.start + window.start, end = Math.min(request.duration, cue.end + window.start), midpoint = (start + end) / 2;
      if (midpoint < window.coreStart || midpoint >= window.coreEnd) continue;
      boundary ||= start < window.coreStart || end > window.coreEnd;
      cues.push({ ...cue, start, end });
    }
    await runtime.onProgress?.({ phase: "transcript", completedSegments: window.index + 1, totalSegments: windows.length, analyzedSeconds: window.coreEnd, totalSeconds: request.duration, cachedSegments });
  }
  if (!first) throw new Error("字幕分段結果遺失");
  cues.sort((a,b) => a.start - b.start || a.end - b.end);
  // Do not silently delete disputed/repeated words. Preserve overlaps and flag
  // them for review instead of certifying direct subtitle burn-in.
  boundary ||= cues.some((cue,index) => index > 0 && cue.start < cues[index-1].end);
  const aggregate = parse(srt(cues), request.duration);
  const translated = request.translationTarget && cues.length ? parse(srt(cues, true), request.duration) : undefined;
  const normalizedCues = aggregate.cues.map((cue, index) => ({ ...cue, ...(cues[index]?.translation ? { translation: cues[index].translation } : {}) }));
  const { rawTranslation: _firstTranslation, segmentation: _firstSegmentation, ...metadata } = first;
  return {
    ...metadata, ...aggregate, cues: normalizedCues,
    ...(translated ? { rawTranslation: translated.rawTranscript } : {}),
    analyzedSeconds: request.duration, elapsedMs: Date.now() - started, cacheHit, modelDownloaded: downloaded,
    engine: `${first.engine}+segmented-v1`,
    acceleration: usedCpu ? "cpu" : "gpu",
    segmentation: { schema: "editkin.segmented-caption-analysis/v1", coreSeconds: CAPTION_WINDOW_SECONDS, contextSeconds: CONTEXT_SECONDS, windows: evidence, boundaryCuesRequireReview: boundary },
  };
}
