import { fe, g, path, tf } from "../../svg/document";
import { expoIn, expoOut, smoothstep } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground,
  titleSafeBox,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T69 Blur Trail (疾馳殘影), RHYTHM, on the dark card: the word dashes in from
 * beyond the left edge, holds crisp, and dashes off to the right.
 * - In 0.0–0.35 s: from fully off-frame left to the centre (expoOut: most of the
 *   distance in the first frames, then a long brake).
 * - Hold crisp 0.35–1.4 s (it grows with longer clips).
 * - Out 1.4–1.7 s: from the centre to fully off-frame right (expoIn), then the frame
 *   is empty for the last 0.3 s.
 * While it moves the word trails six echoes in the accent at 50/38/28/18/10/5%, each
 * where the word was one frame (1/30 s) earlier than the previous one, so the trail
 * stretches with speed into separate ghosts (a shorter lag stacked them into a solid
 * band) and collapses toward the word as it brakes (an echo fades out as it closes on
 * the word, so nothing stacks; the trail clears over the last quarter of the dash in,
 * so the hold is crisp from 0.35 s). A horizontal Gaussian blur proportional to
 * speed (σ = speed / 250, capped at 12 px at 1080 units, none below 0.6 px) smears the
 * word and its trail; the filter region hugs them. At the hold the word is crisp and
 * unfiltered.
 *
 * Colours (ART_DIRECTION §0): the word is the readable text role, the trail the second
 * tone (cream word, teal trail on the dark card; ink and deep teal on the teal card).
 * The word is hero-sized (heroTextBox, tight displayTracking) inside the title-safe
 * box at the hold. Times are standard-energy seconds, scaled by energy and squeezed
 * into short clips (itemTiming); energy never changes the distances.
 */

const ID = "T69";
const REVISION = 1;
/** Standard-energy seconds: dash in, dash out, empty tail; the hold takes the rest of the clip. */
export const T69_IN = 0.35, T69_OUT = 0.3, T69_TAIL = 0.3, T69_MIN_HOLD = 0.4;
const NATURAL_SECONDS = T69_IN + T69_MIN_HOLD + T69_OUT + T69_TAIL;
/** Echo opacities, echo lag (s), the distance (× glyph height) over which an echo fades in as it separates from the word. */
export const T69_ECHOES: readonly number[] = [0.5, 0.38, 0.28, 0.18, 0.1, 0.05];
export const T69_LAG = 1 / 30, T69_ECHO_FADE = 0.15;
/** Blur: σ px per px/s, cap (px at 1080 units), threshold (px). */
export const T69_BLUR_PER_SPEED = 1 / 250, T69_BLUR_MAX = 12, T69_BLUR_MIN = 0.6;
const LINE_HEIGHT = 1.08;

export interface BlurTrailPlan {
  readonly pathD: string;
  /** Pen origin offset from the ink centre (px): the word is drawn at translate(x + offsetX, cy + offsetY). */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly cx: number;
  readonly cy: number;
  /** Ink half extents (px). */
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly glyphHeight: number;
  /** Ink centre x fully off-frame left and right. */
  readonly startX: number;
  readonly endX: number;
  readonly color: string;
  readonly echoColor: string;
  readonly blurMax: number;
  /** Phase times (s, energy applied). */
  readonly inEnd: number;
  readonly outStart: number;
  readonly outEnd: number;
  /** Ink box at the hold (frame px). */
  readonly box: GlyphBox;
}

export function blurTrailPlan(params: TextMotionParams, size: MotionFrameSize): BlurTrailPlan {
  const safe = titleSafeBox(size);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), { ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines) });
  const halfWidth = (text.ink.x1 - text.ink.x0) / 2, halfHeight = (text.ink.y1 - text.ink.y0) / 2;
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const inEnd = T69_IN * timeScale, outEnd = params.durationSeconds - T69_TAIL * timeScale, outStart = outEnd - T69_OUT * timeScale;
  const backdrop = textBackdrop(params);
  // Off-frame by a little more than the blur reach, so the smear never peeks in at the ends.
  const margin = 0.02 * size.width + 3 * T69_BLUR_MAX * frameUnit(size);
  return {
    pathD: compactPathD(text.block.pathD), offsetX: -text.inkCenter[0], offsetY: -text.inkCenter[1], cx: safe.cx, cy: safe.cy,
    halfWidth, halfHeight, glyphHeight, startX: -halfWidth - margin, endX: size.width + halfWidth + margin,
    color: textOnBackground(params.palette, backdrop), echoColor: secondaryTone(params.palette, backdrop), blurMax: T69_BLUR_MAX * frameUnit(size),
    inEnd, outStart, outEnd,
    box: { x0: safe.cx - halfWidth, y0: safe.cy - halfHeight, x1: safe.cx + halfWidth, y1: safe.cy + halfHeight },
  };
}

/** Ink centre x at time t (s), or undefined when the word is not in the clip (before 0, after the dash out). */
export function dashX(plan: BlurTrailPlan, t: number): number | undefined {
  if (t < 0 || t > plan.outEnd) return undefined;
  if (t < plan.inEnd) return plan.startX + (plan.cx - plan.startX) * expoOut(t / plan.inEnd);
  if (t < plan.outStart) return plan.cx;
  return plan.cx + (plan.endX - plan.cx) * expoIn((t - plan.outStart) / (plan.outEnd - plan.outStart));
}

/** Speed (px/s) of the word at time t: the exact derivative of the dash (expoOut in, expoIn out); 0 at the hold and outside. */
export function dashSpeed(plan: BlurTrailPlan, t: number): number {
  const rate = 10 * Math.LN2;
  if (t >= 0 && t < plan.inEnd) return ((plan.cx - plan.startX) * rate * 2 ** (-10 * (t / plan.inEnd))) / plan.inEnd;
  const out = plan.outEnd - plan.outStart;
  if (t >= plan.outStart && t <= plan.outEnd) return ((plan.endX - plan.cx) * rate * 2 ** (10 * ((t - plan.outStart) / out) - 10)) / out;
  return 0;
}

/** Horizontal blur σ (px) at time t: speed / 250, capped; 0 below the threshold. */
export function dashBlur(plan: BlurTrailPlan, t: number): number {
  const sigma = Math.min(plan.blurMax, dashSpeed(plan, t) * T69_BLUR_PER_SPEED);
  return sigma < T69_BLUR_MIN ? 0 : sigma;
}

export interface TrailEcho { readonly x: number; readonly opacity: number }

/**
 * The visible echoes at time t: echo k sits where the word was k·lag earlier, faded in by its distance from the word; the
 * whole trail fades out over the last quarter of the dash in (none during the hold).
 */
export function trailEchoes(plan: BlurTrailPlan, t: number): TrailEcho[] {
  const x = dashX(plan, t);
  if (x === undefined) return [];
  const fade = T69_ECHO_FADE * plan.glyphHeight;
  // The trail clears during the last quarter of the dash in, so the hold is crisp from its first frame.
  const clear = t < plan.outStart ? 1 - smoothstep(0.75 * plan.inEnd, plan.inEnd, t) : 1;
  if (clear <= 0) return [];
  const echoes: TrailEcho[] = [];
  T69_ECHOES.forEach((alpha, index) => {
    const at = t - (index + 1) * T69_LAG;
    const ex = at < 0 ? plan.startX : dashX(plan, at);
    if (ex === undefined) return;
    const opacity = alpha * clear * Math.min(1, Math.abs(x - ex) / fade);
    if (opacity >= 0.005) echoes.push({ x: ex, opacity: Number(opacity.toFixed(3)) });
  });
  return echoes;
}

export const T69_blurTrail = defineTextMotion(ID, (params, t, size) => {
  const plan = blurTrailPlan(params, size);
  const doc = createTextDocument(size, params);
  const x = dashX(plan, t);
  if (x === undefined) return doc.render();
  const echoes = trailEchoes(plan, t);
  const word = (at: number, fill: string, opacity?: number) => path(plan.pathD, { fill, opacity, transform: tf.translate(at + plan.offsetX, plan.cy + plan.offsetY) });
  // Farthest echo first, the word on top.
  const parts = [...echoes].reverse().map(echo => word(echo.x, plan.echoColor, echo.opacity)).concat(word(x, plan.color));
  const sigma = dashBlur(plan, t);
  if (sigma === 0) return doc.render(g(undefined, parts));
  const xs = [x, ...echoes.map(echo => echo.x)];
  const pad = 3 * sigma;
  // Hug the word and its trail, clipped to the frame (librsvg pays per filtered pixel).
  const x0 = Math.max(-pad, Math.min(...xs) - plan.halfWidth - pad), x1 = Math.min(size.width + pad, Math.max(...xs) + plan.halfWidth + pad);
  const y0 = plan.cy - plan.halfHeight - 2, y1 = plan.cy + plan.halfHeight + 2;
  const filter = doc.filter(fe.blur({ in: "SourceGraphic", stdDeviation: [sigma, 0] }),
    { x: Number(x0.toFixed(1)), y: Number(y0.toFixed(1)), width: Number((x1 - x0).toFixed(1)), height: Number((y1 - y0).toFixed(1)) });
  return doc.render(g({ filter }, parts));
}, { revision: REVISION });
