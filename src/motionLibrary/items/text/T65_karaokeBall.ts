import { ellipse, g, path, rect, tf } from "../../svg/document";
import { backOut, clamp01, quadIn } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace, textOnBackground,
  titleSafeBox, type WordGlyph,
} from "../shared";

/**
 * T65 Karaoke Ball (卡拉OK跳球), RHYTHM, on the dark card: the line waits in grey
 * (the text colour at 40%) and a ball (22% of the glyph height across) bounces
 * along its top, one landing per character, while each character fills with the
 * accent in a left-to-right wipe, like a lyric being sung.
 * - Beat: per-character time c = (clip duration − 0.6 s) ÷ the number of characters.
 *   The ball lands on character i's top centre at exactly 0.3 + i·c s, and character i
 *   wipes linearly from its left edge to its right over [0.3 + i·c, 0.3 + (i + 1)·c].
 *   Landings are exact fractions of the clip, ready to sit on a beat grid.
 * - Ball: it pops in above the first character (backOut, 0.1 s) and drops onto it
 *   under gravity by 0.3 s; each hop is a parabola in linear time (constant gravity)
 *   with its apex 40% of the glyph height above the cap line; it squashes for about two
 *   frames on every landing. On the last character it bounces once in place, lands
 *   as the wipe completes and rests 0.3 s while the coloured line holds.
 * Separators (「・」 …) are skipped by the ball and fill with their neighbour.
 *
 * Colours: grey = the readable text role at 40%; the fill and the ball take the §0
 * second tone (teal on the dark card, deep teal on the teal card). The line is
 * hero-sized (heroTextBox, tight displayTracking) and the bounce envelope (apex +
 * ball + line) is centred in the title-safe box. The beat follows the clip length,
 * not the energy (a later lyric mode can take caption timestamps).
 */

const ID = "T65";
const REVISION = 1;
/** Lead-in before the first landing and the rest after the last (s). */
export const T65_LEAD = 0.3, T65_REST = 0.3;
/** Ball diameter and apex above the cap line (× glyph height), grey opacity, ball pop-in (s). */
export const T65_BALL = 0.22, T65_APEX = 0.4, T65_GREY = 0.4, T65_POP = 0.1;
/** Landing squash: window (s) and depth (scaleY at the peak; scaleX widens by half as much). */
export const T65_SQUASH_SECONDS = 0.08, T65_SQUASH = 0.72;
const LINE_HEIGHT = 1.3;

export interface KaraokeGlyph extends WordGlyph {
  /** Beat index of the character (separators share their previous neighbour's beat). */
  readonly beat: number;
}

export interface KaraokeBallPlan {
  readonly glyphs: readonly KaraokeGlyph[];
  /** Landing spots (ball centre, frame px), one per beat. */
  readonly spots: readonly (readonly [number, number])[];
  readonly glyphHeight: number;
  readonly radius: number;
  /** Ball centre height at the apex of a hop (frame px). */
  readonly apexY: number;
  /** Seconds per character and the number of beats. */
  readonly beatSeconds: number;
  readonly beats: number;
  readonly greyColor: string;
  readonly fillColor: string;
  readonly box: GlyphBox;
}

export function karaokeBallPlan(params: TextMotionParams, size: MotionFrameSize): KaraokeBallPlan {
  const safe = titleSafeBox(size), hero = heroTextBox(size);
  const reach = T65_APEX + T65_BALL;
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    maxWidth: hero.maxWidth, maxHeight: Math.min(hero.maxHeight, (0.96 * safe.height) / (1 + reach)), maxSize: hero.maxSize,
    lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const probe = placeWordGlyphs(text, 0, 0);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy + (reach * probe.glyphHeight) / 2 - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const radius = (T65_BALL * glyphHeight) / 2;
  let beat = -1;
  const placed: KaraokeGlyph[] = glyphs.map(glyph => {
    if (!glyph.separator || beat < 0) beat += 1;
    return { ...glyph, beat };
  });
  const beats = beat + 1;
  const spots = Array.from({ length: beats }, (_, index) => {
    const glyph = placed.find(entry => entry.beat === index && !entry.separator) ?? placed.find(entry => entry.beat === index)!;
    return [glyph.cx, glyph.box.y0 - radius - 0.02 * glyphHeight] as const;
  });
  const capTop = Math.min(...placed.filter(glyph => glyph.line === 0).map(glyph => glyph.box.y0));
  const backdrop = textBackdrop(params);
  return {
    glyphs: placed, spots, glyphHeight, radius, apexY: capTop - T65_APEX * glyphHeight - radius,
    beatSeconds: Math.max(0.05, (params.durationSeconds - T65_LEAD - T65_REST) / Math.max(1, beats)), beats,
    greyColor: textOnBackground(params.palette, backdrop), fillColor: secondaryTone(params.palette, backdrop),
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

/** Landing time of beat i (s); beat `beats` is the final in-place bounce. */
export function landingTime(plan: KaraokeBallPlan, beat: number): number {
  return T65_LEAD + beat * plan.beatSeconds;
}

/** Wipe progress 0..1 of a beat at time t. */
export function wipeProgress(plan: KaraokeBallPlan, beat: number, t: number): number {
  return clamp01((t - landingTime(plan, beat)) / plan.beatSeconds);
}

export interface BallPose {
  readonly x: number;
  readonly y: number;
  /** Pop-in scale and the landing squash (about the ball's bottom). */
  readonly scale: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** A parabola from a to b whose apex reaches apexY (y-down), in linear time p (constant gravity). */
function hop(a: readonly [number, number], b: readonly [number, number], apexY: number, p: number): readonly [number, number] {
  const height = Math.max(0, Math.min(a[1], b[1]) - apexY);
  return [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p - 4 * height * p * (1 - p)];
}

export function ballPose(plan: KaraokeBallPlan, t: number): BallPose {
  const first = plan.spots[0], last = plan.spots[plan.spots.length - 1];
  const scale = backOut(clamp01(t / T65_POP));
  let position: readonly [number, number];
  let sinceLanding = Infinity;
  if (t < T65_LEAD) {
    // Pops in at the apex height above the first character and drops onto it.
    const p = clamp01(t / T65_LEAD);
    position = [first[0], plan.apexY + (first[1] - plan.apexY) * quadIn(p)];
  } else {
    const k = Math.floor((t - T65_LEAD) / plan.beatSeconds);
    if (k >= plan.beats) {
      position = last;
      sinceLanding = t - landingTime(plan, plan.beats);
    } else {
      const from = plan.spots[k], to = plan.spots[Math.min(k + 1, plan.beats - 1)];
      position = hop(from, to, plan.apexY, (t - landingTime(plan, k)) / plan.beatSeconds);
      sinceLanding = t - landingTime(plan, k);
    }
  }
  const squash = sinceLanding < T65_SQUASH_SECONDS ? Math.sqrt(Math.sin((Math.PI * sinceLanding) / T65_SQUASH_SECONDS)) * (1 - T65_SQUASH) : 0;
  return { x: position[0], y: position[1], scale, scaleX: 1 + squash / 2, scaleY: 1 - squash };
}

export const T65_karaokeBall = defineTextMotion(ID, (params, t, size) => {
  const plan = karaokeBallPlan(params, size);
  const doc = createTextDocument(size, params);
  const parts = plan.glyphs.map(glyph => {
    const at = tf.translate(glyph.x, glyph.y);
    const p = wipeProgress(plan, glyph.beat, t);
    if (p >= 1) return path(glyph.pathD, { fill: plan.fillColor, transform: at });
    const grey = path(glyph.pathD, { fill: plan.greyColor, opacity: T65_GREY, transform: at });
    if (p <= 0) return grey;
    const pad = 0.04 * plan.glyphHeight, x0 = glyph.box.x0 - pad, width = (glyph.box.x1 - glyph.box.x0 + 2 * pad) * p;
    const clip = doc.clipPath(rect(x0, glyph.box.y0 - pad, width, glyph.box.y1 - glyph.box.y0 + 2 * pad));
    // The clip is in frame px, so it sits on an untransformed group around the transformed glyph.
    return g(undefined, grey, g({ "clip-path": clip }, path(glyph.pathD, { fill: plan.fillColor, transform: at })));
  });
  const pose = ballPose(plan, t);
  const bottom = pose.y + plan.radius;
  const ball = pose.scale <= 1e-6 ? "" : ellipse(0, -plan.radius * pose.scaleY, plan.radius * pose.scaleX, plan.radius * pose.scaleY, {
    fill: plan.fillColor, transform: `${tf.translate(pose.x, bottom)} ${tf.scale(pose.scale)}`,
  });
  return doc.render(g(undefined, parts), ball);
}, { revision: REVISION });
