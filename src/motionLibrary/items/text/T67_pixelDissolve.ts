import { g, path, tf } from "../../svg/document";
import { loopPhase } from "../../svg/easing";
import { blockOutlines, cellsPathD, sampleGlyphCells, type GlyphCell } from "../../svg/glyphCells";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, layoutFittedText, placeWordGlyphs, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";
import { compactPathD, distinctFrom } from "./T09_hugeTextScroll";

/**
 * T67 Pixel Dissolve (像素溶解), RHYTHM, shown on the paper plate: the crisp ink
 * word breaks into square pixels and rebuilds. The glyph-cell sampler (DESIGN §8)
 * cuts our own outlines into cells 1/9 of the glyph height (nonzero fill, cells at
 * least 30% covered, the grid aligned to the word's ink box); there is no pixel font.
 * - 0.0–0.3 s: the crisp vector word.
 * - Break up 0.3–0.75 s: at 0.3 s the word turns to pixels, then the cells vanish one
 *   by one in a seeded random order, evenly spaced in time, the last at 0.75 s.
 * - Empty 0.75–0.85 s.
 * - Return 0.85–1.3 s: the cells come back in a different seeded order; at 1.3 s the
 *   crisp vector word replaces them, so the hold has no cell seams.
 * Each cell flashes the accent for one frame (1/30 s) as it vanishes or arrives, a
 * digital sparkle in the item's own accent; the rest is ink. A seamless 1.8 s loop
 * (catalog loopSeconds): every phase is a fraction of the loop (1/6, 5/12, 17/36,
 * 13/18), so it can sit on a beat grid.
 *
 * Colours: ink on the cream card (the readable text role elsewhere); the sparkle is
 * the accent unless it nearly vanishes on the backdrop, then the deep shade. The word
 * is hero-sized (heroTextBox, tight displayTracking) inside the title-safe box. Energy
 * does not apply: the dissolve is a timing effect.
 */

const ID = "T67";
const REVISION = 1;
export const T67_LOOP_SECONDS = 1.8;
/** Phase times (s): break-up start / end, return start / end. */
export const T67_BREAK = 0.3, T67_GONE = 0.75, T67_RETURN = 0.85, T67_WHOLE = 1.3;
/** Cell size (glyph heights per cell), minimum coverage, drawn square scale, sparkle length (s). */
export const T67_CELLS_PER_GLYPH = 9, T67_MIN_COVERAGE = 0.3, T67_SQUARE = 0.9, T67_SPARKLE = 1 / 30;
const LINE_HEIGHT = 1.08;

export interface PixelDissolvePlan {
  /** Crisp word outline (compact) drawn at translate(x, y). */
  readonly wordPathD: string;
  readonly x: number;
  readonly y: number;
  readonly cells: readonly GlyphCell[];
  /** Vanish and appear times per cell (s), in cell order. */
  readonly vanishAt: readonly number[];
  readonly appearAt: readonly number[];
  readonly cellSize: number;
  readonly glyphHeight: number;
  readonly color: string;
  readonly sparkleColor: string;
  readonly box: GlyphBox;
}

/** A seeded permutation of 0..n−1 (Fisher–Yates on the item's RNG stream). */
function seededOrder(seed: number, stream: string, n: number): number[] {
  const rng = createSeededRng(ID, seed, stream), order = Array.from({ length: n }, (_, index) => index);
  for (let index = n - 1; index > 0; index -= 1) {
    const pick = rng.int(0, index);
    [order[index], order[pick]] = [order[pick], order[index]];
  }
  return order;
}

export function pixelDissolvePlan(params: TextMotionParams, size: MotionFrameSize): PixelDissolvePlan {
  const safe = titleSafeBox(size);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), { ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines) });
  const x = safe.cx - text.inkCenter[0], y = safe.cy - text.inkCenter[1];
  const { glyphHeight } = placeWordGlyphs(text, x, y);
  const cellSize = glyphHeight / T67_CELLS_PER_GLYPH;
  const box = { x0: text.ink.x0 + x, y0: text.ink.y0 + y, x1: text.ink.x1 + x, y1: text.ink.y1 + y };
  const cells = sampleGlyphCells(blockOutlines(text.block, x, y), { cellSize, minCoverage: T67_MIN_COVERAGE, originX: box.x0, originY: box.y0 });
  const n = cells.length;
  const vanishRank = seededOrder(params.seed, "vanish", n), appearRank = seededOrder(params.seed, "appear", n);
  const vanishAt: number[] = new Array(n), appearAt: number[] = new Array(n);
  // Rank r vanishes at the (r + 1)-th even step (the last exactly at 0.75 s) and arrives at the r-th step from 0.85 s.
  vanishRank.forEach((cell, rank) => { vanishAt[cell] = T67_BREAK + ((T67_GONE - T67_BREAK) * (rank + 1)) / n; });
  appearRank.forEach((cell, rank) => { appearAt[cell] = T67_RETURN + ((T67_WHOLE - T67_RETURN) * rank) / n; });
  const backdrop = textBackdrop(params), color = textOnBackground(params.palette, backdrop);
  return {
    wordPathD: compactPathD(text.block.pathD), x, y, cells, vanishAt, appearAt, cellSize, glyphHeight, color,
    sparkleColor: distinctFrom(backdrop, params.palette.accent, [params.palette.accent2, color]), box,
  };
}

export type PixelPhase = "word" | "cells";

/** Whether the crisp word or the cells show at loop time u (seconds in 0..1.8). */
export function pixelPhase(u: number): PixelPhase {
  return u >= T67_BREAK && u < T67_WHOLE ? "cells" : "word";
}

/** State of cell i at loop time u: hidden, shown in the text colour, or sparkling for its one frame. */
export function cellState(plan: PixelDissolvePlan, index: number, u: number): "hidden" | "ink" | "sparkle" {
  if (u < T67_RETURN) {
    const vanish = plan.vanishAt[index];
    if (u >= vanish) return "hidden";
    return u >= vanish - T67_SPARKLE ? "sparkle" : "ink";
  }
  const appear = plan.appearAt[index];
  if (u < appear) return "hidden";
  return u < appear + T67_SPARKLE ? "sparkle" : "ink";
}

export const T67_pixelDissolve = defineTextMotion(ID, (params, t, size) => {
  const plan = pixelDissolvePlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T67_LOOP_SECONDS) * T67_LOOP_SECONDS;
  if (pixelPhase(u) === "word") return doc.render(path(plan.wordPathD, { fill: plan.color, transform: tf.translate(plan.x, plan.y) }));
  const ink: GlyphCell[] = [], sparkle: GlyphCell[] = [];
  plan.cells.forEach((cell, index) => {
    const state = cellState(plan, index, u);
    if (state === "ink") ink.push(cell); else if (state === "sparkle") sparkle.push(cell);
  });
  const draw = (cells: GlyphCell[], fill: string) => (cells.length ? path(cellsPathD(cells, { scale: T67_SQUARE, decimals: 1 }), { fill }) : "");
  return doc.render(g(undefined, draw(ink, plan.color), draw(sparkle, plan.sparkleColor)));
}, { revision: REVISION });
