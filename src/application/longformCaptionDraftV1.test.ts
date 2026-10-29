import { describe, expect, it, vi } from "vitest";
import { readLongformCaptionDraftV1, type CaptionDraftDepsV1 } from "./longformCaptionDraftV1";
import type { LongformWordTimingArtifactV1 } from "./longformWordRecognitionV1";
import type { LongformTimedWordV1 } from "../domain/longformWordTimingV1";
const runtime = { sourceRoot: "D:/owned", cacheRoot: "D:/owned/cache" }, artifactId = "a".repeat(64);
function fixture() {
  const index = { schema: "editkin.longform-word-cache-window/v1" as const, key: "b".repeat(64), rawFile: "raw.json", parsedFile: "parsed.json",
    rawSha256: "c".repeat(64), parsedSha256: "d".repeat(64), wordCount: 2, issueCount: 3, segmentCount: 1 };
  const artifact = { artifactId, wordCount: 2, issueCount: 3, windows: [index],
    intake: { request: { language: "zh" }, materials: [{ kind: "narration", duration: 2, sourceStart: 7 }] } } as LongformWordTimingArtifactV1;
  const words = [{ text: "先看流程。", start: 0, end: 0.6 }, { text: "下一段落", start: 1.2, end: 1.8 }] as LongformTimedWordV1[];
  const deps: CaptionDraftDepsV1 = { text: vi.fn<CaptionDraftDepsV1["text"]>(async (_root, current) => ({
      words: current.parsed.words.map(word => ({ text: word.text, start: word.start, end: word.end })),
      issues: [], totalIssues: 0, issuesTruncated: false, sourceRawSha256: current.index.rawSha256,
      sourceWordsUnchanged: true, syntheticTimingUsed: false })), artifact: vi.fn(async () => structuredClone(artifact)), identity: vi.fn(async () => "e".repeat(64)),
    window: vi.fn(async () => ({ index: structuredClone(index), parsed: { words } } as Awaited<ReturnType<CaptionDraftDepsV1["window"]>>)) };
  return { index, artifact, words, deps };
}
describe("source-bound caption artifact derivation", () => {
  it("reads validated windows once, revalidates the source and returns stable bounded pages and original issues", async () => {
    const f = fixture(), before = structuredClone(f.words);
    const first = await readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, f.deps);
    expect(first.lines).toEqual([{ lineIndex: 0, text: "先看流程。", start: 0, end: 0.6, sourceWordIndices: [0] }]);
    expect(first).toMatchObject({ originalAsrIssueCount: 3, totalLines: 2, nextOffset: 1, narrationSourceStart: 7,
      contentVerified: false, syntheticTimingUsed: false, projectModified: false });
    expect(f.deps.artifact).toHaveBeenCalledTimes(2); expect(f.deps.window).toHaveBeenCalledTimes(1);
    const second = await readLongformCaptionDraftV1(runtime, artifactId, 15, 1, 1, f.deps);
    expect(second.binding).toEqual(first.binding); expect(second.lines[0].sourceWordIndices).toEqual([1]); expect(second.nextOffset).toBeNull();
    expect(f.words).toEqual(before);
  });
  it("rejects a changed window index and incomplete word references instead of publishing invented captions", async () => {
    const g = fixture(); g.deps.window = vi.fn(async () => ({ index: { ...g.index, wordCount: 1 }, parsed: { words: g.words } } as any));
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, g.deps)).rejects.toThrow("WINDOW_REFERENCE");
    const h = fixture(); h.artifact.wordCount = 1;
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, h.deps)).rejects.toThrow("WORD_REFERENCE");
  });
  it("rejects changed material/policy generations and cancellation before returning a page", async () => {
    const f = fixture(); vi.mocked(f.deps.artifact).mockImplementationOnce(async () => structuredClone(f.artifact))
      .mockImplementationOnce(async () => ({ ...structuredClone(f.artifact), issueCount: 4 }));
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, f.deps)).rejects.toThrow("SOURCE_OR_POLICY_CHANGED");
    const g = fixture(); vi.mocked(g.deps.identity).mockResolvedValueOnce("e".repeat(64)).mockResolvedValueOnce("f".repeat(64));
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, g.deps)).rejects.toThrow("SOURCE_OR_POLICY_CHANGED");
    const controller = new AbortController(); controller.abort();
    await expect(readLongformCaptionDraftV1({ ...runtime, signal: controller.signal }, artifactId, 15, 0, 1, fixture().deps)).rejects.toThrow();
  });
  it("rejects a source text projector that changes a real word clock before returning any line", async () => {
    const f = fixture(); const actual = f.deps.text;
    f.deps.text = vi.fn<CaptionDraftDepsV1["text"]>(async (...args) => {
      const result = await actual(...args); result.words[0].start += 0.01; return result;
    });
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, f.deps)).rejects.toThrow("TEXT_CLOCK_REFERENCE");
  });
  it("refuses excessive source counts and invalid pages before source IO", async () => {
    const f = fixture(); f.artifact.wordCount = 200001;
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, 0, 1, f.deps)).rejects.toThrow("WORD_BUDGET");
    const g = fixture();
    await expect(readLongformCaptionDraftV1(runtime, artifactId, 15, -1, 1, g.deps)).rejects.toThrow("INPUT_OR_PAGE");
    expect(g.deps.artifact).not.toHaveBeenCalled();
  });
});
