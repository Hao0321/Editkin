import { circle, g, line, path, tf } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, heroTextBox, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
  type WordGlyph,
} from "../shared";

/**
 * T66 Swing Letters (鐘擺字), RHYTHM, shown on the accent plate: every character
 * hangs on a short thread from a pivot 0.35 glyph heights above its top, along a
 * thin rail, and swings like a pendulum: rotation = 14°·sin(2πt/1.6 + 0.7·i), with a
 * seeded ±20% amplitude per character, so the word sways in a soft travelling wave
 * (ゆらゆら). One swing per 1.6 s, a seamless loop (catalog loopSeconds) whose
 * period is the beat: every pose is a function of the loop phase.
 *
 * The thread and pin turn with their character; the rail and pins are the text
 * colour, thin (rail 1.6%, thread 1.3% of the glyph height), so the type stays the
 * hero. Characters are letter-spaced (+0.22 em, not the tight display tracking):
 * neighbours with seeded amplitudes swing up to about 11° apart, which moves their
 * feet about 0.26 glyph heights toward each other; at −0.04 em they would collide.
 *
 * Colours (ART_DIRECTION §0, measured on this reference: black and deep teal on
 * teal): ink and the deep shade alternate on the teal card; elsewhere the readable
 * text role and the §0 second tone (cream and teal on the dark card). The word fills
 * about 85% of the title-safe width at rest (a little less at hype energy: the end
 * characters' outer feet swing out, and the fit leaves room for them), and the whole
 * swing (rail to swinging feet) stays inside the safe box. Energy scales the swing
 * amplitude, never the period.
 */

const ID = "T66";
const REVISION = 1;
export const T66_LOOP_SECONDS = 1.6;
/** Peak swing (degrees), phase step per character (rad), seeded amplitude spread, pivot height above the top (× glyph height). */
export const T66_SWING = 14, T66_PHASE_STEP = 0.7, T66_SPREAD = 0.2, T66_PIVOT = 0.35;
/** Letter spacing (em), rail and thread strokes and pin radius (× glyph height). */
export const T66_TRACKING = 0.22;
const RAIL = 0.016, THREAD = 0.013, PIN = 0.032, LINE_HEIGHT = 1.5;

export interface SwingGlyph extends WordGlyph {
  readonly color: string;
  /** Pivot (frame px) and the thread's lower end at rest (the glyph's top centre). */
  readonly pivotX: number;
  readonly pivotY: number;
  readonly threadY: number;
  /** Peak swing of this character (degrees, energy and seed applied). */
  readonly swing: number;
}

export interface SwingLettersPlan {
  readonly glyphs: readonly SwingGlyph[];
  readonly glyphHeight: number;
  /** Rails, one per line (frame px). */
  readonly rails: readonly { readonly x0: number; readonly x1: number; readonly y: number }[];
  readonly railWidth: number;
  readonly threadWidth: number;
  readonly pin: number;
  readonly lineColor: string;
  readonly box: GlyphBox;
}

export function swingLettersPlan(params: TextMotionParams, size: MotionFrameSize): SwingLettersPlan {
  const safe = titleSafeBox(size), hero = heroTextBox(size);
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  const peak = T66_SWING * (1 + T66_SPREAD) * amplitude, radians = (peak * Math.PI) / 180;
  // The swing envelope: vertically the pivot height plus the rest word; horizontally the end characters' outer bottom
  // corners swing out by e glyph heights (half width·cos + pivot distance·sin − half width), so the word is fitted to leave
  // 2e beside it: with the word k glyph heights wide, maxWidth = 0.98·safe width·k / (k + 2e), capped at the hero width.
  const face = textFace(params.font, 900);
  const probeText = layoutFittedText(params.lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: 100, lineHeight: LINE_HEIGHT, tracking: T66_TRACKING });
  const probeH = placeWordGlyphs(probeText, 0, 0).glyphHeight, k = (probeText.ink.x1 - probeText.ink.x0) / probeH;
  const excursion = Math.max(0, 0.5 * Math.cos(radians) + (1 + T66_PIVOT) * Math.sin(radians) - 0.5);
  const text = layoutFittedText(params.lines, face, {
    maxWidth: Math.min(hero.maxWidth, (0.98 * safe.width * k) / (k + 2 * excursion)),
    maxHeight: Math.min(hero.maxHeight, (0.94 * safe.height) / (1 + T66_PIVOT + PIN)),
    maxSize: hero.maxSize, lineHeight: LINE_HEIGHT, tracking: T66_TRACKING,
  });
  const probe = placeWordGlyphs(text, 0, 0);
  const lift = (T66_PIVOT + PIN) * probe.glyphHeight;
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy + lift / 2 - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  const rng = createSeededRng(ID, params.seed, "swing");
  const lineTops = new Map<number, number>();
  for (const glyph of glyphs) lineTops.set(glyph.line, Math.min(lineTops.get(glyph.line) ?? Infinity, glyph.box.y0));
  const swingGlyphs: SwingGlyph[] = glyphs.map((glyph, index) => {
    const pivotY = lineTops.get(glyph.line)! - T66_PIVOT * glyphHeight;
    return {
      ...glyph, color: index % 2 === 0 ? first : second, pivotX: glyph.cx, pivotY, threadY: glyph.box.y0,
      swing: T66_SWING * amplitude * (1 + rng.fork(index).range(-T66_SPREAD, T66_SPREAD)),
    };
  });
  const rails = [...lineTops.keys()].map(lineIndex => {
    const members = swingGlyphs.filter(glyph => glyph.line === lineIndex);
    const reach = 0.3 * glyphHeight;
    return { x0: Math.min(...members.map(glyph => glyph.pivotX)) - reach, x1: Math.max(...members.map(glyph => glyph.pivotX)) + reach, y: members[0].pivotY };
  });
  return {
    glyphs: swingGlyphs, glyphHeight, rails, railWidth: RAIL * glyphHeight, threadWidth: THREAD * glyphHeight, pin: PIN * glyphHeight,
    lineColor: first, box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

/** Swing angle (degrees, clockwise) of a character at loop phase u: swing·sin(2πu + 0.7·i). */
export function swingAngle(glyph: SwingGlyph, u: number): number {
  return glyph.swing * Math.sin(2 * Math.PI * u + T66_PHASE_STEP * glyph.index);
}

export const T66_swingLetters = defineTextMotion(ID, (params, t, size) => {
  const plan = swingLettersPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T66_LOOP_SECONDS);
  const rails = plan.rails.map(rail => line(rail.x0, rail.y, rail.x1, rail.y,
    { stroke: plan.lineColor, "stroke-width": plan.railWidth, "stroke-linecap": "round" }));
  const swinging = plan.glyphs.map(glyph => g({ transform: tf.rotate(swingAngle(glyph, u), glyph.pivotX, glyph.pivotY) },
    line(glyph.pivotX, glyph.pivotY, glyph.pivotX, glyph.threadY, { stroke: plan.lineColor, "stroke-width": plan.threadWidth }),
    path(glyph.pathD, { fill: glyph.color, transform: tf.translate(glyph.x, glyph.y) })));
  const pins = plan.glyphs.map(glyph => circle(glyph.pivotX, glyph.pivotY, plan.pin, { fill: plan.lineColor }));
  return doc.render(g(undefined, rails), g(undefined, swinging), g(undefined, pins));
}, { revision: REVISION });

