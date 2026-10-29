import { describe, expect, it } from "vitest";
import { LONGFORM_CAPTION_LEXICON_V1 } from "../domain/longformCaptionLexiconV1";
import { deriveLongformCaptionWordsV1, type CaptionSourceWordV1 } from "./longformCaptionWordRulesV1";
const word = (text: string, index: number): CaptionSourceWordV1 => ({ text, start: index / 2, end: index / 2 + 0.4 });

describe("separate canonical timed-word corrections", () => {
  it("merges a cross-word correction using the exact original endpoints and preserves frozen input", () => {
    const source = Object.freeze([Object.freeze(word("Cloud", 0)), Object.freeze(word(" Code", 1)), Object.freeze(word("做出來", 2))]);
    const result = deriveLongformCaptionWordsV1(source, 2);
    expect(result.words[0]).toEqual({ text: "Claude Code", start: 0, end: 0.9, sourceWordIndices: [0, 1], fixIndices: [0] });
    expect(source.map(row => row.text)).toEqual(["Cloud", " Code", "做出來"]);
    expect(result.syntheticTimingUsed).toBe(false); expect(result.requiresEditorReview).toBe(true);
  });
  it("corrects every occurrence inside a word and retains surrounding emoji and source clock", () => {
    const source = [word("😃Cloud Code與Cloud Code！", 0)];
    const result = deriveLongformCaptionWordsV1(source, 1);
    expect(result.words[0].text).toBe("😃Claude Code與Claude Code！");
    expect(result.words[0].start).toBe(source[0].start); expect(result.words[0].end).toBe(source[0].end);
    expect(result.words[0].sourceWordIndices).toEqual([0]);
  });
  it("preserves the Python Unicode word-boundary rule and joins only actual matched character ranges", () => {
    const source = [word("中C ode中、C ode、Code、C ode尾", 0)];
    expect(deriveLongformCaptionWordsV1(source, 1).words[0].text).toBe("中C ode中、Code、Code、C ode尾");
    expect(deriveLongformCaptionWordsV1([word("G\u0085P\u0085T", 0)], 1).words[0].text).toBe("GPT");
  });
  it("removes credit hallucinations only from the derived layer and retains exact source indices", () => {
    const source = [word("字幕組abc", 0), word("真正旁白", 1)];
    const result = deriveLongformCaptionWordsV1(source, 2);
    // Canonical \S* reaches contiguous non-whitespace, as in the source policy.
    expect(result.words).toEqual([]); expect(result.removedSourceWordIndices).toEqual([0, 1]);
    expect(result.corrections[0]).toMatchObject({ start: 0, end: 0.9, removed: true, sourceWordIndices: [0, 1] });
    expect(source[1].text).toBe("真正旁白"); expect(result.contentVerified).toBe(false);
  });
  it("retains real overlapping evidence and rejects invalid/orderless/oversized evidence without invented timing", () => {
    const overlapping = [word("Cloud", 0), { text: "Code", start: 0.2, end: 0.3 }];
    const result = deriveLongformCaptionWordsV1(overlapping, 1);
    expect(result.words[0]).toMatchObject({ start: 0, end: 0.4 }); expect(result.overlappingSourceWords).toBe(1);
    for (const source of [[{ text: "a", start: NaN, end: 1 }], [{ text: "\ud800", start: 0, end: 1 }],
      [word("a", 1), word("b", 0)], [word("x".repeat(2000001), 0)]])
      expect(() => deriveLongformCaptionWordsV1(source, 2)).toThrow();
  });
  it("bounds correction retention and keeps complete totals and source ownership", () => {
    const source = Array.from({ length: 205 }, (_, index) => word("Cloud Code ", index));
    const result = deriveLongformCaptionWordsV1(source, 104);
    expect(result.words).toHaveLength(205); expect(result.totalCorrections).toBe(205);
    expect(result.corrections).toHaveLength(200); expect(result.correctionsTruncated).toBe(true);
    expect(result.words.flatMap(row => row.sourceWordIndices)).toEqual(source.map((_, index) => index));
    expect(LONGFORM_CAPTION_LEXICON_V1.fixes).toHaveLength(21); expect(LONGFORM_CAPTION_LEXICON_V1.NEVER_SPLIT).toHaveLength(92);
  });
  it("handles an admitted transcript beyond the JS argument-count limit without dropping a source word", () => {
    const count = 140000;
    const source = Array.from({ length: count }, (_, index) => ({ text: index ? "a" : "Cloud Code", start: index / count, end: (index + 1) / count }));
    const result = deriveLongformCaptionWordsV1(source, 1);
    expect(result.words).toHaveLength(count); expect(result.words[0].text).toBe("Claude Code");
    expect(result.words.at(-1)).toMatchObject({ sourceWordIndices: [count - 1], end: 1 });
  });
});
