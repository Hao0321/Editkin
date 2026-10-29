/**
 * Balanced caption line breaking for CJK-first captions (roadmap 1.6/1.7). Every line fits maxEm,
 * breaks fall only between words (ICU word segmentation), a line never starts with closing
 * punctuation and never ends with an opening bracket, no line is a single character, a break after
 * punctuation is preferred, and lines are as even as possible (the lower line may be the wider one).
 * A word wider than a whole line is the only thing ever split. Explicit newlines are kept.
 */
const wordSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh-Hant", { granularity: "word" }) : undefined;
const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh-Hant", { granularity: "grapheme" }) : undefined;

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u;
const NO_LINE_START = /^[，。、；：！？」』）》〉】〕…‧·,.;:!?)\]}%～〜ー]/u;
const NO_LINE_END = /[「『（《〈【〔([{]$/u;
/** Particles that bind to the word before them; a line should not open with one. */
const BOUND_PARTICLE = /^(?:的|了|嗎|呢|吧|啊|喔|呀|啦|地|得|著|過|們|嘛)/u;
const BREAK_AFTER = /[，。、；：！？,.;:!?…]$/u;
const PHRASE_END = /(?:的|了|嗎|呢|吧|啊|啦|喔|呀|嘛)$/u;
const SINGLE_HAN = /^\p{Script=Han}$/u;

/** How natural a break between two adjacent word units is. The segmenter's dictionary misses
 * compounds (社|群, 很好|用): a single-character unit on either side is a likely fragment of a word. */
function breakCost(before: Unit | undefined, after: Unit | undefined): number {
  if (!before || !after) return 0;
  if (BREAK_AFTER.test(before.text)) return 0;
  if (PHRASE_END.test(before.text)) return 1;
  const shortBefore = SINGLE_HAN.test(before.text.trim()); const shortAfter = SINGLE_HAN.test(after.text.trim());
  if (shortBefore && shortAfter) return 15;
  return shortBefore || shortAfter ? 4 : 2;
}

interface Unit { text: string; width: number; letters: number }

function graphemes(text: string): string[] {
  return graphemeSegmenter ? [...graphemeSegmenter.segment(text)].map((part) => part.segment) : [...text];
}

/** Display width in em: full-width CJK 1, Latin and digits about 0.6 (capitals 0.7), spaces 0.3. */
export function captionEmWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemes(text)) {
    width += WIDE.test(grapheme) ? 1 : /^\s+$/u.test(grapheme) ? 0.3 : /^[A-Z]/.test(grapheme) ? 0.7 : 0.6;
  }
  return width;
}

function letterCount(text: string): number {
  return graphemes(text).filter((grapheme) => !/^[\s\p{P}\p{S}]+$/u.test(grapheme)).length;
}

function units(line: string, maxEm: number): Unit[] {
  const words = wordSegmenter ? [...wordSegmenter.segment(line)].map((part) => part.segment) : graphemes(line);
  return words.flatMap((word) => {
    const width = captionEmWidth(word);
    // Only a word wider than a whole line may be split, and then only between graphemes.
    const parts = width > maxEm ? graphemes(word) : [word];
    return parts.map((text) => ({ text, width: captionEmWidth(text), letters: letterCount(text) }));
  });
}

function lineOf(parts: readonly Unit[], from: number, to: number) {
  const text = parts.slice(from, to).map((part) => part.text).join("").trim();
  return { text, width: captionEmWidth(text), letters: letterCount(text) };
}

function breakLine(line: string, maxEm: number): string {
  const text = line.trim();
  // Paragraph-length text is not a caption line; leave it to the renderer's own wrapping.
  if (!text || captionEmWidth(text) <= maxEm || text.length > 240) return text;
  const parts = units(text, maxEm);
  const total = captionEmWidth(text);
  for (let count = Math.max(2, Math.ceil(total / maxEm)); count <= Math.max(2, Math.ceil(total / maxEm)) + 3; count += 1) {
    const target = total / count;
    // best[k][j]: cheapest way to lay parts[0..j) as k lines; from[k][j] remembers the previous break.
    const best = Array.from({ length: count + 1 }, () => new Array<number>(parts.length + 1).fill(Number.POSITIVE_INFINITY));
    const from = Array.from({ length: count + 1 }, () => new Array<number>(parts.length + 1).fill(-1));
    best[0][0] = 0;
    for (let k = 1; k <= count; k += 1) {
      for (let j = 1; j <= parts.length; j += 1) {
        for (let i = k - 1; i < j; i += 1) {
          if (!Number.isFinite(best[k - 1][i])) continue;
          const current = lineOf(parts, i, j);
          if (!current.text || current.width > maxEm + 1e-9 || current.letters < 2) continue;
          if (NO_LINE_START.test(current.text) || NO_LINE_END.test(current.text)) continue;
          let cost = (current.width - target) ** 2;
          if (k > 1 && BOUND_PARTICLE.test(current.text)) cost += 6;
          if (j < parts.length) cost += breakCost(parts[j - 1], parts[j]);
          // Equal splits: keep the upper line the wider one, as libass smart wrapping does.
          if (k === 1 && j < parts.length) cost += 1e-3 * Math.max(0, target - current.width);
          if (best[k - 1][i] + cost < best[k][j]) { best[k][j] = best[k - 1][i] + cost; from[k][j] = i; }
        }
      }
    }
    if (!Number.isFinite(best[count][parts.length])) continue;
    const lines: string[] = [];
    for (let k = count, j = parts.length; k > 0; k -= 1) {
      const i = from[k][j];
      lines.unshift(lineOf(parts, i, j).text);
      j = i;
    }
    return lines.join("\n");
  }
  return text; // No layout satisfies every rule (e.g. one enormous word): leave wrapping to the renderer.
}

export function breakCaptionLines(text: string, maxEm: number): string {
  if (!Number.isFinite(maxEm) || maxEm < 2) return text;
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => breakLine(line, maxEm)).join("\n");
}

interface WrapGlyph { text: string; width: number; space: boolean }

/** libass may end a line after glyph i: after a run of spaces, or next to a full-width character, never before
 * closing punctuation or after opening punctuation (the UAX #14 cases captions meet). */
function libassBreakAfter(glyphs: readonly WrapGlyph[], index: number): boolean {
  const glyph = glyphs[index], next = glyphs[index + 1];
  if (!next) return false;
  if (glyph.space) return !next.space;
  if (next.space || NO_LINE_START.test(next.text) || NO_LINE_END.test(glyph.text)) return false;
  return WIDE.test(glyph.text) || WIDE.test(next.text);
}

/** libass skips plain spaces at both ends of every line (trim_whitespace). */
const trimLibassSpaces = (line: string) => line.replace(/^ +| +$/g, "");

function libassWrapLine(line: string, maxEm: number, spacingEm: number): string[] {
  const glyphs: WrapGlyph[] = graphemes(line).map((text) => ({ text, width: captionEmWidth(text) + spacingEm, space: text === " " }));
  const width = (from: number, to: number) => {
    while (from <= to && glyphs[from].space) from += 1;
    while (to >= from && glyphs[to].space) to -= 1;
    let sum = 0;
    for (let index = from; index <= to; index += 1) sum += glyphs[index].width;
    return sum;
  };
  // Greedy pass: once the line reaches the width at a non-space glyph, break at the last opportunity before it.
  const lines: Array<[number, number]> = [];
  let start = 0, lastBreak = -1;
  for (let index = 0; index < glyphs.length; index += 1) {
    if (!glyphs[index].space && lastBreak >= start && width(start, index) >= maxEm) {
      lines.push([start, lastBreak]);
      start = lastBreak + 1;
      lastBreak = -1;
    }
    if (libassBreakAfter(glyphs, index)) lastBreak = index;
  }
  lines.push([start, glyphs.length - 1]);
  // Smart pass (WrapStyle 0), libass's own scan: from the end of an upper line, back over spaces to the last
  // glyph a break may follow; that glyph's word opens the lower line if the move evens the pair. For full-width
  // text libass measures and moves that glyph itself, so it moves one glyph at a time, can open a line with "，"
  // or close one with "「", and leaves the lower line one glyph wider on odd counts (measured on the vendored
  // FFmpeg: 53/54/55 glyphs → 26+27, 27+27, 27+28).
  for (let changed = lines.length > 1; changed;) {
    changed = false;
    for (let pair = 0; pair + 1 < lines.length; pair += 1) {
      const [upperStart, upperEnd] = lines[pair], [lowerStart, lowerEnd] = lines[pair + 1];
      let opener = upperEnd;
      while (opener > upperStart && glyphs[opener].space) opener -= 1;
      while (opener > upperStart && !libassBreakAfter(glyphs, opener)) opener -= 1;
      let upperLast = opener;
      while (upperLast > upperStart && glyphs[upperLast].space) upperLast -= 1;
      if (glyphs[opener].space) opener += 1;
      if (opener <= upperStart) continue;
      const before = Math.abs(width(upperStart, upperEnd) - width(lowerStart, lowerEnd));
      const after = Math.abs(width(upperStart, upperLast) - width(opener, lowerEnd));
      if (after < before) { lines[pair] = [upperStart, opener - 1]; lines[pair + 1] = [opener, lowerEnd]; changed = true; }
    }
  }
  return lines.map(([from, to]) => trimLibassSpaces(glyphs.slice(from, to + 1).map((glyph) => glyph.text).join("")));
}

/**
 * How libass itself wraps a caption line wider than maxEm (WrapStyle 0 with wrap_unicode, as the export runs
 * it), for previews that must break where the export breaks, quirks included: greedy breaks at the last
 * opportunity, then libass's smart pass evens each pair of lines. Explicit newlines stay. Widths are
 * captionEmWidth estimates (plus per-glyph letter spacing in em): exact for CJK, approximate for Latin.
 * Shorts captions never reach this: breakCaptionLines already keeps their lines well inside the frame.
 */
export function libassWrapText(text: string, maxEm: number, spacingEm = 0): string {
  if (!Number.isFinite(maxEm) || maxEm <= 0) return text;
  return text.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => captionEmWidth(line) + spacingEm * graphemes(line).length < maxEm
    ? [trimLibassSpaces(line)] : libassWrapLine(line, maxEm, spacingEm)).join("\n");
}
