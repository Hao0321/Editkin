import { g, path, tf, transform } from "../../svg/document";
import { clamp01, expoIn, expoOut, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace,
  textOnBackground, titleSafeBox, type WordGlyph,
} from "../shared";
import { scatterOffsets, scatterPose, type ScatterOffset } from "./scatter";

/**
 * T77 Letter Assemble (文字集合), MOOD, on the dark card: the characters gather
 * from all around into the word, hold, and scatter again.
 * - In 0.0–0.6 s: one after another, 0.05 s apart, each character flies home from a
 *   seeded scattered position within half a frame (the scatter helper's "field" mode,
 *   at least a fifth of the short side away), starting turned up to ±60° and at scale
 *   0.6–1.4, on an expoOut curve (most of the way in the first frames, then a soft
 *   landing), fading in over the first 40% of its flight.
 * - Hold 0.6–1.6 s (it grows with longer clips).
 * - Out 1.6–2.1 s: each character, 0.05 s apart, leaves for a new seeded position
 *   (a second field scatter) on expoIn, spinning 90–200° and fading over the second
 *   half; the last 0.3 s are empty.
 * Colours alternate cream and gold (ART_DIRECTION §0 dark card; ink and the deep
 * gold on a gold card). The word is hero-sized (heroTextBox, tight displayTracking)
 * inside the 5% title-safe box at the hold; the flights may cross the frame edges.
 * Times are standard-energy seconds, scaled by energy and squeezed into short clips
 * (itemTiming); energy also scales the scatter distance.
 */

const ID = "T77";
const REVISION = 1;
/** Standard-energy seconds: assembly window, stagger, leave start (from the end), leave window, empty tail. */
export const T77_IN = 0.6, T77_STAGGER = 0.05, T77_OUT = 0.5, T77_TAIL = 0.3, T77_MIN_HOLD = 0.3;
const NATURAL_SECONDS = T77_IN + T77_MIN_HOLD + T77_OUT + T77_TAIL;
/** Scatter: distance range (× short side), in-rotation (degrees), in-scale, out-spin (degrees), out-scale. */
export const T77_DISTANCE: readonly [number, number] = [0.2, 0.5], T77_IN_ROTATION = 60, T77_IN_SCALE: readonly [number, number] = [0.6, 1.4];
export const T77_OUT_SPIN: readonly [number, number] = [90, 200], T77_OUT_SCALE: readonly [number, number] = [0.7, 1.3];
const LINE_HEIGHT = 1.08;

export interface AssembleGlyph extends WordGlyph {
  readonly color: string;
  readonly from: ScatterOffset;
  readonly to: ScatterOffset;
}

export interface AssemblePlan {
  readonly glyphs: readonly AssembleGlyph[];
  readonly glyphHeight: number;
  readonly box: GlyphBox;
  /** Per-character flight time in and out, stagger, out start and end (s, energy applied). */
  readonly flightIn: number;
  readonly flightOut: number;
  readonly stagger: number;
  readonly outStart: number;
  readonly outEnd: number;
}

export function assemblePlan(params: TextMotionParams, size: MotionFrameSize): AssemblePlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), { ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines) });
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const { glyphs, glyphHeight } = placeWordGlyphs(text, dx, dy);
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const reach = Math.min(1.4, energy.amplitude);
  const targets = glyphs.map(glyph => ({ x: glyph.cx, y: glyph.cy }));
  const distance: readonly [number, number] = [T77_DISTANCE[0] * short * reach, T77_DISTANCE[1] * short * reach];
  const from = scatterOffsets(targets, { mode: "field", itemId: ID, seed: params.seed, stream: "in", frame: size, distance,
    rotation: [0, T77_IN_ROTATION], scale: T77_IN_SCALE });
  const to = scatterOffsets(targets, { mode: "field", itemId: ID, seed: params.seed, stream: "out", frame: size, distance,
    rotation: T77_OUT_SPIN, scale: T77_OUT_SCALE });
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  const n = glyphs.length, stagger = T77_STAGGER * timeScale;
  const outEnd = params.durationSeconds - T77_TAIL * timeScale, outStart = outEnd - T77_OUT * timeScale;
  return {
    glyphs: glyphs.map((glyph, index) => ({ ...glyph, color: index % 2 === 0 ? first : second, from: from[index], to: to[index] })), glyphHeight,
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
    flightIn: Math.max(0.1 * timeScale, T77_IN * timeScale - stagger * (n - 1)),
    flightOut: Math.max(0.1 * timeScale, T77_OUT * timeScale - stagger * (n - 1)),
    stagger, outStart, outEnd,
  };
}

export interface AssemblePose {
  readonly dx: number;
  readonly dy: number;
  readonly rotation: number;
  readonly scale: number;
  readonly opacity: number;
}

const HOME: AssemblePose = Object.freeze({ dx: 0, dy: 0, rotation: 0, scale: 1, opacity: 1 });

/** Pose of a character at time t (null when it is not drawn). */
export function assemblePose(plan: AssemblePlan, glyph: AssembleGlyph, t: number): AssemblePose | null {
  const inStart = glyph.index * plan.stagger;
  if (t < inStart) return null;
  const pIn = (t - inStart) / plan.flightIn;
  if (pIn < 1) {
    const pose = scatterPose(glyph.from, expoOut(pIn));
    return { ...pose, opacity: smoothstep(0, 0.4, pIn) };
  }
  const outStart = plan.outStart + glyph.index * plan.stagger;
  if (t < outStart) return HOME;
  const pOut = (t - outStart) / plan.flightOut;
  if (pOut >= 1) return null;
  const pose = scatterPose(glyph.to, 1 - expoIn(clamp01(pOut)));
  return { ...pose, opacity: 1 - smoothstep(0.5, 1, pOut) };
}

export const T77_letterAssemble = defineTextMotion(ID, (params, t, size) => {
  const plan = assemblePlan(params, size);
  const doc = createTextDocument(size, params);
  const parts = plan.glyphs.map(glyph => {
    const pose = assemblePose(plan, glyph, t);
    if (!pose || pose.opacity <= 0.004 || pose.scale <= 0.01) return "";
    if (pose === HOME) return path(glyph.pathD, { fill: glyph.color, transform: tf.translate(glyph.x, glyph.y) });
    return path(glyph.pathD, {
      fill: glyph.color, opacity: pose.opacity < 1 ? Number(pose.opacity.toFixed(3)) : undefined,
      transform: transform(tf.translate(glyph.cx + pose.dx, glyph.cy + pose.dy), tf.rotate(pose.rotation), tf.scale(pose.scale),
        tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
