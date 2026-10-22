import { g, path, rect, transform, tf } from "../../svg/document";
import { backOut, clamp01, energyProfile, expoInOut, smoothstep, wrap } from "../../svg/easing";
import { lineOutlines, sampleGlyphCells } from "../../svg/glyphCells";
import { layoutLine, resolveMotionFace, type GlyphBox, type LineLayout, type MotionFontSelector } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T32 Split Halves (上下分割), SWITCH: a word (line 1, 外表) splits across its
 * middle, along the least-inked row near the centre (found once per text with the
 * glyph-cell sampler), so the knife falls between strokes instead of shaving a
 * horizontal stroke into hairline slivers. The top half slides up and the bottom
 * half slides down (0.3 s, backOut), opening a slot in which a smaller word (line 2,
 * 真心) in the accent shows, clipped to the opening so it never shows through the big
 * word's strokes; it eases from 0.86× to full size as the slot opens. The slot holds
 * open, then the halves shut again (0.25 s, expoInOut). A seamless 2 s loop (catalog
 * loopSeconds): whole 0–0.45 s, open by 0.75 s, held to 1.45 s, shut by 1.7 s, whole
 * until the loop wraps (frame 0 equals the frame at 2 s). The big word is sized with
 * heroTextBox, leaving room for the opening; the inner word is 42% of the big word's
 * glyph height and the slot opens to 1.6× its height (punchier energies open it up to
 * 1.35× wider; energy also sets the pace, always inside the loop). Colours follow
 * ART_DIRECTION §0: the text role for the halves, secondaryTone for the revealed word
 * (paper and accent on a dark card; ink and accent2 on cream). Without a second line
 * the slot reveals the same word, small.
 */

const ID = "T32";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T32_LOOP_SECONDS = 2;
const OPEN_AT = 0.45, OPEN = 0.3, CLOSE_AT = 1.45, CLOSE = 0.25;
/** Inner word glyph height (× the big word's ink height) and the slot it needs (× the inner word height) at standard energy. */
const INNER = 0.42, SLOT = 1.6, INNER_FROM = 0.86;
/** Cut search: rows across the ink height, and the band around the middle they may come from (fractions of the height). */
const CUT_ROWS = 72, CUT_BAND = 0.14;

const cutCache = new Map<string, number>();

/**
 * Where to cut a word, as a fraction of its ink height from the top: the row with the least glyph coverage within
 * ±CUT_BAND of the middle (ties go to the row nearest the middle). Sampled once per text and face at 120 px.
 */
export function splitCutFraction(text: string, face: MotionFontSelector, tracking: number): number {
  const key = `${resolveMotionFace(face).faceId}\u0000${tracking}\u0000${text}`;
  const hit = cutCache.get(key);
  if (hit !== undefined) return hit;
  const line = layoutLine(text, { ...face, size: 120, tracking });
  let best = 0.5;
  if (line.inkBox) {
    const height = line.inkBox.y1 - line.inkBox.y0, cell = height / CUT_ROWS;
    const cells = sampleGlyphCells(lineOutlines(line), { cellSize: cell, supersample: 2, originX: line.inkBox.x0, originY: line.inkBox.y0 });
    const coverage = new Array<number>(CUT_ROWS).fill(0);
    for (const sample of cells) if (sample.row >= 0 && sample.row < CUT_ROWS) coverage[sample.row] += sample.coverage;
    let bestScore = Infinity;
    for (let row = 0; row < CUT_ROWS; row += 1) {
      const centre = (row + 0.5) / CUT_ROWS;
      if (Math.abs(centre - 0.5) > CUT_BAND) continue;
      const score = coverage[row] + 1e-3 * Math.abs(centre - 0.5);
      if (score < bestScore) { bestScore = score; best = centre; }
    }
  }
  cutCache.set(key, best);
  if (cutCache.size > 64) cutCache.delete(cutCache.keys().next().value!);
  return best;
}

export interface SplitHalvesLayout {
  readonly word: LineLayout;
  readonly inner: LineLayout;
  /** Pen origins (frame px). */
  readonly wordX: number;
  readonly wordY: number;
  readonly innerX: number;
  readonly innerY: number;
  /** The cut line and the full opening (each half moves `travel` px) at standard pace. */
  readonly cutY: number;
  readonly travel: number;
  /** Ink box of the closed word (frame px). */
  readonly box: GlyphBox;
  /** Ink box of the inner word at full size (frame px). */
  readonly innerBox: GlyphBox;
  /** Loop phase boundaries (seconds). */
  readonly openAt: number;
  readonly openEnd: number;
  readonly closeAt: number;
  readonly closeEnd: number;
}

/** Word fit, the inner word and the loop timing (shared by the generator and its tests). */
export function splitHalvesLayout(params: TextMotionParams, size: MotionFrameSize): SplitHalvesLayout {
  const energy = energyProfile(params.energy);
  const wordText = params.lines[0], innerText = params.lines[1] ?? params.lines[0];
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  // The slot never closes below its standard size (the inner word must fit); punchier energies open it wider.
  const slot = INNER * SLOT * Math.max(1, Math.min(1.35, energy.amplitude));
  // Hero size (ART_DIRECTION §0) with headroom for the opening: the open word is (1 + slot) × its height.
  const probe = layoutLine(wordText, { ...face, size: 100, tracking: displayTracking([wordText]) });
  const probeInk = probe.inkBox ?? { x0: 0, y0: -88, x1: probe.width, y1: 12 };
  const hero = heroTextBox(size);
  const fontSize = Number(Math.max(8, Math.min(hero.maxSize, (hero.maxWidth * 100) / (probeInk.x1 - probeInk.x0),
    (0.94 * safe.height * 100) / ((probeInk.y1 - probeInk.y0) * (1 + slot)), (hero.maxHeight * 100) / (probeInk.y1 - probeInk.y0))).toFixed(3));
  const word = layoutLine(wordText, { ...face, size: fontSize, tracking: displayTracking([wordText]) });
  const ink = word.inkBox ?? { x0: 0, y0: -fontSize * 0.88, x1: word.width, y1: fontSize * 0.12 };
  const wordHeight = ink.y1 - ink.y0;
  const innerProbe = layoutLine(innerText, { ...face, size: 100, tracking: displayTracking([innerText]) });
  const innerProbeInk = innerProbe.inkBox ?? { x0: 0, y0: -88, x1: innerProbe.width, y1: 12 };
  // Inner word: INNER of the big word's height, never wider than the big word.
  const innerSize = Number(Math.min((INNER * wordHeight * 100) / (innerProbeInk.y1 - innerProbeInk.y0),
    (0.96 * (ink.x1 - ink.x0) * 100) / (innerProbeInk.x1 - innerProbeInk.x0)).toFixed(3));
  const inner = layoutLine(innerText, { ...face, size: innerSize, tracking: displayTracking([innerText]) });
  const innerInk = inner.inkBox ?? { x0: 0, y0: -innerSize * 0.88, x1: inner.width, y1: innerSize * 0.12 };
  const wordX = safe.cx - (ink.x0 + ink.x1) / 2, wordY = safe.cy - (ink.y0 + ink.y1) / 2;
  // The cut falls between strokes; the inner word is centred on it (the middle of the slot).
  const cutY = wordY + ink.y0 + splitCutFraction(wordText, face, displayTracking([wordText])) * wordHeight;
  const innerX = safe.cx - (innerInk.x0 + innerInk.x1) / 2, innerY = cutY - (innerInk.y0 + innerInk.y1) / 2;
  // Energy sets the pace, always inside the loop (the program spans 0.45–1.7 s at standard energy).
  const pace = Math.min(energy.time, (T32_LOOP_SECONDS - 0.15) / (CLOSE_AT + CLOSE));
  return {
    word, inner, wordX, wordY, innerX, innerY, cutY, travel: (slot * wordHeight) / 2,
    box: { x0: wordX + ink.x0, y0: wordY + ink.y0, x1: wordX + ink.x1, y1: wordY + ink.y1 },
    innerBox: { x0: innerX + innerInk.x0, y0: innerY + innerInk.y0, x1: innerX + innerInk.x1, y1: innerY + innerInk.y1 },
    openAt: OPEN_AT * pace, openEnd: (OPEN_AT + OPEN) * pace, closeAt: CLOSE_AT * pace, closeEnd: (CLOSE_AT + CLOSE) * pace,
  };
}

/** How far the halves are apart at loop time u: 0 = whole, 1 = open (backOut overshoots a little on the way out). */
export function splitHalvesOpening(layout: SplitHalvesLayout, u: number): number {
  if (u < layout.openAt || u >= layout.closeEnd) return 0;
  if (u < layout.openEnd) return backOut((u - layout.openAt) / (layout.openEnd - layout.openAt));
  if (u < layout.closeAt) return 1;
  return 1 - expoInOut((u - layout.closeAt) / (layout.closeEnd - layout.closeAt));
}

export const T32_splitHalves = defineTextMotion(ID, (params, t, size) => {
  const layout = splitHalvesLayout(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const wordColor = textOnBackground(params.palette, backdrop);
  const innerColor = secondaryTone(params.palette, backdrop);
  const u = wrap(t, T32_LOOP_SECONDS);
  const opening = splitHalvesOpening(layout, u);
  const placed = path(layout.word.pathD, { fill: wordColor, transform: tf.translate(layout.wordX, layout.wordY) });
  // Halves less than a pixel apart draw as the whole word: a sub-pixel gap would only paint a seam line across it.
  if (2 * layout.travel * opening < 1) return doc.render(placed);
  const { box, cutY, travel } = layout;
  const shift = travel * opening;
  const pad = 0.25 * (box.y1 - box.y0), wide = box.x1 - box.x0;
  const parts: string[] = [];
  // The inner word, clipped to the slot between the halves (never through the big word's strokes).
  const gap = Math.max(0, shift);
  if (gap > 0.5) {
    const slot = doc.clipPath(rect(box.x0 - wide, cutY - gap, 3 * wide, 2 * gap));
    const grow = INNER_FROM + (1 - INNER_FROM) * smoothstep(0.15, 1, clamp01(opening));
    const ic = [(layout.innerBox.x0 + layout.innerBox.x1) / 2, (layout.innerBox.y0 + layout.innerBox.y1) / 2] as const;
    parts.push(g({ "clip-path": slot }, path(layout.inner.pathD, {
      fill: innerColor, transform: transform(tf.translate(ic[0], ic[1]), grow !== 1 && tf.scale(grow), tf.translate(layout.innerX - ic[0], layout.innerY - ic[1])),
    })));
  }
  // The halves: clipPaths along the cut line, each sliding with its clip.
  const top = doc.clipPath(rect(box.x0 - wide, box.y0 - pad, 3 * wide, cutY - (box.y0 - pad)));
  const bottom = doc.clipPath(rect(box.x0 - wide, cutY, 3 * wide, box.y1 + pad - cutY));
  parts.push(g({ transform: tf.translate(0, -shift) }, g({ "clip-path": top }, placed)));
  parts.push(g({ transform: tf.translate(0, shift) }, g({ "clip-path": bottom }, placed)));
  return doc.render(parts);
}, { revision: REVISION });
