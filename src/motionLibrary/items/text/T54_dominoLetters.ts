import { g, line, path, roundRect, tf, transform } from "../../svg/document";
import { backOut, clamp01, cubicIn, energyProfile, loopPhase, quadIn, quadOut } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, frameUnit, layoutFittedText, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD, distinctFrom } from "./T09_hugeTextScroll";

/**
 * T54 Domino Letters (骨牌倒下), PLAY, shown on the accent plate: the characters
 * stand on a thin floor line (the text colour at 30%) like dominoes, every other
 * one on a cream tile (rounded rectangle). One after another, 0.1 s apart, each
 * tips over clockwise about its bottom-right corner: 0 → 88° in 0.22 s (cubicIn,
 * like gravity), knocks against its neighbour and rebounds 88 → 82 → 88° (0.08 s
 * each way), lies still for 0.35 s, then stands back up in the same order
 * (88 → 0° in 0.25 s, backOut). The backOut overshoot rocks a tile past upright,
 * and then it pivots on its bottom-left corner instead, so no tile ever dips
 * through the floor. A seamless 2 s loop (catalog loopSeconds): the word stands
 * still from 1.43 s until the next fall at 0.12 s.
 *
 * Every character is a domino of the same size (the tile: the widest and tallest
 * glyph plus padding), whether or not its tile is drawn, so the chain has an even
 * rhythm; the text is letter-spaced so standing tiles keep a gap. Fallen tiles
 * reach one tile height past the last pivot: the word, its tiles, the fallen chain
 * and the first tile rocking back all stay inside the 5% title-safe box, so the
 * standing word sits left of centre with the floor running out to where the chain
 * lands. Colours: ink glyphs,
 * cream tiles on the coral card (as in the reference); a glyph on a tile is always
 * read against the tile; bare glyphs follow the contrast rule (cream on the dark
 * card). Energy deepens the rebound and the stand-up overshoot.
 */

const ID = "T54";
const REVISION = 1;
export const T54_LOOP_SECONDS = 2;
/** Timing (seconds): first fall, stagger, fall, rebound (each way), rest, stand-up. */
export const T54_START = 0.12, T54_STAGGER = 0.1, T54_FALL = 0.22, T54_REBOUND = 0.08, T54_REST = 0.35, T54_STAND = 0.25;
/** Angles (degrees, clockwise): lying, rebound peak. */
export const T54_DOWN = 88, T54_REBOUND_TO = 82;
/** Tile padding (× glyph height), tile corner (× tile width), letter spacing (em), floor stroke (1080 units). */
const PAD = 0.06, CORNER = 0.12, TRACKING = 0.24, FLOOR_UNITS = 4, FLOOR_OPACITY = 0.3;
/** Share of the safe width the whole chain (standing word plus the last fallen tile) may take. */
const CHAIN_FILL = 0.94;

export interface Domino {
  readonly index: number;
  readonly pathD: string;
  /** Glyph pen origin (frame px). */
  readonly x: number;
  readonly y: number;
  /** The domino body (frame px): the tile, drawn or not. Pivots are its bottom corners. */
  readonly tile: GlyphBox;
  readonly tiled: boolean;
}

export interface DominoPlan {
  readonly dominoes: readonly Domino[];
  readonly floorY: number;
  readonly floorX0: number;
  readonly floorX1: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly stagger: number;
  readonly amplitude: number;
}

export function dominoPlan(params: TextMotionParams, size: MotionFrameSize): DominoPlan {
  const safe = titleSafeBox(size);
  const face = textFace(params.font, 900);
  // Measure at a probe size, then size the whole chain (word + the last tile lying flat) to the safe width.
  const probe = layoutFittedText(params.lines.slice(0, 1), face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: 100, lineHeight: 1, tracking: TRACKING });
  const probeGlyphs = probe.block.lines[0].layout.glyphs.filter(glyph => glyph.bbox && !glyph.whitespace);
  const probeH = Math.max(1, ...probeGlyphs.map(glyph => glyph.bbox!.y1 - glyph.bbox!.y0));
  const probeW = Math.max(1, ...probeGlyphs.map(glyph => glyph.bbox!.x1 - glyph.bbox!.x0));
  const probeTileH = probeH + 2 * PAD * probeH, probeTileW = probeW + 2 * PAD * probeH;
  // Room on the left for the first tile rocking back past upright (the stand-up's backOut overshoot).
  const amplitude = Math.min(1.5, energyProfile(params.energy).amplitude);
  const backSin = Math.sin((T54_DOWN * backOutPeak(1.70158 * amplitude) * Math.PI) / 180);
  // Measured exactly as the final layout: uniform tiles centred on each glyph, the last one lying flat past its pivot.
  const probeLine = probe.block.lines[0];
  const probeCenters = probeGlyphs.map(glyph => probeLine.x + glyph.x + (glyph.bbox!.x0 + glyph.bbox!.x1) / 2);
  const probeChain = Math.max(...probeCenters) - Math.min(...probeCenters) + probeTileW + probeTileH + backSin * probeTileH;
  const scale = Math.min((CHAIN_FILL * safe.width) / probeChain, (0.6 * safe.height) / probeTileH, (0.98 * safe.height) / (2 * probeTileW));
  const text = layoutFittedText(params.lines.slice(0, 1), face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: Number((100 * scale).toFixed(3)), lineHeight: 1, tracking: TRACKING });
  const glyphs = text.block.lines[0].layout.glyphs.filter(glyph => glyph.bbox && !glyph.whitespace);
  const glyphHeight = Math.max(1, ...glyphs.map(glyph => glyph.bbox!.y1 - glyph.bbox!.y0));
  const glyphWidth = Math.max(1, ...glyphs.map(glyph => glyph.bbox!.x1 - glyph.bbox!.x0));
  const pad = PAD * glyphHeight;
  const tileWidth = glyphWidth + 2 * pad, tileHeight = glyphHeight + 2 * pad;
  // Centre the chain extent (first tile's left edge → last pivot + one tile height) in the safe box.
  const line = text.block.lines[0];
  const centers = glyphs.map(glyph => line.x + glyph.x + (glyph.bbox!.x0 + glyph.bbox!.x1) / 2);
  const middles = glyphs.map(glyph => line.baselineY + (glyph.bbox!.y0 + glyph.bbox!.y1) / 2);
  const left = Math.min(...centers) - tileWidth / 2, lastPivot = Math.max(...centers) + tileWidth / 2;
  const reachLeft = left - backSin * tileHeight;
  const chain = lastPivot + tileHeight - reachLeft;
  const dx = safe.cx - chain / 2 - reachLeft;
  const middle = middles.reduce((sum, value) => sum + value, 0) / Math.max(1, middles.length);
  const dy = safe.cy - middle;
  const floorY = safe.cy + tileHeight / 2;
  const dominoes: Domino[] = glyphs.map((glyph, index) => {
    const cx = centers[index] + dx;
    return {
      index, pathD: compactPathD(glyph.pathD), x: line.x + glyph.x + dx,
      y: line.baselineY + dy + (safe.cy - (middles[index] + dy)),
      tile: { x0: cx - tileWidth / 2, y0: floorY - tileHeight, x1: cx + tileWidth / 2, y1: floorY }, tiled: index % 2 === 0,
    };
  });
  const n = dominoes.length;
  // Long words compress the stagger so the last tile is up again before the loop wraps.
  const chainTime = T54_FALL + 2 * T54_REBOUND + T54_REST + T54_STAND;
  const stagger = n > 1 ? Math.min(T54_STAGGER, (T54_LOOP_SECONDS - 0.4 - T54_START - chainTime) / (n - 1)) : T54_STAGGER;
  return {
    dominoes, floorY, floorX0: left + dx - 0.04 * tileWidth, floorX1: lastPivot + dx + tileHeight + 0.04 * tileWidth,
    tileWidth, tileHeight, stagger, amplitude,
  };
}

/** How far backOut(p, overshoot) rises above 1 at its peak (sampled): the stand-up rocks back this share of 88°. */
function backOutPeak(overshoot: number): number {
  let peak = 0;
  for (let step = 0; step <= 200; step += 1) peak = Math.max(peak, backOut(step / 200, overshoot) - 1);
  return peak;
}

/** Tilt of domino `index` at loop time u (degrees, clockwise; negative = rocked back past upright). */
export function dominoAngle(plan: DominoPlan, index: number, u: number): number {
  const start = T54_START + index * plan.stagger;
  const local = u - start;
  if (local <= 0) return 0;
  const rebound = (T54_DOWN - T54_REBOUND_TO) * plan.amplitude;
  if (local < T54_FALL) return T54_DOWN * cubicIn(local / T54_FALL);
  let at = T54_FALL;
  if (local < at + T54_REBOUND) return T54_DOWN - rebound * quadOut((local - at) / T54_REBOUND);
  at += T54_REBOUND;
  if (local < at + T54_REBOUND) return T54_DOWN - rebound + rebound * quadIn((local - at) / T54_REBOUND);
  at += T54_REBOUND + T54_REST;
  if (local < at) return T54_DOWN;
  if (local < at + T54_STAND) return T54_DOWN * (1 - backOut(clamp01((local - at) / T54_STAND), 1.70158 * plan.amplitude));
  return 0;
}

/** Placement of a domino tilted by `degrees`: rotate about its bottom-right corner (clockwise) or bottom-left (rocked back). */
export function dominoTransform(domino: Domino, degrees: number): string | undefined {
  if (Math.abs(degrees) < 1e-6) return undefined;
  const pivotX = degrees > 0 ? domino.tile.x1 : domino.tile.x0;
  return transform(tf.rotate(degrees, pivotX, domino.tile.y1));
}

export const T54_dominoLetters = defineTextMotion(ID, (params, t, size) => {
  const plan = dominoPlan(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const bare = textOnBackground(params.palette, backdrop);
  const tileColor = distinctFrom(backdrop, params.palette.paper, [params.palette.accent, params.palette.ink]);
  const onTile = textOnBackground(params.palette, tileColor);
  const u = loopPhase(t, T54_LOOP_SECONDS) * T54_LOOP_SECONDS;
  const radius = CORNER * plan.tileWidth;
  const floor = line(plan.floorX0, plan.floorY, plan.floorX1, plan.floorY,
    { stroke: bare, "stroke-opacity": FLOOR_OPACITY, "stroke-width": FLOOR_UNITS * frameUnit(size), "stroke-linecap": "round" });
  // Later dominoes are drawn first: a falling tile lands on top of the one it knocks over.
  const parts = [...plan.dominoes].reverse().map(domino => {
    const tilt = dominoTransform(domino, dominoAngle(plan, domino.index, u));
    const { tile } = domino;
    return g({ transform: tilt },
      domino.tiled ? roundRect(tile.x0, tile.y0, tile.x1 - tile.x0, tile.y1 - tile.y0, radius, { fill: tileColor }) : "",
      path(domino.pathD, { fill: domino.tiled ? onTile : bare, transform: tf.translate(domino.x, domino.y) }));
  });
  return doc.render(floor, parts);
}, { revision: REVISION });
