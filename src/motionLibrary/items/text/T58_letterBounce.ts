import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type MotionPalette, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, displayTracking, heroTextBox, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace,
  textOnBackground, titleSafeBox, type WordGlyph,
} from "../shared";

/**
 * T58 Letter Bounce (跳跳字), PHYSICS, shown on the accent plate: one character at
 * a time crouches, hops and lands, left to right, then the word rests.
 * - Take-off: a 0.1 s crouch (scaleX 1.08, scaleY 0.9 about the glyph's foot, held
 *   for about 2 frames at 30 fps) springs the character up.
 * - Flight: 0.32 s on a gravity parabola (rise eases out, fall eases in: constant
 *   acceleration), 45% of the glyph height at the apex, stretched to scaleY 1.05 at
 *   the top (scaleX narrows to keep the volume).
 * - Landing: the same 0.1 s squash as it hits the line, then still.
 * Hops start 0.16 s apart, so two characters are in the air at once, a ripple
 * across the word; long lines tighten the spacing so the last landing still leaves
 * at least 0.3 s of rest. 「・」 and other separators stay still. A seamless 1.6 s
 * loop (catalog loopSeconds): every character is at rest at t = 0 and at 1.6 s, and
 * the pose is a function of the loop phase.
 *
 * Colours: on the violet card the characters alternate ink and cream, as in the
 * reference; elsewhere the readable text role and the §0 second tone (cream and
 * violet on the dark card). The word is hero-sized (heroTextBox, tight
 * displayTracking) and the hop envelope (word + apex + stretch) is centred in the
 * title-safe box, so every glyph stays inside it in every pose. Energy scales the hop
 * height and the squash; the timing never changes.
 */

const ID = "T58";
const REVISION = 1;
export const T58_LOOP_SECONDS = 1.6;
/** Hop height (× glyph height), flight time, hop spacing, crouch / landing window (s). */
export const T58_HOP_HEIGHT = 0.45, T58_FLIGHT = 0.32, T58_SPACING = 0.16, T58_SQUASH_SECONDS = 0.1;
/** Squash pose (scaleX, scaleY) and the stretch at the apex (scaleY). */
export const T58_SQUASH_X = 1.08, T58_SQUASH_Y = 0.9, T58_STRETCH_Y = 1.05;
/** First take-off, and the least rest after the last landing (s). */
export const T58_START = 0.04, T58_MIN_REST = 0.3;
const LINE_HEIGHT = 1.08;

// ---------------------------------------------------------------------------
// Tone pair shared with T62 (placeWordGlyphs, once here, now lives in items/shared.ts)
// ---------------------------------------------------------------------------

/**
 * The two alternating tones of a per-character item: on the accent card the reference pair ink and cream (T58),
 * elsewhere the readable text role and the §0 second tone.
 */
export function inkCreamOnAccent(palette: MotionPalette, backdrop: string): readonly [string, string] {
  const first = textOnBackground(palette, backdrop);
  if (backdropTone(palette, backdrop) === "accent") return [first, first === palette.ink ? palette.paper : palette.ink];
  return [first, secondaryTone(palette, backdrop)];
}

// ---------------------------------------------------------------------------
// T58
// ---------------------------------------------------------------------------

export interface BounceGlyph extends WordGlyph {
  readonly color: string;
  /** Hop order among the hopping characters (−1 for a still separator). */
  readonly hop: number;
}

export interface LetterBouncePlan {
  readonly glyphs: readonly BounceGlyph[];
  readonly glyphHeight: number;
  /** Apex height in px (energy applied) and the squash / stretch depth multiplier. */
  readonly hopHeight: number;
  readonly amplitude: number;
  /** Seconds between take-offs. */
  readonly spacing: number;
  /** Ink box of the word at rest (frame px). */
  readonly box: GlyphBox;
}

/** Seconds one hop takes: crouch, flight, landing. */
export const T58_HOP_TOTAL = T58_SQUASH_SECONDS + T58_FLIGHT + T58_SQUASH_SECONDS;

export function letterBouncePlan(params: TextMotionParams, size: MotionFrameSize): LetterBouncePlan {
  const safe = titleSafeBox(size), hero = heroTextBox(size);
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  // Upward reach above the word: the apex plus the stretch at the top (both in glyph heights ≤ block heights).
  const reach = T58_HOP_HEIGHT * amplitude + (T58_STRETCH_Y - 1) * amplitude;
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    maxWidth: hero.maxWidth / (1 + (T58_SQUASH_X - 1) * amplitude * 0.5), maxHeight: Math.min(hero.maxHeight, (0.96 * safe.height) / (1 + reach)),
    maxSize: hero.maxSize, lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const probe = placeWordGlyphs(text, 0, 0);
  const reachPx = reach * probe.glyphHeight;
  // Centre the motion envelope (the word plus the hop above it) in the safe box.
  const dx = safe.cx - text.inkCenter[0];
  const dy = safe.cy + reachPx / 2 - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const [first, second] = inkCreamOnAccent(params.palette, textBackdrop(params));
  let hop = 0, colorIndex = 0;
  const bounce: BounceGlyph[] = glyphs.map(glyph => {
    if (glyph.separator) return { ...glyph, color: first, hop: -1 };
    const color = colorIndex++ % 2 === 0 ? first : second;
    return { ...glyph, color, hop: hop++ };
  });
  const free = T58_LOOP_SECONDS - T58_MIN_REST - T58_START - T58_HOP_TOTAL;
  const spacing = hop > 1 ? Math.min(T58_SPACING, free / (hop - 1)) : T58_SPACING;
  return {
    glyphs: bounce, glyphHeight, hopHeight: T58_HOP_HEIGHT * glyphHeight * amplitude, amplitude, spacing,
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

export interface BouncePose {
  /** Lift above the rest position (px, positive = up). */
  readonly lift: number;
  /** Scale about the glyph's foot (ink bottom centre). */
  readonly scaleX: number;
  readonly scaleY: number;
}

const REST: BouncePose = Object.freeze({ lift: 0, scaleX: 1, scaleY: 1 });

/** A 0.1 s squash window held near its peak for about two frames: sqrt(sin πp). */
function squashWindow(p: number): number {
  return Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, p)))));
}

/** The pose of the `hop`-th hopping character at loop time u (seconds in 0..1.6). */
export function bouncePose(plan: LetterBouncePlan, hop: number, u: number): BouncePose {
  if (hop < 0) return REST;
  const local = u - (T58_START + hop * plan.spacing);
  if (local <= 0 || local >= T58_HOP_TOTAL) return REST;
  const a = plan.amplitude;
  const squash = (p: number): BouncePose => {
    const k = squashWindow(p) * a;
    return { lift: 0, scaleX: 1 + (T58_SQUASH_X - 1) * k, scaleY: 1 - (1 - T58_SQUASH_Y) * k };
  };
  if (local < T58_SQUASH_SECONDS) return squash(local / T58_SQUASH_SECONDS);
  const flight = local - T58_SQUASH_SECONDS;
  if (flight < T58_FLIGHT) {
    const p = flight / T58_FLIGHT;
    // Ballistic: a parabola in linear time is constant gravity (decelerating up, accelerating down).
    const lift = plan.hopHeight * 4 * p * (1 - p);
    const stretch = (T58_STRETCH_Y - 1) * a * Math.sin(Math.PI * p);
    return { lift, scaleX: 1 / Math.sqrt(1 + stretch), scaleY: 1 + stretch };
  }
  return squash((flight - T58_FLIGHT) / T58_SQUASH_SECONDS);
}

export const T58_letterBounce = defineTextMotion(ID, (params, t, size) => {
  const plan = letterBouncePlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T58_LOOP_SECONDS) * T58_LOOP_SECONDS;
  const parts = plan.glyphs.map(glyph => {
    const pose = bouncePose(plan, glyph.hop, u);
    const footX = glyph.cx, footY = glyph.box.y1;
    const moved = pose.lift !== 0 || pose.scaleX !== 1 || pose.scaleY !== 1;
    return path(glyph.pathD, {
      fill: glyph.color,
      transform: moved
        ? transform(tf.translate(footX, footY - pose.lift), tf.scale(pose.scaleX, pose.scaleY), tf.translate(glyph.x - footX, glyph.y - footY))
        : tf.translate(glyph.x, glyph.y),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
