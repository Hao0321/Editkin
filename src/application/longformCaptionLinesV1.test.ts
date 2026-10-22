import { describe, expect, it } from "vitest";
import { deriveLongformCaptionLinesV1 } from "./longformCaptionLinesV1";
import type { CaptionSourceWordV1 } from "./longformCaptionWordRulesV1";
function source(texts: string[]): CaptionSourceWordV1[] {
  return texts.map((text, index) => ({ text, start: index * 0.1, end: index * 0.1 + 0.09 }));
}
describe("source-clock longform caption lines", () => {
  it("applies cross-word fixes before any line split and covers every remaining source exactly once", () => {
    const words = source(["這是", "Cloud", "Code", "的", "美速圖", "教學", "接下來", "會", "分享", "觀念"]);
    const before = structuredClone(words), result = deriveLongformCaptionLinesV1(words, 2, 12);
    expect(result.lines.map(line => line.text).join("")).toBe("這是Claude Code的美術圖教學接下來會分享觀念");
    expect(result.lines.some(line => line.text.includes("Claude Code"))).toBe(true);
    expect(result.lines.flatMap(line => line.sourceWordIndices)).toEqual(words.map((_, index) => index));
    for (const line of result.lines) {
      expect(line.start).toBe(Math.min(...line.sourceWordIndices.map(index => words[index].start)));
      expect(line.end).toBe(Math.max(...line.sourceWordIndices.map(index => words[index].end)));
    }
    expect(words).toEqual(before); expect(result.syntheticTimingUsed).toBe(false);
  });
  it("keeps forbidden pairs and auxiliary phrases together even when a strict short limit must overflow", () => {
    const result = deriveLongformCaptionLinesV1(source(["我們", "社", "群", "會", "一", "直", "開發", "工具"]), 2, 4);
    const lines = result.lines.map(line => line.text);
    expect(lines.join("")).toBe("我們社群會一直開發工具");
    for (let index = 1; index < lines.length; index++) {
      expect(lines[index - 1].at(-1)! + lines[index][0]).not.toBe("社群");
      expect(lines[index - 1].at(-1)! + lines[index][0]).not.toBe("一直");
      expect(lines[index - 1].endsWith("會")).toBe(false); expect(lines[index - 1].endsWith("一直")).toBe(false);
    }
    expect(result.issues.some(issue => issue.code === "LINE_OVERFLOW")).toBe(true);
  });
  it("respects an actual pause while refusing to split a direction complement at the next head", () => {
    const words = source(["我們做好", "了", "下", "去", "再來一次", "其他章節"]);
    words[4].start = 1; words[4].end = 1.1; words[5].start = 1.6; words[5].end = 1.7;
    const result = deriveLongformCaptionLinesV1(words, 2, 15);
    expect(result.lines.map(line => line.text)).toEqual(["我們做好了下去", "再來一次", "其他章節"]);
    expect(result.lines[0].start).toBe(0); expect(result.lines[0].end).toBe(words[3].end);
  });
  it("preserves an indivisible real word and reports overflow rather than fabricating subword clocks", () => {
    const word = { text: "不可分割的辨識時間區間", start: 0.25, end: 1.75 };
    const result = deriveLongformCaptionLinesV1([word], 2, 4);
    expect(result.lines).toEqual([{ ...word, sourceWordIndices: [0] }]);
    expect(result.issues).toContainEqual({ code: "LINE_OVERFLOW", lineIndex: 0, observed: 11 });
    expect(result.contentVerified).toBe(false); expect(result.requiresEditorReview).toBe(true);
  });
  it("retains a final single character, reports overlap and rejects a nonintegral width", () => {
    const words = [{ text: "先看章節。", start: 0, end: 1 }, { text: "再看流程", start: 0.8, end: 1.4 }, { text: "好", start: 1.5, end: 1.7 }];
    const result = deriveLongformCaptionLinesV1(words, 2, 8);
    expect(result.lines.at(-1)!.text.endsWith("好")).toBe(true);
    expect(result.lines.flatMap(line => line.sourceWordIndices)).toEqual([0, 1, 2]);
    expect(result.issues.some(issue => issue.code === "OVERLAPPING_LINES")).toBe(true);
    expect(() => deriveLongformCaptionLinesV1(words, 2, 3.5)).toThrow("LINE_WIDTH");
    expect(deriveLongformCaptionLinesV1([], 2).lines).toEqual([]);
  });
});
