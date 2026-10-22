import { mixHex } from "../../svg/color";
import { fmt, g, path, rect } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, loopPhase, sineInOut } from "../../svg/easing";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { distinctFrom } from "./T09_hugeTextScroll";

/**
 * T37 Text Liquid Fill (液体), STYLE: hollow outline text fills with liquid. A
 * wave surface of two sine layers rises from below the word to above it in 2 s
 * (sineInOut), stays brimful for 0.6 s, drains in 1 s (cubicInOut) and rests empty
 * before the loop wraps. The liquid is clipped to the glyph outlines; the outline
 * (stroke 3% of the font size, round joins) is drawn over it, so the liquid's
 * edge is always clean.
 *
 * The two layers: a front wave in the accent (2 crests across the word, running
 * right) and a back wave in the deep shade (accent2) a little higher, longer and
 * running left, so the surface reads as depth, not as a flat bar. Both run a whole
 * number of cycles per 4 s loop (catalog loopSeconds), and the level is a function
 * of the loop phase, so the seam is invisible. The waves swell while the level
 * moves and calm when it rests.
 *
 * Colours follow ART_DIRECTION §0 and the contrast rule: the outline is the
 * readable text role (cream on the dark card, ink on cream or on the accent card,
 * the reference's ink outline); the front liquid is the accent (accent2 on the
 * accent card, where the accent would vanish, with a tint of it behind). The word
 * is hero-sized (heroTextBox) and static inside the title-safe box.
 */

const ID = "T37";
const REVISION = 1;
export const T37_LOOP_SECONDS = 4;
/** Level program (seconds within the loop): empty, rise, brimful, drain, empty. */
export const T37_RISE_AT = 0.2, T37_RISE = 2, T37_FULL = 0.6, T37_DRAIN = 1;
/** Waves: amplitude (× glyph height), wavelength (× word ink width), cycles per loop (signed: + runs right). */
const FRONT = { amplitude: 0.035, wavelength: 0.5, cycles: 2, lift: 0 } as const;
const BACK = { amplitude: 0.045, wavelength: 0.78, cycles: -1, lift: 0.045 } as const;
/** Outline stroke as a share of the font size (ART_DIRECTION §2: 4–8% for outlined text; hollow 900 glyphs need less to keep counters open). */
const OUTLINE = 0.014;
const LINE_HEIGHT = 1.04, WAVE_SAMPLES = 72;
/** Luminance mask paints: pure white keeps, pure black drops (CERTIFICATION ruling: allowed inside masks). */
const MASK_KEEP = "#FFFFFF", MASK_DROP = "#000000";

export interface LiquidFillPlan {
  readonly pathD: string;
  readonly box: GlyphBox;
  readonly fontSize: number;
  readonly glyphHeight: number;
  /** Wave amplitude multiplier from energy. */
  readonly swell: number;
}

export function liquidFillPlan(params: TextMotionParams, size: MotionFrameSize): LiquidFillPlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 800), {
    ...heroTextBox(size, { headroom: 1 + 2.5 * OUTLINE }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const safe = titleSafeBox(size);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  return {
    pathD: translatePathD(text.block.pathD, dx, dy),
    box: { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy },
    fontSize: text.fontSize, glyphHeight, swell: Math.min(1.6, energyProfile(params.energy).amplitude),
  };
}

/** Fill level at loop time u (seconds): 0 = surface clear below the word, 1 = clear above it. */
export function liquidLevel(u: number): number {
  if (u < T37_RISE_AT) return 0;
  if (u < T37_RISE_AT + T37_RISE) return sineInOut((u - T37_RISE_AT) / T37_RISE);
  const drainAt = T37_RISE_AT + T37_RISE + T37_FULL;
  if (u < drainAt) return 1;
  if (u < drainAt + T37_DRAIN) return 1 - cubicInOut((u - drainAt) / T37_DRAIN);
  return 0;
}

/** How much the surface is stirred (0..1): 1 while the level moves fastest, 0 at rest. */
function stir(u: number): number {
  const dt = 0.05;
  const speed = Math.abs(liquidLevel(Math.min(T37_LOOP_SECONDS, u + dt)) - liquidLevel(Math.max(0, u - dt))) / (2 * dt);
  return clamp01(speed / 0.85);
}

/** The liquid polygon under one wave layer (frame px). */
function wavePathD(plan: LiquidFillPlan, layer: typeof FRONT | typeof BACK, level: number, phase: number, amplitude: number): string {
  const { box, glyphHeight } = plan;
  const width = box.x1 - box.x0, margin = 0.05 * width;
  const x0 = box.x0 - margin, x1 = box.x1 + margin;
  const clearance = (layer.amplitude + BACK.lift) * glyphHeight * 1.7 + 2;
  // Level 0 puts every crest below the ink, level 1 every trough above it.
  const surface = box.y1 + clearance - level * (box.y1 - box.y0 + 2 * clearance) - layer.lift * glyphHeight;
  const wavelength = layer.wavelength * width, bottom = box.y1 + clearance + 4;
  let d = `M${fmt(x0, 1)} ${fmt(bottom, 1)}`;
  for (let index = 0; index <= WAVE_SAMPLES; index += 1) {
    const x = x0 + ((x1 - x0) * index) / WAVE_SAMPLES;
    const y = surface + amplitude * Math.sin(2 * Math.PI * ((x - box.x0) / wavelength - phase));
    d += `L${fmt(x, 1)} ${fmt(y, 1)}`;
  }
  return `${d}L${fmt(x1, 1)} ${fmt(bottom, 1)}Z`;
}

export const T37_textLiquidFill = defineTextMotion(ID, (params, t, size) => {
  const plan = liquidFillPlan(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const outline = textOnBackground(params.palette, backdrop);
  const front = distinctFrom(backdrop, params.palette.accent, [params.palette.accent2, outline]);
  // The back wave is the accent's deep shade; when the front is already that shade (accent card), a mix of it and the card.
  const back = front === params.palette.accent ? params.palette.accent2 : mixHex(front, backdrop, 0.5);
  const u = loopPhase(t, T37_LOOP_SECONDS) * T37_LOOP_SECONDS;
  const level = liquidLevel(u);
  const ring = OUTLINE * plan.fontSize;
  const { box } = plan;
  const region = { x: box.x0 - 2 * ring, y: box.y0 - 2 * ring, width: box.x1 - box.x0 + 4 * ring, height: box.y1 - box.y0 + 4 * ring };
  const parts: string[] = [];
  if (level > 0) {
    // The liquid reaches 0.7 of the way under the ring, so the ring's inner edge always sits on solid liquid (no seam).
    const liquidMask = doc.mask(path(plan.pathD, { fill: MASK_KEEP, stroke: MASK_KEEP, "stroke-width": 1.4 * ring, "stroke-linejoin": "round" }), region);
    const phase = loopPhase(t, T37_LOOP_SECONDS);
    const swell = plan.swell * (0.6 + 0.4 * stir(u)) * plan.glyphHeight;
    parts.push(g({ mask: liquidMask },
      path(wavePathD(plan, BACK, level, BACK.cycles * phase + 0.35, BACK.amplitude * swell), { fill: back }),
      path(wavePathD(plan, FRONT, level, FRONT.cycles * phase, FRONT.amplitude * swell), { fill: front })));
  }
  // The outline: a ring outside the glyphs' union (stroke 2× the ring, the glyphs masked out), so the font's
  // overlapping stroke contours never show as lines inside the letter.
  const ringMask = doc.mask([rect(region.x, region.y, region.width, region.height, { fill: MASK_KEEP }), path(plan.pathD, { fill: MASK_DROP })], region);
  parts.push(g({ mask: ringMask }, path(plan.pathD, { fill: "none", stroke: outline, "stroke-width": 2 * ring, "stroke-linejoin": "round" })));
  return doc.render(parts);
}, { revision: REVISION });
