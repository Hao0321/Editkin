import { g, path, transform, tf } from "../../svg/document";
import { backIn, backOut, clamp01, energyProfile } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T06 Stretch Text (ストレッチ): characters stretch vertically one at a time,
 * anchored on the line's floor (the lowest ink edge, so every glyph keeps its
 * footing): scaleY 1.0 → 1.5 → 1.0 with scaleX 1.0 → 0.85 → 1.0, a 0.35 s sine
 * pulse per character with a small rubber rebound (scaleY dips to 0.94 for 0.14 s),
 * characters 0.25 s apart, so a wave travels across the word. Colours alternate
 * between the readable text role and a second readable colour (ink and cream on
 * the accent plate). The clip has an in → hold → out shape: the characters pop up
 * out of the floor (scaleY 0 → 1, backOut, 0.06 s apart), whole wave passes are
 * spread evenly through the hold (as many as fit with at least 0.1 s of rest
 * between them; the last one ends 0.1 s before the exit), and the characters squash
 * back into the floor at the end. Times are standard-energy
 * seconds, scaled by energy and squeezed into short clips.
 *
 * Shared with T75 Elastic Wave Stretch (CATALOG: T75 ↔ T06): stretchWordLayout
 * lays a word out as one path per character on its floor line and drawStretchWord
 * draws it with any per-character stretch, so T75 only supplies a continuous sine.
 */

const ID = "T06";
/** Art revision (part of the clip cache key): 1 = first render; 2 = self-review fix after the first contact sheet (whole wave passes spread evenly through the hold; rest pose lowered for big stretches); 3 = ART_DIRECTION §0 (hero size, tight tracking, ink + accent2 on accent). */
const REVISION = 3;
const PULSE = 0.35, STAGGER = 0.25, REST = 0.25, MIN_REST = 0.1, REBOUND = 0.4;
const ENTER = 0.28, ENTER_STAGGER = 0.06, EXIT = 0.22, EXIT_STAGGER = 0.05, TAIL = 0.08;
/** Full stretch: scaleY + STRETCH_Y, scaleX − SQUEEZE_X (× scaleDepth). The rebound dips by REBOUND_DEPTH of that. */
export const STRETCH_Y = 0.5, SQUEEZE_X = 0.15;
const REBOUND_DEPTH = 0.12;
const LINE_HEIGHT = 1.08;

export interface StretchGlyph {
  readonly index: number;
  readonly pathD: string;
  /** Pen origin of the glyph (frame px, on its baseline). */
  readonly x: number;
  readonly y: number;
  /** Scale anchor: the glyph's horizontal ink centre on its line's floor (frame px). */
  readonly anchorX: number;
  readonly floorY: number;
  readonly color: string;
}

export interface StretchWordLayout {
  readonly fontSize: number;
  readonly glyphs: readonly StretchGlyph[];
  /** Ink box at rest, frame px. */
  readonly box: GlyphBox;
}

/**
 * Lay a word out for stretching: fitted inside the title-safe box with room for a
 * stretch of maxStretchY (fraction of the glyph height) above it, one path per
 * visible character, alternating colours. The rest pose sits a little below centre
 * (lower when the stretch is big) so the stretched glyphs stay inside the safe box too.
 */
export function stretchWordLayout(params: TextMotionParams, size: MotionFrameSize, maxStretchY: number, alternate = true): StretchWordLayout {
  const safe = titleSafeBox(size);
  const headroom = 1 + Math.max(0, maxStretchY);
  // Hero size (ART_DIRECTION §0); the height leaves room for the full stretch.
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { heightFill: Math.min(0.62, 1 / headroom) }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const { ink } = text;
  const inkHeight = ink.y1 - ink.y0;
  // Sit the rest word 12% of its height below centre, but always low enough for the full stretch to stay in the safe box.
  const stretch = Math.max(0, maxStretchY);
  const lowest = safe.y0 - safe.cy + inkHeight / 2 + stretch * inkHeight, highest = safe.y1 - safe.cy - inkHeight / 2;
  const lift = Math.max(lowest, Math.min(0.12 * inkHeight, (stretch * inkHeight) / 2, highest));
  const offsetX = safe.cx - (ink.x0 + ink.x1) / 2, offsetY = safe.cy + lift - (ink.y0 + ink.y1) / 2;
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const secondary = alternate ? secondaryTone(params.palette, backdrop) : primary;
  const glyphs: StretchGlyph[] = [];
  for (const line of text.block.lines) {
    let floor = -Infinity;
    for (const glyph of line.layout.glyphs) if (glyph.bbox) floor = Math.max(floor, glyph.bbox.y1);
    for (const glyph of line.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = offsetX + line.x + glyph.x, y = offsetY + line.baselineY;
      glyphs.push({
        index: glyphs.length, pathD: glyph.pathD, x, y,
        anchorX: x + (glyph.bbox.x0 + glyph.bbox.x1) / 2, floorY: y + floor,
        color: glyphs.length % 2 === 0 ? primary : secondary,
      });
    }
  }
  return {
    fontSize: text.fontSize, glyphs,
    box: { x0: ink.x0 + offsetX, y0: ink.y0 + offsetY, x1: ink.x1 + offsetX, y1: ink.y1 + offsetY },
  };
}

export interface StretchPose {
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * Draw the word with a per-character pose (anchored on the floor). Glyphs whose
 * scale collapses below 0.01 are skipped: a zero scale is a singular matrix.
 */
export function drawStretchWord(layout: StretchWordLayout, pose: (glyph: StretchGlyph) => StretchPose | null): string[] {
  const parts: string[] = [];
  for (const glyph of layout.glyphs) {
    const p = pose(glyph);
    if (!p || Math.abs(p.scaleX) < 0.01 || Math.abs(p.scaleY) < 0.01) continue;
    const scaled = p.scaleX !== 1 || p.scaleY !== 1;
    parts.push(path(glyph.pathD, {
      fill: glyph.color,
      transform: transform(scaled && tf.translate(glyph.anchorX, glyph.floorY), scaled && tf.scale(p.scaleX, p.scaleY),
        tf.translate(scaled ? glyph.x - glyph.anchorX : glyph.x, scaled ? glyph.y - glyph.floorY : glyph.y)),
    }));
  }
  return parts;
}

/** Pulse amount at progress u through one pulse window: a sine up and down, then a small rubber rebound below rest. */
function pulseAmount(u: number): number {
  if (u <= 0 || u >= 1 + REBOUND) return 0;
  if (u < 1) return Math.sin(Math.PI * u);
  return -REBOUND_DEPTH * Math.sin((Math.PI * (u - 1)) / REBOUND);
}

export interface StretchTiming {
  readonly timeScale: number;
  readonly depth: number;
  /** Start of the first wave pass (clip seconds). */
  readonly waveStart: number;
  readonly waveCycles: number;
  /** Start-to-start spacing of the passes (0 for a single pass). */
  readonly cycleSeconds: number;
  /** Length of one pass (every character's pulse and rebound). */
  readonly passSeconds: number;
  readonly exitAt: number;
}

/** Entrance, whole wave passes spread evenly through the hold, and the exit (clip seconds). */
export function stretchTiming(params: TextMotionParams, glyphCount: number): StretchTiming {
  const count = Math.max(1, glyphCount);
  const enterSpan = ENTER + ENTER_STAGGER * (count - 1), exitSpan = EXIT + EXIT_STAGGER * (count - 1);
  const pass = STAGGER * (count - 1) + PULSE * (1 + REBOUND);
  const natural = enterSpan + pass + REST + exitSpan + TAIL;
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const waveStart = enterSpan * timeScale;
  const exitAt = params.durationSeconds - (exitSpan + TAIL) * timeScale;
  const passSeconds = pass * timeScale, gap = MIN_REST * timeScale;
  // Room for passes: from the end of the entrance to a short gap before the exit.
  const room = exitAt - gap - waveStart;
  const waveCycles = room + 1e-9 < passSeconds ? 0 : 1 + Math.floor((room - passSeconds + 1e-9) / (passSeconds + gap));
  const cycleSeconds = waveCycles > 1 ? (room - passSeconds) / (waveCycles - 1) : 0;
  return { timeScale, depth: energy.scaleDepth, waveStart, waveCycles, cycleSeconds, passSeconds, exitAt };
}

export const T06_stretchText = defineTextMotion(ID, (params, t, size) => {
  const layout = stretchWordLayout(params, size, STRETCH_Y * energyProfile(params.energy).scaleDepth);
  const timing = stretchTiming(params, layout.glyphs.length);
  const doc = createTextDocument(size, params);
  const ts = timing.timeScale;
  const parts = drawStretchWord(layout, glyph => {
    const i = glyph.index;
    // Entrance: pop up out of the floor.
    const enterStart = ENTER_STAGGER * i * ts;
    if (t < enterStart) return null;
    if (t < enterStart + ENTER * ts) {
      const p = (t - enterStart) / (ENTER * ts);
      return { scaleX: 1 + 0.12 * (1 - clamp01(p * 1.6)), scaleY: backOut(p, 1.9) };
    }
    // Exit: squash back into the floor (a short stretch up first, from backIn).
    const exitStart = timing.exitAt + EXIT_STAGGER * i * ts;
    if (t >= exitStart) {
      const q = (t - exitStart) / (EXIT * ts);
      if (q >= 1) return null;
      const down = backIn(q, 1.4);
      return { scaleX: 1 + 0.12 * clamp01(q * 1.4), scaleY: 1 - down };
    }
    // Wave: whole passes, evenly spaced through the hold.
    if (t < timing.waveStart || timing.waveCycles < 1) return { scaleX: 1, scaleY: 1 };
    const cycle = timing.cycleSeconds > 0 ? Math.min(timing.waveCycles - 1, Math.floor((t - timing.waveStart) / timing.cycleSeconds)) : 0;
    const local = t - timing.waveStart - cycle * timing.cycleSeconds - STAGGER * i * ts;
    const amount = pulseAmount(local / (PULSE * ts)) * timing.depth;
    return amount === 0 ? { scaleX: 1, scaleY: 1 } : { scaleX: 1 - SQUEEZE_X * amount, scaleY: 1 + STRETCH_Y * amount };
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
