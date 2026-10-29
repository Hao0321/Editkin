import { g, path, tf } from "../../svg/document";
import { clamp01, cubicIn, quadIn, quadOut } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground } from "../shared";
import { scatterOffsets, springSettle, type ScatterOffset } from "./scatter";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T61 Magnet Pull (磁力吸附), PHYSICS: the characters are pulled in from the frame
 * edges and snap together.
 * - Approach (0.0–0.5 s): every character starts off-frame on its own side (the left
 *   half from the left, the right half from the right, ±10% of the frame height,
 *   seeded: the scatter helper's "sides" mode) and accelerates toward the centre on a
 *   cubic ease-in, arriving 0.4–0.48 s (seeded) at its overshoot position.
 * - Snap (0.35–0.6 s): the arrival overshoots into the centre: the word is squeezed
 *   toward its middle so neighbours overlap by 30% of a glyph, and from there every
 *   character springs back to its slot (springSettle, damping ratio 0.5, 2.2 Hz: home
 *   is crossed about 0.18 s after arrival, a 16% rebound, settled by about 1.1 s).
 * - Hold to 1.6 s; then the characters drift apart a little (8% of their distance
 *   from the centre) and fade out by 2.0 s; the clip is empty to 2.3 s.
 * Characters alternate the text colour and the second tone (cream and violet on the
 * dark card, ART_DIRECTION §0). Hero type: display 900 at heroTextBox size, tight
 * tracking, inside the 5% title-safe box at the hold, ≥ 9% of the short side tall.
 * Timing: standard-energy seconds, scaled by energy (itemTiming) and squeezed into
 * short clips; a longer clip lengthens the hold (the exit stays at the end).
 */

const ID = "T61";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T61_ARRIVE: readonly [number, number] = [0.4, 0.48], T61_HOLD_END = 1.6, T61_FADE_END = 2.0, T61_END = 2.3;
/** Neighbour overlap at the squeeze (× glyph width), spring (Hz, damping ratio), exit drift (× distance from the centre). */
export const T61_OVERLAP = 0.3, T61_SPRING_HZ = 2.2, T61_DAMPING = 0.5, T61_DRIFT = 0.08;
const LINE_HEIGHT = 1.04;

export interface MagnetGlyph {
  readonly index: number;
  readonly pathD: string;
  /** Ink centre at home (frame px) and the block-coordinate ink centre. */
  readonly cx: number;
  readonly cy: number;
  readonly localX: number;
  readonly localY: number;
  readonly halfWidth: number;
  readonly color: string;
  /** Off-frame start offset (from the scatter helper). */
  readonly start: ScatterOffset;
  /** Squeezed offset at arrival (px), and arrival time (standard seconds). */
  readonly squeezeX: number;
  readonly arrive: number;
}

export interface MagnetPlan {
  readonly glyphs: readonly MagnetGlyph[];
  readonly centerX: number;
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  /** Squeeze factor k: a character sits at centre + (1 − k)·(home − centre) at arrival. */
  readonly squeeze: number;
}

export function magnetPlan(params: TextMotionParams, size: MotionFrameSize): MagnetPlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const offsetX = size.width / 2 - text.inkCenter[0], offsetY = size.height / 2 - text.inkCenter[1];
  const backdrop = textBackdrop(params);
  const colors = [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)];
  const raw: Array<{ pathD: string; cx: number; cy: number; localX: number; localY: number; halfWidth: number; lineIndex: number; x: number }> = [];
  let glyphHeight = 0;
  text.block.lines.forEach((line, lineIndex) => {
    for (const glyph of line.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = line.x + glyph.x, y = line.baselineY;
      glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
      const localX = x + (glyph.bbox.x0 + glyph.bbox.x1) / 2, localY = y + (glyph.bbox.y0 + glyph.bbox.y1) / 2;
      raw.push({ pathD: compactPathD(translatePathD(glyph.pathD, x, y)), cx: offsetX + localX, cy: offsetY + localY, localX, localY,
        halfWidth: (glyph.bbox.x1 - glyph.bbox.x0) / 2, lineIndex, x });
    }
  });
  // Squeeze so neighbours on a line overlap by 30% of a glyph: spacing·(1 − k) = ink width − overlap.
  let spacing = 0, inkWidth = 0, pairs = 0;
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index].lineIndex !== raw[index - 1].lineIndex) continue;
    spacing += raw[index].cx - raw[index - 1].cx; inkWidth += raw[index].halfWidth + raw[index - 1].halfWidth; pairs += 1;
  }
  const squeeze = pairs ? Math.min(0.6, Math.max(0, 1 - ((1 - T61_OVERLAP) * (inkWidth / pairs)) / (spacing / pairs))) : 0;
  const centerX = size.width / 2;
  const starts = scatterOffsets(raw.map(glyph => ({ x: glyph.cx, y: glyph.cy, halfWidth: glyph.halfWidth })),
    { mode: "sides", itemId: ID, seed: params.seed, frame: size, verticalJitter: 0.1, margin: 0.02 * size.width });
  const rng = createSeededRng(ID, params.seed, "arrive");
  return {
    glyphs: raw.map((glyph, index) => ({
      index, pathD: glyph.pathD, cx: glyph.cx, cy: glyph.cy, localX: glyph.localX, localY: glyph.localY, halfWidth: glyph.halfWidth,
      color: colors[index % 2], start: starts[index], squeezeX: -squeeze * (glyph.cx - centerX),
      arrive: rng.fork(index).range(T61_ARRIVE[0], T61_ARRIVE[1]),
    })),
    centerX, glyphHeight: glyphHeight || text.fontSize * 0.88, squeeze,
    box: { x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY },
  };
}

export interface MagnetTimes {
  readonly timeScale: number;
  /** Exit drift starts and the fade ends (clip seconds). */
  readonly exit: number;
  readonly fadeEnd: number;
}

export function magnetTimes(params: TextMotionParams): MagnetTimes {
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, T61_END);
  const fadeEnd = params.durationSeconds - (T61_END - T61_FADE_END) * timeScale;
  return { timeScale, fadeEnd, exit: fadeEnd - (T61_FADE_END - T61_HOLD_END) * timeScale };
}

/** Offset of a character from home at time t (px) and its opacity. */
export function magnetPose(plan: MagnetPlan, glyph: MagnetGlyph, times: MagnetTimes, t: number): { readonly dx: number; readonly dy: number; readonly opacity: number } {
  const arrive = glyph.arrive * times.timeScale;
  if (t < arrive) {
    // Cubic ease-in from the off-frame start to the squeezed position.
    const e = cubicIn(clamp01(t / arrive));
    return { dx: glyph.start.dx + (glyph.squeezeX - glyph.start.dx) * e, dy: glyph.start.dy * (1 - e), opacity: 1 };
  }
  let dx = glyph.squeezeX * (1 - springSettle((t - arrive) / times.timeScale, { frequency: T61_SPRING_HZ, damping: T61_DAMPING }));
  let opacity = 1;
  if (t > times.exit) {
    const q = clamp01((t - times.exit) / (times.fadeEnd - times.exit));
    dx += T61_DRIFT * (glyph.cx - plan.centerX) * quadOut(q);
    opacity = 1 - quadIn(q);
  }
  // + 0 folds −0 (a spring at rest on the left half) into 0.
  return { dx: dx + 0, dy: 0, opacity };
}

export const T61_magnetPull = defineTextMotion(ID, (params, t, size) => {
  const plan = magnetPlan(params, size), times = magnetTimes(params);
  const parts = plan.glyphs.map(glyph => {
    const pose = magnetPose(plan, glyph, times, t);
    if (pose.opacity <= 0.002) return "";
    return path(glyph.pathD, { fill: glyph.color, opacity: pose.opacity < 0.999 ? pose.opacity : undefined,
      transform: tf.translate(glyph.cx - glyph.localX + pose.dx, glyph.cy - glyph.localY + pose.dy) });
  });
  return createTextDocument(size, params).render(g(undefined, parts));
}, { revision: REVISION });
