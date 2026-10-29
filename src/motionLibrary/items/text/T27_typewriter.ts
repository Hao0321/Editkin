import { g, path, rect, transform, tf } from "../../svg/document";
import { clamp01, cubicOut } from "../../svg/easing";
import { layoutLine, layoutVertical, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T27 Typewriter (タイプライター), SWITCH: Mincho (Noto Serif TC 900 by default)
 * typed one character every 0.07 s behind a caret, line by line. Each new character
 * strikes in at 1.16× and settles within its character slot; a line break pauses
 * 0.22 s. Line 1 types in the text role, line 2 in the accent (ART_DIRECTION §0:
 * paper and accent on a dark card; ink and accent2 on cream), alternating for more
 * lines. The caret is a slim accent bar: solid while typing or deleting, blinking
 * once per second while idle (≤ 1 flash per second). After the hold the text deletes
 * backwards, faster than it was typed (0.045 s a character), line by line; the caret
 * blinks on the empty line and the clip ends blank.
 *
 * Layout: horizontal lines, left-aligned like real typing, the block centred on its
 * longest line and sized with heroTextBox. In a portrait frame, mostly-CJK text is
 * typeset vertically instead (tategaki: columns right to left, typed top to bottom,
 * the caret a horizontal bar under the last character) whenever that sets it at least
 * 1.25× larger, so a short line does not float small in a tall frame. Times are
 * standard-energy seconds, scaled by energy and squeezed into short clips; the hold
 * takes any spare time.
 */

const ID = "T27";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const LEAD = 0.18, CHAR = 0.07, NEWLINE = 0.22, MIN_HOLD = 0.9, DELETE = 0.045, CARET_TAIL = 0.32, TAIL = 0.08;
/** Idle caret blink: period and the visible share of it. */
const BLINK = 1, BLINK_ON = 0.5;
/** Strike-in: a new character starts at 1 + STRIKE × and settles within one character slot. */
const STRIKE = 0.16;
/** Line (column) spacing in em; caret thickness, gap to the text and length (em). */
const LINE_HEIGHT = 1.22, COLUMN_SPACING = 1.24, CARET_WIDTH = 0.07, CARET_GAP = 0.07, CARET_TOP = 0.9, CARET_BOTTOM = 0.14, CARET_ACROSS = 0.86;
/** Vertical setting needs this share of CJK characters and this size gain over horizontal. */
const CJK_SHARE = 0.6, VERTICAL_GAIN = 1.25;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface TypedGlyph {
  readonly pathD: string;
  /** Translate that places the outline (frame px). */
  readonly x: number;
  readonly y: number;
  /** Strike anchor: the glyph's ink centre (frame px). */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Caret top-left once this glyph is the last one typed (frame px). */
  readonly caretX: number;
  readonly caretY: number;
  /** Clip seconds: typed (appears) and deleted (gone). */
  readonly typedAt: number;
  readonly deletedAt: number;
}

export interface TypedLine {
  readonly color: string;
  /** Caret top-left on the empty line (frame px). */
  readonly caretX: number;
  readonly caretY: number;
  readonly glyphs: readonly TypedGlyph[];
  /** Clip seconds: the caret arrives on this line. */
  readonly caretIn: number;
}

export interface TypewriterLayout {
  readonly vertical: boolean;
  readonly fontSize: number;
  readonly timeScale: number;
  readonly lines: readonly TypedLine[];
  /** Caret rectangle size (px). */
  readonly caretWidth: number;
  readonly caretHeight: number;
  /** Ink box of the fully typed block (frame px). */
  readonly box: GlyphBox;
  /** Clip seconds: everything typed, deletion starts, deletion done, caret gone. */
  readonly typedEnd: number;
  readonly deleteStart: number;
  readonly deleteEnd: number;
  readonly caretGone: number;
}

/** Whether `lines` are mostly CJK (vertical typesetting reads naturally). */
function mostlyCjk(lines: readonly string[]): boolean {
  const visible = lines.flatMap(line => [...line].filter(character => character.trim() !== ""));
  return visible.length > 0 && visible.filter(character => CJK.test(character)).length >= CJK_SHARE * visible.length;
}

/** Layout and the typing / deleting schedule (shared by the generator and its tests). */
export function typewriterLayout(params: TextMotionParams, size: MotionFrameSize): TypewriterLayout {
  const texts = params.lines;
  const total = texts.reduce((sum, text) => sum + [...text].length, 0);
  const typing = LEAD + CHAR * total + NEWLINE * (texts.length - 1);
  const deleting = DELETE * total;
  const natural = typing + MIN_HOLD + deleting + CARET_TAIL + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const face = textFace(params.font, 900);
  const tracking = displayTracking(texts);
  const safe = titleSafeBox(size);
  const caretRoom = CARET_GAP + CARET_WIDTH;

  // Horizontal: hero size for the widest line plus the caret beside it.
  const horizontal = texts.map(text => layoutLine(text, { ...face, size: 100, tracking }));
  const hero = heroTextBox(size);
  const wide = Math.max(...horizontal.map(line => line.width), 1e-6) + caretRoom * 100;
  const tall = -horizontal[0].emTop + LINE_HEIGHT * 100 * (texts.length - 1) + horizontal[horizontal.length - 1].emBottom;
  const horizontalSize = Math.min(hero.maxSize, (hero.maxWidth * 100) / wide, (hero.maxHeight * 100) / tall);
  // Vertical (portrait, mostly CJK): the longest column plus the caret below it fills 86% of the safe height.
  let verticalSize = 0;
  if (size.height > size.width && mostlyCjk(texts)) {
    const columns = texts.map(text => layoutVertical(text, { ...face, size: 100, tracking }));
    const column = heroTextBox(size, { heightFill: 0.86 });
    const high = Math.max(...columns.map(layout => layout.height), 1e-6) + caretRoom * 100;
    const across = (COLUMN_SPACING * (texts.length - 1) + 1) * 100;
    verticalSize = Math.min(column.maxSize, (column.maxHeight * 100) / high, (column.maxWidth * 100) / across);
  }
  const vertical = verticalSize >= VERTICAL_GAIN * horizontalSize;
  const fontSize = Number(Math.max(8, vertical ? verticalSize : horizontalSize).toFixed(3));
  const backdrop = textBackdrop(params);
  const tones = [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)];
  const gap = CARET_GAP * fontSize;

  // Typing runs forwards through the lines; deletion runs backwards from the last character.
  const typedEnd = typing * timeScale;
  const deleteEnd = params.durationSeconds - (CARET_TAIL + TAIL) * timeScale;
  const deleteStart = deleteEnd - deleting * timeScale;
  let clock = LEAD * timeScale, remaining = total, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (box: GlyphBox) => { x0 = Math.min(x0, box.x0); y0 = Math.min(y0, box.y0); x1 = Math.max(x1, box.x1); y1 = Math.max(y1, box.y1); };
  const schedule = () => {
    const typedAt = clock;
    clock += CHAR * timeScale;
    remaining -= 1;
    // The last character typed is the first deleted: `remaining` characters follow this one.
    return { typedAt, deletedAt: deleteStart + remaining * DELETE * timeScale };
  };
  let lines: TypedLine[];
  if (vertical) {
    const columns = texts.map(text => layoutVertical(text, { ...face, size: fontSize, tracking }));
    const blockWidth = (COLUMN_SPACING * (texts.length - 1) + 1) * fontSize;
    const blockHeight = Math.max(...columns.map(layout => layout.height)) + caretRoom * fontSize;
    const right = safe.cx + blockWidth / 2 - fontSize / 2, top = safe.cy - blockHeight / 2;
    lines = columns.map((column, index): TypedLine => {
      if (index > 0) clock += NEWLINE * timeScale;
      const axis = right - COLUMN_SPACING * fontSize * index, caretX = axis - (CARET_ACROSS * fontSize) / 2;
      const caretIn = clock;
      const glyphs = column.glyphs.map((glyph): TypedGlyph => {
        const ink = glyph.bbox;
        if (ink) grow({ x0: axis + ink.x0, y0: top + glyph.y + ink.y0, x1: axis + ink.x1, y1: top + glyph.y + ink.y1 });
        return { pathD: glyph.pathD, x: axis, y: top + glyph.y, anchorX: axis + (ink ? (ink.x0 + ink.x1) / 2 : 0),
          anchorY: top + glyph.y + (ink ? (ink.y0 + ink.y1) / 2 : glyph.advance / 2), caretX, caretY: top + glyph.y + glyph.advance + gap, ...schedule() };
      });
      return { color: tones[index % 2], caretX, caretY: top, glyphs, caretIn };
    });
  } else {
    const layouts = texts.map(text => layoutLine(text, { ...face, size: fontSize, tracking }));
    const blockWidth = Math.max(...layouts.map(line => line.width)) + caretRoom * fontSize;
    const blockHeight = -layouts[0].emTop + LINE_HEIGHT * fontSize * (texts.length - 1) + layouts[layouts.length - 1].emBottom;
    const left = safe.cx - blockWidth / 2, top = safe.cy - blockHeight / 2;
    lines = layouts.map((layout, index): TypedLine => {
      if (index > 0) clock += NEWLINE * timeScale;
      const baseline = top - layouts[0].emTop + LINE_HEIGHT * fontSize * index, caretY = baseline - CARET_TOP * fontSize;
      const caretIn = clock;
      const glyphs = layout.glyphs.map((glyph, glyphIndex): TypedGlyph => {
        const ink = glyph.bbox;
        if (ink) grow({ x0: left + glyph.x + ink.x0, y0: baseline + ink.y0, x1: left + glyph.x + ink.x1, y1: baseline + ink.y1 });
        const next = glyphIndex + 1 < layout.glyphs.length ? layout.glyphs[glyphIndex + 1].x : layout.width;
        return { pathD: glyph.pathD, x: left + glyph.x, y: baseline, anchorX: left + glyph.x + (ink ? (ink.x0 + ink.x1) / 2 : glyph.advance / 2),
          anchorY: baseline + (ink ? (ink.y0 + ink.y1) / 2 : -fontSize / 2), caretX: left + Math.min(next, glyph.x + glyph.advance) + gap, caretY, ...schedule() };
      });
      return { color: tones[index % 2], caretX: left, caretY, glyphs, caretIn };
    });
  }
  return {
    vertical, fontSize, timeScale, lines, typedEnd, deleteStart, deleteEnd, caretGone: params.durationSeconds - TAIL * timeScale,
    caretWidth: (vertical ? CARET_ACROSS : CARET_WIDTH) * fontSize, caretHeight: (vertical ? CARET_WIDTH : CARET_TOP + CARET_BOTTOM) * fontSize,
    box: { x0, y0, x1, y1 },
  };
}

export interface CaretState {
  readonly visible: boolean;
  /** Caret top-left (frame px). */
  readonly x: number;
  readonly y: number;
}

/** Caret position and visibility at clip time t: solid while typing or deleting, blinking 1 Hz while idle. */
export function typewriterCaret(layout: TypewriterLayout, t: number): CaretState {
  const first = layout.lines[0];
  if (t >= layout.caretGone) return { visible: false, x: first.caretX, y: first.caretY };
  let line = first;
  let shown: readonly TypedGlyph[];
  if (t < layout.deleteStart) {
    // Typing: the caret is on the latest line it has reached, after that line's last typed character.
    for (const candidate of layout.lines) if (t >= candidate.caretIn) line = candidate;
    shown = line.glyphs.filter(glyph => glyph.typedAt <= t);
  } else {
    // Deleting: the caret is on the last line that still shows a character; an emptied line hands it to the line before.
    for (const candidate of layout.lines) if (candidate.glyphs.some(glyph => t < glyph.deletedAt)) line = candidate;
    shown = line.glyphs.filter(glyph => t < glyph.deletedAt);
  }
  const at = shown.length ? shown[shown.length - 1] : undefined;
  const typingStart = first.glyphs[0]?.typedAt ?? first.caretIn;
  const busy = (t >= typingStart && t < layout.typedEnd) || (t >= layout.deleteStart && t < layout.deleteEnd);
  const idleSince = t < typingStart ? 0 : t < layout.deleteStart ? layout.typedEnd : layout.deleteEnd;
  return { visible: busy || (t - idleSince) % BLINK < BLINK_ON * BLINK, x: at ? at.caretX : line.caretX, y: at ? at.caretY : line.caretY };
}

export const T27_typewriter = defineTextMotion(ID, (params, t, size) => {
  const layout = typewriterLayout(params, size);
  const doc = createTextDocument(size, params);
  const parts: string[] = [];
  const strike = CHAR * layout.timeScale;
  for (const line of layout.lines) {
    for (const glyph of line.glyphs) {
      if (t < glyph.typedAt || t >= glyph.deletedAt || !glyph.pathD) continue;
      const age = (t - glyph.typedAt) / strike;
      const scale = age < 1 ? 1 + STRIKE * (1 - cubicOut(age)) : 1;
      const opacity = clamp01(age * 3);
      parts.push(path(glyph.pathD, {
        fill: line.color, opacity: opacity < 1 ? opacity : undefined,
        transform: scale !== 1
          ? transform(tf.translate(glyph.anchorX, glyph.anchorY), tf.scale(scale), tf.translate(glyph.x - glyph.anchorX, glyph.y - glyph.anchorY))
          : tf.translate(glyph.x, glyph.y),
      }));
    }
  }
  const caret = typewriterCaret(layout, t);
  if (caret.visible) {
    const backdrop = textBackdrop(params);
    const color = readableColor(backdrop, [params.palette.accent, secondaryTone(params.palette, backdrop), textOnBackground(params.palette, backdrop)]);
    parts.push(rect(caret.x, caret.y, layout.caretWidth, layout.caretHeight, { fill: color }));
  }
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
