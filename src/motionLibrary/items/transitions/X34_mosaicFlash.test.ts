import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { mosaicBeats, mosaicBlocks, mosaicGrid } from "./X34_mosaicFlash";
const fillsOf = (svg: string) => [...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);

const ID = "X34";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "d39b22e8f6a45fe8a2166549ac3c2f832deaac2567a04ecd793ca5e2453f91ae",
    "f87e8337660c6f945004995f0fb070050f2c65946c604a6b1c6b578bb9633254",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "9b83d5fa0bc801aae409376f0a13d41385beaadf7da0e448d7646b312f8d1c5f",
    "ecedeb170eb9e7fabf0d6a6c9c0b5f3947686d6c734c9c7c295c8119a67b185f",
    "6f39a25128cdf1861a213a57b8b3e7d9f711059518cdd30caaac7d2e618b4b9a",
    "6f39a25128cdf1861a213a57b8b3e7d9f711059518cdd30caaac7d2e618b4b9a",
  ],
};

const item = () => getMotionLibraryItem(ID) as TransitionMotionItem;
/** The item's default palette, so colour assertions follow the catalog's default theme. */
const palette = () => item().defaultParams.palette;
function frame(t: number, input?: unknown, size: MotionFrameSize = LANDSCAPE): TransitionFrame {
  return generateTransitionFrame(item(), resolveMotionLibraryParams(item(), input), t, size);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const head = (size: MotionFrameSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`;
const full = (size: MotionFrameSize, fill: string) => `<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${fill}"/>`;
const ALL_A = (size: MotionFrameSize) => `${head(size)}${full(size, "#000000")}</svg>`;
const ALL_B = (size: MotionFrameSize) => `${head(size)}${full(size, "#000000")}${full(size, "#FFFFFF")}</svg>`;
const EMPTY = (size: MotionFrameSize) => `${head(size)}</svg>`;

// Scanline rasterizer for <rect>/<path> frames (no transforms), sampled at cell centres.
// "matte": painter's order, #FFFFFF paints 1 and #000000 paints 0 (the B fraction). "overlay": opaque fills paint 1.
interface Shape { readonly rings: FlatPoint[][]; readonly evenOdd: boolean; readonly value: number }
function shapes(svg: string, mode: "matte" | "overlay"): Shape[] {
  const result: Shape[] = [];
  for (const [, tag, attrs] of svg.matchAll(/<(rect|path)\b([^>]*?)\/>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
    const fill = attr("fill") ?? "#000000";
    if (mode === "matte" && fill !== "#FFFFFF" && fill !== "#000000") throw new Error(`matte paints ${fill}`);
    if (mode === "overlay" && (fill === "none" || Number(attr("opacity") ?? 1) < 1 || Number(attr("fill-opacity") ?? 1) < 1)) continue;
    const rings: FlatPoint[][] = tag === "rect"
      ? (() => { const [x, y, w, h] = ["x", "y", "width", "height"].map(name => Number(attr(name) ?? 0)); return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]]; })()
      : flattenPathD(attr("d") ?? "", { segmentLength: 4 });
    result.push({ rings, evenOdd: attr("fill-rule") === "evenodd", value: mode === "overlay" || fill === "#FFFFFF" ? 1 : 0 });
  }
  return result;
}
/** Edge crossings of the horizontal line y, sorted by x, with the edge direction (+1 down, −1 up). */
function crossings(shape: Shape, y: number): Array<readonly [number, number]> {
  const hits: Array<readonly [number, number]> = [];
  for (const ring of shape.rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, ay] = ring[index], [bx, by] = ring[(index + 1) % ring.length];
      if ((ay <= y) !== (by <= y)) hits.push([ax + ((y - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
    }
  }
  return hits.sort((a, b) => a[0] - b[0]);
}
/** Spans [x0, x1) of line y inside the shape (nonzero or even-odd). */
function spans(shape: Shape, y: number): Array<readonly [number, number]> {
  const hits = crossings(shape, y), result: Array<readonly [number, number]> = [];
  let winding = 0;
  for (let index = 0; index + 1 < hits.length; index += 1) {
    winding += hits[index][1];
    if (shape.evenOdd ? (index + 1) % 2 === 1 : winding !== 0) result.push([hits[index][0], hits[index + 1][0]]);
  }
  return result;
}
function valueAt(list: readonly Shape[], x: number, y: number): number {
  let value = 0;
  for (const shape of list) if (spans(shape, y).some(([x0, x1]) => x >= x0 && x < x1)) value = shape.value;
  return value;
}
function painted(svg: string, size: MotionFrameSize, mode: "matte" | "overlay", columns = 192, rows = 108): number {
  const grid = new Uint8Array(columns * rows);
  for (const shape of shapes(svg, mode)) {
    for (let row = 0; row < rows; row += 1) {
      for (const [x0, x1] of spans(shape, ((row + 0.5) * size.height) / rows)) {
        const from = Math.max(0, Math.ceil((x0 * columns) / size.width - 0.5)), to = Math.min(columns - 1, Math.ceil((x1 * columns) / size.width - 0.5) - 1);
        for (let column = from; column <= to; column += 1) grid[row * columns + column] = shape.value;
      }
    }
  }
  return grid.reduce((sum, cell) => sum + cell, 0) / grid.length;
}
const coverage = (t: number, input?: Record<string, unknown>, size = LANDSCAPE) => painted(frame(t, input, size).matte, size, "matte");
/** The d attribute of every <path> in a frame, in document order. */
const pathDs = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]);
void valueAt; void EMPTY;

describe("X34 Mosaic Flash", () => {
  for (const [format, size] of Object.entries({ portrait: PORTRAIT, landscape: LANDSCAPE }) as Array<["portrait" | "landscape", MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => { const f = frame(t, undefined, size); return sha256(`${f.matte}\n--overlay--\n${f.overlay ?? ""}`); })).toEqual(GOLDEN[format]);
    });
  }

  it("matte is strictly all A at t = 0 and all B at t = D, overlay empty, for every energy and duration", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const start = frame(0, { energy, durationSeconds }, size), end = frame(durationSeconds, { energy, durationSeconds }, size);
          expect([start.matte, start.overlay, end.matte, end.overlay]).toEqual([ALL_A(size), EMPTY(size), ALL_B(size), EMPTY(size)]);
        }
      }
    }
    expect(item().supportedDirections).toBeUndefined();
  });

  it("switches A to B at exactly 50% while every block covers the frame (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          for (const p of [0.46, 0.5, 0.6]) expect(painted(frame(p * durationSeconds, input, size).overlay!, size, "overlay"), `${label} ${p}`).toBe(1);
          expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("never flashes more than three times, and every state holds at least two frames at 30 fps (every duration, every energy)", () => {
    for (const durationSeconds of [0.2, 0.25, 0.3, 1 / 3, 0.5, 1, 2]) {
      for (const energy of MOTION_ENERGIES) {
        const changes: number[] = [];
        let previous = frame(0, { energy, durationSeconds });
        for (let step = 1; step <= 600; step += 1) {
          const t = (step / 600) * durationSeconds, current = frame(t, { energy, durationSeconds });
          if (current.overlay !== previous.overlay || (current.matte !== previous.matte && step !== 300)) changes.push(t);
          previous = current;
        }
        // The matte switch at D/2 happens under full cover (not a visible change); only the beats change what is seen.
        expect(changes.length, `${durationSeconds} ${energy}`).toBeLessThanOrEqual(3);
        const marks = [0, ...changes, durationSeconds];
        for (let index = 1; index < marks.length; index += 1) expect(marks[index] - marks[index - 1], `${durationSeconds} ${energy}`).toBeGreaterThanOrEqual(1 / 15 - durationSeconds / 600 - 1e-9);
      }
    }
    expect(mosaicBeats(0.5)).toEqual([0.25, 0.45, 0.72]);
    expect(mosaicBeats(0.2)).toEqual([1 / 3, 2 / 3]);
  });

  it("tiles the frame with a seeded mosaic of blocks of different sizes in the four tones, never two neighbours alike", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const { columns, rows } = mosaicGrid(size);
      expect([columns, rows]).toEqual(size.width > size.height ? [8, 5] : [5, 8]);
      for (let seed = 1; seed <= 6; seed += 1) {
        const blocks = mosaicBlocks(seed, columns, rows), owner = new Array<number>(columns * rows).fill(-1);
        blocks.forEach((block, index) => {
          for (let dy = 0; dy < block.rows; dy += 1) for (let dx = 0; dx < block.columns; dx += 1) {
            expect(owner[(block.row + dy) * columns + block.column + dx]).toBe(-1);
            owner[(block.row + dy) * columns + block.column + dx] = index;
          }
        });
        expect(owner.every(index => index >= 0)).toBe(true);
        expect(new Set(blocks.map(block => `${block.columns}x${block.rows}`)).size).toBeGreaterThanOrEqual(3);
        for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
          const self = owner[row * columns + column];
          if (column + 1 < columns && owner[row * columns + column + 1] !== self) expect(blocks[owner[row * columns + column + 1]].tone).not.toBe(blocks[self].tone);
          if (row + 1 < rows && owner[(row + 1) * columns + column] !== self) expect(blocks[owner[(row + 1) * columns + column]].tone).not.toBe(blocks[self].tone);
        }
        expect(blocks.some(block => block.early) && blocks.some(block => !block.early)).toBe(true);
      }
    }
    // Only the four reference tones; the first beat shows part of the mosaic over A, the full-cover beat steps every colour.
    const early = frame(0.15), full = frame(0.3);
    for (const fill of [...fillsOf(early.overlay!), ...fillsOf(full.overlay!)]) expect([palette().accent, palette().accent2, palette().paper, palette().ink]).toContain(fill);
    expect(painted(early.overlay!, LANDSCAPE, "overlay")).toBeGreaterThan(0.1);
    expect(painted(early.overlay!, LANDSCAPE, "overlay")).toBeLessThan(1);
    expect(frame(0.4).overlay).toBe(EMPTY(LANDSCAPE));
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
