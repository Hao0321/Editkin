import { fe, g, path, rect, tf } from "../../svg/document";
import { clamp01, cubicIn, expoOut, quartOut } from "../../svg/easing";
import { layoutLine, type GlyphBox, type LineLayout, type MotionFontSelector } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, heroTextBox, itemTiming, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T29 Odometer (カウンター), SWITCH: rolling digit reels count up to a number
 * (12,480 by default), with a label before it (累計) and a unit after it (人) in the
 * accent (ART_DIRECTION §0: paper digits and accent words on a dark card). The
 * number line is the first line with a digit; the line before it is the label, the
 * line after it the unit. Digits are Bebas Neue (tabular, condensed: the reels line
 * up and the number reads big; Noto Sans TC 900 digits were the alternative tried:
 * wider and rounder, they set the same lockup about 20% shorter, with a heavy comma);
 * a serif or hand font param sets the digits in that face instead. Separators stay
 * still.
 *
 * Every digit is a reel clipped to its own window. All reels start blank and roll up
 * into view together (0.05 s), then roll with a quart ease-out, the lower digits
 * travelling further (ones 3 turns, tens 2, hundreds 1, above that straight to their
 * digit) so they spin faster; the reels land left to right, 0.05 s apart, so the
 * fast ones digit clicks into place last. A vertical motion blur follows each
 * reel's speed. The label and the unit rise in, the lockup holds, then the digits
 * roll on up out of their windows (left first) while the words fade. Landscape sets one row (label, number, unit on one
 * baseline); a portrait frame stacks the label above the number and unit, so the
 * number can be larger. Times are standard-energy seconds, scaled by energy and
 * squeezed into short clips.
 */

const ID = "T29";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const ROLL_START = 0.05, ROLL = 1.45, LAND_STAGGER = 0.05, WORDS_IN = 0.32, MIN_HOLD = 0.9, EXIT = 0.28, EXIT_STAGGER = 0.04, TAIL = 0.08;
/** Full turns per place (ones, tens, hundreds, …): lower digits travel further and spin faster. */
const TURNS = [3, 2, 1];
/** Label / unit glyph height as a share of the digit height; gaps (× number font size). */
const WORD_RATIO = 0.42, ROW_GAP = 0.13, STACK_GAP = 0.1;
/** Reel window: a tight band around the digits (padding × digit height above the cap line and below the baseline), and
 * the reel pitch (× digit height): a rolling digit only shows inside the number's own band. */
const WINDOW_PAD = 0.04, PITCH = 1.2;
/** Motion blur: sigma per (digit per second), in pitches; cap. */
const BLUR_PER_SPEED = 0.006, BLUR_MAX = 0.36;
const DIGIT_TRACKING = -0.02;

export interface OdometerReel {
  /** Target digit and place (0 = ones). */
  readonly digit: number;
  readonly place: number;
  /** Window centre x and the digit pen x offset from it (frame px). */
  readonly cx: number;
  readonly penDx: number;
  /** Reel travel in digit steps from the blank cell below 0 to the target. */
  readonly distance: number;
  /** Clip seconds: landing and roll-out start. */
  readonly land: number;
  readonly exitAt: number;
}

export interface OdometerLayout {
  readonly mode: "row" | "stack";
  readonly numberSize: number;
  readonly wordSize: number;
  readonly digitFace: MotionFontSelector;
  readonly wordFace: MotionFontSelector;
  /** Digit baseline (frame px), digit height (px) and the digit band's top / bottom relative to the baseline (px). */
  readonly baseline: number;
  readonly digitHeight: number;
  readonly digitTop: number;
  readonly digitBottom: number;
  /** The number line laid out (separators drawn from it, digits replaced by reels). */
  readonly number: LineLayout;
  readonly numberX: number;
  readonly reels: readonly OdometerReel[];
  readonly label?: { readonly layout: LineLayout; readonly x: number; readonly y: number };
  readonly unit?: { readonly layout: LineLayout; readonly x: number; readonly y: number };
  readonly timeScale: number;
  readonly exitStart: number;
  /** Ink box of the whole lockup at the hold (frame px). */
  readonly box: GlyphBox;
}

const DIGIT = /^[0-9]$/;

/** Number, label and unit lines, the reel plan and the lockup geometry (shared by the generator and its tests). */
export function odometerLayout(params: TextMotionParams, size: MotionFrameSize): OdometerLayout {
  const numberIndex = Math.max(0, params.lines.findIndex(line => /[0-9]/.test(line)));
  const numberText = params.lines[numberIndex].trim();
  const labelText = numberIndex > 0 ? params.lines[numberIndex - 1].trim() : "";
  const unitText = numberIndex + 1 < params.lines.length ? params.lines[numberIndex + 1].trim() : "";
  const digitFace = params.font === "serif" || params.font === "hand" ? textFace(params.font, 900) : { font: "latin" as const };
  const wordFace = params.font === "latin" ? textFace("display", 900) : textFace(params.font, 900);
  const places = [...numberText].filter(character => DIGIT.test(character)).length;
  const natural = ROLL_START + ROLL + LAND_STAGGER * Math.max(0, places - 1) + MIN_HOLD + EXIT + EXIT_STAGGER * Math.max(0, places - 1) + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, natural);

  // Measure at 100 px, then scale. The digit band comes from the digits alone (a separator's descender must not stretch
  // the reel windows); the digit height sets the word size.
  const number100 = layoutLine(numberText, { ...digitFace, size: 100, tracking: DIGIT_TRACKING });
  let digitTop100 = 0, digitBottom100 = 0;
  for (let digit = 0; digit <= 9; digit += 1) {
    const ink = layoutLine(String(digit), { ...digitFace, size: 100 }).inkBox;
    if (ink) { digitTop100 = Math.min(digitTop100, ink.y0); digitBottom100 = Math.max(digitBottom100, ink.y1); }
  }
  if (!(digitBottom100 - digitTop100 > 0)) { digitTop100 = -70; digitBottom100 = 0; }
  const digitHeight100 = digitBottom100 - digitTop100;
  const wordProbe = layoutLine("計", { ...wordFace, size: 100 });
  const wordInk = wordProbe.inkBox ? wordProbe.inkBox.y1 - wordProbe.inkBox.y0 : 95;
  const wordSize100 = (WORD_RATIO * digitHeight100 * 100) / wordInk;
  const tracking = (text: string) => ([...text].filter(character => character.trim()).length >= 3 ? -0.04 : -0.02);
  const label100 = labelText ? layoutLine(labelText, { ...wordFace, size: wordSize100, tracking: tracking(labelText) }) : undefined;
  const unit100 = unitText ? layoutLine(unitText, { ...wordFace, size: wordSize100, tracking: tracking(unitText) }) : undefined;
  const inkWidth = (line: LineLayout | undefined) => (line?.inkBox ? line.inkBox.x1 - line.inkBox.x0 : 0);
  const numberWidth100 = inkWidth(number100);
  const mode: "row" | "stack" = size.height > size.width && label100 ? "stack" : "row";
  const hero = heroTextBox(size);
  let width100: number, height100: number;
  if (mode === "row") {
    width100 = inkWidth(label100) + (label100 ? ROW_GAP * 100 : 0) + numberWidth100 + (unit100 ? ROW_GAP * 100 + inkWidth(unit100) : 0);
    height100 = digitHeight100;
  } else {
    width100 = Math.max(inkWidth(label100), numberWidth100 + (unit100 ? ROW_GAP * 100 + inkWidth(unit100) : 0));
    height100 = WORD_RATIO * digitHeight100 + STACK_GAP * 100 + digitHeight100;
  }
  const k = Math.min(hero.maxWidth / width100, hero.maxHeight / height100);
  const numberSize = Number((100 * k).toFixed(3)), wordSize = Number((wordSize100 * k).toFixed(3));
  const number = layoutLine(numberText, { ...digitFace, size: numberSize, tracking: DIGIT_TRACKING });
  const label = labelText ? layoutLine(labelText, { ...wordFace, size: wordSize, tracking: tracking(labelText) }) : undefined;
  const unit = unitText ? layoutLine(unitText, { ...wordFace, size: wordSize, tracking: tracking(unitText) }) : undefined;
  const digitHeight = digitHeight100 * k, digitTop = digitTop100 * k, digitBottom = digitBottom100 * k;
  const safe = titleSafeBox(size);
  const numberInk = number.inkBox ?? { x0: 0, y0: digitTop, x1: number.width, y1: digitBottom };
  const lockWidth = width100 * k, lockHeight = height100 * k;
  const left = safe.cx - lockWidth / 2, top = safe.cy - lockHeight / 2;
  // The digit band closes the lockup at the bottom; label and unit sit on the digits' bottom edge.
  const baseline = top + lockHeight - digitBottom;
  let numberX: number, labelPlace: OdometerLayout["label"], unitPlace: OdometerLayout["unit"];
  const wordBaseline = (line: LineLayout, bottom: number) => bottom - (line.inkBox ? line.inkBox.y1 : 0);
  if (mode === "row") {
    let x = left;
    if (label) { labelPlace = { layout: label, x: x - (label.inkBox?.x0 ?? 0), y: wordBaseline(label, baseline + digitBottom) }; x += inkWidth(label) + ROW_GAP * numberSize; }
    numberX = x - numberInk.x0;
    x += numberInk.x1 - numberInk.x0;
    if (unit) unitPlace = { layout: unit, x: x + ROW_GAP * numberSize - (unit.inkBox?.x0 ?? 0), y: wordBaseline(unit, baseline + digitBottom) };
  } else {
    const rowWidth = numberInk.x1 - numberInk.x0 + (unit ? ROW_GAP * numberSize + inkWidth(unit) : 0);
    const rowLeft = safe.cx - rowWidth / 2;
    numberX = rowLeft - numberInk.x0;
    if (label) labelPlace = { layout: label, x: rowLeft - (label.inkBox?.x0 ?? 0), y: wordBaseline(label, top + WORD_RATIO * digitHeight) };
    if (unit) unitPlace = { layout: unit, x: rowLeft + numberInk.x1 - numberInk.x0 + ROW_GAP * numberSize - (unit.inkBox?.x0 ?? 0), y: wordBaseline(unit, baseline + digitBottom) };
  }
  const exitStart = params.durationSeconds - (EXIT + EXIT_STAGGER * Math.max(0, places - 1) + TAIL) * timeScale;
  const digitGlyphs = number.glyphs.filter(glyph => DIGIT.test(glyph.char));
  const reels = digitGlyphs.map((glyph, order): OdometerReel => {
    const place = digitGlyphs.length - 1 - order, digit = Number(glyph.char);
    return {
      digit, place, cx: numberX + glyph.x + glyph.advance / 2, penDx: -glyph.advance / 2,
      distance: 1 + 10 * (TURNS[place] ?? 0) + digit,
      land: (ROLL_START + ROLL + LAND_STAGGER * order) * timeScale,
      exitAt: exitStart + EXIT_STAGGER * order * timeScale,
    };
  });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const grow = (line: LineLayout | undefined, x: number, y: number) => {
    if (!line?.inkBox) return;
    x0 = Math.min(x0, x + line.inkBox.x0); x1 = Math.max(x1, x + line.inkBox.x1); y0 = Math.min(y0, y + line.inkBox.y0); y1 = Math.max(y1, y + line.inkBox.y1);
  };
  grow(number, numberX, baseline); grow(labelPlace?.layout, labelPlace?.x ?? 0, labelPlace?.y ?? 0); grow(unitPlace?.layout, unitPlace?.x ?? 0, unitPlace?.y ?? 0);
  return {
    mode, numberSize, wordSize, digitFace, wordFace, baseline, digitHeight, digitTop, digitBottom, number, numberX, reels, label: labelPlace, unit: unitPlace,
    timeScale, exitStart, box: { x0, y0, x1, y1 },
  };
}

/** Reel position (digit steps from the blank cell below 0) and speed (steps per second) at clip time t. */
export function odometerReel(reel: OdometerReel, t: number, timeScale: number): { readonly position: number; readonly speed: number } {
  const start = ROLL_START * timeScale, span = reel.land - start;
  if (t >= reel.exitAt) {
    const q = clamp01((t - reel.exitAt) / (EXIT * timeScale));
    return { position: reel.distance + cubicIn(q), speed: q < 1 ? (3 * q * q) / (EXIT * timeScale) : 0 };
  }
  if (t <= start) return { position: 0, speed: 0 };
  if (t >= reel.land) return { position: reel.distance, speed: 0 };
  const p = (t - start) / span;
  return { position: reel.distance * quartOut(p), speed: (reel.distance * 4 * (1 - p) ** 3) / span };
}

export const T29_odometer = defineTextMotion(ID, (params, t, size) => {
  const layout = odometerLayout(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const numberColor = textOnBackground(params.palette, backdrop);
  const wordColor = secondaryTone(params.palette, backdrop);
  const ts = layout.timeScale;
  const parts: string[] = [];
  // Label and unit: rise in, hold, fade with the roll-out.
  const wordsIn = expoOut(clamp01(t / (WORDS_IN * ts)));
  const wordsOut = t >= layout.exitStart ? 1 - clamp01((t - layout.exitStart) / ((EXIT + EXIT_STAGGER * Math.max(0, layout.reels.length - 1)) * ts)) : 1;
  const wordOpacity = Math.min(clamp01(t / (0.6 * WORDS_IN * ts)), wordsOut);
  const rise = (1 - wordsIn) * 0.35 * layout.digitHeight * 0.42 - (1 - wordsOut) * 0.2 * layout.digitHeight;
  for (const word of [layout.label, layout.unit]) {
    if (!word || wordOpacity <= 0.002) continue;
    parts.push(path(word.layout.pathD, { fill: wordColor, opacity: wordOpacity < 1 ? wordOpacity : undefined, transform: tf.translate(word.x, word.y + rise) }));
  }
  // Separators: still, in the number colour, fading with the words.
  const separatorOpacity = Math.min(clamp01(t / (0.6 * WORDS_IN * ts)), wordsOut);
  if (separatorOpacity > 0.002) {
    for (const glyph of layout.number.glyphs) {
      if (DIGIT.test(glyph.char) || glyph.whitespace) continue;
      parts.push(path(glyph.pathD, { fill: numberColor, opacity: separatorOpacity < 1 ? separatorOpacity : undefined, transform: tf.translate(layout.numberX + glyph.x, layout.baseline) }));
    }
  }
  // Digit reels: cell j shows digit (j − 1) mod 10 (cell 0 is the blank below 0; past the target is blank).
  const pitch = PITCH * layout.digitHeight, pad = WINDOW_PAD * layout.digitHeight;
  const digitGlyph = new Map<number, LineLayout>();
  const glyphFor = (digit: number) => {
    let line = digitGlyph.get(digit);
    if (!line) { line = layoutLine(String(digit), { ...layout.digitFace, size: layout.numberSize }); digitGlyph.set(digit, line); }
    return line;
  };
  const windowTop = layout.baseline + layout.digitTop - pad, windowHeight = layout.digitHeight + 2 * pad;
  for (const reel of layout.reels) {
    const { position, speed } = odometerReel(reel, t, ts);
    const halfWidth = (glyphFor(0).width * 1.1) / 2;
    const cells: string[] = [];
    for (let cell = Math.floor(position) - 1; cell <= Math.floor(position) + 2; cell += 1) {
      if (cell < 1 || cell > reel.distance) continue;
      const dy = (cell - position) * pitch;
      if (Math.abs(dy) > windowHeight / 2 + pitch / 2 + pad) continue;
      const line = glyphFor((cell - 1) % 10);
      cells.push(path(line.pathD, { fill: numberColor, transform: tf.translate(reel.cx - line.width / 2, layout.baseline + dy) }));
    }
    if (!cells.length) continue;
    const clip = doc.clipPath(rect(reel.cx - halfWidth, windowTop, 2 * halfWidth, windowHeight));
    const sigma = Math.min(BLUR_MAX * pitch, BLUR_PER_SPEED * speed * pitch);
    const blur = sigma >= 0.5 ? doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: [0, sigma] }),
      { x: reel.cx - halfWidth, y: windowTop - 3 * sigma, width: 2 * halfWidth, height: windowHeight + 6 * sigma }) : undefined;
    parts.push(g({ "clip-path": clip }, blur ? g({ filter: blur }, cells) : cells));
  }
  return doc.render(g(undefined, parts));
}, { revision: REVISION });

