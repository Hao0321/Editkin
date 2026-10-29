import { g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, heroTextBox, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T49 Wave Letters (波浪字): every character rides a travelling sine,
 * y = 18% of the glyph height × sin(2πt / 1.2 − 0.9·i), and tilts with the
 * wave's slope (±8° at the steepest point, about its ink centre), so the line
 * rolls like a swell. Characters alternate the readable text colour and the second
 * tone (paper and coral on the dark card, ART_DIRECTION §0). The word fills 88% of the
 * safe width (heroTextBox, tight displayTracking) with room for
 * the swing, so every glyph stays inside the 5% title-safe box at every phase,
 * and is at least 9% of the short side. Several lines share one wave (the index
 * runs on through the lines).
 *
 * A seamless 1.2 s loop (catalog loopSeconds): the wave is a function of the loop
 * phase, so frame 0 equals the frame at 1.2 s. Energy scales the amplitude and
 * the tilt, never the period.
 */

const ID = "T49";
const REVISION = 1;
export const T49_LOOP_SECONDS = 1.2;
/** Wave amplitude (× glyph height), phase step per character (rad), peak tilt (degrees). */
export const T49_AMPLITUDE = 0.18, T49_PHASE_STEP = 0.9, T49_TILT = 8;
/** Main word fill of the safe width (ART_DIRECTION §0: 80–90%); stacked lines keep 1.3 em so neighbouring swells never touch. */
const FILL = 0.88, LINE_HEIGHT = 1.3;

export interface WaveGlyph {
  readonly index: number;
  readonly pathD: string;
  /** Pen origin on the baseline and ink centre (frame px, at rest). */
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly color: string;
  /** Ink box at rest (frame px). */
  readonly box: GlyphBox;
}

export interface WaveLettersPlan {
  readonly glyphs: readonly WaveGlyph[];
  /** Wave amplitude in px and peak tilt in degrees (energy applied). */
  readonly amplitude: number;
  readonly tilt: number;
  /** Ink box of the word at rest (frame px). */
  readonly box: GlyphBox;
  readonly glyphHeight: number;
}

export function waveLettersPlan(params: TextMotionParams, size: MotionFrameSize): WaveLettersPlan {
  const safe = titleSafeBox(size), hero = heroTextBox(size, { fill: FILL });
  const energy = Math.min(1.5, energyProfile(params.energy).amplitude);
  // Headroom: the swing (2 × amplitude) plus the corners a tilted glyph sweeps out.
  const swing = 1 + 2 * T49_AMPLITUDE * energy + 0.25 * Math.sin((T49_TILT * energy * Math.PI) / 180);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    maxWidth: hero.maxWidth, maxHeight: Math.min(hero.maxHeight, (safe.height * 0.9) / swing), maxSize: hero.maxSize,
    lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const offsetX = safe.cx - text.inkCenter[0], offsetY = safe.cy - text.inkCenter[1];
  const backdrop = textBackdrop(params);
  const primary = textOnBackground(params.palette, backdrop);
  const secondary = secondaryTone(params.palette, backdrop);
  const glyphs: WaveGlyph[] = [];
  let glyphHeight = 0;
  for (const placed of text.block.lines) {
    for (const glyph of placed.layout.glyphs) {
      if (glyph.whitespace || !glyph.bbox) continue;
      const x = offsetX + placed.x + glyph.x, y = offsetY + placed.baselineY;
      glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
      glyphs.push({ index: glyphs.length, pathD: compactPathD(glyph.pathD), x, y, cx: x + (glyph.bbox.x0 + glyph.bbox.x1) / 2,
        cy: y + (glyph.bbox.y0 + glyph.bbox.y1) / 2, color: glyphs.length % 2 === 0 ? primary : secondary,
        box: { x0: x + glyph.bbox.x0, y0: y + glyph.bbox.y0, x1: x + glyph.bbox.x1, y1: y + glyph.bbox.y1 } });
    }
  }
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  return {
    glyphs, amplitude: T49_AMPLITUDE * glyphHeight * energy, tilt: T49_TILT * energy, glyphHeight,
    box: { x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY },
  };
}

/** Vertical offset (px) and tilt (degrees, clockwise) of glyph i at loop phase u. */
export function wavePose(plan: WaveLettersPlan, index: number, u: number): { readonly dy: number; readonly rotation: number } {
  const phase = 2 * Math.PI * u - T49_PHASE_STEP * index;
  // y = A·sin(phase); along the line the phase falls by 0.9 per character, so the slope is ∝ −cos(phase).
  return { dy: plan.amplitude * Math.sin(phase), rotation: -plan.tilt * Math.cos(phase) };
}

export const T49_waveLetters = defineTextMotion(ID, (params, t, size) => {
  const plan = waveLettersPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T49_LOOP_SECONDS);
  const parts = plan.glyphs.map(glyph => {
    const pose = wavePose(plan, glyph.index, u);
    return path(glyph.pathD, {
      fill: glyph.color,
      transform: transform(tf.translate(glyph.cx, glyph.cy + pose.dy), tf.rotate(pose.rotation), tf.translate(glyph.x - glyph.cx, glyph.y - glyph.cy)),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
