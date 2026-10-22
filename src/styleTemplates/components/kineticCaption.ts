import { createSvgDocument, ellipse, fe, fmt, g, path, rect, roundRect, transform, tf, type SvgDocument } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp, sineOut } from "../../motionLibrary/svg/easing";
import { blurFilter, dropShadow, filterRegion, growBox } from "../svgFx";
import { layoutLine, motionFaceMetrics, translatePathD, type GlyphBox, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import type { CaptionEntry, CaptionTreatment } from "../types";

/**
 * C1 kinetic captions (STYLE_TEMPLATE_DESIGN §1 laws 1, 3, 7; brief §2).
 *
 * A phrase is a run of real timed words split into lead (small connector words
 * before the keyword), ONE keyword (3–4× the lead size, with one treatment) and
 * tail words. Every word is built on its own timing with an eased entry; the
 * phrase never appears as a uniform block. Lines stack: lead → KEYWORD → tail.
 *
 * Params are fully resolved by the compiler (placement, sizes, colours,
 * readability), so a frame is a pure function of (params, t). Text is glyph
 * outlines (motion library glyphs), never <text>. Times are seconds relative to
 * the job start.
 */

export const KINETIC_CAPTION_REVISION = 5;

export type CaptionRole = "lead" | "keyword" | "tail";

export interface CaptionWord {
  readonly text: string;
  /** Job-local start / end (s): the recognizer timing of the word. */
  readonly t0: number;
  readonly t1: number;
  readonly role: CaptionRole;
}

export type KeywordFill =
  | { readonly kind: "solid"; readonly color: string }
  | { readonly kind: "gradient"; readonly top: string; readonly bottom: string };

export interface KineticCaptionTypography {
  readonly lead: { readonly font: MotionFontSelector; readonly size: number; readonly tracking: number; readonly color: string; readonly maxWidth: number;
    /** boxAll readability step: every lead/tail line sits on this box (lead em units for padding and radius). */
    readonly box?: { readonly color: string; readonly padding: number; readonly radius: number } };
  readonly keyword: {
    readonly font: MotionFontSelector; readonly size: number; readonly tracking: number; readonly maxWidth: number;
    readonly treatment: CaptionTreatment; readonly fill: KeywordFill;
    /** highlightBox: box colour, padding and radius in keyword em. */
    readonly box?: { readonly color: string; readonly padding: number; readonly radius: number };
    /** glow: halo colour and its hot core. */
    readonly glow?: { readonly color: string; readonly core: string };
    /** script: rotation in degrees. */
    readonly rotation?: number;
  };
  /** Gap between stacked lines, px. */
  readonly lineGap: number;
  readonly align: "start" | "center" | "end";
}

export interface KineticCaptionParams {
  readonly component: "caption";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly words: readonly CaptionWord[];
  readonly typography: KineticCaptionTypography;
  /** Block top-left (frame px) and uniform scale from the placement solver. */
  readonly block: { readonly x: number; readonly y: number; readonly scale: number };
  readonly entry: { readonly lead: CaptionEntry; readonly keyword: CaptionEntry };
  readonly exit: { readonly at: number; readonly duration: number };
  readonly readability: {
    readonly shadow?: { readonly color: string; readonly opacity: number; readonly blur: number };
    readonly plate?: { readonly color: string; readonly opacity: number };
    /** A soft, feathered radial darkening behind the phrase (on footage; never a hard box). Opacity at its core. */
    readonly scrim?: { readonly color: string; readonly opacity: number };
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LaidOutGlyph { readonly char: string; readonly pathD: string; readonly ink: GlyphBox | null }

export interface LaidOutWord {
  readonly index: number;
  readonly role: CaptionRole;
  /** Outline in block coordinates (scale 1). */
  readonly pathD: string;
  readonly glyphs: readonly LaidOutGlyph[];
  readonly ink: GlyphBox;
  readonly line: number;
}

export interface LaidOutLine { readonly role: CaptionRole; readonly words: readonly number[]; readonly top: number; readonly bottom: number; readonly baseline: number; readonly ink: GlyphBox }

export interface KineticCaptionLayout {
  readonly width: number;
  readonly height: number;
  readonly words: readonly LaidOutWord[];
  readonly lines: readonly LaidOutLine[];
  /** Keyword line ink box (block coordinates), when there is a keyword. */
  readonly keywordInk?: GlyphBox;
  /** Keyword size actually used (shrunk to maxWidth when a long keyword needs it). */
  readonly keywordSize: number;
}

const LATIN_EDGE = /[A-Za-z0-9]$/, LATIN_START = /^[A-Za-z0-9]/;
const needsSpace = (left: string, right: string) => LATIN_EDGE.test(left) && LATIN_START.test(right);

interface MeasuredRun { text: string; width: number; ink: GlyphBox | null }

function measure(text: string, font: MotionFontSelector, size: number, tracking: number): MeasuredRun {
  const line = layoutLine(text, { ...font, size, tracking });
  return { text, width: line.width, ink: line.inkBox };
}

/** Body box of a line: a fixed share of the em so lines stack evenly whatever their glyphs (CJK ideographic box). */
function lineBody(font: MotionFontSelector, size: number): { top: number; bottom: number } {
  const metrics = motionFaceMetrics(font, size);
  return { top: metrics.emTop * 0.98, bottom: size * 0.1 };
}

const layoutCache = new Map<string, KineticCaptionLayout>();

export function layoutKineticCaption(words: readonly Pick<CaptionWord, "text" | "role">[], typography: KineticCaptionTypography): KineticCaptionLayout {
  const key = JSON.stringify([words.map(word => [word.text, word.role]), typography]);
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const lead = typography.lead, kw = typography.keyword;
  // Group consecutive words into lines: lead lines (wrapped), one keyword line, tail lines (wrapped).
  type Pending = { role: CaptionRole; words: number[] };
  const pending: Pending[] = [];
  const keywordIndices = words.map((word, index) => (word.role === "keyword" ? index : -1)).filter(index => index >= 0);
  let keywordSize = kw.size;
  if (keywordIndices.length) {
    const text = joinWords(keywordIndices.map(index => words[index].text));
    const run = measure(text, kw.font, kw.size, kw.tracking);
    const inkWidth = run.ink ? run.ink.x1 - run.ink.x0 : run.width;
    if (inkWidth > kw.maxWidth) keywordSize = Number(fmt(kw.size * (kw.maxWidth / inkWidth), 2));
  }
  const wrap = (role: CaptionRole) => {
    const indices = words.map((word, index) => (word.role === role ? index : -1)).filter(index => index >= 0);
    const widthOf = (line: number[]) => measure(joinWords(line.map(i => words[i].text)), lead.font, lead.size, lead.tracking).width;
    const lines: number[][] = [];
    let current: number[] = [];
    for (const index of indices) {
      const candidate = [...current, index];
      if (current.length && widthOf(candidate) > lead.maxWidth) { lines.push(current); current = [index]; }
      else current = candidate;
    }
    if (current.length) lines.push(current);
    // Balance: no orphan last line (a single short word under a long line); move words down while that evens the lines.
    for (let line = lines.length - 1; line > 0; line -= 1) {
      while (lines[line - 1].length > 1) {
        const above = lines[line - 1], below = lines[line];
        const moved = [above[above.length - 1], ...below];
        const before = Math.abs(widthOf(above) - widthOf(below)), after = Math.abs(widthOf(above.slice(0, -1)) - widthOf(moved));
        if (widthOf(moved) > lead.maxWidth || after >= before) break;
        lines[line - 1] = above.slice(0, -1);
        lines[line] = moved;
      }
    }
    for (const line of lines) pending.push({ role, words: line });
  };
  wrap("lead");
  if (keywordIndices.length) pending.push({ role: "keyword", words: keywordIndices });
  wrap("tail");

  // Lay out each line with per-word offsets, measure ink, then stack.
  type Built = { role: CaptionRole; words: number[]; font: MotionFontSelector; size: number; tracking: number;
    parts: Array<{ index: number; dx: number; glyphs: Array<{ char: string; pathD: string; x: number; ink: GlyphBox | null }> }>; ink: GlyphBox; body: { top: number; bottom: number } };
  const built: Built[] = pending.map(line => {
    const isKeyword = line.role === "keyword";
    const font = isKeyword ? kw.font : lead.font, size = isKeyword ? keywordSize : lead.size, tracking = isKeyword ? kw.tracking : lead.tracking;
    const full = layoutLine(joinWords(line.words.map(index => words[index].text)), { ...font, size, tracking });
    // Map glyphs back to words by code-point offsets.
    const parts: Built["parts"] = [];
    let cursor = 0;
    line.words.forEach((index, position) => {
      if (position > 0 && needsSpace(words[line.words[position - 1]].text, words[index].text)) cursor += 1;
      const count = [...words[index].text].length;
      const glyphs = full.glyphs.slice(cursor, cursor + count).map(glyph => ({ char: glyph.char, pathD: glyph.pathD, x: glyph.x,
        ink: glyph.bbox ? { x0: glyph.bbox.x0 + glyph.x, y0: glyph.bbox.y0, x1: glyph.bbox.x1 + glyph.x, y1: glyph.bbox.y1 } : null }));
      parts.push({ index, dx: 0, glyphs });
      cursor += count;
    });
    const ink = full.inkBox ?? { x0: 0, y0: -size * 0.8, x1: full.width, y1: 0 };
    return { role: line.role, words: line.words, font, size, tracking, parts, ink, body: lineBody(font, size) };
  });
  const width = Math.max(1, ...built.map(line => line.ink.x1 - line.ink.x0));
  const laidWords: LaidOutWord[] = new Array(words.length);
  const lines: LaidOutLine[] = [];
  let cursorY = 0, keywordInk: GlyphBox | undefined;
  built.forEach((line, lineIndex) => {
    const inkWidth = line.ink.x1 - line.ink.x0;
    const x = typography.align === "start" ? -line.ink.x0 : typography.align === "end" ? width - line.ink.x1 : (width - inkWidth) / 2 - line.ink.x0;
    if (lineIndex > 0) cursorY += typography.lineGap * (line.role === "keyword" || built[lineIndex - 1].role === "keyword" ? 0.75 : 1);
    const top = cursorY, baseline = top - line.body.top, bottom = baseline + line.body.bottom;
    for (const part of line.parts) {
      const glyphs = part.glyphs.map(glyph => ({ char: glyph.char, pathD: glyph.pathD ? translatePathD(glyph.pathD, x + glyph.x, baseline) : "",
        ink: glyph.ink ? { x0: glyph.ink.x0 + x, y0: glyph.ink.y0 + baseline, x1: glyph.ink.x1 + x, y1: glyph.ink.y1 + baseline } : null }));
      const inks = glyphs.map(glyph => glyph.ink).filter((box): box is GlyphBox => Boolean(box));
      const ink = inks.length ? inks.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }))
        : { x0: x, y0: top, x1: x + 1, y1: bottom };
      laidWords[part.index] = Object.freeze({ index: part.index, role: line.role, pathD: glyphs.map(glyph => glyph.pathD).join(""), glyphs: Object.freeze(glyphs), ink, line: lineIndex });
    }
    const lineInk = { x0: line.ink.x0 + x, y0: line.ink.y0 + baseline, x1: line.ink.x1 + x, y1: line.ink.y1 + baseline };
    if (line.role === "keyword") keywordInk = lineInk;
    lines.push(Object.freeze({ role: line.role, words: Object.freeze([...line.words]), top, bottom, baseline, ink: lineInk }));
    cursorY = bottom;
  });
  const layout: KineticCaptionLayout = Object.freeze({ width, height: Math.max(1, cursorY), words: Object.freeze(laidWords), lines: Object.freeze(lines), keywordInk, keywordSize });
  layoutCache.set(key, layout);
  if (layoutCache.size > 256) layoutCache.delete(layoutCache.keys().next().value!);
  return layout;
}

function joinWords(texts: readonly string[]): string {
  let out = "";
  texts.forEach((text, index) => { out += (index > 0 && needsSpace(texts[index - 1], text) ? " " : "") + text; });
  return out;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** Entry lengths (s) at standard energy (Motion Language v1: fast attack, character from easing). */
export const CAPTION_ENTRY_SECONDS: Readonly<Record<CaptionEntry, number>> = Object.freeze({ blurIn: 0.38, pop: 0.5, slide: 0.36, typeOn: 0.06 });
/** Blur-in never exceeds this many frame px, and is only present during the entry. */
export const CAPTION_MAX_BLUR_PX = 8;

export interface WordPose {
  readonly visible: boolean;
  readonly opacity: number;
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
  readonly rotation: number;
  /** Gaussian blur in frame px (0 = no filter). */
  readonly blur: number;
  /** typeOn: characters shown (fractional = the last one fading in). */
  readonly reveal?: number;
}

const HIDDEN: WordPose = Object.freeze({ visible: false, opacity: 0, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0 });

/** Pose of a word at job-local time t (no exit applied). em is the word's own glyph size. */
export function wordEntryPose(entry: CaptionEntry, word: Pick<CaptionWord, "t0" | "t1" | "text">, t: number, em: number, direction: -1 | 0 | 1): WordPose {
  if (t < word.t0) return HIDDEN;
  const local = t - word.t0;
  switch (entry) {
    case "blurIn": {
      const p = clamp01(local / CAPTION_ENTRY_SECONDS.blurIn), e = curve("quintOut", p);
      return { visible: true, opacity: Math.min(1, 0.12 + curve("expoOut", p) * 1.1), dx: 0, dy: em * 0.22 * (1 - e), scale: 1 + 0.08 * (1 - e), rotation: 0,
        blur: CAPTION_MAX_BLUR_PX * (1 - e) };
    }
    case "pop": {
      const p = clamp01(local / CAPTION_ENTRY_SECONDS.pop);
      return { visible: true, opacity: Math.min(1, 0.15 + local / 0.07), dx: 0, dy: 0, scale: lerp(0.3, 1, curve("springSnappy", p)),
        rotation: -7 * (1 - curve("backOutSoft", p)), blur: 0 };
    }
    case "slide": {
      const p = clamp01(local / CAPTION_ENTRY_SECONDS.slide), e = curve("expoOut", p);
      const travel = em * 0.55;
      return { visible: true, opacity: Math.min(1, 0.1 + curve("expoOut", p) * 1.15), dx: direction === 0 ? 0 : -direction * travel * (1 - e),
        dy: direction === 0 ? em * 0.3 * (1 - e) : 0, scale: 1, rotation: 0, blur: 3 * (1 - e) };
    }
    case "typeOn": {
      const count = Math.max(1, [...word.text].length);
      const step = Math.min(0.07, Math.max(1 / 60, (word.t1 - word.t0) / count));
      // First character at t0 exactly; each character fades in over two 30 fps frames.
      const reveal = Math.min(count, local / step + 1);
      return { visible: true, opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0, reveal };
    }
  }
}

/** Phrase exit: fast, accelerating away (snapIn), slightly up and soft. Returns opacity multiplier and offsets. */
export function exitPose(params: Pick<KineticCaptionParams, "exit">, t: number, em: number): { opacity: number; dy: number; blur: number; scale: number } {
  if (t <= params.exit.at) return { opacity: 1, dy: 0, blur: 0, scale: 1 };
  const p = clamp01((t - params.exit.at) / params.exit.duration), e = curve("snapIn", p);
  return { opacity: 1 - e, dy: -em * 0.35 * e, blur: 4 * e, scale: 1 - 0.03 * e };
}

/** Visible words at t (opacity > 0): what the sync test and the frame generator share. */
export function captionWordStates(params: KineticCaptionParams, t: number): Array<{ index: number; opacity: number }> {
  const exit = exitPose(params, t, params.typography.lead.size);
  return params.words.map((word, index) => {
    const entry = word.role === "keyword" ? params.entry.keyword : params.entry.lead;
    const pose = wordEntryPose(entry, word, t, word.role === "keyword" ? params.typography.keyword.size : params.typography.lead.size, 0);
    return { index, opacity: pose.visible ? pose.opacity * exit.opacity : 0 };
  });
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

const unionBox = (a: GlyphBox, b: GlyphBox): GlyphBox => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const grow = growBox;
const region = filterRegion;

function shadowFilter(doc: SvgDocument, shadow: NonNullable<KineticCaptionParams["readability"]["shadow"]>, box: GlyphBox, sigma: number, dy: number): string {
  return dropShadow(doc, { box, sigma, dy, color: shadow.color, opacity: shadow.opacity });
}

export function kineticCaptionFrame(params: KineticCaptionParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "kc" });
  const typo = params.typography;
  const layout = layoutKineticCaption(params.words, typo);
  const scale = params.block.scale;
  const leadEm = typo.lead.size;
  const exit = exitPose(params, t, leadEm);
  const direction: -1 | 0 | 1 = typo.align === "start" ? 1 : typo.align === "end" ? -1 : 0;
  const parts: string[] = [], underlay: string[] = [];
  let visibleInk: GlyphBox | undefined;

  // Plate (very low contrast fallback): appears with the first word, leaves with the phrase.
  if (params.readability.plate && t >= params.words[0].t0) {
    const fade = clamp01((t - params.words[0].t0) / 0.15) * exit.opacity;
    const pad = leadEm * 0.45;
    parts.push(roundRect(-pad, -pad * 0.8, layout.width + pad * 2, layout.height + pad * 1.6, leadEm * 0.35,
      { fill: params.readability.plate.color, opacity: Number(fmt(params.readability.plate.opacity * fade, 3)) }));
  }

  // Scrim: a radial gradient whose full-opacity core (to 62% of the radius) holds the block, feathering to 0 well outside it.
  if (params.readability.scrim && t >= params.words[0].t0) {
    const fade = clamp01((t - params.words[0].t0) / 0.2) * exit.opacity;
    const cx = layout.width / 2, cy = layout.height / 2, rx = layout.width / 2 * 1.9 + leadEm, ry = layout.height / 2 * 1.9 + leadEm;
    const fill = doc.radialGradient({ cx: 0.5, cy: 0.5, r: 0.5, units: "objectBoundingBox", stops: [
      { offset: 0, color: params.readability.scrim.color, opacity: params.readability.scrim.opacity },
      { offset: 0.62, color: params.readability.scrim.color, opacity: params.readability.scrim.opacity },
      { offset: 1, color: params.readability.scrim.color, opacity: 0 }] });
    // Outside the shadow filter (whose region would clip it into a hard box).
    underlay.push(g({ opacity: fade < 0.999 ? Number(fmt(fade, 3)) : undefined }, ellipse(cx, cy, rx, ry, { fill })));
  }

  // boxAll: each lead/tail line on its own box, sweeping in with the line's first word.
  if (typo.lead.box) {
    const box = typo.lead.box, pad = leadEm * box.padding;
    for (const line of layout.lines) {
      if (line.role === "keyword") continue;
      const first = params.words[line.words[0]];
      if (t < first.t0) continue;
      const sweep = curve("expoOut", clamp01((t - first.t0) / 0.22));
      const x0 = line.ink.x0 - pad * 1.4, width = (line.ink.x1 - line.ink.x0 + pad * 2.8) * sweep;
      parts.push(g({ opacity: exit.opacity < 0.999 ? Number(fmt(exit.opacity, 3)) : undefined },
        roundRect(x0, line.ink.y0 - pad, width, line.ink.y1 - line.ink.y0 + pad * 2, leadEm * box.radius, { fill: box.color })));
    }
  }

  // Highlight box: drawn once behind the keyword, sweeping in left → right from the keyword's first frame.
  const firstKeyword = params.words.find(word => word.role === "keyword");
  if (typo.keyword.treatment === "highlightBox" && typo.keyword.box && layout.keywordInk && firstKeyword && t >= firstKeyword.t0) {
    const box = typo.keyword.box, ink = layout.keywordInk, pad = layout.keywordSize * box.padding;
    // The box grows word by word: its right edge sweeps to each keyword word as that word is spoken.
    const keywordWords = layout.words.filter(word => params.words[word.index].role === "keyword");
    const left = ink.x0 - pad * 1.25;
    let right = left;
    for (const word of keywordWords) {
      const t0 = params.words[word.index].t0;
      if (t < t0) break;
      const target = word.ink.x1 + pad * 1.25;
      right = right + (target - right) * curve("expoOut", clamp01((t - t0) / 0.24));
    }
    parts.push(g({ opacity: exit.opacity < 0.999 ? Number(fmt(exit.opacity, 3)) : undefined },
      roundRect(left, ink.y0 - pad, Math.max(0, right - left), ink.y1 - ink.y0 + pad * 2, layout.keywordSize * box.radius, { fill: box.color })));
  }

  for (const word of layout.words) {
    const source = params.words[word.index];
    const isKeyword = source.role === "keyword";
    const entry = isKeyword ? params.entry.keyword : params.entry.lead;
    const em = isKeyword ? layout.keywordSize : leadEm;
    const pose = wordEntryPose(entry, source, t, em, direction);
    if (!pose.visible) continue;
    const opacity = pose.opacity * exit.opacity;
    if (opacity <= 0.001) continue;
    const cx = (word.ink.x0 + word.ink.x1) / 2, cy = (word.ink.y0 + word.ink.y1) / 2;
    const blurPx = Math.min(CAPTION_MAX_BLUR_PX, pose.blur + exit.blur);
    const sigma = blurPx / Math.max(0.05, scale);
    const glyphPath = pose.reveal === undefined ? word.pathD
      : word.glyphs.slice(0, Math.ceil(pose.reveal)).map(glyph => glyph.pathD).join("");
    // typeOn: the newest character fades in over its step.
    const lastOpacity = pose.reveal === undefined ? 1 : pose.reveal - Math.floor(pose.reveal) || 1;
    const content: string[] = [];
    const fill = isKeyword ? keywordFill(doc, typo.keyword, layout.keywordInk ?? word.ink) : typo.lead.color;
    if (isKeyword && typo.keyword.treatment === "glow" && typo.keyword.glow) {
      const flash = 1 + 0.6 * (1 - sineOut(clamp01((t - source.t0) / 0.6)));
      const halo = doc.filter([fe.blur({ in: "SourceGraphic", stdDeviation: Number(fmt(layout.keywordSize * 0.06, 2)) })], region(grow(word.ink, layout.keywordSize * 0.3)));
      const wide = doc.filter([fe.blur({ in: "SourceGraphic", stdDeviation: Number(fmt(layout.keywordSize * 0.2, 2)) })], region(grow(word.ink, layout.keywordSize * 0.75)));
      content.push(path(glyphPath, { fill: typo.keyword.glow.color, opacity: Number(fmt(Math.min(1, 0.75 * flash), 3)), filter: wide }));
      content.push(path(glyphPath, { fill: typo.keyword.glow.core, opacity: Number(fmt(Math.min(1, 0.9 * flash), 3)), filter: halo }));
    }
    // Script words (a single-weight hand face) get a same-colour stroke so they hold up next to the heavy sans.
    const ink = isKeyword && typo.keyword.treatment === "script"
      ? { fill, stroke: fill, "stroke-width": Number(fmt(layout.keywordSize * 0.03, 2)), "stroke-linejoin": "round" } : { fill };
    if (pose.reveal !== undefined && word.glyphs.length > 1 && lastOpacity < 1) {
      const shown = Math.floor(pose.reveal);
      content.push(path(word.glyphs.slice(0, shown).map(glyph => glyph.pathD).join(""), ink));
      content.push(path(word.glyphs[shown]?.pathD ?? "", { ...ink, opacity: Number(fmt(lastOpacity, 3)) }));
    } else content.push(path(glyphPath, ink));
    let inner = g({}, content);
    if (isKeyword && typo.keyword.treatment === "script") {
      // Write-on: a clip that wipes left → right over the word (handwriting feel).
      const wipe = curve("quintOut", clamp01((t - source.t0) / Math.max(0.25, Math.min(0.6, source.t1 - source.t0))));
      const ink = grow(word.ink, layout.keywordSize * 0.1);
      const clip = doc.clipPath(rect(ink.x0, ink.y0, Math.max(0.5, (ink.x1 - ink.x0) * wipe), ink.y1 - ink.y0));
      inner = g({ "clip-path": clip }, content);
    }
    const blurred = sigma >= 0.05 ? g({ filter: blurFilter(doc, sigma, grow(word.ink, layout.keywordSize * 0.3)) }, inner) : inner;
    const rotation = (isKeyword ? typo.keyword.rotation ?? 0 : 0) + pose.rotation;
    const tr = transform(
      tf.translate(cx + pose.dx, cy + pose.dy),
      rotation ? tf.rotate(rotation) : false,
      pose.scale !== 1 ? tf.scale(pose.scale) : false,
      tf.translate(-cx, -cy),
    );
    parts.push(g({ transform: tr, opacity: opacity < 0.999 ? Number(fmt(opacity, 3)) : undefined, "data-w": String(word.index) }, blurred));
    visibleInk = visibleInk ? unionBox(visibleInk, word.ink) : word.ink;
  }
  if (!visibleInk) return doc.render();
  let body = g({}, parts);
  if (params.readability.shadow) {
    const shadow = params.readability.shadow;
    const box = grow({ x0: Math.min(visibleInk.x0, 0), y0: Math.min(visibleInk.y0, 0), x1: Math.max(visibleInk.x1, layout.width), y1: Math.max(visibleInk.y1, layout.height) },
      layout.keywordSize * 0.35);
    body = g({ filter: shadowFilter(doc, shadow, box, shadow.blur / Math.max(0.05, scale), leadEm * 0.04) }, body);
  }
  // Scale about the block centre so the exit shrink stays in place.
  const halfW = layout.width / 2, halfH = layout.height / 2;
  const blockTransform = transform(tf.translate(params.block.x + halfW * scale, params.block.y + halfH * scale + exit.dy * scale),
    tf.scale(scale * exit.scale), tf.translate(-halfW, -halfH));
  return doc.render(g({ transform: blockTransform }, underlay, body));
}

function keywordFill(doc: SvgDocument, keyword: KineticCaptionTypography["keyword"], ink: GlyphBox): string {
  if (keyword.fill.kind === "solid") return keyword.fill.color;
  return doc.linearGradient({ x1: 0, y1: ink.y0, x2: 0, y2: ink.y1, units: "userSpaceOnUse",
    stops: [{ offset: 0, color: keyword.fill.top }, { offset: 0.45, color: keyword.fill.top }, { offset: 1, color: keyword.fill.bottom }] });
}
