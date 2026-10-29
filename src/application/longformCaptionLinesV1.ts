import { LONGFORM_CAPTION_LEXICON_V1 } from "../domain/longformCaptionLexiconV1";
import { deriveLongformCaptionWordsV1, type CaptionSourceWordV1, type DerivedCaptionWordV1 } from "./longformCaptionWordRulesV1";

const never = new Set<string>(LONGFORM_CAPTION_LEXICON_V1.NEVER_SPLIT);
const tailHard = new Set<string>(LONGFORM_CAPTION_LEXICON_V1.TAIL_HARD);
const headHard = new Set<string>(LONGFORM_CAPTION_LEXICON_V1.HEAD_DANGLERS);
const clean = (text: string) => text.replace(/[\p{P}\p{S}\s]/gu, "");
const length = (text: string) => [...text.replace(/\s/gu, "")].length;
const letters = (text: string) => [...clean(text)].length;
function edge(words: readonly DerivedCaptionWordV1[], at: number, direction: -1 | 1) {
  let text = "", index = at;
  while (index >= 0 && index < words.length && text.length < 32) {
    text = direction < 0 ? words[index].text.slice(-32) + text : text + words[index].text.slice(0, 32);
    index += direction;
  }
  return clean(text);
}
function safeBoundary(words: readonly DerivedCaptionWordV1[], at: number) {
  if (at <= 0 || at >= words.length) return true;
  const before = edge(words, at - 1, -1), after = edge(words, at, 1);
  if (never.has((before.at(-1) ?? "") + (after[0] ?? ""))) return false;
  if (tailHard.has(before.at(-1) ?? "") || LONGFORM_CAPTION_LEXICON_V1.TAIL_HARD_TOK.some(token => before.endsWith(token))) return false;
  if (headHard.has(after[0] ?? "") || LONGFORM_CAPTION_LEXICON_V1.DIR_COMPLEMENTS.some(token => after.startsWith(token))) return false;
  return true;
}
export interface LongformDerivedCaptionLineV1 {
  text: string; start: number; end: number; sourceWordIndices: number[];
}

/** Break only between real timed words; an unsplittable phrase overflows with review evidence. */
export function deriveLongformCaptionLinesV1(source: readonly CaptionSourceWordV1[], duration: number, maxCharacters = 15) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 2 || maxCharacters > 80) throw Error("TIMED_CAPTION_LINE_WIDTH");
  const derived = deriveLongformCaptionWordsV1(source, duration), words = derived.words;
  const prefix = [0], letterPrefix = [0];
  for (const word of words) { prefix.push(prefix.at(-1)! + length(word.text)); letterPrefix.push(letterPrefix.at(-1)! + letters(word.text)); }
  const lines: LongformDerivedCaptionLineV1[] = [];
  const issues: Array<{ code: "LINE_OVERFLOW" | "ORPHAN_LINE" | "OVERLAPPING_LINES"; lineIndex: number; observed: number }> = [];
  const flush = (from: number, to: number) => {
    const selected = words.slice(from, to), text = selected.map(word => word.text).join("").trim();
    const line = { text, start: selected.reduce((value, word) => Math.min(value, word.start), Infinity),
      end: selected.reduce((value, word) => Math.max(value, word.end), -Infinity),
      sourceWordIndices: selected.flatMap(word => word.sourceWordIndices) };
    const lineIndex = lines.length;
    if (length(text) > maxCharacters) issues.push({ code: "LINE_OVERFLOW", lineIndex, observed: length(text) });
    if (letters(text) < 2) issues.push({ code: "ORPHAN_LINE", lineIndex, observed: letters(text) });
    if (lines.length && line.start < lines.at(-1)!.end) issues.push({ code: "OVERLAPPING_LINES", lineIndex, observed: lines.at(-1)!.end - line.start });
    lines.push(line);
  };
  let from = 0, at = 1, lastSafe = 0;
  while (at <= words.length) {
    const count = prefix[at] - prefix[from];
    if (at === words.length) { flush(from, at); break; }
    const safe = safeBoundary(words, at) && letterPrefix[at] - letterPrefix[from] >= 2;
    if (safe && count <= maxCharacters) lastSafe = at;
    const gap = words[at].start - words[at - 1].end;
    const punctuation = /[。！？!?]$/.test(words[at - 1].text.trim()) && count >= 4
      || /[，、；：,;…]$/.test(words[at - 1].text.trim()) && count >= 7 && !/^\d/u.test(words[at].text.trim());
    const pause = gap > 0.42 || gap > 0.28 && count >= 9;
    let to = 0;
    if ((punctuation || pause) && safe) to = at;
    else if (count > maxCharacters && lastSafe > from) to = lastSafe;
    else if (count > maxCharacters + 3 && safe) to = at;
    // Keep a final one-character remainder attached; no artificial word clock is introduced.
    if (to && letterPrefix.at(-1)! - letterPrefix[to] < 2) to = words.length;
    if (to) { flush(from, to); from = to; at = from + 1; lastSafe = from; }
    else at++;
  }
  return { schema: "editkin.longform-caption-lines/v1" as const, maxCharacters, lines, issues, derived,
    contentVerified: false as const, requiresEditorReview: true as const, syntheticTimingUsed: false as const };
}
