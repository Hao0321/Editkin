import { mixHex, relativeLuminance } from "../../svg/color";
import { g, path, pathData, rect, transform, tf } from "../../svg/document";
import { expoIn, expoOut } from "../../svg/easing";
import { assertMotionText, layoutLine, resolveMotionFace, type GlyphBox, type LineLayout, type MotionFontSelector } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, heroTextBox, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";

/**
 * T25 Split Flap (パタパタ), SWITCH: a departure board. Every character of every
 * line (one row per line, rows centred) gets its own cream split-flap card: a top
 * and a bottom flap (the lower one a touch darker) with the seam showing between
 * them. A single line of 4+ cells wraps onto two rows in a portrait frame when that
 * makes the cards larger, as a real board wraps on its grid. The cards unfold out of
 * their seams (0.2 s, 0.035 s apart), then riffle through seeded glyphs (digits,
 * capitals and board kanji, plus the text's own characters): every flip lasts
 * 40–60 ms and is drawn the way the mechanism works. The upper flap (the old
 * character's top half) falls toward the seam as scaleY = cos θ and darkens, shading
 * the half below it; past edge-on its back (the new character's bottom half) swings
 * down over the old bottom half, while the new top half already shows above. The
 * cards settle left to right, 0.08 s apart (first at 0.62 s), each landing with a
 * small flap bounce. The board holds, then every card folds shut into its seam
 * (expoIn, 0.045 s apart), gone 0.08 s before the end. Colours follow the reference:
 * cream cards with ink glyphs on the dark card; the riffling glyphs take the card's
 * second tone (accent2 on cream, ART_DIRECTION §0), so the settled ink characters
 * read as the answer; on a light plate the cards turn dark with paper glyphs. Flip
 * speed is mechanical (not energy-scaled); the settle and exit times are
 * standard-energy seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T25";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const UNFOLD = 0.2, UNFOLD_STAGGER = 0.035, RIFFLE_DELAY = 0.05;
const FIRST_SETTLE = 0.62, SETTLE_STAGGER = 0.08;
/** One flip: 40–60 ms (seeded), the same at every energy (a mechanism, not a gesture). */
const FLIP_MIN = 0.04, FLIP_MAX = 0.06;
/** The landing flap bounces back up by this angle (degrees) and drops again. */
const BOUNCE = 0.1, BOUNCE_DEGREES = 28;
const MIN_HOLD = 0.9, FOLD = 0.2, FOLD_STAGGER = 0.045, TAIL = 0.08;
/** Card geometry: height / width, gaps (× card width / height), glyph em (× card width), seam (× card height), corners. */
const CARD_ASPECT = 1.38, GAP = 0.07, ROW_GAP = 0.12, GLYPH_EM = 0.86, SEAM = 0.03, RADIUS = 0.06;
/** Lower flaps sit a touch darker than the upper ones; a falling flap darkens up to FLAP_SHADE and shades the half below it. */
const LOWER_SHADE = 0.07, FLAP_SHADE = 0.32, CAST_SHADE = 0.12;
/** Riffle pool: board glyphs (digits, capitals without I/O/Q, station kanji); the text's own characters are added. */
const RIFFLE_POOL = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ東西南北中上下出到站時分刻車班線路號";

export interface FlapFlip {
  /** Clip seconds. */
  readonly start: number;
  readonly end: number;
  /** Character shown before / after the flip ("" is a blank card). */
  readonly from: string;
  readonly to: string;
}

export interface FlapCard {
  readonly index: number;
  /** Target character ("" for a blank card). */
  readonly char: string;
  /** Card centre (frame px). */
  readonly cx: number;
  readonly cy: number;
  /** Clip seconds: unfold start, settle (last flip lands), fold start. */
  readonly appear: number;
  readonly settle: number;
  readonly foldAt: number;
  /** Seeded riffle; the last flip lands on `char` at `settle`. */
  readonly flips: readonly FlapFlip[];
}

export interface SplitFlapLayout {
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly fontSize: number;
  readonly timeScale: number;
  readonly cards: readonly FlapCard[];
  /** Board box (every card) at rest, frame px. */
  readonly box: GlyphBox;
  readonly face: MotionFontSelector;
}

const poolCache = new Map<string, readonly string[]>();

/** Riffle glyphs the face can draw (the text's own characters first), cached per face and text. */
function rifflePool(face: MotionFontSelector, texts: readonly string[]): readonly string[] {
  const own = [...new Set(texts.flatMap(text => [...text]).filter(character => character.trim() !== ""))];
  const key = `${resolveMotionFace(face).faceId}\u0000${own.join("")}`;
  const hit = poolCache.get(key);
  if (hit) return hit;
  const pool: string[] = [];
  for (const character of [...own, ...RIFFLE_POOL]) {
    if (pool.includes(character)) continue;
    try { assertMotionText(character, face); pool.push(character); } catch { /* the face lacks it: not a riffle glyph */ }
  }
  const frozen = Object.freeze(pool);
  poolCache.set(key, frozen);
  if (poolCache.size > 32) poolCache.delete(poolCache.keys().next().value!);
  return frozen;
}

/** Card width (px) of a board of `rows` inside the hero box. */
function boardCardWidth(rows: readonly (readonly string[])[], hero: { maxWidth: number; maxHeight: number }): number {
  const columns = Math.max(1, ...rows.map(row => row.length));
  const unitsWide = columns + GAP * (columns - 1);
  const unitsHigh = rows.length * CARD_ASPECT + ROW_GAP * CARD_ASPECT * (rows.length - 1);
  return Math.min(hero.maxWidth / unitsWide, hero.maxHeight / unitsHigh);
}

/**
 * Board rows: one per line. A single line of 4+ cells in a portrait frame wraps onto two rows (at the space nearest
 * the middle, else the middle cell) when that makes the cards larger, as a real board wraps on its grid.
 */
export function splitFlapRows(lines: readonly string[], size: MotionFrameSize, hero: { maxWidth: number; maxHeight: number }): string[][] {
  const rows = lines.map(line => [...line.trim()]);
  if (rows.length !== 1 || rows[0].length < 4 || size.height <= size.width) return rows;
  const cells = rows[0], middle = cells.length / 2;
  let cut = Math.ceil(middle), best = Infinity;
  cells.forEach((cell, index) => { if (cell.trim() === "" && Math.abs(index - middle) < best) { best = Math.abs(index - middle); cut = index; } });
  const wrapped = [cells.slice(0, cut), cells.slice(cut)].map(row => row.join("").trim()).map(row => [...row]).filter(row => row.length > 0);
  return wrapped.length === 2 && boardCardWidth(wrapped, hero) > boardCardWidth(rows, hero) ? wrapped : rows;
}

/** Board geometry, timing and the seeded riffle of every card (shared by the generator and its tests). */
export function splitFlapLayout(params: TextMotionParams, size: MotionFrameSize): SplitFlapLayout {
  // The board fills the hero box (ART_DIRECTION §0): 86% of the title-safe width, capped in height.
  const hero = heroTextBox(size, { heightFill: 0.66 });
  const rows = splitFlapRows(params.lines, size, hero);
  const columns = Math.max(1, ...rows.map(row => row.length));
  const count = rows.reduce((sum, row) => sum + row.length, 0);
  const natural = FIRST_SETTLE + SETTLE_STAGGER * (count - 1) + BOUNCE + MIN_HOLD + FOLD + FOLD_STAGGER * (count - 1) + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, natural);
  const face = textFace(params.font, 900);
  const safe = titleSafeBox(size);
  const unitsHigh = rows.length * CARD_ASPECT + ROW_GAP * CARD_ASPECT * (rows.length - 1);
  const cardWidth = boardCardWidth(rows, hero);
  const cardHeight = cardWidth * CARD_ASPECT;
  const fontSize = Number((GLYPH_EM * cardWidth).toFixed(3));
  const boardHeight = unitsHigh * cardWidth;
  const top = safe.cy - boardHeight / 2;
  const pool = rifflePool(face, params.lines);
  const exitStart = params.durationSeconds - (FOLD + FOLD_STAGGER * (count - 1) + TAIL) * timeScale;
  const cards: FlapCard[] = [];
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.length * cardWidth + GAP * cardWidth * (row.length - 1);
    const left = safe.cx - rowWidth / 2;
    const cy = top + rowIndex * cardHeight * (1 + ROW_GAP) + cardHeight / 2;
    row.forEach((character, column) => {
      const index = cards.length;
      const char = character.trim() === "" ? "" : character;
      const appear = UNFOLD_STAGGER * index * timeScale;
      const settle = (FIRST_SETTLE + SETTLE_STAGGER * index) * timeScale;
      // Flips are laid out backwards from the landing, so the last one lands exactly at `settle`.
      const rng = createSeededRng(ID, params.seed, `riffle/${index}`);
      const ends: number[] = [];
      let end = settle;
      const earliest = appear + RIFFLE_DELAY * timeScale;
      while (true) {
        const duration = rng.range(FLIP_MIN, FLIP_MAX);
        if (end - duration < earliest && ends.length > 0) break;
        ends.push(end);
        end -= duration;
        if (end <= earliest) break;
      }
      const starts = ends.map((value, k) => (k + 1 < ends.length ? ends[k + 1] : end));
      // Glyph sequence: seeded, never the same glyph twice in a row, landing on the target.
      const sequence: string[] = [char];
      for (let k = 0; k < ends.length; k += 1) {
        let pick = pool.length ? rng.pick(pool) : "";
        for (let attempt = 0; attempt < 8 && (pick === sequence[sequence.length - 1] || pick === char); attempt += 1) pick = rng.pick(pool);
        // Still a repeat after the retries: step through the pool (deterministic).
        for (let step = 1; step < pool.length && (pick === sequence[sequence.length - 1] || pick === char); step += 1) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
        sequence.push(pick);
      }
      sequence.reverse(); // sequence[0] shows first; sequence[last] = target
      // ends / starts run backwards from the landing; flip k (forwards) uses entry ends.length - 1 - k.
      const flips: FlapFlip[] = ends.map((_, k) => {
        const backward = ends.length - 1 - k;
        return { start: starts[backward], end: ends[backward], from: sequence[k], to: sequence[k + 1] };
      });
      cards.push({
        index, char, cx: left + column * cardWidth * (1 + GAP) + cardWidth / 2, cy, appear, settle,
        foldAt: exitStart + FOLD_STAGGER * index * timeScale, flips,
      });
    });
  });
  const boardWidth = columns * cardWidth + GAP * cardWidth * (columns - 1);
  return {
    cardWidth, cardHeight, fontSize, timeScale, cards, face,
    box: { x0: safe.cx - boardWidth / 2, y0: top, x1: safe.cx + boardWidth / 2, y1: top + boardHeight },
  };
}

/** A flap (half card) in card-local px: the seam is y = 0; rounded outer corners only. */
function flapPathD(width: number, height: number, radius: number, which: "top" | "bottom"): string {
  const half = width / 2, inner = (SEAM * height) / 2, outer = height / 2;
  const r = Math.min(radius, outer - inner), k = 0.5523 * r;
  const builder = pathData(2);
  if (which === "top") {
    return builder.M(-half, -inner).L(-half, -outer + r).C(-half, -outer + r - k, -half + r - k, -outer, -half + r, -outer)
      .L(half - r, -outer).C(half - r + k, -outer, half, -outer + r - k, half, -outer + r).L(half, -inner).Z().toString();
  }
  return builder.M(-half, inner).L(half, inner).L(half, outer - r).C(half, outer - r + k, half - r + k, outer, half - r, outer)
    .L(-half + r, outer).C(-half + r - k, outer, -half, outer - r + k, -half, outer - r).Z().toString();
}

interface FlapState {
  /** Upper and lower static halves (characters). */
  readonly upper: string;
  readonly lower: string;
  /** The moving flap, if any: which half it shows, its character and its vertical scale (about the seam). */
  readonly flap?: { readonly half: "top" | "bottom"; readonly char: string; readonly scale: number; readonly shade: number };
  /** Shadow cast on the lower half by a falling flap (0..1). */
  readonly cast: number;
}

/** What a card shows at clip time t (the riffle, the landing bounce, then the target). */
export function flapState(card: FlapCard, t: number, timeScale: number): FlapState {
  const flip = card.flips.find(candidate => t >= candidate.start && t < candidate.end);
  if (flip) {
    const theta = Math.PI * ((t - flip.start) / (flip.end - flip.start));
    const c = Math.cos(theta);
    if (c >= 0) return { upper: flip.to, lower: flip.from, flap: { half: "top", char: flip.from, scale: c, shade: FLAP_SHADE * (1 - c) }, cast: CAST_SHADE * Math.sin(theta) };
    return { upper: flip.to, lower: flip.from, flap: { half: "bottom", char: flip.to, scale: -c, shade: FLAP_SHADE * (1 + c) }, cast: CAST_SHADE * Math.sin(theta) };
  }
  const first = card.flips[0];
  if (first && t < first.start) return { upper: first.from, lower: first.from, cast: 0 };
  const since = t - card.settle, bounce = BOUNCE * timeScale;
  if (card.flips.length && since >= 0 && since < bounce) {
    // The landed flap bounces off its stop: up by BOUNCE_DEGREES and back down, showing a sliver of the old lower half.
    const angle = (BOUNCE_DEGREES * Math.PI / 180) * Math.sin(Math.PI * (since / bounce));
    const previous = card.flips[card.flips.length - 1].from;
    return { upper: card.char, lower: previous, flap: { half: "bottom", char: card.char, scale: Math.cos(angle), shade: FLAP_SHADE * (1 - Math.cos(angle)) }, cast: 0 };
  }
  return { upper: card.char, lower: card.char, cast: 0 };
}

/** How far a card is unfolded at clip time t: 0 closed (or gone) … 1 open; it unfolds out of its seam and folds back into it. */
export function splitFlapOpenAmount(card: FlapCard, t: number, timeScale: number): number {
  if (t < card.appear) return 0;
  const unfold = UNFOLD * timeScale;
  let open = t < card.appear + unfold ? expoOut((t - card.appear) / unfold) : 1;
  if (t >= card.foldAt) open *= 1 - expoIn(Math.min(1, (t - card.foldAt) / (FOLD * timeScale)));
  return open;
}

export const T25_splitFlap = defineTextMotion(ID, (params, t, size) => {
  const layout = splitFlapLayout(params, size);
  const doc = createTextDocument(size, params);
  const { cardWidth: w, cardHeight: h, fontSize, face } = layout;
  const backdrop = textBackdrop(params);
  const palette = params.palette;
  // Cream cards on dark or accent (the reference); dark cards on a light plate. Glyphs take the card's readable role.
  const card = readableColor(backdrop, [palette.paper, palette.bg], 1.6);
  const light = relativeLuminance(card) > 0.2;
  // The settled glyph is the card's text role; riffling glyphs take the card's second tone (accent2 on cream).
  const glyphColor = textOnBackground(palette, card);
  const riffleColor = secondaryTone(palette, card);
  const lower = mixHex(card, light ? palette.ink : palette.paper, LOWER_SHADE);
  const topD = flapPathD(w, h, RADIUS * w, "top"), bottomD = flapPathD(w, h, RADIUS * w, "bottom");
  const inner = (SEAM * h) / 2;
  const clipTop = doc.clipPath(rect(-w / 2, -h / 2, w, h / 2 - inner));
  const clipBottom = doc.clipPath(rect(-w / 2, inner, w, h / 2 - inner));
  const glyphs = new Map<string, string>();
  const glyph = (character: string, settled: boolean): string => {
    if (!character) return "";
    const key = `${settled ? 1 : 0}${character}`;
    let d = glyphs.get(key);
    if (d === undefined) {
      const line: LineLayout = layoutLine(character, { ...face, size: fontSize });
      // Centre the em box on the seam (every glyph shares one baseline, like a real board) and the advance on the axis.
      const baseline = -(line.emTop + line.emBottom) / 2;
      d = g({ transform: tf.translate(-line.width / 2, baseline) }, path(line.pathD, { fill: settled ? glyphColor : riffleColor }));
      glyphs.set(key, d);
    }
    return d;
  };

  const parts = layout.cards.map(flapCard => {
    const open = splitFlapOpenAmount(flapCard, t, layout.timeScale);
    if (open < 0.01) return "";
    const state = flapState(flapCard, t, layout.timeScale);
    // The target is drawn in the card's text role; every riffle glyph in its second tone (the target never riffles).
    const half = (which: "top" | "bottom", character: string, fill: string) =>
      [path(which === "top" ? topD : bottomD, { fill }),
        character ? g({ "clip-path": which === "top" ? clipTop : clipBottom }, glyph(character, character === flapCard.char)) : ""];
    const content: string[] = [
      ...half("bottom", state.lower, state.cast > 0 ? mixHex(lower, light ? palette.ink : palette.paper, state.cast) : lower),
      ...half("top", state.upper, card),
    ];
    if (state.flap && state.flap.scale > 0.01) {
      const base = state.flap.half === "top" ? card : lower;
      const fill = state.flap.shade > 0.001 ? mixHex(base, light ? palette.ink : palette.paper, state.flap.shade) : base;
      content.push(g({ transform: tf.scale(1, state.flap.scale) }, half(state.flap.half, state.flap.char, fill)));
    }
    return g({ transform: transform(tf.translate(flapCard.cx, flapCard.cy), open < 1 && tf.scale(1, open)) }, content);
  });
  return doc.render(parts);
}, { revision: REVISION });

