import { assertPreparedGlyphRun, type PreparedGlyphRun } from "./preparedGlyphRun";

/** Opt-in authoring version. Certified compilers continue to use their original layout. */
export const MEASURED_TEXT_LAYOUT_VERSION = "editkin.measured-text-layout/v2" as const;
export const PROTECTED_CJK_WORDS = ["元件", "手遊", "天然", "社群", "Editkin", "CodeX", "Unreal", "Blender"] as const;
const closePunctuation = /^[，。、；：！？）」』】〕〉》,.;:!?)\]}%]/u;
const openPunctuation = /[（「『【〔〈《([{]$/u;
const clauseEnd = /[，。、；：！？,.;:!?…]$/u;
const lexical = /[\p{L}\p{N}]/u;

export class MeasuredTextLayoutError extends Error {
  constructor(message: string) { super(message); this.name = "MeasuredTextLayoutError"; }
}
export interface MeasuredTextLayoutOptions {
  slotWidth: number;
  fontSize: number;
  minFontSize: number;
  maxLines: number;
  letterSpacing?: number;
  locale?: string;
  neverSplit?: readonly string[];
  /** Matches the physical layout's actual padding; never guesses glyph width. */
  padding?: (fontSize: number) => number;
  maxHeight?: number;
  lineGap?: number;
  signal?: AbortSignal;
}
export interface MeasuredTextLayoutResult {
  schema: typeof MEASURED_TEXT_LAYOUT_VERSION;
  text: string;
  fontSize: number;
  lines: Array<{ text: string; width: number; start: number; end: number }>;
  shrunkBeforeWrapping: boolean;
  fontSha256: string;
}
interface Row { text: string; width: number; start: number; end: number; letters: number }

/** ICU word boundaries, with explicit caller phrases removed from the set of legal break positions. */
function boundaries(text: string, locale: string, phrases: readonly string[]): number[] {
  if (typeof Intl.Segmenter !== "function") throw new MeasuredTextLayoutError("目前的執行環境缺少斷詞功能，請更新 Editkin。");
  const values = new Set([0, text.length]);
  for (const part of new Intl.Segmenter(locale, { granularity: "word" }).segment(text)) values.add(part.index);
  for (const phrase of phrases) {
    if (!phrase || phrase.includes("\n") || [...phrase].length > 64) throw new MeasuredTextLayoutError("不可拆開的詞語不合法。");
    for (let from = 0; from < text.length;) {
      const at = text.indexOf(phrase, from);
      if (at < 0) break;
      for (const position of values) if (position > at && position < at + phrase.length) values.delete(position);
      from = at + phrase.length;
    }
  }
  return [...values].sort((a, b) => a - b);
}

/** Same physical advances, ink bounds, pair kerning and tracking as compositionV2's existing renderer. */
export function measureGlyphRange(run: PreparedGlyphRun, start: number, end: number, size: number, tracking = 0): number {
  assertPreparedGlyphRun(run);
  if (![start, end].every(Number.isInteger) || start < 0 || end > run.text.length || end < start
    || !Number.isFinite(size) || size <= 0 || !Number.isFinite(tracking)) throw new MeasuredTextLayoutError("文字量測範圍不合法。");
  const glyphs = run.glyphs.filter(glyph => glyph.sourceUtf16Offset >= start
    && glyph.sourceUtf16Offset + glyph.sourceUtf16Length <= end && glyph.kind !== "newline");
  let cursor = 0, minimum = 0, maximum = 0;
  glyphs.forEach((glyph, index) => {
    if (glyph.inkEm) {
      minimum = Math.min(minimum, cursor + glyph.inkEm.xMin * size);
      maximum = Math.max(maximum, cursor + glyph.inkEm.xMax * size);
    }
    cursor += glyph.advanceEm * size;
    maximum = Math.max(maximum, cursor);
    if (index + 1 < glyphs.length) cursor += glyph.kerningAfterEm * size + tracking;
  });
  return Math.max(maximum, cursor) - minimum;
}

export function layoutMeasuredTextV2(run: PreparedGlyphRun, options: MeasuredTextLayoutOptions): MeasuredTextLayoutResult {
  assertPreparedGlyphRun(run);
  const { slotWidth, maxLines, signal } = options;
  const first = Math.floor(options.fontSize), floor = Math.ceil(options.minFontSize);
  const spacing = options.letterSpacing ?? 0, gap = options.lineGap ?? 0;
  if (![slotWidth, options.fontSize, options.minFontSize, spacing, gap].every(Number.isFinite)
    || slotWidth < 16 || floor < 8 || first > 384 || floor > first || gap < 0
    || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 4
    || (options.maxHeight !== undefined && (!Number.isFinite(options.maxHeight) || options.maxHeight <= 0))) {
    throw new MeasuredTextLayoutError("文字欄寬、字級下限或行數不合法。");
  }
  const check = () => { if (signal?.aborted) throw new MeasuredTextLayoutError("文字排版已取消，專案未修改。"); };
  const padding = options.padding ?? (size => Math.max(6, Math.ceil(size * .28)));
  const width = (size: number) => {
    const pad = padding(size);
    if (!Number.isFinite(pad) || pad < 0) throw new MeasuredTextLayoutError("文字留白不合法。");
    return slotWidth - pad * 2;
  };
  const text = run.text;
  if (!text.trim()) throw new MeasuredTextLayoutError("請先填入要顯示的文字。");
  const paragraphs: Array<[number, number]> = [];
  let position = 0;
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) throw new MeasuredTextLayoutError("文字中有空白行，請先移除。");
    paragraphs.push([position, position + paragraph.length]); position += paragraph.length + 1;
  }
  if (paragraphs.length > maxLines) throw new MeasuredTextLayoutError(`文字超過 ${maxLines} 行，請縮短文字。`);
  const row = (start: number, end: number, size: number): Row => {
    const raw = text.slice(start, end), leading = raw.length - raw.trimStart().length, trailing = raw.length - raw.trimEnd().length;
    const from = start + leading, to = end - trailing, trimmed = text.slice(from, to);
    return { text: trimmed, start: from, end: to, width: measureGlyphRange(run, from, to, size, spacing),
      letters: [...trimmed].filter(character => lexical.test(character)).length };
  };
  const top = Math.min(-run.ascender / run.unitsPerEm, ...run.glyphs.flatMap(glyph => glyph.inkEm ? [glyph.inkEm.yMin] : []));
  const bottom = Math.max(-run.descender / run.unitsPerEm, ...run.glyphs.flatMap(glyph => glyph.inkEm ? [glyph.inkEm.yMax] : []));
  const fitsHeight = (count: number, size: number) => options.maxHeight === undefined
    || count * (bottom - top) * size + Math.max(0, count - 1) * gap + padding(size) * 2 <= options.maxHeight;
  const result = (lines: Row[], size: number, wrapped: boolean): MeasuredTextLayoutResult => ({
    schema: MEASURED_TEXT_LAYOUT_VERSION, text: lines.map(line => line.text).join("\n"), fontSize: size,
    lines: lines.map(({ letters: _letters, ...line }) => line), shrunkBeforeWrapping: wrapped, fontSha256: run.fontSha256,
  });
  // Exhaust the size range before introducing any additional line. Existing explicit newlines are preserved.
  for (let size = first; size >= floor; size--) {
    check();
    const lines = paragraphs.map(([start, end]) => row(start, end, size));
    if (lines.every(line => line.width <= width(size) + 1e-7) && fitsHeight(lines.length, size)) return result(lines, size, false);
  }
  const legal = boundaries(text, options.locale ?? "zh-Hant", [...PROTECTED_CJK_WORDS, ...(options.neverSplit ?? [])]);
  const maximum = width(floor), wrapped: Row[] = [];
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    check();
    const [start, end] = paragraphs[paragraphIndex], points = legal.filter(at => at >= start && at <= end);
    const remainingParagraphs = paragraphs.length - paragraphIndex - 1;
    const allowed = maxLines - wrapped.length - remainingParagraphs;
    const cache = new Map<string, Row>();
    const candidate = (i: number, j: number) => {
      const key = `${i}:${j}`, existing = cache.get(key);
      if (existing) return existing;
      const measured = row(points[i], points[j], floor); cache.set(key, measured); return measured;
    };
    let chosen: Row[] | undefined;
    for (let count = 1; count <= allowed && !chosen; count++) {
      const costs = Array.from({ length: count + 1 }, () => new Array<number>(points.length).fill(Infinity));
      const previous = Array.from({ length: count + 1 }, () => new Array<number>(points.length).fill(-1));
      costs[0][0] = 0;
      for (let line = 1; line <= count; line++) for (let j = 1; j < points.length; j++) {
        check();
        for (let i = line - 1; i < j; i++) {
          if (!Number.isFinite(costs[line - 1][i])) continue;
          const value = candidate(i, j);
          if (!value.text || value.width > maximum + 1e-7 || closePunctuation.test(value.text) || openPunctuation.test(value.text)) continue;
          // A naturally short label may stay short; a new wrapped line may never become a 1-2 character orphan.
          if (count > 1 && value.letters < 3) continue;
          const target = measureGlyphRange(run, start, end, floor, spacing) / count;
          const raggedness = ((value.width - target) / Math.max(1, maximum)) ** 2;
          const boundaryCost = j === points.length - 1 || clauseEnd.test(value.text) ? 0 : 2;
          const score = costs[line - 1][i] + raggedness + boundaryCost;
          if (score < costs[line][j]) { costs[line][j] = score; previous[line][j] = i; }
        }
      }
      if (!Number.isFinite(costs[count][points.length - 1])) continue;
      chosen = [];
      for (let line = count, j = points.length - 1; line > 0; line--) {
        const i = previous[line][j]; chosen.unshift(candidate(i, j)); j = i;
      }
    }
    if (!chosen) throw new MeasuredTextLayoutError("文字在最小字級仍放不下；請縮短文字或加寬文字區，詞語會保持完整。");
    wrapped.push(...chosen);
  }
  if (!fitsHeight(wrapped.length, floor)) throw new MeasuredTextLayoutError("文字超出安全區高度，請縮短文字。");
  return result(wrapped, floor, true);
}
