import { createHash } from "node:crypto";
import type { LongformParsedWordWindowV1 } from "../domain/longformWordTimingV1";
import { LONGFORM_WORD_TIMING_V1 } from "../domain/longformWordTimingV1";
import type { CaptionSourceWordV1 } from "./longformCaptionWordRulesV1";

const controlToken = /^\[_[A-Z][A-Z0-9_]*(?:_[\d.]+)?_?\]$/;
const separators = /^[\p{P}\p{S}\s\u0085]*$/u;
const leadingSeparators = /^[\p{P}\p{S}\s\u0085]*/u;
export interface CaptionSourceTextIssueV1 {
  code: "UNTIMED_TEXT_GAP"; windowIndex: number; segmentIndex: number;
  beforeWordIndex: number; afterWordIndex: number; characterStart: number; characterEnd: number;
}
export interface CaptionSourceTextProjectionV1 {
  words: CaptionSourceWordV1[]; issues: CaptionSourceTextIssueV1[]; totalIssues: number; issuesTruncated: boolean;
  sourceRawSha256: string; sourceWordsUnchanged: true; syntheticTimingUsed: false;
}

/** Character ranges belong to concatenated non-control tokens, which may differ from segment.text at its edges. */
export function projectLongformCaptionSourceTextV1(rawJson: string, parsed: LongformParsedWordWindowV1): CaptionSourceTextProjectionV1 {
  if (Buffer.byteLength(rawJson, "utf8") > LONGFORM_WORD_TIMING_V1.maximumWindowJsonBytes)
    throw Error("CAPTION_SOURCE_RAW_BUDGET");
  const sourceRawSha256 = createHash("sha256").update(rawJson).digest("hex");
  if (sourceRawSha256 !== parsed.rawJsonSha256) throw Error("CAPTION_SOURCE_RAW_SHA");
  const document = JSON.parse(rawJson) as { transcription: Array<{ tokens: Array<{ text: string }> }> };
  if (!Array.isArray(document.transcription) || document.transcription.length !== parsed.segments.length)
    throw Error("CAPTION_SOURCE_SEGMENTS");
  const joined = document.transcription.map((segment, index) => {
    if (!Array.isArray(segment.tokens) || segment.tokens.some(token => typeof token.text !== "string")) throw Error("CAPTION_SOURCE_TOKENS");
    const text = segment.tokens.filter(token => !controlToken.test(token.text)).map(token => token.text).join("");
    if (text.trim() !== parsed.segments[index].text.trim()) throw Error("CAPTION_SOURCE_SEGMENT_TEXT");
    return text;
  });
  const words: CaptionSourceWordV1[] = parsed.words.map(word => ({ text: word.text, start: word.start, end: word.end }));
  const groups = new Map<number, number[]>();
  parsed.words.forEach((word, index) => {
    if (!Number.isSafeInteger(word.segmentIndex) || word.segmentIndex < 0 || word.segmentIndex >= joined.length
      || word.windowIndex !== parsed.window.index || !Number.isSafeInteger(word.characterStart) || !Number.isSafeInteger(word.characterEnd)
      || word.characterStart < 0 || word.characterEnd <= word.characterStart || word.characterEnd > joined[word.segmentIndex].length
      || joined[word.segmentIndex].slice(word.characterStart, word.characterEnd) !== word.text)
      throw Error("CAPTION_SOURCE_WORD_RANGE");
    const group = groups.get(word.segmentIndex) ?? []; group.push(index); groups.set(word.segmentIndex, group);
  });
  const issues: CaptionSourceTextIssueV1[] = []; let totalIssues = 0;
  for (const [segmentIndex, indexes] of groups) {
    const text = joined[segmentIndex];
    const first = parsed.words[indexes[0]], last = parsed.words[indexes.at(-1)!];
    const prefix = text.slice(0, first.characterStart);
    // A prefix containing discarded context words belongs to the preceding core window, which already owns its following separators.
    if (separators.test(prefix)) words[indexes[0]].text = prefix + words[indexes[0]].text;
    for (let position = 1; position < indexes.length; position++) {
      const beforeIndex = indexes[position - 1], afterIndex = indexes[position];
      const before = parsed.words[beforeIndex], after = parsed.words[afterIndex];
      if (before.characterEnd > after.characterStart) throw Error("CAPTION_SOURCE_WORD_TEXT_ORDER");
      const gap = text.slice(before.characterEnd, after.characterStart);
      if (separators.test(gap)) words[beforeIndex].text += gap;
      else {
        totalIssues++;
        if (issues.length < 200) issues.push({ code: "UNTIMED_TEXT_GAP", windowIndex: parsed.window.index, segmentIndex,
          beforeWordIndex: beforeIndex, afterWordIndex: afterIndex, characterStart: before.characterEnd, characterEnd: after.characterStart });
      }
    }
    words[indexes.at(-1)!].text += text.slice(last.characterEnd).match(leadingSeparators)?.[0] ?? "";
  }
  return { words, issues, totalIssues, issuesTruncated: totalIssues > issues.length, sourceRawSha256,
    sourceWordsUnchanged: true, syntheticTimingUsed: false };
}
