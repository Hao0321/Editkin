import type { LongformTimedWordV1 } from "../domain/longformWordTimingV1";
import { LONGFORM_CAPTION_LEXICON_V1 } from "../domain/longformCaptionLexiconV1";

export type CaptionSourceWordV1 = Pick<LongformTimedWordV1, "text" | "start" | "end">;
export interface DerivedCaptionWordV1 extends CaptionSourceWordV1 {
  sourceWordIndices: number[];
  fixIndices: number[];
}
export const TIMED_CAPTION_RULE_LIMITS_V1 = Object.freeze({ words: 200000, characters: 2000000,
  retainedCorrections: 200, correctionTextCharacters: 2048 });
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
function validText(text: unknown): text is string {
  return typeof text === "string" && !!text.trim() && !controls.test(text)
    && ![...text].some(char => char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff);
}
function pattern(source: string) {
  // Python's fixed \b is Unicode-aware. JS \b is ASCII-oriented, so preserve the source rule's boundary.
  const unicodeBoundary = source === "\\bC\\s*ode\\b"
    ? "(?<![\\p{L}\\p{N}_])C\\s*ode(?![\\p{L}\\p{N}_])" : source;
  return new RegExp(unicodeBoundary.replaceAll("\\s", "[\\s\\u0085]").replaceAll("\\S", "[^\\s\\u0085]"), "gu");
}
function clipped(text: string) {
  let result = text.slice(0, TIMED_CAPTION_RULE_LIMITS_V1.correctionTextCharacters);
  if (/[\ud800-\udbff]$/.test(result)) result = result.slice(0, -1);
  return result;
}
function wordAt(starts: readonly number[], position: number) {
  let low = 0, high = starts.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= position) low = middle; else high = middle - 1;
  }
  return low;
}

/** A derived layer only: raw recognition words and their token timing remain untouched. */
export function deriveLongformCaptionWordsV1(source: readonly CaptionSourceWordV1[], duration: number) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || source.length > TIMED_CAPTION_RULE_LIMITS_V1.words)
    throw Error("TIMED_CAPTION_SOURCE_BUDGET");
  let characters = 0, priorStart = -1, overlappingSourceWords = 0;
  source.forEach((word, index) => {
    if (!validText(word.text) || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < 0 || word.end <= word.start || word.end > duration || word.start < priorStart)
      throw Error("TIMED_CAPTION_SOURCE_CLOCK_OR_TEXT");
    characters += word.text.length; priorStart = word.start;
    if (index && word.start < source[index - 1].end) overlappingSourceWords++;
  });
  if (characters > TIMED_CAPTION_RULE_LIMITS_V1.characters) throw Error("TIMED_CAPTION_CHARACTER_BUDGET");
  let words: DerivedCaptionWordV1[] = source.map((word, index) => ({ text: word.text, start: word.start, end: word.end,
    sourceWordIndices: [index], fixIndices: [] }));
  const corrections: Array<{ fixIndex: number; sourceWordIndices: number[]; start: number; end: number;
    before: string; after: string; textTruncated: boolean; removed: boolean }> = [];
  let totalCorrections = 0;
  const removedSourceWordIndices: number[] = [];
  LONGFORM_CAPTION_LEXICON_V1.fixes.forEach(([expression, replacement], fixIndex) => {
    const joined = words.map(word => word.text).join("");
    const starts: number[] = []; let offset = 0;
    for (const word of words) { starts.push(offset); offset += word.text.length; }
    const groups: Array<{ first: number; last: number; matches: Array<{ start: number; end: number }> }> = [];
    let resultingLength = joined.length;
    for (const match of joined.matchAll(pattern(expression))) {
      if (match[0] === replacement) continue;
      const start = match.index!, end = start + match[0].length;
      const first = wordAt(starts, start), last = wordAt(starts, end - 1), prior = groups.at(-1);
      if (prior && first <= prior.last) { prior.last = Math.max(prior.last, last); prior.matches.push({ start, end }); }
      else groups.push({ first, last, matches: [{ start, end }] });
      resultingLength += replacement.length - match[0].length;
    }
    if (resultingLength > TIMED_CAPTION_RULE_LIMITS_V1.characters) throw Error("TIMED_CAPTION_REPLACEMENT_BUDGET");
    if (!groups.length) return;
    const next: DerivedCaptionWordV1[] = []; let cursor = 0;
    for (const group of groups) {
      for (let index = cursor; index < group.first; index++) next.push(words[index]);
      const selected = words.slice(group.first, group.last + 1), startOffset = starts[group.first];
      const endOffset = starts[group.last] + words[group.last].text.length;
      const before = joined.slice(startOffset, endOffset), parts: string[] = [];
      let characterCursor = startOffset;
      for (const match of group.matches) { parts.push(joined.slice(characterCursor, match.start), replacement); characterCursor = match.end; }
      parts.push(joined.slice(characterCursor, endOffset)); const text = parts.join("");
      const sourceWordIndices = selected.flatMap(word => word.sourceWordIndices);
      const start = selected.reduce((value, word) => Math.min(value, word.start), Infinity);
      const end = selected.reduce((value, word) => Math.max(value, word.end), -Infinity);
      const removed = !text.trim();
      totalCorrections++;
      if (corrections.length < TIMED_CAPTION_RULE_LIMITS_V1.retainedCorrections) corrections.push({ fixIndex, sourceWordIndices: [...sourceWordIndices],
        start, end, before: clipped(before), after: clipped(text), textTruncated: clipped(before) !== before || clipped(text) !== text, removed });
      if (removed) for (const index of sourceWordIndices) removedSourceWordIndices.push(index);
      else next.push({ text, start, end, sourceWordIndices,
        fixIndices: [...new Set([...selected.flatMap(word => word.fixIndices), fixIndex])] });
      cursor = group.last + 1;
    }
    for (let index = cursor; index < words.length; index++) next.push(words[index]);
    words = next;
  });
  return { schema: "editkin.longform-derived-caption-words/v1" as const,
    policyReferenceSha256: LONGFORM_CAPTION_LEXICON_V1.referenceSha256, words, corrections, totalCorrections,
    correctionsTruncated: totalCorrections > corrections.length, removedSourceWordIndices, overlappingSourceWords,
    contentVerified: false as const, requiresEditorReview: true as const, syntheticTimingUsed: false as const };
}
