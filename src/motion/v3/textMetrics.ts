import advanceIndex from "../../generated/fontAdvanceMetrics.json";
import { bundledFontAssMetrics, bundledFontCssBaseline } from "../../typography/fontEmMetrics";
import { resolveBundledFontFace } from "../../typography/fontFaces";

/** `cjk` is null for faces without ideographs; `ascii` holds 0 for a missing glyph. */
interface FaceAdvances { id: string; unitsPerEm: number; cjk: number | null; ascii: number[]; extra: Record<string, number> }

export interface V3Font {
  family: string;
  weight: number;
  size: number;
  letterSpacing: number;
  lineHeight: number;
}

const faces = new Map((advanceIndex.faces as FaceAdvances[]).map(face => [face.id, face]));
const OPENING = new Set([..."（「『《〈【〔“‘([{"]);
const CLOSING = new Set([..."，。、；：！？）」』》〉】〕…”’%‰,.;:!?)]}·"]);

function faceAdvances(family: string, weight: number): FaceAdvances {
  const face = resolveBundledFontFace(family, weight);
  const data = face && faces.get(face.faceId);
  if (!data) throw new Error(`v3 版型只支援已量測的內建字型：${family} ${weight}`);
  return data;
}

/** Full-width scripts and symbols that every bundled CJK face sets on one em. */
export function isWideCodePoint(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300;
}

export function glyphAdvanceEm(family: string, weight: number, char: string): number {
  const data = faceAdvances(family, weight);
  const code = char.codePointAt(0) ?? 0x20;
  if (code >= 0x20 && code < 0x7f) return data.ascii[code - 0x20] / data.unitsPerEm;
  const extra = data.extra[char];
  if (extra !== undefined) return extra / data.unitsPerEm;
  return isWideCodePoint(code) ? (data.cjk ?? data.unitsPerEm) / data.unitsPerEm : 0.6;
}

/** Whether the measured table shows this face drawing `char`; unmeasured symbols count as missing. */
export function faceHasGlyph(family: string, weight: number, char: string): boolean {
  const data = faceAdvances(family, weight);
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x20 && code < 0x7f) return data.ascii[code - 0x20] > 0;
  if (data.extra[char] !== undefined) return true;
  return isWideCodePoint(code) && data.cjk !== null;
}

/** Ink advance of one line; tracking sits between glyphs, not after the last one. */
export function measureText(text: string, font: Pick<V3Font, "family" | "weight" | "size" | "letterSpacing">): number {
  const chars = [...text];
  if (!chars.length) return 0;
  return chars.reduce((sum, char) => sum + glyphAdvanceEm(font.family, font.weight, char) * font.size, 0)
    + font.letterSpacing * (chars.length - 1);
}

/** Break units: a Latin word or number never splits; closing marks stay with the
 * previous unit and opening marks with the next (kinsoku). */
function breakUnits(text: string): string[] {
  const units: string[] = [];
  let pendingOpen = "";
  for (const token of text.match(/[A-Za-z0-9][A-Za-z0-9.,'’%$#&+\-/:]*|\s+|./gu) ?? []) {
    if (/^\s+$/u.test(token)) {
      if (units.length) units[units.length - 1] += " ";
      continue;
    }
    if (OPENING.has(token)) { pendingOpen += token; continue; }
    if (CLOSING.has(token) && units.length && !pendingOpen) { units[units.length - 1] += token; continue; }
    units.push(pendingOpen + token);
    pendingOpen = "";
  }
  if (pendingOpen) units.push(pendingOpen);
  return units;
}

function greedyWrap(units: string[], font: V3Font, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current + unit;
    if (current && measureText(candidate.trimEnd(), font) > maxWidth) {
      lines.push(current.trimEnd());
      current = unit.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines;
}

const PHRASE_END = /[，。、；：！？,.;:!?…）」』》〉】〕”’\s]$/u;

/** Units merged into phrases that end at punctuation or a space. */
function phraseUnits(units: string[]): string[] {
  const phrases: string[] = [];
  let current = "";
  for (const unit of units) {
    current += unit;
    if (PHRASE_END.test(unit)) { phrases.push(current); current = ""; }
  }
  if (current) phrases.push(current);
  return phrases;
}

function balance(units: string[], font: V3Font, maxWidth: number, lineCount: number): string[] {
  let low = maxWidth * .45, high = maxWidth, best = greedyWrap(units, font, maxWidth);
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    const trial = greedyWrap(units, font, middle);
    if (trial.length === lineCount) { best = trial; high = middle; } else { low = middle; }
  }
  return best;
}

/** Balanced wrap (like CSS text-wrap: balance): the fewest lines that fit, then the
 * narrowest width that keeps that line count. Lines break between phrases when the
 * phrases alone reach the same line count, so a clause is not split mid-word. */
export function wrapText(text: string, font: V3Font, maxWidth: number, maxLines: number): string[] {
  const units = breakUnits(text.trim());
  if (!units.length) return [];
  const target = greedyWrap(units, font, maxWidth);
  if (target.length > maxLines) throw new Error(`文字超出版型 ${maxLines} 行：${text}`);
  if (target.length === 1) return target;
  const phrases = phraseUnits(units);
  const phrasesFit = phrases.length > 1 && phrases.every(phrase => measureText(phrase.trim(), font) <= maxWidth)
    && greedyWrap(phrases, font, maxWidth).length === target.length;
  return balance(phrasesFit ? phrases : units, font, maxWidth, target.length);
}

/** libass sizes fonts by Windows ascent+descent, CSS by em; align their baselines. */
export function assTextMetrics(font: Pick<V3Font, "family" | "weight" | "size" | "lineHeight">) {
  return bundledFontAssMetrics(font.family, font.weight, font.size, font.lineHeight);
}

/** Top of the line box to the baseline; runs in different faces share a baseline through it. */
export function baselineOffset(font: Pick<V3Font, "family" | "weight" | "size" | "lineHeight">): number {
  return bundledFontCssBaseline(font.family, font.weight, font.size, font.lineHeight);
}

/** Split copy into runs: characters the primary face draws, and runs set in the fallback face. */
export function splitFaceRuns(text: string, primary: Pick<V3Font, "family" | "weight">): Array<{ primary: boolean; text: string }> {
  const runs: Array<{ primary: boolean; text: string }> = [];
  for (const char of text) {
    const own = char === " " || faceHasGlyph(primary.family, primary.weight, char);
    const last = runs.at(-1);
    if (last && last.primary === own) last.text += char; else runs.push({ primary: own, text: char });
  }
  return runs;
}
