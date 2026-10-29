import { g, path, tf } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { translatePathD } from "../../svg/glyphs";
import { createSeededRng } from "../../svg/random";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD, distinctFrom } from "./T09_hugeTextScroll";
import { columnRepeatStarts, columnUnit, type ColumnUnit } from "./T10_verticalTypography";

/**
 * T51 Letter Rain (文字雨): 10–14 tategaki columns (10 in portrait, 14 in
 * landscape) of small display-700 characters (4.5–6% of the short side, seeded
 * per column) fall downward, each at its own speed: a whole number of repeats of
 * the column text (line 1, then 4–9 empty cells, seeded per column, so the columns
 * fall as streaks with rain gaps between them) passes per loop.
 * Characters listed in line 2 are highlights, drawn in the accent at full
 * opacity on every card (coral on cream, as in the reference; the deep shade only on
 * the accent plate, where the accent itself would vanish); every other
 * character is the text colour at 75% or 40% (seeded per
 * character, so the pattern travels with the text). Columns sit on an even grid
 * across the 5% title-safe width with a small seeded jitter and phase; the rain
 * runs through the top and bottom edges by definition.
 *
 * A seamless 4 s loop (catalog loopSeconds): every column advances a whole number
 * of repeats per loop. Energy scales the fall speeds (whole repeats only).
 */

const ID = "T51";
/** Art revision: 1 = first hand-in; 2 = highlights in the accent on every card (the reference shows coral on cream). */
const REVISION = 2;
export const T51_LOOP_SECONDS = 4;
/** Column em range (× short side), cell tracking (em), seeded speeds (repeats per loop), jitter (× pitch). */
const EM_RANGE: readonly [number, number] = [0.045, 0.06], TRACKING = 0.12, JITTER = 0.12;
const SPEEDS: readonly number[] = [1, 1, 1, 2, 2];
/** Empty cells after each repeat (seeded per column): the columns fall as streaks with rain gaps between them. */
const GAP_CELLS: readonly [number, number] = [4, 9];
/** Share of non-highlight characters drawn at the strong tone (75%); the rest are at 40%. */
const STRONG_SHARE = 0.55, STRONG = 0.75, FAINT = 0.4;

export interface RainColumn {
  readonly x: number;
  readonly unit: ColumnUnit;
  /** Whole repeats per loop (falling) and seeded phase (repeats). */
  readonly repeatsPerLoop: number;
  readonly phase: number;
  /** Outlines of one repeat by tone (column coordinates). */
  readonly highlightPathD: string;
  readonly strongPathD: string;
  readonly faintPathD: string;
}

export interface LetterRainPlan {
  readonly columns: readonly RainColumn[];
  readonly textColor: string;
  readonly highlightColor: string;
}

const toneCache = new Map<string, { highlight: string; strong: string; faint: string }>();

/** Split one repeat's glyphs into highlight / strong / faint outlines (seeded per column; cached). */
function toneSplit(unit: ColumnUnit, highlights: ReadonlySet<string>, seed: number, column: number): { highlight: string; strong: string; faint: string } {
  const key = `${unit.text}\u0000${unit.size}\u0000${unit.tracking}\u0000${[...highlights].join("")}\u0000${seed}\u0000${column}`;
  const hit = toneCache.get(key);
  if (hit) return hit;
  const rng = createSeededRng(ID, seed, `tone/${column}`);
  let highlight = "", strong = "", faint = "";
  for (const glyph of unit.glyphs) {
    if (glyph.whitespace || !glyph.pathD) continue;
    const placed = translatePathD(glyph.pathD, 0, glyph.y);
    const roll = rng.next();
    if (highlights.has(glyph.char)) highlight += placed;
    else if (roll < STRONG_SHARE) strong += placed;
    else faint += placed;
  }
  const split = { highlight: compactPathD(highlight), strong: compactPathD(strong), faint: compactPathD(faint) };
  toneCache.set(key, split);
  if (toneCache.size > 256) toneCache.delete(toneCache.keys().next().value!);
  return split;
}

export function letterRainPlan(params: TextMotionParams, size: MotionFrameSize): LetterRainPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const aspect = size.width / size.height;
  const count = Math.max(10, Math.min(14, Math.round(10 + (4 * (aspect - 9 / 16)) / (16 / 9 - 9 / 16))));
  const face = textFace(params.font, 700);
  const source = params.lines[0].trim();
  const highlights = new Set(params.lines.length > 1 ? [...params.lines[1]].filter(character => character.trim()) : []);
  const amplitude = energyProfile(params.energy).amplitude;
  const rng = createSeededRng(ID, params.seed, "columns");
  const pitch = safe.width / count;
  const columns: RainColumn[] = [];
  for (let index = 0; index < count; index += 1) {
    const column = rng.fork(index);
    const em = column.range(EM_RANGE[0], EM_RANGE[1]) * short;
    const unit = columnUnit(`${source}${"　".repeat(column.int(GAP_CELLS[0], GAP_CELLS[1]))}`, face, em, TRACKING);
    const half = Math.max(-unit.ink.x0, unit.ink.x1);
    const jitter = column.range(-JITTER, JITTER) * pitch;
    const x = Math.min(safe.x1 - half, Math.max(safe.x0 + half, safe.x0 + (index + 0.5) * pitch + jitter));
    const base = column.pick(SPEEDS);
    const repeats = amplitude < 0.75 ? Math.max(1, base - 1) : amplitude >= 1.25 ? base + 1 : base;
    const tones = toneSplit(unit, highlights, params.seed, index);
    columns.push({ x, unit, repeatsPerLoop: repeats, phase: column.next(), highlightPathD: tones.highlight, strongPathD: tones.strong, faintPathD: tones.faint });
  }
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  // Highlights are the accent on every card, as the reference shows (coral rain highlights on cream): decorative rain
  // follows its reference over the 3:1 rule (ART_DIRECTION §0). Only where the accent nearly vanishes (the accent plate)
  // do they take the deep shade.
  return { columns, textColor, highlightColor: distinctFrom(backdrop, params.palette.accent, [params.palette.accent2, textColor]) };
}

export const T51_letterRain = defineTextMotion(ID, (params, t, size) => {
  const plan = letterRainPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T51_LOOP_SECONDS);
  const parts = plan.columns.flatMap(column => {
    // Falling: negative travel moves the content down.
    const starts = columnRepeatStarts(column.unit, 0, -column.repeatsPerLoop * u + column.phase, 0, size.height);
    return starts.map(y => g({ transform: tf.translate(column.x, y) },
      column.faintPathD && path(column.faintPathD, { fill: plan.textColor, "fill-opacity": FAINT }),
      column.strongPathD && path(column.strongPathD, { fill: plan.textColor, "fill-opacity": STRONG }),
      column.highlightPathD && path(column.highlightPathD, { fill: plan.highlightColor })));
  });
  return doc.render(g(undefined, parts));
}, { revision: REVISION });
