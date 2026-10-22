import { createSvgDocument, emptySvg, g, path, rect } from "../../svg/document";
import { backOut, clamp01, energyProfile } from "../../svg/easing";
import { layoutTextBlock } from "../../svg/glyphs";
import { flattenPathD, transformPathD, type FlatPoint } from "../../svg/pathOps";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, displayTracking, frameUnit, heroTextBox, layoutFittedText, MATTE_SHOW_B, textFace } from "../shared";

/**
 * X20 Text Wipe: a title, 「轉場」 in the display face (Noto Sans TC 900), pops out
 * at hero size (86% of the title-safe width) and then scales up hugely; its fill is
 * B, so when one of its strokes fills the frame, B has taken over. Over A the word
 * carries a deep-shade (accent2) keyline outside its letters, so it reads over any
 * footage; the keyline thins away as the zoom takes over.
 *
 * The zoom is about the stroke point farthest from the outline in a glyph (its pole
 * of inaccessibility, found once on the outline at a reference size): the word pops
 * out of that point (back-out, 0 → hero), holds while it pushes in by 4%, then zooms
 * exponentially until the circle inscribed at that point has swallowed the farthest
 * frame corner, so the stroke covers the whole frame. The seed picks the glyph
 * (seed 1: the one with the thickest stroke).
 *
 * Timing: pop 0–13%, push 13–20%, zoom 20–94% (all B after). The zoom's log-scale
 * progress runs through a time warp: an ease-in to the value at which B covers exactly
 * half the frame at D/2, then a slope-matched cubic that keeps accelerating, so the
 * stroke punches through to full cover; the half value is solved from
 * the word's flattened outline with an exact per-row (nonzero winding) scanline
 * (ART_DIRECTION §4: switch at 45–55%). The matte is the outline filled and dilated by
 * a 1.5 px (at 1080) stroke, under the keyline, so no seam of A shows; the keyline is
 * outside-only (a stroke masked by the fill, so the font's overlapping contours never
 * show), 14 px (at 1080) × √amplitude at hero size. t = 0 is pure A (the word has no
 * size yet) and t = D pure B with an empty overlay. Energy sets the pop overshoot and
 * the warp power. Not directional. The word is fixed: transition params carry no
 * text.
 */

const ID = "X20";
const REVISION = 1;
const WORD = "轉場";
/** Em size of the reference layout used for the size-independent geometry. */
const REFERENCE_SIZE = 200;
/** Phase ends (fractions of the duration): pop, push, zoom. */
const POP_END = 0.13, PUSH_END = 0.2, ZOOM_END = 0.94;
const PUSH_SCALE = 1.04;
const KEYLINE = 14;
const TUCK = 1.5;
const OVERSHOOT: Record<MotionEnergy, number> = { calm: 0.6, standard: 1.1, punchy: 1.5, hype: 1.9 };
const WARP_POWER: Record<MotionEnergy, number> = { calm: 1.1, standard: 1.3, punchy: 1.45, hype: 1.6 };
/** Scanline rows of the coverage solve. */
const ROWS = 160;

interface Entry {
  /** Reference-layout coordinates of the zoom point and the radius of the circle inscribed there. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly glyph: number;
}

interface WordShape {
  /** The outline split into its contours (absolute path data, reference layout) with their bounding boxes. */
  readonly pieces: readonly { readonly d: string; readonly box: readonly [number, number, number, number] }[];
  /** Flattened edges x0, y0, x1, y1 (reference layout). */
  readonly edges: Float64Array;
  readonly inkCenter: readonly [number, number];
  /** Best zoom point per glyph, thickest stroke first. */
  readonly entries: readonly Entry[];
}

/** Nonzero winding number of (x, y) against the flattened edges. */
function winding(edges: Float64Array, x: number, y: number): number {
  let total = 0;
  for (let index = 0; index < edges.length; index += 4) {
    const y0 = edges[index + 1], y1 = edges[index + 3];
    if ((y0 <= y) === (y1 <= y)) continue;
    const at = edges[index] + ((y - y0) * (edges[index + 2] - edges[index])) / (y1 - y0);
    if (at > x) total += y1 > y0 ? 1 : -1;
  }
  return total;
}

/** Distance from (x, y) to the nearest flattened edge. */
function edgeDistance(edges: Float64Array, x: number, y: number): number {
  let best = Infinity;
  for (let index = 0; index < edges.length; index += 4) {
    const ax = edges[index], ay = edges[index + 1], dx = edges[index + 2] - ax, dy = edges[index + 3] - ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
    const ex = ax + t * dx - x, ey = ay + t * dy - y;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

let wordShape: WordShape | undefined;
/** The word's outline at the reference size and its zoom points (computed once per process). */
export function textWipeShape(): WordShape {
  if (wordShape) return wordShape;
  const block = layoutTextBlock([WORD], { ...textFace("display", 900), size: REFERENCE_SIZE, lineHeight: 1.04, tracking: displayTracking([WORD]) });
  const contours: FlatPoint[][] = flattenPathD(block.pathD, { segmentLength: 2, label: ID });
  const pieces = block.pathD.split(/(?=M)/).filter(Boolean).map(d => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const contour of flattenPathD(d, { segmentLength: 2, label: ID })) {
      for (const [x, y] of contour) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return Object.freeze({ d, box: Object.freeze([x0, y0, x1, y1] as const) });
  }).filter(piece => Number.isFinite(piece.box[0]));
  const edgeList: number[] = [];
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const [ax, ay] = contour[index], [bx, by] = contour[(index + 1) % contour.length];
      edgeList.push(ax, ay, bx, by);
    }
  }
  const edges = Float64Array.from(edgeList);
  const ink = block.inkBox!;
  const line = block.lines[0];
  const glyphs = line.layout.glyphs.filter(glyph => !glyph.whitespace);
  const glyphOf = (x: number) => {
    let found = 0;
    glyphs.forEach((glyph, index) => { if (x >= line.x + glyph.x) found = index; });
    return found;
  };
  // Coarse grid, then a fine search around the best few candidates of each glyph.
  const coarse = 5, candidates: Entry[] = [];
  for (let y = ink.y0 + coarse / 2; y < ink.y1; y += coarse) {
    for (let x = ink.x0 + coarse / 2; x < ink.x1; x += coarse) {
      if (winding(edges, x, y) !== 0) candidates.push({ x, y, radius: edgeDistance(edges, x, y), glyph: glyphOf(x) });
    }
  }
  const entries: Entry[] = [];
  for (let glyph = 0; glyph < glyphs.length; glyph += 1) {
    const top = candidates.filter(entry => entry.glyph === glyph).sort((a, b) => b.radius - a.radius).slice(0, 4);
    let best = top[0];
    for (const seed of top) {
      for (let dy = -coarse; dy <= coarse; dy += 0.5) {
        for (let dx = -coarse; dx <= coarse; dx += 0.5) {
          const x = seed.x + dx, y = seed.y + dy;
          if (winding(edges, x, y) === 0) continue;
          const radius = edgeDistance(edges, x, y);
          if (radius > best.radius) best = { x, y, radius, glyph };
        }
      }
    }
    if (best) entries.push(best);
  }
  entries.sort((a, b) => b.radius - a.radius);
  wordShape = Object.freeze({ pieces: Object.freeze(pieces), edges, inkCenter: [(ink.x0 + ink.x1) / 2, (ink.y0 + ink.y1) / 2] as const, entries: Object.freeze(entries) });
  return wordShape;
}

/** The zoom point for a seed (seed 1: the thickest stroke). */
export function textWipeEntry(seed: number): Entry {
  const { entries } = textWipeShape();
  return entries[(((seed - 1) % entries.length) + entries.length) % entries.length];
}

interface Placement {
  /** Reference units → hero px. */
  readonly k: number;
  /** The zoom point in frame px at hero size. */
  readonly anchor: readonly [number, number];
  readonly entry: Entry;
  /** Zoom scale (relative to hero) at which the inscribed circle covers every frame corner. */
  readonly endScale: number;
}

const placementCache = new Map<string, Placement>();
function placement(seed: number, size: MotionFrameSize): Placement {
  const key = `${size.width}x${size.height}@${seed}`;
  const hit = placementCache.get(key);
  if (hit) return hit;
  const shape = textWipeShape(), entry = textWipeEntry(seed);
  const fitted = layoutFittedText([WORD], textFace("display", 900), { ...heroTextBox(size), lineHeight: 1.04, tracking: displayTracking([WORD]) });
  const k = fitted.fontSize / REFERENCE_SIZE;
  const anchor = [size.width / 2 + k * (entry.x - shape.inkCenter[0]), size.height / 2 + k * (entry.y - shape.inkCenter[1])] as const;
  const corner = Math.max(...[[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]].map(([x, y]) => Math.hypot(x - anchor[0], y - anchor[1])));
  const result = Object.freeze({ k, anchor, entry, endScale: (corner + 4) / (k * entry.radius) });
  placementCache.set(key, result);
  if (placementCache.size > 64) placementCache.delete(placementCache.keys().next().value!);
  return result;
}

/** Share of the frame the word covers at zoom `scale` (relative to hero, about the zoom point): an exact per-row scanline. */
export function textWipeCoverage(seed: number, scale: number, size: MotionFrameSize): number {
  if (!(scale > 0)) return 0;
  const { edges } = textWipeShape(), { k, anchor, entry } = placement(seed, size);
  const factor = k * scale;
  let covered = 0;
  const hits: Array<readonly [number, number]> = [];
  for (let row = 0; row < ROWS; row += 1) {
    const y = entry.y + (((row + 0.5) * size.height) / ROWS - anchor[1]) / factor;
    hits.length = 0;
    for (let index = 0; index < edges.length; index += 4) {
      const y0 = edges[index + 1], y1 = edges[index + 3];
      if ((y0 <= y) === (y1 <= y)) continue;
      hits.push([edges[index] + ((y - y0) * (edges[index + 2] - edges[index])) / (y1 - y0), y1 > y0 ? 1 : -1]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let index = 0; index + 1 < hits.length; index += 1) {
      wind += hits[index][1];
      if (wind === 0) continue;
      const x0 = anchor[0] + factor * (hits[index][0] - entry.x), x1 = anchor[0] + factor * (hits[index + 1][0] - entry.x);
      covered += Math.max(0, Math.min(size.width, x1) - Math.max(0, x0));
    }
  }
  return covered / (ROWS * size.width);
}

/** Zoom scale at log-progress z (0: the pushed-in hero, 1: the end scale). */
function zoomScale(z: number, endScale: number): number {
  return PUSH_SCALE * (endScale / PUSH_SCALE) ** z;
}

const halfZoomCache = new Map<string, number>();
/** z½: the log-progress at which the word covers exactly half the frame (the last upward crossing). */
function halfZoom(seed: number, size: MotionFrameSize): number {
  const key = `${size.width}x${size.height}@${seed}`;
  const hit = halfZoomCache.get(key);
  if (hit !== undefined) return hit;
  const { endScale } = placement(seed, size);
  const coverageAt = (z: number) => textWipeCoverage(seed, zoomScale(z, endScale), size);
  const samples = 48;
  let low = 0, high = 1;
  for (let index = samples - 1; index >= 0; index -= 1) {
    if (coverageAt(index / samples) < 0.5) { low = index / samples; high = (index + 1) / samples; break; }
  }
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) / 2;
    if (coverageAt(middle) < 0.5) low = middle; else high = middle;
  }
  const result = (low + high) / 2;
  halfZoomCache.set(key, result);
  if (halfZoomCache.size > 64) halfZoomCache.delete(halfZoomCache.keys().next().value!);
  return result;
}

/**
 * Log-progress of the zoom at x (0 → 1 over the zoom phase) with z(middle) = half: an ease-in (power) to the
 * midpoint, then a slope-matched cubic that keeps accelerating into full cover (z = half + s·y + (1 − half − s)·y³),
 * so the last counters fly past instead of crawling. When the midpoint slope is already steeper than that allows,
 * a slope-matched ease-out takes over.
 */
export function textWipeWarp(x: number, middle: number, half: number, power: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x <= middle) return half * (x / middle) ** power;
  const y = (x - middle) / (1 - middle), rest = 1 - half;
  const slope = (power * half * (1 - middle)) / middle;
  if (slope <= rest) return half + slope * y + (rest - slope) * y ** 3;
  const ratio = slope / rest;
  return half + rest * (1 - (1 - y) ** ratio);
}

/** The word's zoom scale (relative to hero) at progress p, and the zoom's log-progress (0 until the zoom starts). */
export function textWipeScale(p: number, seed: number, energy: MotionEnergy, size: MotionFrameSize): { readonly scale: number; readonly zoom: number } {
  if (p <= 0) return { scale: 0, zoom: 0 };
  if (p < POP_END) return { scale: backOut(p / POP_END, OVERSHOOT[energy]), zoom: 0 };
  if (p < PUSH_END) {
    const x = (p - POP_END) / (PUSH_END - POP_END);
    return { scale: 1 + (PUSH_SCALE - 1) * x, zoom: 0 };
  }
  const { endScale } = placement(seed, size);
  const middle = (0.5 - PUSH_END) / (ZOOM_END - PUSH_END);
  const zoom = textWipeWarp((p - PUSH_END) / (ZOOM_END - PUSH_END), middle, halfZoom(seed, size), WARP_POWER[energy]);
  return { scale: zoomScale(zoom, endScale), zoom };
}

export const X20_textWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= ZOOM_END) return { matte: allB(), overlay: emptySvg(size) };

  const shape = textWipeShape(), { k, anchor, entry } = placement(params.seed, size);
  const { scale, zoom } = textWipeScale(p, params.seed, params.energy, size);
  const factor = k * scale;
  if (!(factor > 1e-4)) return { matte: matte.render(), overlay: emptySvg(size) };
  const unit = frameUnit(size);
  // The keyline grows in with the pop and thins away over the zoom.
  const keyline = KEYLINE * unit * Math.sqrt(energyProfile(params.energy).amplitude) * Math.min(1, p / POP_END) * (1 - zoom) ** 1.5;
  const tuck = TUCK * unit, margin = keyline + tuck + 2;
  // Keep only the contours that reach the frame: a contour wholly outside it cannot change the fill inside it.
  const matrix = [factor, 0, 0, factor, anchor[0] - factor * entry.x, anchor[1] - factor * entry.y] as const;
  let wordD = "";
  for (const { d, box } of shape.pieces) {
    const x0 = matrix[0] * box[0] + matrix[4], y0 = matrix[3] * box[1] + matrix[5], x1 = matrix[0] * box[2] + matrix[4], y1 = matrix[3] * box[3] + matrix[5];
    if (x1 < -margin || y1 < -margin || x0 > size.width + margin || y0 > size.height + margin) continue;
    wordD += transformPathD(d, matrix, 2);
  }
  const matteSvg = matte.render(path(wordD, { fill: MATTE_SHOW_B, stroke: MATTE_SHOW_B, "stroke-width": 2 * tuck, "stroke-linejoin": "round" }));
  if (!(keyline > 0.05) || !wordD) return { matte: matteSvg, overlay: emptySvg(size) };
  const overlay = createSvgDocument(size);
  // Outside-only keyline: a stroke painted first, then the fill in black on top masks its inner half and every inner contour line.
  const mask = overlay.mask(path(wordD, { fill: "#000000", stroke: "#FFFFFF", "stroke-width": 2 * keyline, "stroke-linejoin": "round", "paint-order": "stroke" }));
  return { matte: matteSvg, overlay: overlay.render(g({ mask }, rect(0, 0, size.width, size.height, { fill: params.palette.accent2 }))) };
}, { revision: REVISION });
