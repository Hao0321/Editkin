import { mixHex } from "../../svg/color";
import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { lemniscatePath, placeAlongPath, type FollowPath } from "../../svg/pathFollow";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T40 Text Echo (残像), STYLE: the word rides a figure-8 (a lemniscate of
 * Bernoulli, svg/pathFollow) at a constant speed, one lap per loop, and leaves eight
 * echo copies along its trail: where the word was a moment ago, with time offsets
 * that grow (the gaps along the path grow by 1.12× per echo, the first 0.6 glyph
 * heights), so the trail opens out behind the word instead of piling up. The echoes are
 * ghosts, never an extrusion (T04's lesson: thick 3D text is ART_REJECTED) and never a
 * mass (r2, Claude's review): each is 3.5% smaller than the one in front, its opacity
 * falls exponentially from 70% to 5%, and only the newest keeps the full second tone;
 * the older ones turn quickly to its deep shade (orange → deep brown on the dark card;
 * deep shade → ink on the accent card, ART_DIRECTION §0), so the trail reads as
 * receding layers. The live word leads, opaque and crisp, in the text colour (cream on
 * the dark card), drawn over its trail.
 *
 * Layout: a horizontal figure-8 in landscape and square frames, a vertical one in
 * portrait, so the loop uses the long side; the word (heroTextBox type: display 900,
 * tight tracking) is as large as the path allows, its ink box (and every echo's)
 * inside the 5% title-safe box at every phase, and at least 9% of the short side tall.
 *
 * A seamless 3 s loop (catalog loopSeconds): the head sits at loop phase × the path
 * length and every echo a fixed distance behind it (wrapping round the closed path),
 * so frame 0 equals the frame at 3 s. Energy scales the echo gaps (a longer trail at
 * hype), never the period.
 */

const ID = "T40";
/** Art revision (part of the clip cache key): 1 = first render; 2 = growing gaps, 70% → 5% falloff, older echoes in the deep shade (Claude's review). */
const REVISION = 2;
export const T40_LOOP_SECONDS = 3;
/** Echo copies behind the word; the first gap along the path (× glyph ink height) and how much each later gap grows; first and last opacity. */
export const T40_ECHOES = 8, T40_GAP_FIRST = 0.6, T40_GAP_GROWTH = 1.12, T40_OPACITY_FIRST = 0.7, T40_OPACITY_LAST = 0.05;
/** How fast the echoes turn from the second tone to its deep shade: tone = 1 − (1 − p)^T40_TONE_CURVE, p = 0 … 1 along the trail. */
export const T40_TONE_CURVE = 2.2;
/** Each echo is this much smaller than the one in front of it: the trail tapers like a comet. */
export const T40_SHRINK = 0.035;
/** Lemniscate half-width as a multiple of the word's ink width (landscape / square), and in portrait (vertical). */
const LOOP_WIDE = 1.15, LOOP_TALL = 1.2;
const LINE_HEIGHT = 1.04, FIT_STEPS = 240;

export interface EchoPlan {
  readonly pathD: string;
  readonly ink: GlyphBox;
  readonly inkCenter: readonly [number, number];
  readonly fontSize: number;
  readonly glyphHeight: number;
  readonly track: FollowPath;
  /** Distance of echo 1 … 8 behind the word along the path (px); the gaps grow. */
  readonly offsets: readonly number[];
  readonly headColor: string;
  /** Colour, opacity and scale of echo 1 (just behind the word) … echo 8. */
  readonly echoes: ReadonlyArray<{ readonly color: string; readonly opacity: number; readonly scale: number }>;
}

function lemniscateFor(size: MotionFrameSize, cx: number, cy: number, halfWidth: number): FollowPath {
  return lemniscatePath(cx, cy, halfWidth, { rotationDegrees: size.height > size.width * 1.1 ? 90 : 0 });
}

export function echoPlan(params: TextMotionParams, size: MotionFrameSize): EchoPlan {
  const safe = titleSafeBox(size), tall = size.height > size.width * 1.1;
  const face = textFace(params.font, 900), tracking = displayTracking(params.lines);
  // Fit at 100 px: the word and the loop grow together, so one scale factor k fits both.
  const reference = layoutFittedText(params.lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: 100, lineHeight: LINE_HEIGHT, tracking });
  const w = reference.ink.x1 - reference.ink.x0, h = reference.ink.y1 - reference.ink.y0;
  const halfWidth = (tall ? LOOP_TALL : LOOP_WIDE) * w;
  const probe = lemniscateFor(size, 0, 0, halfWidth);
  let worstX = 0, worstY = 0;
  for (const point of placeAlongPath(probe, FIT_STEPS)) {
    worstX = Math.max(worstX, Math.abs(point.x) + w / 2);
    worstY = Math.max(worstY, Math.abs(point.y) + h / 2);
  }
  const k = Math.min(safe.width / 2 / worstX, safe.height / 2 / worstY) * 0.995;
  const text = layoutFittedText(params.lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: Math.floor(100 * k * 1000) / 1000, lineHeight: LINE_HEIGHT, tracking });
  const scale = text.fontSize / 100;
  let glyphHeight = 0;
  for (const placed of text.block.lines) for (const glyph of placed.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const backdrop = textBackdrop(params);
  const head = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  // The deep end of the trail: accent2 behind an accent tone, ink behind accent2 (on the accent card).
  const deep = second.toUpperCase() === params.palette.accent2.toUpperCase() ? params.palette.ink : params.palette.accent2;
  const echoes = Array.from({ length: T40_ECHOES }, (_, index) => {
    const p = T40_ECHOES > 1 ? index / (T40_ECHOES - 1) : 0;
    // Exponential falloff (each echo about 0.69× the one in front) and a fast turn to the deep shade.
    return { color: mixHex(second, deep, 1 - (1 - p) ** T40_TONE_CURVE),
      opacity: Number((T40_OPACITY_FIRST * (T40_OPACITY_LAST / T40_OPACITY_FIRST) ** p).toFixed(4)), scale: 1 - T40_SHRINK * (index + 1) };
  });
  const firstGap = T40_GAP_FIRST * glyphHeight * Math.min(1.4, energyProfile(params.energy).amplitude);
  const offsets: number[] = [];
  for (let index = 0, distance = 0; index < T40_ECHOES; index += 1) { distance += firstGap * T40_GAP_GROWTH ** index; offsets.push(distance); }
  return {
    pathD: compactPathD(text.block.pathD), ink: text.ink, inkCenter: text.inkCenter, fontSize: text.fontSize, glyphHeight,
    track: lemniscateFor(size, safe.cx, safe.cy, halfWidth * scale),
    offsets, headColor: head, echoes,
  };
}

/** Centres of the word (index 0) and its echoes (1…8) at loop phase u. */
export function echoPositions(plan: EchoPlan, u: number): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const length = plan.track.totalLength, head = u * length;
  return [0, ...plan.offsets].map(offset => {
    const point = plan.track((((head - offset) % length) + length) % length);
    return { x: point.x, y: point.y };
  });
}

export const T40_textEcho = defineTextMotion(ID, (params, t, size) => {
  const plan = echoPlan(params, size);
  const positions = echoPositions(plan, loopPhase(t, T40_LOOP_SECONDS));
  const copy = (x: number, y: number, fill: string, opacity?: number, scale = 1) => path(plan.pathD, {
    fill, opacity,
    transform: scale === 1 ? tf.translate(x - plan.inkCenter[0], y - plan.inkCenter[1])
      : transform(tf.translate(x, y), tf.scale(scale), tf.translate(-plan.inkCenter[0], -plan.inkCenter[1])),
  });
  const parts: string[] = [];
  // Oldest (faintest) first, so each newer copy lies over the one behind it; the word last.
  for (let index = T40_ECHOES; index >= 1; index -= 1) {
    const echo = plan.echoes[index - 1], at = positions[index];
    parts.push(copy(at.x, at.y, echo.color, echo.opacity, echo.scale));
  }
  parts.push(copy(positions[0].x, positions[0].y, plan.headColor));
  return createTextDocument(size, params).render(g(undefined, parts));
}, { revision: REVISION });
