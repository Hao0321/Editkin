import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { LONGFORM_WORD_TIMING_V1, type LongformParsedWordWindowV1, type LongformWordTimingWindowV1,
  type LongformWordTimingIssueV1, type LongformTimedWordV1 } from "../domain/longformWordTimingV1";

const offsets = z.object({ from: z.number().int(), to: z.number().int() });
const token = z.object({ text: z.string().max(65536), id: z.number().int().nonnegative(),
  p: z.number().min(0).max(1), offsets: offsets.optional() });
const transcript = z.object({ transcription: z.array(z.object({ text: z.string().max(262144),
  offsets, tokens: z.array(token).max(LONGFORM_WORD_TIMING_V1.maximumWindowTokens),
})).max(4096) });
const windowSchema = z.strictObject({ index: z.number().int().nonnegative(), start: z.number().nonnegative(),
  coreStart: z.number().nonnegative(), coreEnd: z.number().positive(), duration: z.number().positive() });
const control = /^\[_[A-Z][A-Z0-9_]*(?:_[\d.]+)?_?\]$/;
const content = /[\p{L}\p{N}]/u;
const badUnicode = /�|[\uD800-\uDFFF]/u;

/** Actual recognizer clocks only. A partially timed word never borrows time from
 * neighbouring words or divides a subtitle interval by its character count. */
export function parseLongformWordWindowV1(rawJson: string, rawWindow: LongformWordTimingWindowV1,
  narrationDuration: number, language: "auto" | "zh" | "en" | "es" | "ja" | "ko" = "auto"): LongformParsedWordWindowV1 {
  if (Buffer.byteLength(rawJson, "utf8") > LONGFORM_WORD_TIMING_V1.maximumWindowJsonBytes)
    throw new Error("WORD_TIMING_JSON_BUDGET");
  const window = windowSchema.parse(rawWindow);
  if (!Number.isFinite(narrationDuration) || narrationDuration <= 0 || window.coreStart < window.start
    || window.coreEnd <= window.coreStart || window.coreEnd > window.start + window.duration
    || window.start + window.duration > narrationDuration) throw new Error("WORD_TIMING_WINDOW");
  const parsed = transcript.parse(JSON.parse(rawJson));
  if (parsed.transcription.reduce((count, row) => count + row.tokens.length, 0) > LONGFORM_WORD_TIMING_V1.maximumWindowTokens)
    throw new Error("WORD_TIMING_TOKEN_BUDGET");
  const issues: LongformWordTimingIssueV1[] = [], words: LongformTimedWordV1[] = [];
  const segments: LongformParsedWordWindowV1["segments"] = [];
  const segmenter = new Intl.Segmenter(language === "auto" ? undefined : language, { granularity: "word" });
  const issue = (code: LongformWordTimingIssueV1["code"], segmentIndex: number, extra: Partial<LongformWordTimingIssueV1> = {}) =>
    issues.push({ code, windowIndex: window.index, segmentIndex, ...extra });
  parsed.transcription.forEach((segment, segmentIndex) => {
    segments.push({ text: segment.text, start: window.start + segment.offsets.from / 1000,
      end: window.start + segment.offsets.to / 1000 });
    if (segment.offsets.from < 0 || segment.offsets.to <= segment.offsets.from || segment.offsets.to > window.duration * 1000)
      issue("SEGMENT_RANGE", segmentIndex);
    let joined = "";
    const spans = segment.tokens.flatMap((row, tokenIndex) => {
      if (control.test(row.text)) return [];
      const from = joined.length; joined += row.text;
      const valid = row.offsets !== undefined && row.offsets.from >= 0 && row.offsets.to > row.offsets.from
        && row.offsets.to <= window.duration * 1000;
      if (row.offsets && !valid && content.test(row.text)) issue("TOKEN_RANGE", segmentIndex, { tokenIndex });
      if (badUnicode.test(row.text)) issue("INVALID_UNICODE", segmentIndex, { tokenIndex });
      return [{ ...row, tokenIndex, from, to: joined.length, valid }];
    });
    if (joined.trim() !== segment.text.trim()) { issue("TOKEN_TEXT_MISMATCH", segmentIndex); return; }
    for (const part of segmenter.segment(joined)) {
      if (!part.isWordLike) continue;
      const from = part.index, to = from + part.segment.length;
      const selected = spans.filter(row => row.from < to && row.to > from);
      if (!selected.length || selected.some(row => !row.valid || badUnicode.test(row.text))) {
        issue("UNTIMED_WORD", segmentIndex, { text: part.segment }); continue;
      }
      const start = window.start + Math.min(...selected.map(row => row.offsets!.from)) / 1000;
      const end = window.start + Math.max(...selected.map(row => row.offsets!.to)) / 1000;
      // Overlap context is retained in raw evidence. Each word belongs to one core
      // by its acoustic midpoint; its original interval remains untouched.
      const midpoint = (start + end) / 2;
      if (midpoint < window.coreStart || midpoint >= window.coreEnd) continue;
      const sharedTokenRange = selected.some(row => content.test(joined.slice(row.from, from))
        || content.test(joined.slice(to, row.to)));
      if (sharedTokenRange) issue("SHARED_TOKEN_RANGE", segmentIndex, { text: part.segment });
      words.push({ text: part.segment, start, end, confidence: Math.min(...selected.map(row => row.p)),
        windowIndex: window.index, segmentIndex, characterStart: from, characterEnd: to,
        tokenIndices: selected.map(row => row.tokenIndex), sharedTokenRange });
    }
  });
  words.sort((a,b) => a.start - b.start || a.segmentIndex - b.segmentIndex || a.characterStart - b.characterStart);
  for (let index = 1; index < words.length; index++) {
    if (words[index].start < words[index - 1].end)
      issue("OVERLAPPING_WORDS", words[index].segmentIndex, { text: words[index].text });
  }
  return { schema: "editkin.longform-word-window/v1", clock: "narration_local_seconds", window,
    rawJsonSha256: createHash("sha256").update(rawJson).digest("hex"), words, segments, issues,
    requiresReview: issues.length > 0, syntheticTimingUsed: false };
}
