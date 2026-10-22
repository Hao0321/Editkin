import { g, path, pathData, polygonPathD, tf, type Point2 } from "../../svg/document";
import { clamp01, cubicIn, quadOut, smoothstep } from "../../svg/easing";
import { blockOutlines, sampleGlyphCells } from "../../svg/glyphCells";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, frameUnit, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground,
} from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T45 Disintegrate (粒子消散), DRAMA: the word holds, then turns to dust from left
 * to right.
 * - Hold 0.0–0.8 s: the whole word, display 900 at heroTextBox size (tight tracking).
 * - Dissolve 0.8–1.6 s: a front (leaning 10°, with a slight wave) sweeps across the
 *   word in 0.3 s. Behind it the word is no longer a solid outline but its glyph cells
 *   (svg/glyphCells, cell = 6% of the glyph height), and every cell detaches as the
 *   front passes it: it drifts up and to the right (20–60 px right, 30–90 px up at
 *   1080, seeded per cell), spins up to ±45°, shrinks to 40% and fades out within
 *   0.5 s. About 30% of the cells (seeded) are the second tone (lime on the dark
 *   card) instead of the text colour, so the dust sparkles.
 * - The frame is empty 1.6–1.8 s, then the word fades back in by 2.0 s, so the clip's
 *   end matches its start and it loops cleanly when repeated.
 * Ahead of the front the word is still the crisp outline (clipped at the front).
 * Timing: standard-energy seconds, scaled by energy (itemTiming) and squeezed into
 * short clips; a longer clip lengthens the hold (the dissolve stays 1.2 s before the end).
 */

const ID = "T45";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T45_HOLD = 0.8, T45_SWEEP = 0.3, T45_LIFE = 0.5, T45_EMPTY_END = 1.8, T45_END = 2.0;
/** Cell edge (× glyph height), drift (px at 1080: right, up), spin (± degrees), end scale, share of accent cells. */
export const T45_CELL = 0.06, T45_DRIFT_X: readonly [number, number] = [20, 60], T45_DRIFT_Y: readonly [number, number] = [30, 90];
export const T45_SPIN = 45, T45_END_SCALE = 0.4, T45_ACCENT_SHARE = 0.3;
/** Front lean (degrees from vertical, top ahead) and wave (× glyph height). */
const LEAN = 10, WAVE = 0.04, WAVE_PERIOD = 0.9;
/** A cell is part of the word when the glyph covers this much of it. */
const MIN_COVERAGE = 0.35;
/** Cells are drawn this much smaller than the grid (a pixel gap). */
const CELL_FILL = 0.9;
const LINE_HEIGHT = 1.04, OPACITY_LEVELS = 16;

export interface DustCell {
  /** Cell centre at home (frame px) and edge. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  /** 0 = the text colour, 1 = the second tone (paint order does not depend on the palette's hex values). */
  readonly tone: 0 | 1;
  /** Drift at the end of its life (px), spin (degrees). */
  readonly dx: number;
  readonly dy: number;
  readonly spin: number;
}

export interface DisintegratePlan {
  readonly pathD: string;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Word ink box (frame px). */
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  readonly cells: readonly DustCell[];
  readonly textColor: string;
}

export interface DisintegrateTimes {
  readonly dissolve: number;
  readonly sweep: number;
  readonly life: number;
  readonly fadeIn: number;
  readonly end: number;
}

export function disintegrateTimes(params: TextMotionParams): DisintegrateTimes {
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, T45_END);
  const end = params.durationSeconds;
  return { dissolve: end - (T45_END - T45_HOLD) * timeScale, sweep: T45_SWEEP * timeScale, life: T45_LIFE * timeScale,
    fadeIn: end - (T45_END - T45_EMPTY_END) * timeScale, end };
}

export function disintegratePlan(params: TextMotionParams, size: MotionFrameSize): DisintegratePlan {
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const offsetX = size.width / 2 - text.inkCenter[0], offsetY = size.height / 2 - text.inkCenter[1];
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const cellSize = Math.round(T45_CELL * glyphHeight * 100) / 100;
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop), accent = secondaryTone(params.palette, backdrop);
  const unit = frameUnit(size);
  const root = createSeededRng(ID, params.seed, "cells");
  const sampled = sampleGlyphCells(blockOutlines(text.block, offsetX, offsetY), { cellSize, minCoverage: MIN_COVERAGE,
    originX: offsetX + text.ink.x0, originY: offsetY + text.ink.y0 });
  const cells = sampled.map((cell, index) => {
    const rng = root.fork(index);
    const tone: 0 | 1 = rng.next() < T45_ACCENT_SHARE ? 1 : 0;
    return {
      x: cell.x + cell.size / 2, y: cell.y + cell.size / 2, size: cell.size, tone,
      color: tone ? accent : textColor,
      dx: rng.range(T45_DRIFT_X[0], T45_DRIFT_X[1]) * unit, dy: -rng.range(T45_DRIFT_Y[0], T45_DRIFT_Y[1]) * unit,
      spin: rng.range(-T45_SPIN, T45_SPIN),
    };
  });
  return {
    pathD: compactPathD(text.block.pathD), offsetX, offsetY, glyphHeight, cells, textColor,
    box: { x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY },
  };
}

/** x of the front on row y at sweep progress p (0 = left of the word, 1 = past its right edge). */
export function frontX(plan: DisintegratePlan, p: number, y: number): number {
  const lean = Math.tan((LEAN * Math.PI) / 180) * (plan.box.y1 - plan.box.y0);
  const wave = WAVE * plan.glyphHeight;
  const start = plan.box.x0 - lean - wave - plan.glyphHeight * 0.1, end = plan.box.x1 + lean + wave + plan.glyphHeight * 0.1;
  const middleY = (plan.box.y0 + plan.box.y1) / 2;
  // The top leads: rows above the middle are further right.
  return start + (end - start) * p - lean * ((y - middleY) / (plan.box.y1 - plan.box.y0))
    + wave * Math.sin(((y - plan.box.y0) / (WAVE_PERIOD * plan.glyphHeight)) * 2 * Math.PI);
}

/** Sweep progress at time t (0 before the dissolve). */
function sweepAt(times: DisintegrateTimes, t: number): number {
  return clamp01((t - times.dissolve) / times.sweep);
}

/** Time a cell detaches: when the front reaches its centre. */
function detachTime(plan: DisintegratePlan, times: DisintegrateTimes, cell: DustCell): number {
  // frontX is linear in p: solve frontX(p, y) = x.
  const a = frontX(plan, 0, cell.y), b = frontX(plan, 1, cell.y);
  return times.dissolve + clamp01((cell.x - a) / (b - a)) * times.sweep;
}

function squareD(cx: number, cy: number, edge: number, degrees: number): string {
  const r = edge / 2, c = Math.cos((degrees * Math.PI) / 180), s = Math.sin((degrees * Math.PI) / 180);
  const corners: Point2[] = [[-r, -r], [r, -r], [r, r], [-r, r]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as const);
  return polygonPathD(corners, 1);
}

export const T45_disintegrate = defineTextMotion(ID, (params, t, size) => {
  const plan = disintegratePlan(params, size), times = disintegrateTimes(params);
  const doc = createTextDocument(size, params);
  if (t < times.dissolve) return doc.render(path(plan.pathD, { fill: plan.textColor, transform: tf.translate(plan.offsetX, plan.offsetY) }));
  if (t >= times.fadeIn) {
    const opacity = smoothstep(times.fadeIn, times.end, t);
    if (opacity <= 0.002) return doc.render();
    return doc.render(path(plan.pathD, { fill: plan.textColor, opacity: opacity < 0.999 ? opacity : undefined,
      transform: tf.translate(plan.offsetX, plan.offsetY) }));
  }
  const p = sweepAt(times, t);
  const parts: string[] = [];
  // The crisp word ahead of the front: clipped to the region right of the (leaning, waving) front line.
  if (p < 1) {
    const steps = 24, y0 = plan.box.y0 - plan.glyphHeight, y1 = plan.box.y1 + plan.glyphHeight;
    const clip = pathData(1);
    for (let index = 0; index <= steps; index += 1) {
      const y = y0 + ((y1 - y0) * index) / steps, x = frontX(plan, p, y);
      if (index === 0) clip.M(x, y); else clip.L(x, y);
    }
    clip.L(size.width + 1, y1).L(size.width + 1, y0).Z();
    const clipUrl = doc.clipPath(path(clip.toString()));
    parts.push(g({ "clip-path": clipUrl }, path(plan.pathD, { fill: plan.textColor,
      transform: tf.translate(plan.offsetX, plan.offsetY) })));
  }
  // Detached cells, batched into one path per colour and opacity step.
  const buckets = new Map<string, { color: string; opacity: number; d: string }>();
  for (const cell of plan.cells) {
    const born = detachTime(plan, times, cell);
    if (t < born) continue;
    const q = (t - born) / times.life;
    if (q >= 1) continue;
    const opacity = Math.round((1 - cubicIn(q)) * OPACITY_LEVELS) / OPACITY_LEVELS;
    if (opacity <= 0) continue;
    const travel = quadOut(q) * 0.35 + q * q * 0.65;
    const edge = cell.size * CELL_FILL * (1 - (1 - T45_END_SCALE) * q);
    const key = `${cell.tone}|${opacity}`, bucket = buckets.get(key) ?? { color: cell.color, opacity, d: "" };
    bucket.d += squareD(cell.x + cell.dx * travel, cell.y + cell.dy * travel, edge, cell.spin * q);
    buckets.set(key, bucket);
  }
  for (const [, bucket] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    parts.push(path(bucket.d, { fill: bucket.color, opacity: bucket.opacity < 1 ? bucket.opacity : undefined }));
  }
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
