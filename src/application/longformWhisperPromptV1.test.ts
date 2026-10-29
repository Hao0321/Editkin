import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { resolveLongformWhisperPromptV1, longformWhisperPromptArgumentsV1,
  LONGFORM_WHISPER_VOCABULARY_V1, LONGFORM_WHISPER_PROMPT_LIMITS_V1 } from "./longformWhisperPromptV1";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("uses only stable nonempty canonical Hao replacements, deduplicated without executing VA", () => {
  expect(LONGFORM_WHISPER_VOCABULARY_V1).toEqual(["Claude Code", "美術圖", "立繪", "Unreal", "任何", "這行", "手寫", "遊戲", "寫 code", "App Store", "Code", "GPT", "UI"]);
  const prompt = resolveLongformWhisperPromptV1("zh");
  expect(prompt.text).toBe(LONGFORM_WHISPER_VOCABULARY_V1.join(", "));
  expect(prompt.canonicalVocabularySha256).toBe(hash(JSON.stringify(LONGFORM_WHISPER_VOCABULARY_V1)));
  expect(prompt.canonicalVocabularyIncluded).toBe(true); expect(prompt.callerPromptIncluded).toBe(false);
  expect(Object.isFrozen(prompt)).toBe(true); expect(Object.isFrozen(LONGFORM_WHISPER_VOCABULARY_V1)).toBe(true);
});
it("keeps non-Chinese calls without explicit context free of a prompt argument", () => {
  for (const language of ["auto", "en", "es", "ja", "ko"] as const) {
    const prompt = resolveLongformWhisperPromptV1(language);
    expect(prompt.text).toBe(""); expect(prompt.textSha256).toBe(hash(""));
    expect(longformWhisperPromptArgumentsV1(prompt, "--output-json-full")).toEqual([]);
  }
});
it("passes caller context as one literal argument with the exact resolved text hash", () => {
  const text = "--model 'quoted' $() 你好🙂", prompt = resolveLongformWhisperPromptV1("en", ` ${text} `);
  expect(longformWhisperPromptArgumentsV1(prompt, "--prompt PROMPT")).toEqual(["--prompt", text]);
  expect(prompt.textSha256).toBe(hash(text)); expect(prompt.runtimeTokenCoverageVerified).toBe(false);
});
it("appends canonical Chinese vocabulary to the short caller context and binds the resolved text", () => {
  const prompt = resolveLongformWhisperPromptV1("zh", "教學內容");
  expect(prompt.text).toBe(`教學內容\n${LONGFORM_WHISPER_VOCABULARY_V1.join(", ")}`);
  expect(prompt.textSha256).toBe(hash(prompt.text)); expect(prompt.callerPromptIncluded).toBe(true);
});
it("bounds actual UTF-8 bytes including the combined vocabulary without splitting Unicode", () => {
  const text = "🙂".repeat(LONGFORM_WHISPER_PROMPT_LIMITS_V1.resolvedUtf8Bytes / 4);
  expect(resolveLongformWhisperPromptV1("en", text).text).toBe(text);
  expect(() => resolveLongformWhisperPromptV1("en", text + "🙂")).toThrow("PROMPT_BUDGET");
  expect(() => resolveLongformWhisperPromptV1("zh", "a".repeat(224))).toThrow("PROMPT_BUDGET");
});
it("refuses empty, malformed Unicode, controls and oversized caller context", () => {
  for (const text of ["", " \n ", "bad\0text", "bad\u0085text", "bad\ud800text", "a".repeat(257)])
    expect(() => resolveLongformWhisperPromptV1("en", text)).toThrow("PROMPT_TEXT");
});
it("refuses unsupported nonempty prompts without accepting similarly named flags or silently falling back", () => {
  const prompt = resolveLongformWhisperPromptV1("zh");
  expect(() => longformWhisperPromptArgumentsV1(prompt, "--carry-initial-prompt\n--prompting TEXT")).toThrow("PROMPT_MISSING");
  expect(longformWhisperPromptArgumentsV1(prompt, "             --prompt PROMPT [ ] initial prompt")).toEqual(["--prompt", prompt.text]);
});
