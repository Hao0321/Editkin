import { g, path, rect, tf } from "../../svg/document";
import { translatePathD, type GlyphBox } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, displayTracking, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace,
  textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T34 Glitch Slices (グリッチ), STYLE, shown on the accent plate: a huge word cut
 * into 6–10 horizontal slices of uneven, seeded thickness (clipPath bands). In a
 * glitch burst the slices jump sideways by seeded offsets, a few of them far,
 * and each slice carries a small two-tone colour split (copies offset left and
 * right in the item's own tones: accent2 and cream on the orange card, the accent
 * and its deep shade on the dark card), and up to two blocks of corrupted data
 * flash in the word box; then the word snaps back clean. No neon RGB, no filters.
 *
 * Program (standard-energy seconds, compressed for short clips): the word glitches
 * in over 0.2 s (slices arrive in four 0.05 s states, from a few far-flung slices
 * to the settled word), holds clean, glitches in 0.1 s bursts at 0.6, 1.1 and 1.6 s,
 * and glitches out over the last 0.3 s (slices fly wider and drop out until nothing
 * is left). Glitch states change every 0.05 s whatever the project fps, and the
 * whole clip carries at most 3 glitch events in any second, with clean frames
 * between them (photosensitivity, ART_DIRECTION §4).
 *
 * Colours follow ART_DIRECTION §0: ink type on the accent card, cream type on the
 * dark card. The word is hero-sized (heroTextBox, displayTracking) with headroom for
 * the widest jump, so every slice stays inside the 5% title-safe box at all times.
 */

const ID = "T34";
const REVISION = 1;
/** Glitch state length (s): offsets change at this rate in any burst. */
export const T34_STATE_SECONDS = 0.05;
/** Program (standard-energy seconds). */
const ENTRANCE_STATES = 4, BURSTS: readonly number[] = [0.55, 1.0, 1.65], BURST_STATES = 2, EXIT = 0.3;
const NATURAL_SECONDS = 2.5;
/** Glitch events never start closer than this (s): at most 3 per second. */
export const T34_MIN_EVENT_GAP = 1 / 3 + 0.01;
/** Slices: count range, thickness weights; jumps as a share of the word width (small, big), split offset (× glyph height). */
const SLICES: readonly [number, number] = [7, 9], THICKNESS: readonly [number, number] = [0.45, 1.55];
const SMALL_JUMP: readonly [number, number] = [0.012, 0.04], BIG_JUMP: readonly [number, number] = [0.07, 0.1], MOVE_CHANCE = 0.6;
const SPLIT = 0.028;
/** The split's largest share of the word width (a one-character word is about 0.8–1 glyph height wide). */
export const T34_SPLIT_REACH = 0.035;
/** Corruption blocks per glitch state: count range, height (× glyph height), length (× word width). */
const BARS: readonly [number, number] = [0, 2], BAR_HEIGHT: readonly [number, number] = [0.045, 0.09], BAR_LENGTH: readonly [number, number] = [0.08, 0.3];
const LINE_HEIGHT = 1.04;

export interface GlitchSlice { readonly y0: number; readonly y1: number }

export interface GlitchPlan {
  readonly pathD: string;
  readonly box: GlyphBox;
  readonly glyphHeight: number;
  readonly slices: readonly GlitchSlice[];
  /** Jump scale (energy amplitude, capped). */
  readonly amplitude: number;
  readonly timeScale: number;
  /** Start times (s) of the hold bursts that fit the clip (entrance and exit excluded). */
  readonly bursts: readonly number[];
  readonly entranceEnd: number;
  readonly exitStart: number;
}

export function glitchPlan(params: TextMotionParams, size: MotionFrameSize): GlitchPlan {
  const { energy, timeScale } = itemTiming(params.energy, params.durationSeconds, NATURAL_SECONDS);
  const amplitude = Math.min(1.5, energy.amplitude);
  // Headroom: the widest jump plus the split (at most 3.5% of the word width: 2.8% of the glyph height), on both sides.
  const headroom = 1 + 2 * amplitude * (BIG_JUMP[1] + T34_SPLIT_REACH);
  const text = layoutFittedText(params.lines, textFace(params.font, 900), {
    ...heroTextBox(size, { headroom }), lineHeight: LINE_HEIGHT, tracking: displayTracking(params.lines),
  });
  const safe = titleSafeBox(size);
  const dx = safe.cx - text.inkCenter[0], dy = safe.cy - text.inkCenter[1];
  const box = { x0: text.ink.x0 + dx, y0: text.ink.y0 + dy, x1: text.ink.x1 + dx, y1: text.ink.y1 + dy };
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  // Uneven seeded slices covering the ink box (plus a margin, so antialiased edges are never cut off).
  const rng = createSeededRng(ID, params.seed, "slices");
  const count = rng.int(SLICES[0], SLICES[1]);
  const weights = Array.from({ length: count }, () => rng.range(THICKNESS[0], THICKNESS[1]));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Slice edges sit on whole pixels: abutting clip edges then never blend into a hairline seam.
  const top = Math.floor(box.y0 - 2), span = Math.ceil(box.y1 + 2) - top;
  const slices: GlitchSlice[] = [];
  let y = top, acc = 0;
  for (const weight of weights) {
    acc += weight;
    const next = top + Math.round((acc / total) * span);
    if (next > y) slices.push({ y0: y, y1: next });
    y = next;
  }
  const entranceEnd = ENTRANCE_STATES * T34_STATE_SECONDS * timeScale;
  const exitStart = params.durationSeconds - EXIT * timeScale;
  // Hold bursts: kept only when they start at least T34_MIN_EVENT_GAP after the previous event and end before the exit.
  const bursts: number[] = [];
  let previous = 0;
  for (const at of BURSTS) {
    const start = at * timeScale, end = start + BURST_STATES * T34_STATE_SECONDS * timeScale;
    if (start - previous >= T34_MIN_EVENT_GAP && end <= exitStart - 0.05 && exitStart - start >= T34_MIN_EVENT_GAP) {
      bursts.push(start);
      previous = start;
    }
  }
  return { pathD: translatePathD(text.block.pathD, dx, dy), box, glyphHeight, slices, amplitude, timeScale, bursts, entranceEnd, exitStart };
}

export interface GlitchState {
  /** Stable index of the glitch state (seeds its offsets). */
  readonly key: string;
  /** 0..1: how far slices jump (× the jump ranges) and how strong the split is. */
  readonly intensity: number;
  /** Share of slices drawn (entrance and exit drop slices). */
  readonly visible: number;
}

/** The glitch state at time t, or undefined for a clean frame (the whole word, no slices). */
export function glitchState(plan: GlitchPlan, t: number, duration: number): GlitchState | undefined {
  const state = T34_STATE_SECONDS * plan.timeScale;
  if (t < plan.entranceEnd) {
    const index = Math.min(ENTRANCE_STATES - 1, Math.floor(t / state + 1e-9));
    return { key: `in${index}`, intensity: [1, 0.7, 0.45, 0.25][index], visible: [0.35, 0.65, 0.9, 1][index] };
  }
  if (t >= plan.exitStart) {
    const index = Math.floor((t - plan.exitStart) / state + 1e-9);
    const steps = Math.max(1, Math.round((duration - plan.exitStart) / state));
    const p = Math.min(1, (index + 1) / steps);
    return { key: `out${index}`, intensity: 0.45 + 0.75 * p, visible: Math.max(0, 1 - p * 1.05) };
  }
  for (let burst = 0; burst < plan.bursts.length; burst += 1) {
    const local = t - plan.bursts[burst];
    if (local >= 0 && local < BURST_STATES * state) {
      const index = Math.floor(local / state + 1e-9);
      return { key: `b${burst}.${index}`, intensity: index === 0 ? 1 : 0.6, visible: 1 };
    }
  }
  return undefined;
}

interface SliceJump { readonly dx: number; readonly visible: boolean }

/** Seeded jumps for one glitch state: most slices nudge a little, one or two jump far; the visible share drops slices. */
function sliceJumps(plan: GlitchPlan, params: TextMotionParams, state: GlitchState): SliceJump[] {
  const rng = createSeededRng(ID, params.seed, `state:${state.key}`);
  const width = plan.box.x1 - plan.box.x0;
  const count = plan.slices.length;
  const bigCount = state.intensity >= 0.6 ? rng.int(1, 2) : rng.int(0, 1);
  const big = new Set<number>();
  while (big.size < bigCount) big.add(rng.int(0, count - 1));
  const order = Array.from({ length: count }, (_, index) => ({ index, key: rng.next() })).sort((a, b) => a.key - b.key);
  const shown = new Set(order.slice(0, Math.ceil(state.visible * count - 1e-9)).map(entry => entry.index));
  return plan.slices.map((_, index) => {
    const r = rng.fork(index);
    let dx = 0;
    if (big.has(index)) dx = r.sign() * r.range(BIG_JUMP[0], BIG_JUMP[1]);
    else if (r.chance(MOVE_CHANCE)) dx = r.sign() * r.range(SMALL_JUMP[0], SMALL_JUMP[1]);
    return { dx: dx * width * plan.amplitude * Math.min(1, state.intensity), visible: shown.has(index) };
  });
}

export const T34_glitchSlices = defineTextMotion(ID, (params, t, size) => {
  const plan = glitchPlan(params, size);
  const doc = createTextDocument(size, params);
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  const tone = backdropTone(params.palette, backdrop);
  // Split tones: the item's second tone plus one more of its own family (cream on the accent card, the deep shade on dark).
  const splitA = secondaryTone(params.palette, backdrop);
  const splitB = tone === "accent" ? params.palette.paper : tone === "dark" ? params.palette.accent2
    : splitA === params.palette.accent ? params.palette.accent2 : params.palette.accent;
  const state = glitchState(plan, t, params.durationSeconds);
  if (!state) return doc.render(path(plan.pathD, { fill: textColor }));
  if (state.visible <= 0) return doc.render();
  const jumps = sliceJumps(plan, params, state);
  const width = plan.box.x1 - plan.box.x0;
  const split = SPLIT * plan.glyphHeight * plan.amplitude * Math.min(1, 0.4 + 0.6 * state.intensity);
  const parts: string[] = [];
  plan.slices.forEach((slice, index) => {
    const jump = jumps[index];
    if (!jump.visible) return;
    const clip = doc.clipPath(rect(plan.box.x0 - width, slice.y0, 3 * width, slice.y1 - slice.y0));
    parts.push(g({ "clip-path": clip },
      path(plan.pathD, { fill: splitA, transform: tf.translate(jump.dx - split, 0) }),
      path(plan.pathD, { fill: splitB, transform: tf.translate(jump.dx + split, 0) }),
      path(plan.pathD, { fill: textColor, transform: jump.dx ? tf.translate(jump.dx, 0) : undefined })));
  });
  parts.push(...corruptionBars(plan, params, state, [splitB, textColor]));
  return doc.render(parts);
}, { revision: REVISION });

/** 0–2 seeded corruption blocks inside the word box for a glitch state (the split tone and the text colour). */
function corruptionBars(plan: GlitchPlan, params: TextMotionParams, state: GlitchState, colors: readonly [string, string]): string[] {
  if (state.visible < 0.5) return [];
  const rng = createSeededRng(ID, params.seed, `bars:${state.key}`);
  const { box, glyphHeight } = plan;
  const width = box.x1 - box.x0;
  const count = rng.int(BARS[0], BARS[1]);
  const bars: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const height = Math.max(2, Math.round(rng.range(BAR_HEIGHT[0], BAR_HEIGHT[1]) * glyphHeight));
    const length = rng.range(BAR_LENGTH[0], BAR_LENGTH[1]) * width * Math.min(1, 0.5 + 0.5 * state.intensity);
    const x = box.x0 + rng.range(-0.04, 1.04) * width - length / 2;
    const y = Math.round(box.y0 + rng.range(0.05, 0.95) * (box.y1 - box.y0));
    bars.push(rect(Math.max(box.x0 - 0.06 * width, x), y, Math.min(length, box.x1 + 0.06 * width - Math.max(box.x0 - 0.06 * width, x)), height,
      { fill: colors[index % 2] }));
  }
  return bars;
}
