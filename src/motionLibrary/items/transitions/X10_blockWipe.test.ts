import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { blockGrid } from "./X10_blockWipe";

const ID = "X10";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "a31b572c5f7ac2a0054c48915be1816293eff6cf0387a79348990fd5da424dbd",
    "9d89b595ff9dcbde9caa1a3f7359fd14312f2fedcca3df8e92cd53b5d2e63ad9",
    "981179a7a6b0003ccc0a27452dfba8a73a5d514ba2f63fed7751af2dae3ff678",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "7d98a150a2c72ab367c898be10864c7b8aea2ad1bd9df3d51b883849c0261b10",
    "2fab0514f84328f56bb9955855b9ae491af212d0a8946334db8cced0aa1520a3",
    "ca6e177643b8de8fcd401e62a032ea2a70a6e26d86e0788cb48f640212fe05b3",
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

// Scanline rasterizer for <rect>/<path> frames (these items use no transforms), sampled at cell centres.
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
/** Blocks of an overlay as boxes with their fill. */
function blocks(svg: string): Array<{ fill: string; x0: number; x1: number; y0: number; y1: number }> {
  return [...svg.matchAll(/<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/g)].flatMap(([, d, fill]) => flattenPathD(d).map(ring => ({
    fill, x0: Math.min(...ring.map(([x]) => x)), x1: Math.max(...ring.map(([x]) => x)), y0: Math.min(...ring.map(([, y]) => y)), y1: Math.max(...ring.map(([, y]) => y)),
  })));
}

describe("X10 Block Wipe", () => {
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

  it("switches A to B at exactly 50% while the blocks tile the whole frame (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      const { columns, rows } = blockGrid(size);
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          for (const p of [0.47, 0.5]) {
            // Settled blocks are exactly their whole-pixel cells: the full grid, no gaps, no overlaps.
            const tiles = blocks(frame(p * durationSeconds, input, size).overlay!);
            expect(tiles, `${label} ${p}`).toHaveLength(columns * rows);
            for (const tile of tiles) for (const edge of [tile.x0, tile.x1, tile.y0, tile.y1]) expect(Number.isInteger(edge)).toBe(true);
            expect(tiles.reduce((sum, tile) => sum + (tile.x1 - tile.x0) * (tile.y1 - tile.y0), 0)).toBe(size.width * size.height);
          }
          expect(painted(frame(0.2 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.8 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("pops near-square blocks on in a seeded random order, in an accent2 / ink checkerboard, with an overshoot", () => {
    expect(blockGrid(LANDSCAPE)).toEqual({ columns: 7, rows: 4 });
    expect(blockGrid(PORTRAIT)).toEqual({ columns: 4, rows: 7 });
    expect(blockGrid({ width: 1080, height: 1080 })).toEqual({ columns: 4, rows: 4 });
    const settled = blocks(frame(0.24).overlay!);
    const cellOf = (tile: { x0: number; y0: number; x1: number; y1: number }) => [Math.floor(((tile.x0 + tile.x1) / 2) / (1920 / 7)), Math.floor(((tile.y0 + tile.y1) / 2) / 270)];
    const fills = new Map(settled.map(tile => { const [c, r] = cellOf(tile); return [`${c},${r}`, tile.fill]; }));
    for (const [key, fill] of fills) {
      const [c, r] = key.split(",").map(Number);
      expect([palette().accent2, palette().ink]).toContain(fill); // the deep shade and ink
      if (fills.has(`${c + 1},${r}`)) expect(fills.get(`${c + 1},${r}`)).not.toBe(fill);
    }
    // Random order: the set of blocks already on differs between seeds early in the pop-on.
    const onAt = (seed: number) => blocks(frame(0.06, { seed }).overlay!).map(tile => cellOf(tile).join(",")).sort().join(" ");
    expect(new Set([1, 2, 3, 4].map(onAt)).size).toBeGreaterThan(1);
    // Overshoot: some block is larger than its cell while popping.
    const oversized = [0.02, 0.04, 0.06, 0.08, 0.1].some(t => blocks(frame(t).overlay!).some(tile => tile.x1 - tile.x0 > 1920 / 7 + 1));
    expect(oversized).toBe(true);
    expect(frame(0.24, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.2, { seed: 7 }, PORTRAIT)).toEqual(frame(0.2, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
