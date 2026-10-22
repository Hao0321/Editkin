import { describe, expect, it } from "vitest";
import { parseLongformWordWindowV1 } from "./longformWordTimingV1";
import { projectLongformCaptionSourceTextV1 } from "./longformCaptionSourceTextV1";
import { deriveLongformCaptionLinesV1 } from "./longformCaptionLinesV1";
const window = { index: 0, start: 0, coreStart: 0, coreEnd: 2, duration: 2 };
function fixture(text: string, tokenTexts: string[], timed = tokenTexts.map(() => true)) {
  const raw = JSON.stringify({ transcription: [{ text, offsets: { from: 0, to: 2000 },
    tokens: tokenTexts.map((text, index) => ({ text, id: index, p: 0.9,
      ...(timed[index] ? { offsets: { from: 100 + index * 300, to: 350 + index * 300 } } : {}) })) }] });
  return { raw, parsed: parseLongformWordWindowV1(raw, window, 2, "en") };
}
describe("raw token separators before caption fixes", () => {
  it("restores actual English spaces and punctuation even when segment leading whitespace differs", () => {
    const f = fixture("Hello, world!", ["  Hello,", " world!"]), before = structuredClone(f.parsed);
    const projected = projectLongformCaptionSourceTextV1(f.raw, f.parsed);
    expect(projected.words.map(word => word.text).join("")).toBe("  Hello, world!");
    expect(deriveLongformCaptionLinesV1(projected.words, 2).lines[0].text).toBe("Hello, world!");
    expect(projected.words.map(word => [word.start, word.end])).toEqual(f.parsed.words.map(word => [word.start, word.end]));
    expect(f.parsed).toEqual(before); expect(projected.syntheticTimingUsed).toBe(false);
  });
  it("corrects a separated cross-word term before wrapping without losing punctuation or actual endpoints", () => {
    const f = fixture("Cloud Code、UI!", ["Cloud", " Code、", "UI!"]);
    const projected = projectLongformCaptionSourceTextV1(f.raw, f.parsed), result = deriveLongformCaptionLinesV1(projected.words, 2, 20);
    expect(result.lines.map(line => line.text)).toEqual(["Claude Code、", "UI!"]);
    expect(result.lines.map(line => line.text).join("")).toBe("Claude Code、UI!");
    expect(result.lines.map(line => [line.start, line.end])).toEqual([[0.1, 0.65], [0.7, 0.95]]);
    expect(result.derived.words[0]).toMatchObject({ sourceWordIndices: [0, 1], start: 0.1, end: 0.65 });
  });
  it("keeps an untimed letter gap explicit and never attaches its text to a neighbour's clock", () => {
    const f = fixture("Hello missing world!", ["Hello ", "missing ", "world!"], [true, false, true]);
    const projected = projectLongformCaptionSourceTextV1(f.raw, f.parsed);
    expect(projected.words.map(word => word.text)).toEqual(["Hello", "world!"]);
    expect(projected.totalIssues).toBe(1); expect(projected.issues[0]).toMatchObject({ code: "UNTIMED_TEXT_GAP", beforeWordIndex: 0, afterWordIndex: 1 });
    expect(f.parsed.issues.some(issue => issue.code === "UNTIMED_WORD")).toBe(true);
  });
  it("preserves shared token clocks and Unicode separators without subdividing a recognizer token", () => {
    const f = fixture("Hello 😃 world!", ["Hello 😃 world!"]);
    const projected = projectLongformCaptionSourceTextV1(f.raw, f.parsed);
    expect(projected.words.map(word => word.text).join("")).toBe("Hello 😃 world!");
    expect(projected.words.map(word => [word.start, word.end])).toEqual([[0.1, 0.35], [0.1, 0.35]]);
    expect(f.parsed.issues.some(issue => issue.code === "SHARED_TOKEN_RANGE")).toBe(true);
  });
  it("never reinserts words discarded at the core-window boundary", () => {
    const f = fixture("outside Hello world! outside", ["outside ", "Hello ", "world! ", "outside"]);
    const narrowed = { ...window, coreStart: 0.4, coreEnd: 1 };
    const parsed = parseLongformWordWindowV1(f.raw, narrowed, 2, "en");
    const projected = projectLongformCaptionSourceTextV1(f.raw, parsed);
    expect(projected.words.map(word => word.text).join("").trim()).toBe("Hello world!");
    expect(projected.words).toHaveLength(2);
    const previous = parseLongformWordWindowV1(f.raw, { ...window, coreEnd: 0.4 }, 2, "en");
    const prior = projectLongformCaptionSourceTextV1(f.raw, previous);
    expect([...prior.words, ...projected.words].map(word => word.text).join("").trim()).toBe("outside Hello world!");
  });
  it("refuses changed raw bytes, false character ranges and lexical/time order conflicts", () => {
    const f = fixture("Hello, world!", ["Hello,", " world!"]);
    expect(() => projectLongformCaptionSourceTextV1(f.raw + " ", f.parsed)).toThrow("RAW_SHA");
    const changed = structuredClone(f.parsed); changed.words[0].characterStart++;
    expect(() => projectLongformCaptionSourceTextV1(f.raw, changed)).toThrow("WORD_RANGE");
    const inverted = structuredClone(f.parsed); inverted.words.reverse();
    expect(() => projectLongformCaptionSourceTextV1(f.raw, inverted)).toThrow("WORD_TEXT_ORDER");
  });
});
