import { describe, expect, it } from "vitest";
import { breakCaptionLines, captionEmWidth, libassWrapText } from "./captionLineBreak";

const words = (text: string) => new Set([...new Intl.Segmenter("zh-Hant", { granularity: "word" }).segment(text)].map((part) => part.index));
const lettersOf = (line: string) => [...line].filter((character) => !/[\s\p{P}\p{S}]/u.test(character)).length;

function expectValidLayout(source: string, maxEm = 14) {
  const lines = breakCaptionLines(source, maxEm).split("\n");
  // Nothing added or lost (only spaces at a break go), every line fits, no one-character line,
  // and no line opens with closing punctuation.
  expect(lines.join("").replace(/\s/g, "")).toBe(source.replace(/\s/g, ""));
  for (const line of lines) {
    expect(captionEmWidth(line)).toBeLessThanOrEqual(maxEm);
    expect(lettersOf(line)).toBeGreaterThanOrEqual(2);
    expect(line).not.toMatch(/^[，。、；：！？」』）]/u);
  }
  return lines;
}

describe("Shorts caption line breaking (≤14 CJK characters, whole words, no orphan)", () => {
  it("leaves a caption that fits on one line untouched", () => {
    expect(breakCaptionLines("樹上停滿獨角仙", 14)).toBe("樹上停滿獨角仙");
    expect(breakCaptionLines("一二三四五六七八九十一二三四", 14)).toBe("一二三四五六七八九十一二三四");
  });

  it("splits a long sentence into balanced lines at a word boundary", () => {
    const source = "今天帶大家來看觀音山遊客中心門口這棵樹上停滿的獨角仙";
    const lines = expectValidLayout(source);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe(source);
    expect(words(source).has(lines[0].length)).toBe(true);
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThanOrEqual(2);
    expect(lines).toEqual(["今天帶大家來看觀音山遊客中心", "門口這棵樹上停滿的獨角仙"]);
  });

  it("does not split a compound the dictionary misses (社|群) when a clean break exists", () => {
    expect(breakCaptionLines("我們自由工房的社群已經超過一萬人了", 14)).toBe("我們自由工房的社群\n已經超過一萬人了");
    expect(breakCaptionLines("任何人待在同一個社群裡，真的就會合作", 14).split("\n").some((line) => line.endsWith("社"))).toBe(false);
  });

  it("prefers the break after punctuation", () => {
    expect(breakCaptionLines("這碗湯頭真的很濃，麵條是自己做的", 14)).toBe("這碗湯頭真的很濃，\n麵條是自己做的");
  });

  it("never leaves a single character on the last line", () => {
    const lines = expectValidLayout("我們自由工房的社群已經超過一萬人了");
    expect(lines.at(-1)!.length).toBeGreaterThanOrEqual(2);
    expect(lines.join("")).toBe("我們自由工房的社群已經超過一萬人了");
  });

  it("keeps Latin words and numbers whole in mixed captions", () => {
    const source = "這個 AI 工具真的很好用我們今天來實際測試 Claude Code 看看";
    const lines = expectValidLayout(source);
    expect(lines.some((line) => /\bAI\b/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes("Claude") && !line.endsWith("Clau"))).toBe(true);
    for (const line of lines) expect(line).not.toMatch(/^(Code|ode|laude)/);
  });

  it("keeps explicit line breaks and only splits a word wider than a whole line", () => {
    expect(breakCaptionLines("第一行\n第二行", 14)).toBe("第一行\n第二行");
    const long = breakCaptionLines("Supercalifragilisticexpialidocious", 14).split("\n");
    expect(long.length).toBeGreaterThan(1);
    expect(long.join("")).toBe("Supercalifragilisticexpialidocious");
  });
});

describe("libass wrapping for the previews (WrapStyle 0, wrap_unicode)", () => {
  // Measured with the vendored FFmpeg/libass: the long-form default (Noto Sans TC 800, ASS 54) on 1920 px wide,
  // 1840 px between the side margins = 49.34 em. Each probe glyph is one em wide.
  const maxEm = 1840 / (54 / 1.448);
  const split = (text: string) => libassWrapText(text, maxEm).split("\n");
  const counts = (text: string) => split(text).map((line) => [...line].length);

  it("evens two lines one glyph at a time and leaves the lower line wider on odd counts, as libass does", () => {
    expect(counts("永".repeat(53))).toEqual([26, 27]);
    expect(counts("永".repeat(54))).toEqual([27, 27]);
    expect(counts("永".repeat(55))).toEqual([27, 28]);
    expect(counts("永".repeat(57))).toEqual([28, 29]);
    expect(counts("永".repeat(48) + "，" + "永".repeat(6))).toEqual([27, 28]);
  });

  it("copies libass's own punctuation quirks instead of correcting them", () => {
    // libass opens the lower line with a comma and closes the upper one with an opening bracket here.
    expect(split("永".repeat(28) + "，" + "永".repeat(26))).toEqual(["永".repeat(28), "，" + "永".repeat(26)]);
    expect(split("永".repeat(27) + "，" + "永".repeat(27))).toEqual(["永".repeat(27), "，" + "永".repeat(27)]);
    expect(split("永".repeat(26) + "，" + "永".repeat(28))).toEqual(["永".repeat(26) + "，", "永".repeat(28)]);
    expect(split("永".repeat(27) + "「" + "永".repeat(27))).toEqual(["永".repeat(27) + "「", "永".repeat(27)]);
    expect(split("這是一段很長的字幕，用來測試橫式長片在超過畫面寬度的時候，輸出端會自動換行，預覽端也一定要在同一個地方換行才對"))
      .toEqual(["這是一段很長的字幕，用來測試橫式長片在超過畫面寬度的時候", "，輸出端會自動換行，預覽端也一定要在同一個地方換行才對"]);
  });

  it("moves whole words at spaces and leaves short lines and explicit newlines alone", () => {
    expect(split(Array(30).fill("word").join(" "))).toEqual([Array(15).fill("word").join(" "), Array(15).fill("word").join(" ")]);
    expect(libassWrapText("  短句  \n第二行", maxEm)).toBe("短句\n第二行");
    expect(libassWrapText("永".repeat(80), Number.NaN)).toBe("永".repeat(80));
    // Letter spacing widens every glyph: 40 glyphs at 0.25 em extra no longer fit 49.34 em.
    expect(libassWrapText("永".repeat(40), maxEm, 0.25).split("\n")).toHaveLength(2);
  });
});
