import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase, quadIn, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace, textOnBackground,
  titleSafeBox, type WordGlyph,
} from "../shared";

/**
 * T60 Gravity Flip (重力反轉), PHYSICS, on the dark card: gravity turns upside
 * down and the word falls up out of the frame, then gravity returns and it drops
 * back. A seamless 2.2 s loop (catalog loopSeconds):
 * - Rest 0.0–0.5 s.
 * - Fall upward from 0.5 s: one character after another, 0.07 s apart, accelerates
 *   up under constant (inverted) gravity, a quadIn ramp, tilting to a seeded ±10–20°
 *   as it goes, and leaves through the top of the frame; the last one is gone by 1.0 s.
 * - Empty 1.0–1.2 s.
 * - Return from 1.2 s: they drop back from above in the same order, 0.07 s apart,
 *   falling under gravity (quadIn) while the tilt rights itself (1 − p^2.5), and hit
 *   their slot by 1.8 s. The landing is a damped spring: the character dips 8% of
 *   the glyph height below its rest line, squashing a little about its foot, rebounds
 *   and settles, exactly still within 0.38 s, well before the loop closes.
 * Long lines tighten the stagger so these windows always hold.
 *
 * Colours alternate cream and violet on the dark card (ART_DIRECTION §0 and the
 * reference); on the accent or cream card the readable text role and the §0 second
 * tone. The word is hero-sized (heroTextBox, tight displayTracking) and sits inside
 * the 5% title-safe box at rest, with room for the landing dip. Energy scales the
 * tilt and the bounce depth; the timing never changes.
 */

const ID = "T60";
const REVISION = 1;
export const T60_LOOP_SECONDS = 2.2;
/** Windows (s): rest ends, last exit gone, return starts, last landing. */
export const T60_LIFT = 0.5, T60_GONE = 1.0, T60_RETURN = 1.2, T60_LANDED = 1.8;
/** Character stagger (s), the shortest fall (s), tilt range (degrees). */
export const T60_STAGGER = 0.07, T60_MIN_FALL = 0.24, T60_TILT: readonly [number, number] = [10, 20];
/** Landing spring: dip (× glyph height), period, damping ratio, settle time (s); squash per unit of dip. */
export const T60_DIP = 0.08, T60_BOUNCE_PERIOD = 0.26, T60_BOUNCE_DAMPING = 0.32, T60_SETTLE = 0.38, T60_SQUASH = 0.6;
const LINE_HEIGHT = 1.08;

export interface GravityGlyph extends WordGlyph {
  readonly color: string;
  /** Seeded tilt (degrees, signed) on the way out, and on the way back in. */
  readonly tiltOut: number;
  readonly tiltIn: number;
  /** Rise that takes the glyph clear of the top edge (px). */
  readonly travel: number;
}

export interface GravityFlipPlan {
  readonly glyphs: readonly GravityGlyph[];
  readonly glyphHeight: number;
  readonly stagger: number;
  /** Exit and return fall durations (s). */
  readonly fallOut: number;
  readonly fallIn: number;
  /** Landing dip in px (energy applied). */
  readonly dip: number;
  readonly amplitude: number;
  readonly box: GlyphBox;
}

export function gravityFlipPlan(params: TextMotionParams, size: MotionFrameSize): GravityFlipPlan {
  const safe = titleSafeBox(size), hero = heroTextBox(size);
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  const dipShare = T60_DIP * amplitude;
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    maxWidth: hero.maxWidth / (1 + T60_SQUASH * dipShare), maxHeight: Math.min(hero.maxHeight, (0.96 * safe.height) / (1 + 2 * dipShare)),
    maxSize: hero.maxSize, lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  const rng = createSeededRng(ID, params.seed, "tilt");
  const n = glyphs.length;
  const stagger = n > 1 ? Math.min(T60_STAGGER, (T60_GONE - T60_LIFT - T60_MIN_FALL) / (n - 1)) : T60_STAGGER;
  const placed: GravityGlyph[] = glyphs.map((glyph, index) => {
    const r = rng.fork(index), sign = r.sign();
    const tiltOut = sign * r.range(T60_TILT[0], T60_TILT[1]) * amplitude;
    const tiltIn = -sign * r.range(T60_TILT[0], T60_TILT[1]) * amplitude;
    // Clear of the top edge with the glyph turned: its half-diagonal above the ink centre.
    const halfDiagonal = Math.hypot(glyph.box.x1 - glyph.box.x0, glyph.box.y1 - glyph.box.y0) / 2;
    return { ...glyph, color: index % 2 === 0 ? first : second, tiltOut, tiltIn, travel: glyph.cy + halfDiagonal + 0.04 * glyphHeight };
  });
  return {
    glyphs: placed, glyphHeight, stagger,
    fallOut: T60_GONE - T60_LIFT - stagger * (n - 1), fallIn: T60_LANDED - T60_RETURN - stagger * (n - 1),
    dip: dipShare * glyphHeight, amplitude,
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

/** Peak of e^(−ζωτ)·sin(ω_d τ): the landing curve is normalized so its first dip equals the requested depth. */
const BOUNCE = (() => {
  const omegaD = (2 * Math.PI) / T60_BOUNCE_PERIOD, zeta = T60_BOUNCE_DAMPING;
  const omega = omegaD / Math.sqrt(1 - zeta * zeta), decay = zeta * omega;
  const peakAt = Math.atan(omegaD / decay) / omegaD;
  return { omegaD, decay, peak: Math.exp(-decay * peakAt) * Math.sin(omegaD * peakAt) };
})();

/** Landing offset (fraction of the dip, positive = below the rest line) τ seconds after contact; exactly 0 from T60_SETTLE on. */
export function landingBounce(tau: number): number {
  if (tau <= 0 || tau >= T60_SETTLE) return 0;
  const raw = (Math.exp(-BOUNCE.decay * tau) * Math.sin(BOUNCE.omegaD * tau)) / BOUNCE.peak;
  return raw * (1 - smoothstep(0.6 * T60_SETTLE, T60_SETTLE, tau));
}

export interface GravityPose {
  /** Vertical offset from rest (px, positive = down) and clockwise tilt about the ink centre. */
  readonly dy: number;
  readonly rotation: number;
  /** Squash about the foot (1 = none). */
  readonly scaleX: number;
  readonly scaleY: number;
  /** False while the glyph is off-frame (not drawn). */
  readonly visible: boolean;
}

const AT_REST: GravityPose = Object.freeze({ dy: 0, rotation: 0, scaleX: 1, scaleY: 1, visible: true });
const GONE: GravityPose = Object.freeze({ dy: 0, rotation: 0, scaleX: 1, scaleY: 1, visible: false });

/** The pose of glyph `index` at loop time u (seconds in 0..2.2). */
export function gravityPose(plan: GravityFlipPlan, glyph: GravityGlyph, u: number): GravityPose {
  const lift = T60_LIFT + glyph.index * plan.stagger;
  if (u < lift) return AT_REST;
  if (u < lift + plan.fallOut) {
    const p = (u - lift) / plan.fallOut;
    // Inverted gravity: constant acceleration up, the tilt building as it goes.
    return { dy: -glyph.travel * quadIn(p), rotation: glyph.tiltOut * p ** 1.5, scaleX: 1, scaleY: 1, visible: true };
  }
  const drop = T60_RETURN + glyph.index * plan.stagger;
  if (u < drop) return GONE;
  const contact = drop + plan.fallIn;
  if (u < contact) {
    const p = (u - drop) / plan.fallIn;
    // The tilt rights itself late in the fall (1 − p^2.5), so it is still visible once the glyph is in frame.
    return { dy: -glyph.travel * (1 - quadIn(p)), rotation: glyph.tiltIn * (1 - p ** 2.5), scaleX: 1, scaleY: 1, visible: true };
  }
  const offset = landingBounce(u - contact) * plan.dip;
  if (offset === 0) return AT_REST;
  const squash = (T60_SQUASH * Math.max(0, offset)) / plan.glyphHeight;
  return { dy: offset, rotation: 0, scaleX: 1 + squash * 0.6, scaleY: 1 - squash, visible: true };
}

export const T60_gravityFlip = defineTextMotion(ID, (params, t, size) => {
  const plan = gravityFlipPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T60_LOOP_SECONDS) * T60_LOOP_SECONDS;
  const parts = plan.glyphs.map(glyph => {
    const pose = gravityPose(plan, glyph, u);
    if (!pose.visible) return "";
    if (pose === AT_REST) return path(glyph.pathD, { fill: glyph.color, transform: tf.translate(glyph.x, glyph.y) });
    const footY = glyph.box.y1;
    const squashed = pose.scaleX !== 1 || pose.scaleY !== 1;
    return path(glyph.pathD, {
      fill: glyph.color,
      transform: squashed
        ? transform(tf.translate(glyph.cx, footY + pose.dy), tf.scale(pose.scaleX, pose.scaleY), tf.translate(glyph.x - glyph.cx, glyph.y - footY))
        : transform(tf.translate(glyph.cx, glyph.cy + pose.dy), tf.rotate(pose.rotation), tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
