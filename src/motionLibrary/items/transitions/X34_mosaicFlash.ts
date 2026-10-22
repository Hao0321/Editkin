import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01 } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionFrameSize } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X34 Mosaic Flash: the frame is a seeded mosaic of flat colour blocks of different sizes
 * (grid cells merged into 1×1 … 3×2 blocks), each in one of the four reference tones (accent,
 * its deep shade, cream and ink; never two neighbours alike, never neon). The blocks switch on
 * hard beats: about half of them cut in over A, then every block cuts in at once with all the
 * colours stepped round the palette (so the first blocks flash to a new tone), and under that
 * full cover the matte switches to B at exactly D/2 (ART_DIRECTION §4); the last beat cuts
 * straight to B.
 *
 * Photosensitivity (DESIGN §6): there are at most three beats in the whole transition, so never
 * more than three flashes in any second, and every state holds at least two frames at 30 fps
 * (1/15 s). From 1/3 s the beats fall at 25%, 45% and 72% of the duration (the shortest state is
 * 20% of it); below 1/3 s there are two beats, at 1/3 and 2/3 (full cover in between). The
 * beats are hard cuts by design, with no easing; energy does not change them. Blocks are whole
 * pixels, so no seams. Not directional. The seed sets the mosaic, its colours and the first group.
 */

const ID = "X34";
const REVISION = 1;
const SWITCH = 0.5;
/** Grid cells across the short and long sides before merging. */
const SHORT_CELLS = 5, LONG_CELLS = 8;
/** Block shapes in cells (columns × rows), tried biggest first with a seeded chance. */
const SHAPES: ReadonlyArray<readonly [number, number]> = [[3, 2], [2, 3], [2, 2], [2, 1], [1, 2], [1, 1]];
const ROLES = ["accent", "accent2", "paper", "ink"] as const;
type Role = typeof ROLES[number];

export interface MosaicBlock {
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
  /** Index into ROLES of the block's first colour; the second beat steps it by one. */
  readonly tone: number;
  /** Whether the block cuts in on the first beat. */
  readonly early: boolean;
}

/** The mosaic grid for a frame: LONG_CELLS along the long side, SHORT_CELLS along the short side. */
export function mosaicGrid(size: MotionFrameSize): { readonly columns: number; readonly rows: number } {
  return size.width >= size.height ? { columns: LONG_CELLS, rows: SHORT_CELLS } : { columns: SHORT_CELLS, rows: LONG_CELLS };
}

/** The seeded mosaic: blocks tile the grid exactly; neighbouring blocks never share a colour. */
export function mosaicBlocks(seed: number, columns: number, rows: number): MosaicBlock[] {
  const rng = createSeededRng(ID, seed, `mosaic-${columns}x${rows}`);
  const owner = new Array<number>(columns * rows).fill(-1);
  const shapes: Array<{ column: number; row: number; columns: number; rows: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (owner[row * columns + column] >= 0) continue;
      const fits = ([w, h]: readonly [number, number]) => {
        if (column + w > columns || row + h > rows) return false;
        for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) if (owner[(row + dy) * columns + column + dx] >= 0) return false;
        return true;
      };
      const shape = SHAPES.find(candidate => fits(candidate) && (candidate[0] * candidate[1] === 1 || rng.next() < 0.45)) ?? [1, 1];
      for (let dy = 0; dy < shape[1]; dy += 1) for (let dx = 0; dx < shape[0]; dx += 1) owner[(row + dy) * columns + column + dx] = shapes.length;
      shapes.push({ column, row, columns: shape[0], rows: shape[1] });
    }
  }
  // Neighbours: blocks whose cells touch edge to edge.
  const neighbours = shapes.map(() => new Set<number>());
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const self = owner[row * columns + column];
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (column + dx >= columns || row + dy >= rows) continue;
        const other = owner[(row + dy) * columns + column + dx];
        if (other !== self) { neighbours[self].add(other); neighbours[other].add(self); }
      }
    }
  }
  const tones: number[] = [];
  const start = rng.int(0, ROLES.length - 1);
  shapes.forEach((_, index) => {
    const used = new Set([...neighbours[index]].filter(other => other < index).map(other => tones[other]));
    const offset = rng.int(0, ROLES.length - 1);
    let tone = (start + offset) % ROLES.length;
    for (let step = 0; step < ROLES.length && used.has(tone); step += 1) tone = (tone + 1) % ROLES.length;
    tones.push(tone);
  });
  return shapes.map((shape, index) => ({ ...shape, tone: tones[index], early: rng.next() < 0.5 }));
}

/** The beats (fractions of the duration) for a clip of `durationSeconds`: three from 1/3 s, else two. */
export function mosaicBeats(durationSeconds: number): readonly number[] {
  return durationSeconds >= 1 / 3 ? [0.25, 0.45, 0.72] : [1 / 3, 2 / 3];
}

export const X34_mosaicFlash = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const beats = mosaicBeats(params.durationSeconds);
  // Stage: 0 = A, then each beat; the last beat is B.
  const stage = beats.filter(beat => p >= beat).length;
  const full = beats.length === 3 ? stage === 2 : stage === 1;
  const early = beats.length === 3 && stage === 1;
  const { columns, rows } = mosaicGrid(size);
  const fills: Partial<Record<Role, string>> = {};
  if (full || early) {
    for (const block of mosaicBlocks(params.seed, columns, rows)) {
      if (early && !block.early) continue;
      const x0 = Math.round((block.column * size.width) / columns), x1 = Math.round(((block.column + block.columns) * size.width) / columns);
      const y0 = Math.round((block.row * size.height) / rows), y1 = Math.round(((block.row + block.rows) * size.height) / rows);
      // On the full-cover beat every colour steps round the palette, so the first blocks flash to a new tone.
      const role = ROLES[(block.tone + (full && beats.length === 3 ? 1 : 0)) % ROLES.length];
      fills[role] = (fills[role] ?? "") + rectPathD(x0, y0, x1 - x0, y1 - y0, 0);
    }
  }
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(ROLES.map(role => path(fills[role] ?? "", { fill: params.palette[role] }))),
  };
}, { revision: REVISION });
