import { mixHex } from "../../svg/color";
import { g, path, transform, tf } from "../../svg/document";
import { clamp01, cubicInOut, sineInOut } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T72 Shuffle Letters (洗牌重排), RHYTHM: the characters start in a seeded
 * scrambled order that never already reads correctly, and sort themselves out by
 * swapping pairs: every 0.35 s two characters trade places along arcs, one over the
 * top and one under (arc height 45% of the glyph height, 0.3 s, cubic ease-in-out);
 * the one going over grows 8% and is drawn in front, the one going under shrinks 8%
 * and dims a little, so the pass reads in depth. The swap sequence is precomputed
 * from a seeded single cycle and solves it in the fewest swaps, the last one finishing
 * the word; of a dozen seeded cycles the one that keeps the fewest
 * neighbouring pairs of the word intact is used, so the start really looks shuffled,
 * preferring one that sorts by trading neighbours alone (no pass over a third
 * character; otherwise a selection sort). The solved word holds 0.8 s with a small 4% pop as it lands, then
 * re-scrambles in one 0.25 s hop of every character at once (those moving right hop
 * over, those moving left dip under, like the swaps) and the cycle repeats: a clip of
 * n cycles loops seamlessly (frame 0 equals the frame at the cycle length). Colours
 * alternate paper and accent per character of the target word and travel with the
 * characters (ART_DIRECTION §0; ink and accent2 on cream). Long text caps the swaps
 * at 5 (a partial shuffle).
 * Times are standard-energy seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T72";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const LEAD = 0.3, SWAP_EVERY = 0.35, SWAP = 0.3, HOLD = 0.8, JUMP = 0.25, TAIL = 0.05, MAX_SWAPS = 5;
/** Arc height (× glyph height), depth scale of the over / under pass, dimming of the one passing under. */
const ARC = 0.45, DEPTH = 0.08, UNDER_DIM = 0.25;
/** Solved pop and the re-scramble hop height (× glyph height). */
const POP = 0.04, POP_SECONDS = 0.22, HOP = 0.3;

export interface ShuffleGlyph {
  /** Index in the target word (sets the colour). */
  readonly index: number;
  readonly pathD: string;
  /** Pen origin offset from the slot centre (px), on the baseline. */
  readonly dx: number;
  readonly color: string;
}

export interface ShuffleLayout {
  readonly glyphs: readonly ShuffleGlyph[];
  /** Slot centres (frame px) in reading order, and the shared baseline. */
  readonly slots: readonly number[];
  readonly baseline: number;
  readonly glyphHeight: number;
  /** scramble[s] = target index of the character sitting in slot s at the start of a cycle. */
  readonly scramble: readonly number[];
  /** The swaps, as slot pairs, in order; applying them to `scramble` solves the word. */
  readonly swaps: ReadonlyArray<readonly [number, number]>;
  readonly timeScale: number;
  readonly cycles: number;
  readonly cycleSeconds: number;
  /** Ink box of the solved word (frame px). */
  readonly box: GlyphBox;
}

/** Scramble candidates tried per seed; the most shuffled-looking one wins. */
const SCRAMBLE_CANDIDATES = 12;

/** Inversions of an order: how many neighbour swaps sorting it takes. */
function inversions(order: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < order.length; i += 1) for (let j = i + 1; j < order.length; j += 1) if (order[i] > order[j]) count += 1;
  return count;
}

/**
 * Seeded scramble: a single cycle through `moved` of the n slots (all of them when n ≤ MAX_SWAPS + 1). Of
 * SCRAMBLE_CANDIDATES seeded cycles, those that still read as the target (repeated characters) are skipped and the one
 * keeping the fewest neighbouring pairs of the word intact wins, so the start really looks shuffled; among those, a cycle
 * that sorts in its `moved - 1` swaps by trading neighbours alone is preferred (ties: the first).
 */
function scrambleOrder(chars: readonly string[], seed: number): number[] {
  const n = chars.length, identity = chars.map((_, index) => index);
  if (n < 2) return identity;
  const moved = Math.min(n, MAX_SWAPS + 1);
  const rng = createSeededRng(ID, seed, "scramble");
  let best: number[] | undefined, bestScore = Infinity;
  for (let attempt = 0; attempt < SCRAMBLE_CANDIDATES; attempt += 1) {
    const pool = [...identity];
    for (let index = pool.length - 1; index > 0; index -= 1) { const j = rng.int(0, index); [pool[index], pool[j]] = [pool[j], pool[index]]; }
    // A random cyclic order of `moved` chosen slots: slot rotation[k] takes the character whose home is rotation[k + 1].
    const rotation = pool.slice(0, moved);
    const order = [...identity];
    for (let k = 0; k < rotation.length; k += 1) order[rotation[k]] = rotation[(k + 1) % rotation.length];
    if (order.map(index => chars[index]).join("") === chars.join("")) continue;
    let kept = 0;
    for (let slot = 0; slot + 1 < n; slot += 1) if (order[slot + 1] === order[slot] + 1) kept += 1;
    const score = 2 * kept + (inversions(order) === moved - 1 ? 0 : 1);
    if (score < bestScore) { best = order; bestScore = score; }
  }
  if (best) return best;
  // Every arrangement reads the same (e.g. 哈哈哈): swap the first two slots anyway.
  const fallback = [...identity];
  [fallback[0], fallback[1]] = [fallback[1], fallback[0]];
  return fallback;
}

/**
 * Slot pairs to swap, in order, solving the scramble in its fewest swaps. When that many neighbour swaps suffice
 * (inversions = selection-sort swaps), an insertion sort of neighbour swaps, so no pass crosses a third character;
 * otherwise a selection sort (each swap brings a character home).
 */
function sortSwaps(scramble: readonly number[]): Array<readonly [number, number]> {
  const state = [...scramble], swaps: Array<readonly [number, number]> = [];
  for (let slot = 0; slot < state.length; slot += 1) {
    if (state[slot] === slot) continue;
    const from = state.indexOf(slot);
    swaps.push([slot, from]);
    [state[slot], state[from]] = [state[from], state[slot]];
  }
  if (inversions(scramble) !== swaps.length) return swaps;
  const neighbours: Array<readonly [number, number]> = [], order = [...scramble];
  for (let slot = 1; slot < order.length; slot += 1) {
    for (let k = slot; k > 0 && order[k - 1] > order[k]; k -= 1) {
      neighbours.push([k - 1, k]);
      [order[k - 1], order[k]] = [order[k], order[k - 1]];
    }
  }
  return neighbours;
}

/** Glyphs, slots, the scramble and the swap schedule (shared by the generator and its tests). */
export function shuffleLayout(params: TextMotionParams, size: MotionFrameSize): ShuffleLayout {
  // Hero size (ART_DIRECTION §0) with room for the arcs above and below the line.
  const text = layoutFittedText(params.lines.slice(0, 1), textFace(params.font, 900), {
    ...heroTextBox(size, { heightFill: Math.min(0.62, 0.92 / (1 + 2 * ARC)) }), lineHeight: 1.04, tracking: displayTracking(params.lines.slice(0, 1)),
  });
  const safe = titleSafeBox(size);
  const line = text.block.lines[0];
  const offsetX = safe.cx - text.inkCenter[0], offsetY = safe.cy - text.inkCenter[1];
  const backdrop = textBackdrop(params);
  const tones = [textOnBackground(params.palette, backdrop), secondaryTone(params.palette, backdrop)];
  const visible = line.layout.glyphs.filter(glyph => !glyph.whitespace && glyph.bbox);
  let glyphHeight = 0;
  const slots: number[] = [];
  const glyphs = visible.map((glyph, index): ShuffleGlyph => {
    const bbox = glyph.bbox!;
    glyphHeight = Math.max(glyphHeight, bbox.y1 - bbox.y0);
    const centre = offsetX + line.x + glyph.x + (bbox.x0 + bbox.x1) / 2;
    slots.push(centre);
    return { index, pathD: glyph.pathD, dx: -(bbox.x0 + bbox.x1) / 2, color: tones[index % 2] };
  });
  const scramble = scrambleOrder(visible.map(glyph => glyph.char), params.seed);
  const swaps = sortSwaps(scramble);
  const natural = LEAD + (swaps.length ? SWAP + SWAP_EVERY * (swaps.length - 1) : 0) + HOLD + JUMP + TAIL;
  // As many whole cycles as fit at the energy's pace; each cycle then shares the clip equally.
  const { energy } = itemTiming(params.energy, params.durationSeconds, natural);
  const cycles = Math.max(1, Math.floor((params.durationSeconds + 1e-9) / (natural * energy.time)));
  const { timeScale } = itemTiming(params.energy, params.durationSeconds / cycles, natural);
  const ink = text.ink;
  return {
    glyphs, slots, baseline: offsetY + line.baselineY, glyphHeight, scramble, swaps, timeScale, cycles, cycleSeconds: params.durationSeconds / cycles,
    box: { x0: offsetX + ink.x0, y0: offsetY + ink.y0, x1: offsetX + ink.x1, y1: offsetY + ink.y1 },
  };
}

export interface ShufflePose {
  /** Horizontal centre (frame px), lift (px, positive = up), scale and dimming for each glyph (by target index). */
  readonly x: number;
  readonly lift: number;
  readonly scale: number;
  readonly dim: number;
  /** Draw order: higher on top. */
  readonly layer: number;
}

/** Every glyph's pose at clip time t. */
export function shufflePoses(layout: ShuffleLayout, t: number): ShufflePose[] {
  const ts = layout.timeScale, u = ((t % layout.cycleSeconds) + layout.cycleSeconds) % layout.cycleSeconds;
  // Slot of every glyph after k swaps.
  const slotOf = (swapsDone: number) => {
    const state = [...layout.scramble];
    for (let k = 0; k < swapsDone; k += 1) { const [a, b] = layout.swaps[k]; [state[a], state[b]] = [state[b], state[a]]; }
    const slots = new Array<number>(state.length);
    state.forEach((glyph, slot) => { slots[glyph] = slot; });
    return slots;
  };
  const poses: ShufflePose[] = layout.glyphs.map(glyph => ({ x: layout.slots[glyph.index], lift: 0, scale: 1, dim: 0, layer: 0 }));
  const swapStart = (k: number) => (LEAD + SWAP_EVERY * k) * ts;
  const solvedAt = layout.swaps.length ? swapStart(layout.swaps.length - 1) + SWAP * ts : LEAD * ts;
  const jumpAt = solvedAt + HOLD * ts;
  if (u >= jumpAt) {
    // Re-scramble: every character hops from home to its scrambled slot at once; those moving right hop over (in front,
    // a little larger), those moving left dip under (behind, a little smaller and dimmer), so crossings never collide.
    const p = clamp01((u - jumpAt) / (JUMP * ts)), start = slotOf(layout.swaps.length), end = slotOf(0), arc = Math.sin(Math.PI * p);
    return layout.glyphs.map(glyph => {
      const from = layout.slots[start[glyph.index]], to = layout.slots[end[glyph.index]], direction = Math.sign(to - from);
      return {
        x: from + (to - from) * sineInOut(p), lift: direction * HOP * layout.glyphHeight * arc,
        scale: 1 + direction * DEPTH * arc, dim: direction < 0 ? UNDER_DIM * arc : 0, layer: direction,
      };
    });
  }
  let done = 0;
  while (done < layout.swaps.length && u >= swapStart(done) + SWAP * ts) done += 1;
  const slots = slotOf(done);
  layout.glyphs.forEach(glyph => { poses[glyph.index] = { x: layout.slots[slots[glyph.index]], lift: 0, scale: 1, dim: 0, layer: 0 }; });
  if (done < layout.swaps.length && u >= swapStart(done)) {
    // The active swap: the glyph leaving the lower slot goes over the top, the other under.
    const p = (u - swapStart(done)) / (SWAP * ts), e = cubicInOut(p), arc = Math.sin(Math.PI * p);
    const [a, b] = layout.swaps[done];
    const state = [...layout.scramble];
    for (let k = 0; k < done; k += 1) { const [sa, sb] = layout.swaps[k]; [state[sa], state[sb]] = [state[sb], state[sa]]; }
    const over = state[Math.min(a, b)], under = state[Math.max(a, b)];
    const from = layout.slots[Math.min(a, b)], to = layout.slots[Math.max(a, b)];
    poses[over] = { x: from + (to - from) * e, lift: ARC * layout.glyphHeight * arc, scale: 1 + DEPTH * arc, dim: 0, layer: 2 };
    poses[under] = { x: to + (from - to) * e, lift: -ARC * layout.glyphHeight * arc, scale: 1 - DEPTH * arc, dim: UNDER_DIM * arc, layer: -1 };
  } else if (done === layout.swaps.length && u >= solvedAt && u < solvedAt + POP_SECONDS * ts) {
    // Solved: one small pop of the whole word.
    const pop = 1 + POP * Math.sin(Math.PI * ((u - solvedAt) / (POP_SECONDS * ts)));
    return poses.map(pose => ({ ...pose, scale: pop }));
  }
  return poses;
}

export const T72_shuffleLetters = defineTextMotion(ID, (params, t, size) => {
  const layout = shuffleLayout(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const poses = shufflePoses(layout, t);
  const order = layout.glyphs.map(glyph => glyph.index).sort((a, b) => poses[a].layer - poses[b].layer || a - b);
  const parts = order.map(index => {
    const glyph = layout.glyphs[index], pose = poses[index];
    const fill = pose.dim > 0.001 ? mixHex(glyph.color, backdrop, pose.dim) : glyph.color;
    const y = layout.baseline - pose.lift;
    const anchorY = layout.baseline - layout.glyphHeight / 2 - pose.lift;
    return path(glyph.pathD, {
      fill, transform: pose.scale !== 1
        ? transform(tf.translate(pose.x, anchorY), tf.scale(pose.scale), tf.translate(glyph.dx, y - anchorY))
        : tf.translate(pose.x + glyph.dx, y),
    });
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
