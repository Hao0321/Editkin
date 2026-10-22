import { contrastRatio } from "../../svg/color";
import { g, path, transform, tf } from "../../svg/document";
import { clamp01, cubicOut } from "../../svg/easing";
import { layoutLine, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type MotionPalette, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T02 Letter Sequence (レターシーケンス): one character at a time, centred and
 * huge, one 0.5 s slot each. A character enters at 1.4× and 0 opacity and slams
 * to 1.0 in 0.1 s (cubic ease-out, no overshoot), holds 0.25 s and cuts out,
 * leaving a 0.15 s blank. The last character holds until 0.15 s before the end of
 * its cycle, so the clip ends on the payoff instead of a dead slot. Colours
 * alternate as in T02's own reference (set A IMPACT, 「止まるな」): ink and cream on
 * the red card, i.e. the other text role wherever it reads at 2:1; elsewhere the
 * §0 secondaryTone (paper and accent over footage or a dark card). Beats are sized
 * with heroTextBox: the widest beat fills 86% of the title-safe width.
 *
 * Every visible character of every line is a beat (whitespace is skipped). Flash
 * safety (ART_DIRECTION §4, ≤ 3 per second): a slot never drops below 1/3 s. When
 * the text is too long for the clip, neighbouring characters share a beat instead.
 * A clip long enough for two or more programs repeats the sequence in equal cycles.
 * Times are standard-energy seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T02";
/** Art revision (part of the clip cache key): 1 = first render; 2 = ART_DIRECTION §0 (hero size, tight tracking);
 * 3 = back to its own reference's ink + cream alternation on the red card (an item's reference beats the generic tone rule). */
const REVISION = 3;
const SLOT = 0.5, ENTER = 0.1, HOLD = 0.25, BLANK = 0.15, FADE_IN = 0.06;
/** The last beat of a cycle holds this much longer than a normal slot (standard seconds). */
const LAST_EXTRA = 0.3;
/** Shortest slot: one cut-in per slot, so at most 3 per second. */
const MIN_SLOT = 1 / 3;
/** Entry scale is 1 + ENTRY_OVERSIZE · scaleDepth (1.4× at standard energy). */
const ENTRY_OVERSIZE = 0.4;

export interface LetterBeat {
  readonly text: string;
  /** Clip seconds: the beat appears at start (entering) and cuts at cut. */
  readonly start: number;
  readonly cut: number;
  readonly color: string;
  /** Ink box at the hold (1.0×), frame px. */
  readonly box: GlyphBox;
}

export interface LetterSequencePlan {
  readonly fontSize: number;
  readonly timeScale: number;
  readonly cycles: number;
  readonly cycleSeconds: number;
  readonly entryScale: number;
  readonly beats: readonly LetterBeat[];
}

/**
 * The second colour of the alternating pair: the other text role when it reads at 2:1 (cream on the red card, as
 * in the reference), else ART_DIRECTION §0's secondaryTone (accent over footage, accent2 on cream).
 */
export function alternateTextColor(palette: MotionPalette, backdrop: string): string {
  const primary = textOnBackground(palette, backdrop);
  const other = primary === palette.paper ? palette.ink : palette.paper;
  return contrastRatio(other, backdrop) >= 2 ? other : secondaryTone(palette, backdrop);
}

/** Visible characters in reading order (all lines; whitespace skipped). */
function visibleCharacters(lines: readonly string[]): string[] {
  return lines.flatMap(line => [...line].filter(character => character.trim() !== ""));
}

/** Beats per cycle: one character each unless that would make a slot shorter than MIN_SLOT. */
function beatCount(characters: number, durationSeconds: number, energy: TextMotionParams["energy"]): { beats: number; cycles: number } {
  for (let beats = Math.max(1, characters); beats >= 1; beats -= 1) {
    const natural = beats * SLOT + LAST_EXTRA;
    const { energy: profile } = itemTiming(energy, durationSeconds, natural);
    const cycles = Math.max(1, Math.floor((durationSeconds + 1e-9) / (natural * profile.time)));
    const { timeScale } = itemTiming(energy, durationSeconds / cycles, natural);
    if (SLOT * timeScale >= MIN_SLOT - 1e-9 || beats === 1) return { beats, cycles };
  }
  return { beats: 1, cycles: 1 };
}

/** Beat texts, timing, colours and hold boxes for the whole clip (shared by the generator and its tests). */
export function letterSequencePlan(params: TextMotionParams, size: MotionFrameSize): LetterSequencePlan {
  const characters = visibleCharacters(params.lines);
  if (!characters.length) throw new Error("T02 needs at least one visible character");
  const { beats: count, cycles } = beatCount(characters.length, params.durationSeconds, params.energy);
  const texts = Array.from({ length: count }, (_, beat) =>
    characters.slice(Math.floor((beat * characters.length) / count), Math.floor(((beat + 1) * characters.length) / count)).join(""));
  const natural = count * SLOT + LAST_EXTRA, cycleSeconds = params.durationSeconds / cycles;
  const { energy, timeScale } = itemTiming(params.energy, cycleSeconds, natural);
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);

  // One size for every beat: the widest and tallest beat fills the hero box (ART_DIRECTION §0).
  let widest = 1e-6, tallest = 1e-6;
  for (const text of texts) {
    const ink = layoutLine(text, { ...face, size: 100, tracking: displayTracking([text]) }).inkBox;
    if (ink) { widest = Math.max(widest, ink.x1 - ink.x0); tallest = Math.max(tallest, ink.y1 - ink.y0); }
  }
  const hero = heroTextBox(size);
  const fontSize = Number(Math.max(8, Math.min(hero.maxSize, (hero.maxWidth * 100) / widest, (hero.maxHeight * 100) / tallest)).toFixed(3));

  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const secondary = alternateTextColor(params.palette, backdrop);
  const slot = SLOT * timeScale;
  const beats: LetterBeat[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const offset = cycle * cycleSeconds;
    texts.forEach((text, index) => {
      const line = layoutLine(text, { ...face, size: fontSize, tracking: displayTracking([text]) });
      const ink = line.inkBox ?? { x0: 0, y0: -fontSize, x1: line.width, y1: 0 };
      const cx = (ink.x0 + ink.x1) / 2, cy = (ink.y0 + ink.y1) / 2;
      const start = offset + index * slot;
      const last = index === texts.length - 1;
      beats.push({
        text, start,
        cut: last ? offset + cycleSeconds - BLANK * timeScale : start + (ENTER + HOLD) * timeScale,
        color: index % 2 === 0 ? primary : secondary,
        box: { x0: safe.cx + ink.x0 - cx, y0: safe.cy + ink.y0 - cy, x1: safe.cx + ink.x1 - cx, y1: safe.cy + ink.y1 - cy },
      });
    });
  }
  return { fontSize, timeScale, cycles, cycleSeconds, entryScale: 1 + ENTRY_OVERSIZE * energy.scaleDepth, beats };
}

export const T02_letterSequence = defineTextMotion(ID, (params, t, size) => {
  const plan = letterSequencePlan(params, size);
  const doc = createTextDocument(size, params);
  const beat = plan.beats.find(candidate => t >= candidate.start && t < candidate.cut);
  if (!beat) return doc.render();
  const face = textFace(params.font, 900);
  const line = layoutLine(beat.text, { ...face, size: plan.fontSize, tracking: displayTracking([beat.text]) });
  const ink = line.inkBox ?? { x0: 0, y0: -plan.fontSize, x1: line.width, y1: 0 };
  const local = t - beat.start;
  const enter = ENTER * plan.timeScale;
  const scale = local < enter ? 1 + (plan.entryScale - 1) * (1 - cubicOut(local / enter)) : 1;
  const opacity = clamp01(local / (FADE_IN * plan.timeScale));
  if (opacity <= 0.002) return doc.render();
  const center = [(beat.box.x0 + beat.box.x1) / 2, (beat.box.y0 + beat.box.y1) / 2] as const;
  return doc.render(g({
    opacity: opacity < 1 ? opacity : undefined,
    transform: transform(tf.translate(center[0], center[1]), scale !== 1 && tf.scale(scale), tf.translate(-(ink.x0 + ink.x1) / 2, -(ink.y0 + ink.y1) / 2)),
  }, path(line.pathD, { fill: beat.color })));
}, { revision: REVISION });
