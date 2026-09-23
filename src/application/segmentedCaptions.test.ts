import { describe, expect, it } from "vitest";
import { analyzeSegmentedCaptions, captionWindows } from "./segmentedCaptions";
import { parseWhisperRecognition, PINNED_WHISPER_MODEL, type AutomaticCaptionAnalysisResult } from "./automaticCaptions";

const request = { sourcePath: "fixture.wav", sourceStart: 11, duration: 65 };
const runtime = { ffmpegPath: "fixture-ffmpeg", modelRoot: "fixture-model" };
function result(srt: string, duration: number, cacheHit = false): AutomaticCaptionAnalysisResult {
  return { ...parseWhisperRecognition(srt, duration), modelId: PINNED_WHISPER_MODEL.id, modelSha256: PINNED_WHISPER_MODEL.sha256,
    language: "auto", engine: "test-only-no-inference", analyzedSeconds: duration, elapsedMs: 1, cacheHit, modelDownloaded: false, acceleration: "cpu" };
}
describe("bounded, resumable caption windows", () => {
  it("covers the complete source once with context, including a fractional tail", () => {
    expect(captionWindows(65)).toEqual([
      { index: 0, coreStart: 0, coreEnd: 30, start: 0, duration: 32 },
      { index: 1, coreStart: 30, coreEnd: 60, start: 28, duration: 34 },
      { index: 2, coreStart: 60, coreEnd: 65, start: 58, duration: 7 },
    ]);
    expect(captionWindows(431.96666666666664).at(-1)?.coreEnd).toBe(431.96666666666664);
    expect(() => captionWindows(Infinity)).toThrow();
  });
  it("keeps exact window evidence and owns boundary cues by midpoint, with global timing", async () => {
    const calls: number[] = [];
    const raw = ["1\n00:00:29,000 --> 00:00:31,000\nBoundary\n", "1\n00:00:01,000 --> 00:00:03,000\nBoundary\n", "1\n00:00:02,000 --> 00:00:04,000\nTail\n"];
    const output = await analyzeSegmentedCaptions(request, runtime, async req => {
      calls.push(req.sourceStart); return result(raw[calls.length - 1], req.duration);
    }, parseWhisperRecognition);
    expect(calls).toEqual([11, 39, 69]);
    expect(output.cues).toEqual([{ start: 29, end: 31, text: "Boundary" }, { start: 60, end: 62, text: "Tail" }]);
    expect(output.segmentation?.windows.map(window => window.rawTranscript.text)).toEqual(raw);
    expect(output.segmentation?.boundaryCuesRequireReview).toBe(true);
    expect(output.rawTranscript).toEqual(parseWhisperRecognition(output.rawTranscript.text, request.duration).rawTranscript);
  });
  it("resume reuses completed windows and never returns success after cancellation", async () => {
    const cache = new Map<number, AutomaticCaptionAnalysisResult>(), decoded: number[] = [], abort = new AbortController();
    const decode = async (req: typeof request) => {
      const hit = cache.get(req.sourceStart); if (hit) return { ...hit, cacheHit: true };
      decoded.push(req.sourceStart); const output = result("1\n00:00:02,000 --> 00:00:03,000\nWord\n", req.duration); cache.set(req.sourceStart, output); return output;
    };
    await expect(analyzeSegmentedCaptions(request, { ...runtime, signal: abort.signal, onProgress: p => { if (p.completedSegments === 1) abort.abort(); } }, decode, parseWhisperRecognition)).rejects.toMatchObject({ name: "AbortError" });
    const progress: number[] = [];
    const output = await analyzeSegmentedCaptions(request, { ...runtime, onProgress: p => { progress.push(p.cachedSegments); } }, decode, parseWhisperRecognition);
    expect(decoded).toEqual([11, 39, 69]);
    expect(progress.at(-1)).toBe(1); expect(output.segmentation?.windows).toHaveLength(3);
    expect(output.analyzedSeconds).toBe(65);
  });
  it("rejects a changed model and does not silently drop uncertain overlapping speech", async () => {
    let count = 0;
    await expect(analyzeSegmentedCaptions(request, runtime, async req => ({ ...result("", req.duration), modelSha256: String(count++) }), parseWhisperRecognition)).rejects.toThrow("身分不一致");
  });
});
