import { g, path, tf } from "../../svg/document";
import { loopPhase } from "../../svg/easing";
import { cellsPathD, lineOutlines, sampleGlyphCells } from "../../svg/glyphCells";
import { assertMotionText, layoutLine, type MotionFontSelector } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, heroTextBox, itemTiming, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground } from "../shared";

/**
 * T53 Scramble Decode (亂碼解碼), PLAY: a pixel-type decoder. Every glyph is drawn
 * as square pixels on one shared grid by the glyph-cell sampler (svg/glyphCells:
 * Noto Sans TC 500 outlines, a cell = 1/14 of the glyph height, a small gap between
 * pixels); there is no pixel font.
 * - 0.0–0.9 s: every character cycles random glyphs (digits, Latin capitals, #, and
 *   common CJK, the pool filtered by the face's coverage so nothing renders as tofu)
 *   every 0.06 s, in the second tone (coral on the dark card).
 * - The characters lock left to right at 0.35 + 0.18·i s (the stagger shrinks for
 *   long lines so the last still locks by 0.9 s) and turn the text colour (cream).
 *   The next character to lock flickers between two candidates, its answer and one
 *   seeded decoy, for the 0.18 s before it locks.
 * - Hold the decoded word 0.9–1.9 s; then it scrambles again from the right (each
 *   character unlocks, last first), so at 2.4 s every character is cycling again and
 *   the end of the clip matches its start (a seamless 2.4 s cycle when repeated).
 * The random choices are seeded and deterministic (createSeededRng): the same seed and
 * time give the same glyph. Size: the word at heroTextBox size (80–90% of the safe
 * width), inside the 5% title-safe box, ≥ 9% of the short side tall.
 * Timing: standard-energy seconds, scaled by energy (itemTiming) and squeezed into
 * short clips; a longer clip lengthens the hold (the re-scramble stays at the end).
 */

const ID = "T53";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T53_STEP = 0.06, T53_FIRST_LOCK = 0.35, T53_LOCK_STAGGER = 0.18, T53_LAST_LOCK = 0.9, T53_HOLD_END = 1.9, T53_CYCLE = 2.4;
/** Pixels per glyph height, the sampled weight, coverage that lights a pixel and the drawn pixel size (× cell). */
export const T53_CELLS_PER_GLYPH = 14;
const WEIGHT = 500, MIN_COVERAGE = 0.4, PIXEL = 0.86;
/** Space between characters (em): pixel type needs a column of air between glyphs. */
const TRACKING = 0.04;
/** Re-scramble: characters unlock from the right, the last before 2.32 s. */
const UNLOCK_SPAN = 0.42;
/** Riffle pool before the coverage filter: digits, Latin capitals, #, and common CJK. */
export const T53_POOL = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ#的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去";

export interface ScrambleSlot {
  readonly index: number;
  readonly target: string;
  /** Slot origin on the pixel grid (frame px): the cell column/row grid starts here. */
  readonly x: number;
  readonly y: number;
  /** Slot width (px) used to centre other glyphs. */
  readonly advance: number;
  /** Lock and unlock times (clip seconds). */
  readonly lock: number;
  readonly unlock: number;
  /** The decoy shown in the flicker window. */
  readonly decoy: string;
}

export interface ScramblePlan {
  readonly slots: readonly ScrambleSlot[];
  readonly face: MotionFontSelector;
  readonly fontSize: number;
  readonly cell: number;
  /** -emTop: the baseline below the slot origin (px). */
  readonly baseline: number;
  readonly pool: readonly string[];
  /** Random-glyph steps in one clip cycle (the clip duration). */
  readonly steps: number;
  readonly stepSeconds: number;
  readonly scrambleColor: string;
  readonly lockedColor: string;
  readonly glyphHeight: number;
  /** Ink box of the decoded word (frame px). */
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

const poolCache = new Map<string, readonly string[]>();

/** The pool characters the face can draw (MotionLibraryGlyphError filtered out), deterministic and cached. */
export function scramblePool(face: MotionFontSelector): readonly string[] {
  const key = `${face.font}\u0000${face.weight ?? ""}`;
  const hit = poolCache.get(key);
  if (hit) return hit;
  const pool: string[] = [];
  for (const character of T53_POOL) {
    if (pool.includes(character)) continue;
    try { assertMotionText(character, face); pool.push(character); } catch { /* the face lacks it: never shown */ }
  }
  const frozen = Object.freeze(pool);
  poolCache.set(key, frozen);
  return frozen;
}

export function scramblePlan(params: TextMotionParams, size: MotionFrameSize): ScramblePlan {
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, T53_CYCLE);
  const face = textFace(params.font, WEIGHT);
  const text = layoutFittedText(params.lines, face, { ...heroTextBox(size), lineHeight: 1.12, tracking: TRACKING });
  const offsetX = size.width / 2 - text.inkCenter[0], offsetY = size.height / 2 - text.inkCenter[1];
  let glyphHeight = 0;
  for (const line of text.block.lines) for (const glyph of line.layout.glyphs) if (glyph.bbox) glyphHeight = Math.max(glyphHeight, glyph.bbox.y1 - glyph.bbox.y0);
  if (!(glyphHeight > 0)) glyphHeight = text.fontSize * 0.88;
  const cell = Math.round((glyphHeight / T53_CELLS_PER_GLYPH) * 100) / 100;
  const pool = scramblePool(face);
  const targets: Array<{ char: string; x: number; y: number; advance: number }> = [];
  for (const line of text.block.lines) {
    const metrics = line.layout;
    // Each line's grid starts at its em top and its first pen position; slots snap to whole cells.
    const gridX = offsetX + line.x, gridY = offsetY + line.baselineY + metrics.emTop;
    for (const glyph of line.layout.glyphs) {
      if (glyph.whitespace) continue;
      targets.push({ char: glyph.char, x: gridX + Math.round(glyph.x / cell) * cell, y: gridY, advance: glyph.advance });
    }
  }
  const n = targets.length;
  const lockStagger = n > 1 ? Math.min(T53_LOCK_STAGGER, (T53_LAST_LOCK - T53_FIRST_LOCK) / (n - 1)) : 0;
  const unlockStagger = n > 1 ? UNLOCK_SPAN / (n - 1) : 0;
  const end = params.durationSeconds;
  const rng = createSeededRng(ID, params.seed, "decoys");
  const backdrop = textBackdrop(params);
  const steps = Math.max(1, Math.round(end / (T53_STEP * timeScale)));
  return {
    slots: targets.map((target, index) => {
      let decoy = pool.length ? rng.fork(index).pick(pool) : target.char;
      if (decoy === target.char && pool.length > 1) decoy = pool[(pool.indexOf(decoy) + 1) % pool.length];
      return {
        index, target: target.char, x: target.x, y: target.y, advance: target.advance,
        lock: (T53_FIRST_LOCK + lockStagger * index) * timeScale,
        // Re-scramble from the right, finishing before the clip ends (anchored to the end: a longer clip holds longer).
        unlock: end - (T53_CYCLE - T53_HOLD_END) * timeScale + unlockStagger * (n - 1 - index) * timeScale,
        decoy,
      };
    }),
    face, fontSize: text.fontSize, cell, baseline: -text.block.lines[0].layout.emTop, pool, steps, stepSeconds: end / steps,
    scrambleColor: secondaryTone(params.palette, backdrop), lockedColor: textOnBackground(params.palette, backdrop), glyphHeight,
    box: { x0: text.ink.x0 + offsetX, y0: text.ink.y0 + offsetY, x1: text.ink.x1 + offsetX, y1: text.ink.y1 + offsetY },
  };
}

export interface ScrambleState {
  readonly char: string;
  readonly locked: boolean;
}

/** What slot i shows at time t: its answer once locked, else a seeded random glyph (the answer/decoy flicker just before it locks). */
export function scrambleState(plan: ScramblePlan, params: TextMotionParams, slot: ScrambleSlot, t: number): ScrambleState {
  if (t >= slot.lock && t < slot.unlock) return { char: slot.target, locked: true };
  const step = Math.floor(loopPhase(t, params.durationSeconds) * plan.steps + 1e-9);
  const flicker = T53_LOCK_STAGGER * (plan.stepSeconds / T53_STEP);
  if (t < slot.lock && t >= slot.lock - flicker) return { char: step % 2 === 0 ? slot.decoy : slot.target, locked: false };
  if (!plan.pool.length) return { char: slot.target, locked: false };
  const rng = createSeededRng(ID, params.seed, `glyph/${slot.index}/${step}`);
  let pick = rng.pick(plan.pool);
  if (pick === slot.target && plan.pool.length > 1) pick = plan.pool[(plan.pool.indexOf(pick) + 1) % plan.pool.length];
  return { char: pick, locked: false };
}

const pixelCache = new Map<string, string>();

/** A character's pixels (one path), in slot coordinates: the glyph centred in the slot, snapped to the grid. */
export function pixelGlyphD(plan: ScramblePlan, slot: ScrambleSlot, char: string): string {
  const line = layoutLine(char, { ...plan.face, size: plan.fontSize });
  const shift = Math.round((slot.advance - line.width) / 2 / plan.cell) * plan.cell;
  const key = `${plan.face.font}\u0000${plan.face.weight ?? ""}\u0000${plan.fontSize}\u0000${plan.cell}\u0000${shift}\u0000${char}`;
  const hit = pixelCache.get(key);
  if (hit !== undefined) return hit;
  const cells = sampleGlyphCells(lineOutlines(line, shift, plan.baseline), { cellSize: plan.cell, minCoverage: MIN_COVERAGE });
  const d = cellsPathD(cells, { shape: "square", scale: PIXEL, decimals: 1 });
  pixelCache.set(key, d);
  if (pixelCache.size > 512) pixelCache.delete(pixelCache.keys().next().value!);
  return d;
}

export const T53_scrambleDecode = defineTextMotion(ID, (params, t, size) => {
  const plan = scramblePlan(params, size);
  const parts = plan.slots.map(slot => {
    const state = scrambleState(plan, params, slot, t);
    return path(pixelGlyphD(plan, slot, state.char), { fill: state.locked ? plan.lockedColor : plan.scrambleColor, transform: tf.translate(slot.x, slot.y) });
  });
  return createTextDocument(size, params).render(g(undefined, parts));
}, { revision: REVISION });
