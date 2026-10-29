import { circle, g, path, transform, tf } from "../../svg/document";
import { clamp01, expoOut, quadIn, quadOut } from "../../svg/easing";
import { layoutLine, translatePathD, type GlyphBox, type LineLayout, type MotionFontSelector } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T48 Number Slam (倒數重擊), DRAMA: a countdown, one item per line (3 / 2 / 1 /
 * 出發！). Each item slams from 2.6× to 1.0× in 0.12 s (expoOut, no overshoot) and
 * is cut by the next; numbers get 0.45 s each, the final word 0.7 s (any spare clip
 * time goes to it), then a 0.25 s blank. On every slam one accent ring (stroke 3% of
 * the short side) appears around the item at its landing, born just clear of the ink
 * (its inner edge on the circle through a narrow digit's ink box corners, or on 0.92
 * of a wide word's ink box diagonal) and grows to 1.6× over 0.35 s while it thins
 * and fades. Pure-digit lines are set in Bebas Neue, every other line
 * in the display face (a serif or hand font param sets everything in that face).
 * Numbers are paper and the final word is the accent (ART_DIRECTION §0 on the dark
 * card; ink and accent2 on cream). Digits share one size (as tall as the hero box
 * allows, capped at 0.75 of the short side so the ring still reads as a ring); the
 * final word fills 86% of the title-safe width. Full-width punctuation in a word line
 * (！？、。…) is set by its ink, as proportional CJK punctuation would be, so the payoff
 * reads 出發！ and not 出發 ！. Flash safety (≤ 3 cut-ins a second):
 * a slot never drops below 1/3 s; when the clip is too short for every item, the
 * earliest numbers are dropped and the countdown starts later. Times are
 * standard-energy seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T48";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const SLOT = 0.45, FINAL = 0.7, MIN_FINAL = 0.4, BLANK = 0.25, SLAM = 0.12, FADE_IN = 0.05;
/** Shortest slot: one cut-in per slot, so at most 3 per second. */
const MIN_SLOT = 1 / 3;
/** Slam start scale is 1 + SLAM_OVERSIZE · scaleDepth (2.6× at standard energy). */
const SLAM_OVERSIZE = 1.6;
/**
 * Ring, measured to the stroke's inner edge: born on RING_BASE × the ink box diagonal, or on the circle through the ink box
 * corners when that is larger (a narrow item; at most RING_TALL × its height); then its growth, life, stroke (× short side)
 * and the stroke's thinning.
 */
const RING_BASE = 0.92, RING_TALL = 1.1, RING_GROWTH = 1.6, RING_LIFE = 0.35, RING_STROKE = 0.03, RING_THIN = 0.8;
/** Digit height cap (× short side) beside the hero box. */
const DIGIT_CAP = 0.75;
const DIGITS = /^[0-9]+$/;
/** Full-width punctuation set by its ink (CJK symbols and punctuation, full-width forms) and the side gap it keeps (em). */
const PUNCTUATION = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;
const PUNCTUATION_GAP = 0.06;

/**
 * A line with full-width punctuation set proportionally: each punctuation glyph keeps only its ink plus PUNCTUATION_GAP
 * em on either side, the other glyphs keep their advances (and tracking). Returns the line unchanged without punctuation.
 */
function proportionalPunctuation(line: LineLayout): LineLayout {
  if (!line.glyphs.some(glyph => PUNCTUATION.test(glyph.char) && glyph.bbox)) return line;
  const gap = PUNCTUATION_GAP * line.size, tracking = line.tracking * line.size;
  let pen = 0, pathD = "", x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  line.glyphs.forEach((glyph, index) => {
    if (index > 0) pen += tracking;
    const punctuation = PUNCTUATION.test(glyph.char) && glyph.bbox;
    const x = punctuation ? pen + gap - glyph.bbox!.x0 : pen;
    if (glyph.pathD) pathD += translatePathD(glyph.pathD, x, 0);
    if (glyph.bbox) { x0 = Math.min(x0, x + glyph.bbox.x0); x1 = Math.max(x1, x + glyph.bbox.x1); y0 = Math.min(y0, glyph.bbox.y0); y1 = Math.max(y1, glyph.bbox.y1); }
    pen = punctuation ? x + glyph.bbox!.x1 + gap : pen + glyph.advance;
  });
  return { ...line, pathD, width: pen, inkBox: x1 > x0 ? { x0, y0, x1, y1 } : line.inkBox };
}

export interface SlamBeat {
  readonly text: string;
  readonly layout: LineLayout;
  readonly digits: boolean;
  readonly final: boolean;
  /** Pen origin (frame px) and the ink box at the hold. */
  readonly x: number;
  readonly y: number;
  readonly box: GlyphBox;
  readonly color: string;
  /** Clip seconds: slam start and cut. */
  readonly start: number;
  readonly cut: number;
}

export interface NumberSlamLayout {
  readonly beats: readonly SlamBeat[];
  readonly timeScale: number;
  readonly slamScale: number;
  readonly slot: number;
}

function faceFor(params: TextMotionParams, digits: boolean): MotionFontSelector {
  if (params.font === "serif" || params.font === "hand") return textFace(params.font, 900);
  return digits ? { font: "latin" } : textFace(params.font === "latin" ? "display" : params.font, 900);
}

/** Beats, sizes and timing (shared by the generator and its tests). */
export function numberSlamLayout(params: TextMotionParams, size: MotionFrameSize): NumberSlamLayout {
  const texts = params.lines.map(line => line.trim()).filter(Boolean);
  const numbers = texts.length - 1;
  const natural = SLOT * numbers + FINAL + BLANK;
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  // Flash safety: keep the slot ≥ 1/3 s; drop the earliest numbers if they no longer fit.
  const slot = Math.max(MIN_SLOT, SLOT * timeScale);
  const blank = BLANK * timeScale;
  let kept = numbers;
  while (kept > 0 && kept * slot + MIN_FINAL * timeScale + blank > params.durationSeconds + 1e-9) kept -= 1;
  const shown = texts.slice(numbers - kept);
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const hero = heroTextBox(size);
  const backdrop = textBackdrop(params);
  const numberColor = textOnBackground(params.palette, backdrop), finalColor = secondaryTone(params.palette, backdrop);
  // One size for every pure-digit beat (the tallest the hero box and the cap allow); the final word fills the hero width.
  const digitTexts = shown.filter((text, index) => index < shown.length - 1 && DIGITS.test(text));
  let digitSize = Infinity;
  for (const text of digitTexts) {
    const ink = layoutLine(text, { ...faceFor(params, true), size: 100 }).inkBox;
    if (!ink) continue;
    digitSize = Math.min(digitSize, (100 * hero.maxWidth) / (ink.x1 - ink.x0), (100 * Math.min(hero.maxHeight, DIGIT_CAP * short)) / (ink.y1 - ink.y0));
  }
  const beats: SlamBeat[] = shown.map((text, index): SlamBeat => {
    const final = index === shown.length - 1, digits = !final && DIGITS.test(text);
    const face = faceFor(params, digits), tracking = digits ? 0 : displayTracking([text]);
    let fontSize: number;
    if (digits && Number.isFinite(digitSize)) fontSize = digitSize;
    else {
      const ink = proportionalPunctuation(layoutLine(text, { ...face, size: 100, tracking })).inkBox ?? { x0: 0, y0: -88, x1: 100, y1: 12 };
      fontSize = Math.min(hero.maxSize, (100 * hero.maxWidth) / (ink.x1 - ink.x0), (100 * Math.min(hero.maxHeight, DIGIT_CAP * short)) / (ink.y1 - ink.y0));
    }
    const laid = layoutLine(text, { ...face, size: Number(Math.max(8, fontSize).toFixed(3)), tracking });
    const layout = digits ? laid : proportionalPunctuation(laid);
    const ink = layout.inkBox ?? { x0: 0, y0: -layout.size, x1: layout.width, y1: 0 };
    const x = safe.cx - (ink.x0 + ink.x1) / 2, y = safe.cy - (ink.y0 + ink.y1) / 2;
    const start = index * slot;
    return {
      text, layout, digits, final, x, y, box: { x0: x + ink.x0, y0: y + ink.y0, x1: x + ink.x1, y1: y + ink.y1 },
      color: final ? finalColor : numberColor, start, cut: final ? params.durationSeconds - blank : start + slot,
    };
  });
  return { beats, timeScale, slamScale: 1 + SLAM_OVERSIZE * energy.scaleDepth, slot };
}

export const T48_numberSlam = defineTextMotion(ID, (params, t, size) => {
  const layout = numberSlamLayout(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const ringColor = readableColor(backdrop, [params.palette.accent, secondaryTone(params.palette, backdrop), textOnBackground(params.palette, backdrop)]);
  const short = Math.min(size.width, size.height), ts = layout.timeScale;
  const parts: string[] = [];
  // Rings first (behind every item); a ring outlives its item by a few frames as it fades.
  for (const beat of layout.beats) {
    const age = (t - beat.start - SLAM * ts) / (RING_LIFE * ts);
    if (age < 0 || age >= 1) continue;
    // Born clear of the ink and never smaller than the item's height (the spec's 1.0×): a narrow digit's ring passes its
    // ink box corners, a wide word's frames 92% of its diagonal. The stroke is centred outside that inner edge.
    const height = beat.box.y1 - beat.box.y0, diagonal = Math.hypot(beat.box.x1 - beat.box.x0, height);
    const base = Math.max(RING_BASE * diagonal, Math.min(diagonal, RING_TALL * height));
    const stroke = RING_STROKE * short * (1 - RING_THIN * age);
    const diameter = base * (1 + (RING_GROWTH - 1) * quadOut(age)) + stroke;
    const opacity = 1 - quadIn(age);
    if (opacity <= 0.002) continue;
    parts.push(circle((beat.box.x0 + beat.box.x1) / 2, (beat.box.y0 + beat.box.y1) / 2, diameter / 2,
      { fill: "none", stroke: ringColor, "stroke-width": stroke, opacity: opacity < 1 ? opacity : undefined }));
  }
  const beat = layout.beats.find(candidate => t >= candidate.start && t < candidate.cut);
  if (beat) {
    const local = t - beat.start, slam = SLAM * ts;
    const scale = local < slam ? layout.slamScale + (1 - layout.slamScale) * expoOut(local / slam) : 1;
    const opacity = clamp01(local / (FADE_IN * ts));
    if (opacity > 0.002) {
      const cx = (beat.box.x0 + beat.box.x1) / 2, cy = (beat.box.y0 + beat.box.y1) / 2;
      parts.push(g({ opacity: opacity < 1 ? opacity : undefined,
        transform: scale !== 1 ? transform(tf.translate(cx, cy), tf.scale(scale), tf.translate(beat.x - cx, beat.y - cy)) : tf.translate(beat.x, beat.y) },
      path(beat.layout.pathD, { fill: beat.color })));
    }
  }
  return doc.render(parts);
}, { revision: REVISION });
