import { createSvgDocument, rect } from "../../svg/document";
import { clamp, cubicInOut, expoInOut, lerp, loopPhase, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B33 Minimal Blocks (ART_DIRECTION §10, base A): a few large flat planes on the
 * accent card, as in the reference. The accent keeps a wide column at the start of
 * the frame (left in landscape, top in portrait) as open space for a title; next to
 * it a cream plane sits on an ink plane, and a dark card column closes the frame.
 * Every two seconds the planes slide and resize into a new arrangement in one calm,
 * eased move, then hold: the accent column narrows and widens, the cream plane
 * rises and falls on the ink, and the dark column opens out of the far edge and
 * closes again. Each boundary leads the next by a beat, so a move reads as one
 * gesture rather than a jump.
 *
 * Loop: four arrangements per cycle, one cycle per loop at speed 1
 * (backgroundLoop). density sets the number of columns (3 at density 1, as in the
 * reference). Energy sets the move curve (calm sine, standard cubic, punchy quart,
 * hype expo); the seed nudges every arrangement.
 */

const ID = "B33";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B33_LOOP_SECONDS = 8;
/** Cycles per loop at speed 1 (each cycle steps through every arrangement once). */
export const B33_LOOP_CYCLES = 1;
/** Arrangements per cycle; share of a step spent moving; lead of each boundary over the next (× step). */
const STEPS = 4, MOVE = 0.42, STAGGER = 0.07;
/** Width of the accent column (× the long side) in each arrangement, and the seeded nudge. */
const ACCENT_WIDTHS = [0.6, 0.38, 0.5, 0.66] as const;
/** Height of the top part of a split column (× the short side), per arrangement, and the seeded nudge. */
const SPLITS = [0.54, 0.74, 0.4, 0.62] as const;
const NUDGE = 0.03;
/** Relative width of a split column and of the plain dark card column. */
const SPLIT_WEIGHT = 1, CARD_WEIGHT = 0.6;

const MOVE_CURVE: Record<MotionEnergy, EasingFunction> = { calm: sineInOut, standard: cubicInOut, punchy: quartInOut, hype: expoInOut };

/** Columns after the accent one, in order: a split (top/bottom role) or the plain dark card. */
type Column = { readonly kind: "split"; readonly top: "paper" | "ink"; readonly bottom: "paper" | "ink" | "bg" } | { readonly kind: "card" };
const COLUMN_CYCLE: readonly Column[] = [
  { kind: "split", top: "paper", bottom: "ink" },
  { kind: "card" },
  { kind: "split", top: "ink", bottom: "paper" },
  { kind: "split", top: "paper", bottom: "bg" },
];

export interface BlockArrangement {
  /** Column boundaries along the long side, 0 … 1 (the accent column is [bounds[0], bounds[1]]). */
  readonly bounds: readonly number[];
  /** Per column after the accent one: where the split falls along the short side (0 … 1). */
  readonly splits: readonly number[];
}

/** Columns at a density: 3 at density 1 (accent, split, card), 2 at 0.5, up to 5 at 2. */
export function blockColumns(density: number): number {
  return clamp(1 + Math.round(2 * density), 2, 5);
}

/**
 * Arrangement `step` for `columns` columns. In even arrangements the last column is closed (its
 * width is 0), so the plane before it reaches the far edge, as in the reference.
 */
export function blockArrangement(step: number, columns: number, seed: number): BlockArrangement {
  const rng = createSeededRng(ID, seed, `arrangement/${columns}/${step}`);
  const accent = ACCENT_WIDTHS[step % STEPS] + rng.range(-NUDGE, NUDGE);
  const weights: number[] = [];
  for (let column = 1; column < columns; column += 1) {
    const closed = step % 2 === 0 && column === columns - 1 && columns > 2;
    const base = COLUMN_CYCLE[(column - 1) % COLUMN_CYCLE.length].kind === "card" ? CARD_WEIGHT : SPLIT_WEIGHT;
    weights.push(closed ? 0 : base * rng.range(0.85, 1.15));
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const bounds = [0, accent];
  let at = accent;
  for (const weight of weights) {
    at += ((1 - accent) * weight) / total;
    bounds.push(at);
  }
  bounds[bounds.length - 1] = 1;
  const splits = weights.map((_, index) => SPLITS[(step + index) % STEPS] + rng.range(-NUDGE, NUDGE));
  return { bounds, splits };
}

/** Rect in frame px for long-axis span [u0, u1] and short-axis span [v0, v1] (fractions). */
function planeRect(size: MotionFrameSize, u0: number, u1: number, v0: number, v1: number): readonly [number, number, number, number] {
  const landscape = size.width >= size.height;
  const long = landscape ? size.width : size.height, short = landscape ? size.height : size.width;
  const a = u0 * long, b = v0 * short, along = (u1 - u0) * long, across = (v1 - v0) * short;
  return landscape ? [a, b, along, across] : [b, a, across, along];
}

export const B33_minimalBlocks = defineBackgroundMotion(ID, (params, t, size) => {
  const { loopSeconds, cycles } = backgroundLoop(B33_LOOP_SECONDS, B33_LOOP_CYCLES, params.speed);
  const position = STEPS * cycles * loopPhase(t, loopSeconds);
  const step = Math.floor(position), local = position - step;
  const columns = blockColumns(params.density);
  const from = blockArrangement(step % STEPS, columns, params.seed), to = blockArrangement((step + 1) % STEPS, columns, params.seed);
  const ease = MOVE_CURVE[params.energy];
  // Boundary j and split j each start their move STAGGER later than the one before (all finish inside the step).
  const moved = (delay: number) => ease(clamp((local - delay) / MOVE, 0, 1));
  const bounds = from.bounds.map((value, index) => (index === 0 || index === from.bounds.length - 1 ? value : lerp(value, to.bounds[index], moved((index - 1) * STAGGER))));
  const splits = from.splits.map((value, index) => lerp(value, to.splits[index], moved(index * STAGGER + STAGGER / 2)));
  const colour = { paper: params.palette.paper, ink: params.palette.ink, bg: params.palette.bg };
  const parts: string[] = [];
  // A plane narrower than this (px) is closed: skip it, so a closing column never leaves a sub-pixel sliver.
  const minimum = 0.01;

  // Painter's order with overlap: each column runs to the far edge and the next one covers it, and a split's
  // bottom part covers its top part, so every boundary is one antialiased edge (no hairline of accent between planes).
  for (let column = 1; column < columns; column += 1) {
    const u0 = bounds[column];
    const spec = COLUMN_CYCLE[(column - 1) % COLUMN_CYCLE.length];
    const pieces: Array<[number, string]> = spec.kind === "card"
      ? [[0, colour.bg]]
      : [[0, colour[spec.top]], [splits[column - 1], colour[spec.bottom]]];
    for (const [v0, fill] of pieces) {
      const [x, y, width, height] = planeRect(size, u0, 1, v0, 1);
      if (width >= minimum && height >= minimum) parts.push(rect(x, y, width, height, { fill }));
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(parts);
}, { revision: REVISION, loopSeconds: B33_LOOP_SECONDS, loopCycles: B33_LOOP_CYCLES });
