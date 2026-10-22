import { tint } from "../../svg/color";
import { circle, g, path, transform, tf } from "../../svg/document";
import { backOut, cubicOut, energyProfile, quadInOut, wrap } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, displayTracking, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground,
  titleSafeBox, type FittedText,
} from "../shared";

/**
 * T46 Heartbeat Zoom (心跳脈動), DRAMA, designed on the accent plate with ink
 * glyphs. A seamless 1 s loop at 60 BPM (catalog loopSeconds): a lub-dub of two
 * beats, so 2 pulses a second (≤ 3 per second).
 * - Lub-dub scale: 1.0 → 1.10 by 0.08 s → 1.0 by 0.2 s → 1.06 by 0.3 s → 1.0 by 0.45 s,
 *   then still; the up-strokes use backOut, the down-strokes ease in and out.
 * - Glow: each beat blooms a soft light behind the word (a radial gradient, no
 *   filter). It rises with the beat's up-stroke, then expands from 0.45× to 0.8× the
 *   word width while it fades, gone 0.5 s after the beat (lub 55% at its peak, dub 35%).
 * - Rings: each lub spawns a crisp ring (stroke 1.2% of the short side, thinning as
 *   it grows) at 0.5× the word width that grows to 1.4× over 0.9 s (cubicOut) while
 *   it fades from 90%; each dub spawns a fainter one from 55%. Glow and ring ages wrap
 *   with the loop, so the last dub ring is still fading at the start of the next beat
 *   and frame 0 equals the frame at 1 s.
 * Colours (ART_DIRECTION §0): on the accent plate, as in the reference, the word is
 * ink, the glow a light tint of the accent toward paper and the rings its deep shade
 * (accent2). On the dark card (or over footage) the word is paper and the glow and
 * rings take the accent; on a cream card the glow is the accent and the rings the deep
 * shade. The word is sized with heroTextBox, leaving room for the lub. Energy scales
 * the beat depth; the tempo stays 60 BPM.
 */

const ID = "T46";
/**
 * Art revision (part of the clip cache key): 1 = first render; 2 = a light accent-tint glow on each beat instead of the
 * dark radial shadow, and crisp deep-shade rings on the accent plate (Claude's p2d review, 2026-10-16).
 */
const REVISION = 2;
export const T46_LOOP_SECONDS = 1;
/** Beat keyframes (seconds into the beat) and peaks above 1 at standard energy. */
const LUB_UP = 0.08, LUB_DOWN = 0.2, DUB_UP = 0.3, DUB_DOWN = 0.45, LUB_PEAK = 0.1, DUB_PEAK = 0.06;
/** Rings: start and end diameter (× word width), life, start opacity for the lub and the dub, stroke (× short side). */
const RING_FROM = 0.5, RING_TO = 1.4, RING_LIFE = 0.9, LUB_RING = 0.9, DUB_RING = 0.55, RING_STROKE = 0.012;
/**
 * Glows: start and end radius (× word width), life after the beat, peak opacity for the lub and the dub, and on the accent
 * plate the tint toward paper (0.45 read too faint on lime at these peaks; 0.6 is clearly light and still lime).
 */
const GLOW_FROM = 0.45, GLOW_TO = 0.8, GLOW_LIFE = 0.5, LUB_GLOW = 0.55, DUB_GLOW = 0.35, GLOW_TINT = 0.6;

export interface HeartbeatLayout {
  readonly text: FittedText;
  /** Ink box at rest (frame px) and its centre. */
  readonly box: GlyphBox;
  readonly cx: number;
  readonly cy: number;
  readonly wordWidth: number;
  /** Beat depth multiplier (energy scaleDepth). */
  readonly depth: number;
}

/** Word fit (shared by the generator and its tests). */
export function heartbeatLayout(params: TextMotionParams, size: MotionFrameSize): HeartbeatLayout {
  const depth = energyProfile(params.energy).scaleDepth;
  const safe = titleSafeBox(size);
  // Hero size (ART_DIRECTION §0) with headroom for the lub and its backOut overshoot.
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom: 1 + LUB_PEAK * depth * 1.12 }), lineHeight: 1.04, tracking: displayTracking(params.lines),
  });
  const { ink, inkCenter } = text;
  const box = { x0: safe.cx + ink.x0 - inkCenter[0], y0: safe.cy + ink.y0 - inkCenter[1], x1: safe.cx + ink.x1 - inkCenter[0], y1: safe.cy + ink.y1 - inkCenter[1] };
  return { text, box, cx: safe.cx, cy: safe.cy, wordWidth: box.x1 - box.x0, depth };
}

/** Word scale at loop time u (seconds): the lub-dub, still from 0.45 s. */
export function heartbeatScale(u: number, depth: number): number {
  const lub = LUB_PEAK * depth, dub = DUB_PEAK * depth;
  if (u < LUB_UP) return 1 + lub * backOut(u / LUB_UP);
  if (u < LUB_DOWN) return 1 + lub * (1 - quadInOut((u - LUB_UP) / (LUB_DOWN - LUB_UP)));
  if (u < DUB_UP) return 1 + dub * backOut((u - LUB_DOWN) / (DUB_UP - LUB_DOWN));
  if (u < DUB_DOWN) return 1 + dub * (1 - quadInOut((u - DUB_UP) / (DUB_DOWN - DUB_UP)));
  return 1;
}

/**
 * One beat's glow at loop time u: its strength 0..1 (up with the beat's up-stroke, then fading) and its growth 0..1, or
 * null once it is spent (GLOW_LIFE after the beat). Ages wrap with the loop.
 */
export function heartbeatGlow(u: number, beat: "lub" | "dub"): { readonly strength: number; readonly growth: number } | null {
  const spawn = beat === "lub" ? 0 : LUB_DOWN, rise = beat === "lub" ? LUB_UP : DUB_UP - LUB_DOWN;
  const age = wrap(u - spawn, T46_LOOP_SECONDS);
  if (age >= GLOW_LIFE) return null;
  const strength = age < rise ? cubicOut(age / rise) : (1 - (age - rise) / (GLOW_LIFE - rise)) ** 1.6;
  return { strength, growth: cubicOut(age / GLOW_LIFE) };
}

export const T46_heartbeatZoom = defineTextMotion(ID, (params, t, size) => {
  const layout = heartbeatLayout(params, size);
  const doc = createTextDocument(size, params);
  const { palette } = params;
  const backdrop = textBackdrop(params);
  const wordColor = textOnBackground(palette, backdrop);
  // The reference: light glows behind ink type with deep-shade rings on the accent plate; elsewhere the glow is the accent.
  const glowColor = backdropTone(palette, backdrop) === "accent" ? tint(palette.accent, GLOW_TINT, palette.paper) : palette.accent;
  const ringColor = secondaryTone(palette, backdrop);
  const u = wrap(t, T46_LOOP_SECONDS);
  const { cx, cy, wordWidth, text } = layout;
  const short = Math.min(size.width, size.height);
  const parts: string[] = [];

  // Glows first, behind the rings and the word: a soft disc per beat that expands while it fades.
  for (const [beat, peak] of [["lub", LUB_GLOW], ["dub", DUB_GLOW]] as const) {
    const glow = heartbeatGlow(u, beat);
    if (!glow || glow.strength * peak <= 0.002) continue;
    const radius = wordWidth * (GLOW_FROM + (GLOW_TO - GLOW_FROM) * glow.growth);
    const fill = doc.radialGradient({ cx, cy, r: radius, stops: [
      // A Gaussian-like falloff: full at the heart, feathering out with no visible rim.
      { offset: 0, color: glowColor, opacity: 1 }, { offset: 0.35, color: glowColor, opacity: 0.8 },
      { offset: 0.68, color: glowColor, opacity: 0.32 }, { offset: 1, color: glowColor, opacity: 0 }] });
    parts.push(circle(cx, cy, radius, { fill, opacity: glow.strength * peak }));
  }
  // Rings: lub at 0, dub at LUB_DOWN; ages wrap with the loop so the loop is seamless.
  for (const [spawn, strength] of [[0, LUB_RING], [LUB_DOWN, DUB_RING]] as const) {
    const age = wrap(u - spawn, T46_LOOP_SECONDS);
    if (age >= RING_LIFE) continue;
    const p = age / RING_LIFE;
    const diameter = wordWidth * (RING_FROM + (RING_TO - RING_FROM) * cubicOut(p));
    const opacity = strength * (1 - p) ** 1.4;
    if (opacity <= 0.002) continue;
    parts.push(circle(cx, cy, diameter / 2, { fill: "none", stroke: ringColor, "stroke-width": RING_STROKE * short * (1 - 0.5 * p), opacity }));
  }
  const scale = heartbeatScale(u, layout.depth);
  parts.push(g({ transform: transform(tf.translate(cx, cy), scale !== 1 && tf.scale(scale), tf.translate(-text.inkCenter[0], -text.inkCenter[1])) },
    path(text.block.pathD, { fill: wordColor })));
  return doc.render(parts);
}, { revision: REVISION });
