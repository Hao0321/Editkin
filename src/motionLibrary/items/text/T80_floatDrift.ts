import { mixHex } from "../../svg/color";
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
 * T80 Float Drift (輕飄浮動), MOOD, on the dark card: the characters float as if
 * weightless. Each one drifts on its own slow Lissajous path, x ±2.5% and y ±5% of
 * the glyph size with periods 3 s and 2 s and seeded phases, turns gently (±4°,
 * period 3 s), breathes between 92% and 100% opacity (period 3 s; r2, Claude's p2k
 * review: at 75% the cream went grey and muddy on the dark card) and cross-fades
 * between cream and gold on its own phase (period 6 s), so the word shimmers softly
 * without ever going still. Every period divides 6 s: a seamless 6 s loop (catalog
 * loopSeconds).
 *
 * Colours: the readable text role and the §0 second tone (cream ↔ gold on the dark
 * card; ink ↔ the deep gold on cream or gold); the blend between two light tones
 * stays clean. The word is hero-sized (heroTextBox; displayTracking opened by exactly the
 * room the drift and turn need, so neighbours never touch), inside the 5% title-safe box
 * at every phase. Energy scales the drift
 * and the turn, never the periods.
 */

const ID = "T80";
const REVISION = 2;
export const T80_LOOP_SECONDS = 6;
/** Drift amplitudes (× glyph size), periods (s), turn (degrees) and its period, opacity range, colour period. */
export const T80_DRIFT_X = 0.025, T80_DRIFT_Y = 0.05, T80_PERIOD_X = 3, T80_PERIOD_Y = 2, T80_TURN = 4, T80_PERIOD_TURN = 3;
export const T80_OPACITY: readonly [number, number] = [0.92, 1], T80_PERIOD_OPACITY = 3, T80_PERIOD_COLOR = 6;
const LINE_HEIGHT = 1.08;

/**
 * Tracking (em) for the drifting word: the tight display tracking plus exactly the room two
 * neighbours can close between them. Both drift toward each other (2 × the x drift) and both
 * turn, which swings a box corner out by at most ½·sin(turn) of the glyph height each, so a
 * float never bumps one character into the next (a 1% hair of air on top).
 */
export function floatTracking(lines: readonly string[], amplitude: number): number {
  return displayTracking(lines) + 2 * T80_DRIFT_X * amplitude + Math.sin((T80_TURN * amplitude * Math.PI) / 180) + 0.01;
}

export interface FloatGlyph extends WordGlyph {
  /** Seeded phases (rad): x, y, turn, opacity, colour. */
  readonly phases: readonly [number, number, number, number, number];
}

export interface FloatPlan {
  readonly glyphs: readonly FloatGlyph[];
  readonly glyphHeight: number;
  readonly amplitude: number;
  readonly first: string;
  readonly second: string;
  readonly box: GlyphBox;
}

export function floatPlan(params: TextMotionParams, size: MotionFrameSize): FloatPlan {
  const safe = titleSafeBox(size);
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  const headroom = 1 + 2 * T80_DRIFT_Y * amplitude + 0.12 * Math.sin((T80_TURN * amplitude * Math.PI) / 180);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom }), lineHeight: LINE_HEIGHT, tracking: floatTracking(params.lines, amplitude),
  });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const rng = createSeededRng(ID, params.seed, "phases");
  const backdrop = textBackdrop(params);
  return {
    glyphs: glyphs.map((glyph, index) => {
      const r = rng.fork(index), turn = () => r.range(0, 2 * Math.PI);
      return { ...glyph, phases: [turn(), turn(), turn(), turn(), turn()] as const };
    }),
    glyphHeight, amplitude, first: textOnBackground(params.palette, backdrop), second: secondaryTone(params.palette, backdrop),
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
  };
}

export interface FloatPose {
  readonly dx: number;
  readonly dy: number;
  readonly rotation: number;
  readonly opacity: number;
  /** 0 = the text colour … 1 = the second tone. */
  readonly tone: number;
}

/** Pose of a glyph at time t (seconds within the 6 s loop). */
export function floatPose(plan: FloatPlan, glyph: FloatGlyph, t: number): FloatPose {
  const wave = (period: number, phase: number) => Math.sin((2 * Math.PI * t) / period + phase);
  const [px, py, pr, po, pc] = glyph.phases, a = plan.amplitude;
  return {
    dx: T80_DRIFT_X * plan.glyphHeight * a * wave(T80_PERIOD_X, px),
    dy: T80_DRIFT_Y * plan.glyphHeight * a * wave(T80_PERIOD_Y, py),
    rotation: T80_TURN * a * wave(T80_PERIOD_TURN, pr),
    opacity: T80_OPACITY[0] + (T80_OPACITY[1] - T80_OPACITY[0]) * (0.5 + 0.5 * wave(T80_PERIOD_OPACITY, po)),
    tone: 0.5 + 0.5 * wave(T80_PERIOD_COLOR, pc),
  };
}

export const T80_floatDrift = defineTextMotion(ID, (params, t, size) => {
  const plan = floatPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T80_LOOP_SECONDS) * T80_LOOP_SECONDS;
  const parts = plan.glyphs.map(glyph => {
    const pose = floatPose(plan, glyph, u);
    return path(glyph.pathD, {
      fill: mixHex(plan.first, plan.second, pose.tone), opacity: Number(pose.opacity.toFixed(3)),
      transform: transform(tf.translate(glyph.cx + pose.dx, glyph.cy + pose.dy), tf.rotate(pose.rotation), tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
