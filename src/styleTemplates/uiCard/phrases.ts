/**
 * Phrase captions (S1 v2): timed words → complete short phrases for one-line subtitles.
 * Hard breaks: an untimed recognizer word between two words (gapBefore) or a real pause; inside a run, a
 * dynamic program picks breaks that fall on the longest pauses while keeping every line within `maxChars`
 * (CJK = 1, Latin/digits ≈ 0.55) and avoiding stub phrases. Never splits a word. Pure and deterministic.
 */

export interface PhraseWord { readonly text: string; readonly start: number; readonly end: number; readonly gapBefore?: boolean }

export interface PhraseOptions {
  readonly maxChars?: number;
  /** A pause at least this long always ends a phrase (s). */
  readonly hardPause?: number;
  /** Word indices that must start a phrase (e.g. a keyword's lockup boundaries). */
  readonly forcedStarts?: ReadonlySet<number>;
}

export function displayChars(text: string): number {
  let count = 0;
  for (const character of text) count += /\s/.test(character) ? 0.3 : /[\u0000-ɏ]/.test(character) ? 0.55 : 1;
  return count;
}

export function segmentPhrases(words: readonly PhraseWord[], options: PhraseOptions = {}): Array<[number, number]> {
  const maxChars = options.maxChars ?? 16, hardPause = options.hardPause ?? 0.35;
  const forced = options.forcedStarts ?? new Set<number>();
  const pause = (i: number) => (i <= 0 ? Infinity : words[i].start - words[i - 1].end);
  // Runs between hard breaks.
  const runs: Array<[number, number]> = [];
  let runStart = 0;
  for (let i = 1; i <= words.length; i += 1) {
    if (i === words.length || words[i].gapBefore || pause(i) >= hardPause || forced.has(i)) { runs.push([runStart, i - 1]); runStart = i; }
  }
  const out: Array<[number, number]> = [];
  for (const [a, b] of runs) {
    // best[i] = min cost to cover words a..i-1 with phrases; a break before word j earns its pause.
    const n = b - a + 1;
    const best = new Array<number>(n + 1).fill(Infinity), from = new Array<number>(n + 1).fill(-1);
    best[0] = 0;
    for (let end = 1; end <= n; end += 1) {
      let chars = 0;
      for (let start = end - 1; start >= 0; start -= 1) {
        chars += displayChars(words[a + start].text);
        if (chars > maxChars && start < end - 1) break;
        if (best[start] === Infinity) continue;
        // Cost: one per phrase, short stubs penalized, breaks rewarded by the pause before them.
        const breakReward = start === 0 ? 0 : Math.min(0.5, Math.max(0, pause(a + start))) * 4;
        const stub = chars < 3 ? 2.2 : chars < 5 ? 0.6 : 0;
        const cost = best[start] + 1 + stub - breakReward;
        if (cost < best[end]) { best[end] = cost; from[end] = start; }
      }
    }
    const pieces: Array<[number, number]> = [];
    for (let end = n; end > 0; end = from[end]) pieces.unshift([a + from[end], a + end - 1]);
    out.push(...pieces);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phrases from the recognizer's segments (complete text with punctuation)
// ---------------------------------------------------------------------------

export interface RecognizerSegment { readonly start: number; readonly end: number; readonly text: string }

export interface SegmentPhrase {
  /** Display text: the recognizer's complete clause (untimed words included), spaced CJK|Latin, no clause-final punctuation. */
  readonly text: string;
  /** Timed words aligned inside it (inclusive range), and where each sits in `text` (char offsets). */
  readonly words: readonly [number, number];
  readonly offsets: ReadonlyArray<{ readonly word: number; readonly from: number; readonly to: number }>;
  readonly start: number;
  readonly end: number;
}

const CLAUSE_BREAK = /[,，。！？!?；;：:]/;
const isLatin = (c: string) => /[A-Za-z0-9]/.test(c);
const isCjk = (c: string) => /[㐀-鿿豈-﫿]/.test(c);

/** CJK|Latin boundaries get one space ("用 GPT 來生"); runs of spaces collapse. */
export function spaceMixedScript(text: string): string {
  let out = "";
  for (const c of text.replace(/\s+/g, " ").trim()) {
    const last = out[out.length - 1];
    if (last && c !== " " && last !== " " && ((isCjk(last) && isLatin(c)) || (isLatin(last) && isCjk(c)))) out += " ";
    out += c;
  }
  return out;
}

/**
 * Clauses of the recognizer's segments, each anchored to the timed words it contains. Segments that repeat speech
 * (overlapping recognition windows) are dropped: a clause whose words were already used carries no new words.
 * Clauses longer than `maxChars` split at the timed-word boundary with the longest pause (both halves ≥ 4 chars).
 */
export function phrasesFromSegments(segments: readonly RecognizerSegment[], words: readonly PhraseWord[], maxChars = 16): SegmentPhrase[] {
  let pointer = 0;
  const out: SegmentPhrase[] = [];
  for (const segment of segments) {
    const clauses = segment.text.split(CLAUSE_BREAK).map(part => part.trim()).filter(Boolean);
    for (const raw of clauses) {
      const text = spaceMixedScript(raw);
      // Overlapping recognition windows repeat speech: a clause already shown (inside a recent phrase) is skipped.
      if (out.slice(-4).some(previous => previous.text.replace(/\s+/g, "").includes(text.replace(/\s+/g, "")))) continue;
      const offsets: Array<{ word: number; from: number; to: number }> = [];
      let i = 0;
      const compact = (s: string) => s.replace(/\s+/g, "");
      // Where word w matches at i (ignoring spaces inside the display text), or -1.
      const matchAt = (w: number, at: number) => {
        const target = compact(words[w].text);
        let j = at, k = 0;
        while (j < text.length && k < target.length) { if (text[j] === " ") { j += 1; continue; } if (text[j] !== target[k]) break; j += 1; k += 1; }
        return k === target.length ? j : -1;
      };
      while (pointer < words.length && i < text.length) {
        const end = matchAt(pointer, i);
        if (end >= 0) { let from = i; while (text[from] === " ") from += 1; offsets.push({ word: pointer, from, to: end }); pointer += 1; i = end; continue; }
        // A word the segment text spells differently: skip it if one of the next words (≥ 2 characters, inside this
        // segment's time) matches here instead.
        let skipped = false;
        for (let d = 1; d <= 3 && pointer + d < words.length; d += 1) {
          const candidate = words[pointer + d];
          if (compact(candidate.text).length < 2 || candidate.start < segment.start - 0.5 || candidate.start > segment.end + 0.5) continue;
          const to = matchAt(pointer + d, i);
          if (to < 0) continue;
          for (let e = 0; e < d; e += 1) offsets.push({ word: pointer + e, from: i, to: i });
          let from = i; while (text[from] === " ") from += 1;
          offsets.push({ word: pointer + d, from, to }); pointer += d + 1; i = to; skipped = true;
          break;
        }
        if (!skipped) i += 1; // an untimed character of the clause
      }
      if (!offsets.length) continue; // nothing timed
      out.push(...splitLong({ text, offsets, words: [offsets[0].word, offsets[offsets.length - 1].word],
        start: words[offsets[0].word].start, end: Math.max(...offsets.map(offset => words[offset.word].end)) }, words, maxChars));
    }
  }
  return out;
}

const compactLength = (text: string) => [...text.replace(/\s+/g, "")].length;

function splitLong(phrase: SegmentPhrase, words: readonly PhraseWord[], maxChars: number): SegmentPhrase[] {
  if (displayChars(phrase.text) <= maxChars || phrase.offsets.length < 2) return [phrase];
  let best = -1, bestScore = -Infinity;
  // Split right after a timed word (untimed characters go with the words that follow them).
  const splitAt = (k: number) => phrase.offsets[k - 1].to;
  for (let k = 1; k < phrase.offsets.length; k += 1) {
    const at = splitAt(k);
    if (at <= 0 || at >= phrase.text.length) continue;
    const left = displayChars(phrase.text.slice(0, at)), right = displayChars(phrase.text.slice(at));
    if (left < 4 || right < 4) continue;
    const pause = words[phrase.offsets[k].word].start - words[phrase.offsets[k - 1].word].end;
    // A one-character word at the end of a line usually binds to what follows (我 / 的 / 了 …).
    const dangling = compactLength(words[phrase.offsets[k - 1].word].text) === 1 ? 1.5 : 0;
    const score = Math.min(0.6, Math.max(0, pause)) * 10 - Math.abs(left - right) * 0.25 - (left > maxChars || right > maxChars ? 5 : 0) - dangling;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) return [phrase];
  const at = splitAt(best);
  const make = (from: number, to: number, list: SegmentPhrase["offsets"]): SegmentPhrase => ({
    text: phrase.text.slice(from, to).trim(), offsets: list.map(offset => ({ ...offset, from: offset.from - from, to: offset.to - from })),
    words: [list[0].word, list[list.length - 1].word], start: words[list[0].word].start, end: Math.max(...list.map(offset => words[offset.word].end)) });
  const left = make(0, at, phrase.offsets.slice(0, best)), right = make(at, phrase.text.length, phrase.offsets.slice(best));
  return [...splitLong(left, words, maxChars), ...splitLong(right, words, maxChars)];
}
