import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace, textOnBackground,
  titleSafeBox, type WordGlyph,
} from "../shared";

/**
 * T74 Jitter Settle (顫抖平息), MOOD, shown on the accent plate: the word shivers
 * and calms down.
 * - Shake 0.0–1.0 s: every character takes a new seeded pose every 2 frames (15 poses
 *   a second, fps independent): an offset up to ±6% of the glyph size and a rotation
 *   up to ±10°, about its own ink centre. The amplitude decays exponentially (time
 *   constant 0.25 s), renormalised so it reaches exactly zero at 1.0 s:
 *   a(t) = (e^(−t/0.25) − e^(−4)) / (1 − e^(−4)).
 * - Still 1.0–1.6 s, then the next shake starts abruptly (the loop).
 * A seamless 1.6 s loop (catalog loopSeconds): the pose index and the decay are
 * functions of the loop phase, and the word is perfectly still at the seam's end.
 *
 * Colours: ink and the deep gold on the gold card (ART_DIRECTION §0: the catalog's
 * cream reads at 1.4:1 on gold); cream and gold on the dark card. The word is
 * hero-sized (heroTextBox, tight displayTracking) with room for the largest pose, so
 * every glyph stays inside the 5% title-safe box. The jitter is per character and
 * well under 2% of the frame. Energy scales the jitter, never the timing.
 */

const ID = "T74";
const REVISION = 1;
export const T74_LOOP_SECONDS = 1.6;
/** Shake window and decay time constant (s), poses per second, offset (× glyph size) and rotation (degrees) at full amplitude. */
export const T74_SHAKE = 1.0, T74_TAU = 0.25, T74_POSES_PER_SECOND = 15, T74_OFFSET = 0.06, T74_ROTATION = 10;
const LINE_HEIGHT = 1.08;

export interface JitterGlyph extends WordGlyph {
  readonly color: string;
}

export interface JitterPlan {
  readonly glyphs: readonly JitterGlyph[];
  readonly glyphHeight: number;
  readonly amplitude: number;
  readonly box: GlyphBox;
}

export function jitterPlan(params: TextMotionParams, size: MotionFrameSize): JitterPlan {
  const safe = titleSafeBox(size);
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  // Headroom for the largest pose: a 6% shift on each side and the corners a 10° turn sweeps out.
  const headroom = 1 + 2 * T74_OFFSET * amplitude + 0.18 * Math.sin((T74_ROTATION * amplitude * Math.PI) / 180);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  return {
    glyphs: glyphs.map((glyph, index) => ({ ...glyph, color: index % 2 === 0 ? first : second })), glyphHeight, amplitude,
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

/** Shake envelope at loop time u: exponential decay renormalised to hit exactly 0 at 1.0 s; 0 after. */
export function jitterEnvelope(u: number): number {
  if (u < 0 || u >= T74_SHAKE) return 0;
  const floor = Math.exp(-T74_SHAKE / T74_TAU);
  return (Math.exp(-u / T74_TAU) - floor) / (1 - floor);
}

/** Pose index at loop time u (a new pose every 2 frames at 30 fps, whatever the project fps). */
export function jitterPoseIndex(u: number): number {
  return Math.floor(u * T74_POSES_PER_SECOND + 1e-6);
}

export interface JitterPose { readonly dx: number; readonly dy: number; readonly rotation: number }

/** The pose of glyph `index` at loop time u: a seeded offset and rotation, times the decay envelope. */
export function jitterPose(plan: JitterPlan, seed: number, index: number, u: number): JitterPose {
  const envelope = jitterEnvelope(u) * plan.amplitude;
  if (envelope <= 0) return { dx: 0, dy: 0, rotation: 0 };
  const rng = createSeededRng(ID, seed, `pose:${index}:${jitterPoseIndex(u)}`);
  const offset = T74_OFFSET * plan.glyphHeight * envelope;
  return { dx: rng.range(-offset, offset), dy: rng.range(-offset, offset), rotation: rng.range(-T74_ROTATION, T74_ROTATION) * envelope };
}

export const T74_jitterSettle = defineTextMotion(ID, (params, t, size) => {
  const plan = jitterPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T74_LOOP_SECONDS) * T74_LOOP_SECONDS;
  const parts = plan.glyphs.map(glyph => {
    const pose = jitterPose(plan, params.seed, glyph.index, u);
    const still = pose.dx === 0 && pose.dy === 0 && pose.rotation === 0;
    return path(glyph.pathD, {
      fill: glyph.color,
      transform: still ? tf.translate(glyph.x, glyph.y)
        : transform(tf.translate(glyph.cx + pose.dx, glyph.cy + pose.dy), tf.rotate(pose.rotation), tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
