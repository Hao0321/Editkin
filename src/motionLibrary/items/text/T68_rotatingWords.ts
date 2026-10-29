import { g, path, tf, transform } from "../../svg/document";
import { backOut, clamp01, cubicIn, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD, isMarqueeSeparator } from "./T09_hugeTextScroll";
import { layoutRingText, type RingTextLayout } from "./ringText";

/**
 * T68 Rotating Words (旋轉換字), RHYTHM, on the dark card: a word sits at the
 * centre of a ring of small characters. Line 1 holds the centre words, separated by
 * 「／」; line 2 is the ring text, repeated around the circle with 「・」 (ringText,
 * DESIGN §8: evenly spaced, no seam, tops outward).
 * - Ring: radius 0.9× the centre word size; the ring turns clockwise at 90°/s, so a
 *   4-word loop is exactly one turn. Ring characters alternate cream and teal (the
 *   separators take the second tone).
 * - Centre: the word changes every 1.0 s with a vertical flip: scaleY 1 → 0 in 0.1 s
 *   (cubicIn, so two frames of the fold show at 30 fps), swap, then 0 → 1 in 0.12 s
 *   (backOut), which lands exactly on the beat (word k is whole from k s). Centre
 *   words alternate teal and cream.
 * The loop is the number of words × 1.0 s (4 s by default, catalog loopSeconds), and
 * frame 0 shows the first word whole. For other word counts the ring speed rounds to
 * the nearest whole number of ring repeats per loop, so every loop is seamless; the
 * beat is always exactly 1.0 s.
 *
 * Size: the composition (ring + its glyphs) fills 96% of the title-safe short side;
 * the centre word is fitted inside the ring (a long word shrinks to the inner chord)
 * and is far above 9% of the short side, the ring glyphs above 4.5%. Colours follow
 * ART_DIRECTION §0: the readable text role and the second tone (cream and teal on
 * the dark card; ink and deep teal on the teal card). Energy does not change the
 * tempo; the flip overshoot is fixed.
 */

const ID = "T68";
const REVISION = 1;
/** Seconds per centre word (the beat), ring speed (degrees per second, clockwise). */
export const T68_BEAT = 1.0, T68_RING_SPEED = 90;
/** Flip out / in durations (s). */
export const T68_FLIP_OUT = 0.1, T68_FLIP_IN = 0.12;
/** Ring radius (× centre word size), ring glyph size (× centre word size), the composition's share of the safe short side. */
export const T68_RING_RADIUS = 0.9, T68_RING_SIZE = 0.24, T68_FILL = 0.96;
const WORD_SEPARATOR = /[／/]/;

export interface CentreWord {
  readonly text: string;
  readonly pathD: string;
  /** Pen origin (frame px) of the fitted word, ink box (frame px). */
  readonly x: number;
  readonly y: number;
  readonly box: GlyphBox;
  readonly color: string;
}

export interface RotatingWordsPlan {
  readonly words: readonly CentreWord[];
  readonly ring: RingTextLayout;
  readonly ringColors: readonly string[];
  readonly cx: number;
  readonly cy: number;
  /** Centre word size: the ink height a single character reaches (px). */
  readonly wordSize: number;
  readonly loopSeconds: number;
  /** Ring turn over one loop (degrees, a whole number of repeats). */
  readonly ringTurn: number;
}

/** Centre words from line 1 split on 「／」 (blank pieces dropped); a line without separators is one word. */
export function centreWords(lines: readonly string[]): string[] {
  const words = lines[0].split(WORD_SEPARATOR).map(word => word.trim()).filter(Boolean);
  return words.length ? words : [lines[0].trim()];
}

/** Ring text: line 2, or the centre words joined when there is no second line. */
export function ringSource(lines: readonly string[]): string {
  return (lines[1] ?? centreWords(lines).join("")).trim() || centreWords(lines).join("");
}

export function rotatingWordsLoopSeconds(lines: readonly string[]): number {
  return centreWords(lines).length * T68_BEAT;
}

export function rotatingWordsPlan(params: TextMotionParams, size: MotionFrameSize): RotatingWordsPlan {
  const safe = titleSafeBox(size);
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  const face = textFace(params.font, 900);
  // Composition diameter = 2·(0.9·S) + ring glyph size (0.24·S) must fill 96% of the safe short side.
  const short = Math.min(safe.width, safe.height);
  const wordSize = (T68_FILL * short) / (2 * T68_RING_RADIUS + T68_RING_SIZE * 1.1);
  const cx = safe.cx, cy = safe.cy;
  const radius = T68_RING_RADIUS * wordSize;
  // The inner edge of the ring glyphs leaves a chord the word must fit in (a square of side √2·inner, kept with a margin).
  const inner = radius - (T68_RING_SIZE * wordSize) / 2;
  const words = centreWords(params.lines).map((text, index) => {
    const fitted = layoutFittedText([text], face, {
      maxWidth: 1.3 * inner, maxHeight: wordSize, maxSize: 4 * wordSize, lineHeight: 1, tracking: displayTracking([text]),
    });
    const x = cx - fitted.inkCenter[0], y = cy - fitted.inkCenter[1];
    return {
      text, pathD: compactPathD(fitted.block.pathD), x, y,
      box: { x0: fitted.ink.x0 + x, y0: fitted.ink.y0 + y, x1: fitted.ink.x1 + x, y1: fitted.ink.y1 + y },
      color: index % 2 === 0 ? second : first,
    };
  });
  // Ring glyph em size: their ink height ≈ 0.92 em in the display face, so the em is set to reach T68_RING_SIZE·S of ink.
  const ring = layoutRingText({ ...face, text: ringSource(params.lines), size: (T68_RING_SIZE * wordSize) / 0.92, radius, cx, cy });
  let letter = 0;
  const ringColors = ring.glyphs.map(glyph => (glyph.isSeparator || isMarqueeSeparator(glyph.char) ? second : letter++ % 2 === 0 ? first : second));
  const loopSeconds = words.length * T68_BEAT;
  const repeatDegrees = 360 / ring.repeats;
  const ringTurn = Math.max(1, Math.round((T68_RING_SPEED * loopSeconds) / repeatDegrees)) * repeatDegrees;
  return { words, ring, ringColors, cx, cy, wordSize, loopSeconds, ringTurn };
}

export interface CentreState {
  readonly word: number;
  readonly scaleY: number;
}

/**
 * The centre word and its flip at loop time u (seconds): word k is whole on [k, k + 1 − 0.22) (beat k, minus the swap),
 * flips out over the next 0.1 s, swaps at k + 1 − 0.12 and flips in to land on k + 1.
 */
export function centreState(plan: RotatingWordsPlan, u: number): CentreState {
  const n = plan.words.length;
  const swap = T68_BEAT - T68_FLIP_IN, outStart = swap - T68_FLIP_OUT;
  const beat = Math.floor(u / T68_BEAT), local = u - beat * T68_BEAT;
  if (local < outStart) return { word: beat % n, scaleY: 1 };
  if (local < swap) return { word: beat % n, scaleY: 1 - cubicIn(clamp01((local - outStart) / T68_FLIP_OUT)) };
  return { word: (beat + 1) % n, scaleY: backOut(clamp01((local - swap) / T68_FLIP_IN)) };
}

export const T68_rotatingWords = defineTextMotion(ID, (params, t, size) => {
  const plan = rotatingWordsPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, plan.loopSeconds) * plan.loopSeconds;
  const angle = (plan.ringTurn * u) / plan.loopSeconds;
  const ring = g({ transform: tf.rotate(angle, plan.cx, plan.cy) },
    plan.ring.glyphs.map((glyph, index) => (glyph.pathD ? path(glyph.pathD, { fill: plan.ringColors[index], transform: glyph.transform }) : "")));
  const state = centreState(plan, u), word = plan.words[state.word];
  const centre = state.scaleY <= 0.001 ? "" : path(word.pathD, {
    fill: word.color,
    transform: state.scaleY === 1 ? tf.translate(word.x, word.y)
      : transform(tf.translate(plan.cx, plan.cy), tf.scale(1, state.scaleY), tf.translate(word.x - plan.cx, word.y - plan.cy)),
  });
  return doc.render(ring, centre);
}, { revision: REVISION });
