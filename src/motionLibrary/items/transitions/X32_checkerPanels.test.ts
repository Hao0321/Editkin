import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { checkerFlip, checkerGrid, checkerLayout, checkerWave } from "./X32_checkerPanels";

const ID = "X32";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "dc052be88dc95674a20961602ae84f8d58a0fe05b4182ed85774fa07c3f50f43",
    "d656226cd2946445c8992884a8a38cb3ff77f9d23ecf6cb7fb26bdcb5f81899b",
    "c3c55f92aaef46a56c3e16b714ffc9271dd1086b960b5a813b2cf30dcb3715c6",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "35597f3e1d74a5be418a9b309c6db0e5ce5f463233835a2f9a5ee6e084c14a26",
    "03a6c02f2da89ca777b0bfd324c9820bcaf0398279a64084e28e33240bed12ce",
    "f4d9b5426930389975cb8cb53f8f3544d8339492b62f4ac5a2e6b9570bd7e8a3",
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

describe("X32 Checker Panels", () => {
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

  it("switches each tile when it is edge-on, so B crosses half the frame at D/2 (every energy, duration, seed, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const seed of [1, 2, 3, 4]) {
            const input = { energy, durationSeconds, seed }, label = `${energy} ${durationSeconds} ${seed} ${size.width}`;
            expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
            expect(Math.abs(coverage(0.5 * durationSeconds, input, size) - 0.5), label).toBeLessThan(0.02);
            expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
          }
        }
      }
    }
    // Both 16:9 grids have nine diagonal steps: the two middle diagonals switch symmetrically about D/2.
    for (const energy of MOTION_ENERGIES) {
      const { spread } = checkerWave(9, energy);
      expect(0.5 - (0.5 + (4 / 9 - 0.5) * spread)).toBeCloseTo(0.5 + (5 / 9 - 0.5) * spread - 0.5, 12);
      expect(checkerFlip(4, 9, 0.5, energy).local).toBeGreaterThan(0.5);
      expect(checkerFlip(5, 9, 0.5, energy).local).toBeLessThan(0.5);
    }
    // An even grid (square) switches its middle diagonal at exactly D/2.
    expect(checkerGrid({ width: 1080, height: 1080 })).toEqual({ columns: 4, rows: 4 });
    for (const energy of MOTION_ENERGIES) expect(checkerFlip(3, 6, 0.5, energy).local).toBe(0.5);
  });

  it("flips big square tiles (four across the short side) in a diagonal wave at most two diagonals deep, from a seeded corner", () => {
    expect([checkerGrid(PORTRAIT), checkerGrid(LANDSCAPE)]).toEqual([{ columns: 4, rows: 7 }, { columns: 7, rows: 4 }]);
    expect(new Set(Array.from({ length: 16 }, (_, seed) => checkerLayout(seed + 1).corner))).toEqual(new Set([0, 1, 2, 3]));
    for (const energy of MOTION_ENERGIES) {
      for (const last of [6, 9]) {
        for (let step = 0; step <= 1000; step += 1) {
          let turning = 0;
          for (let k = 0; k <= last; k += 1) { const { local } = checkerFlip(k, last, step / 1000, energy); if (local > 0 && local < 1) turning += 1; }
          expect(turning, `${energy} ${last} ${step}`).toBeLessThanOrEqual(2);
        }
      }
    }
    // B only grows: every tile flips once.
    let previous = 0;
    for (let step = 1; step <= 40; step += 1) { const value = coverage((step / 40) * 0.5); expect(value).toBeGreaterThanOrEqual(previous); previous = value; }
  });

  it("draws two flat tones only: A's face untouched, B's face crisp in a deep-shade edge, the deep-shade board at the sides, edge-on cells all board", () => {
    const { corner } = checkerLayout(1), { columns, rows } = checkerGrid(LANDSCAPE), last = columns + rows - 2;
    const k = (column: number, row: number) => (corner === 1 || corner === 2 ? columns - 1 - column : column) + (corner >= 2 ? rows - 1 - row : row);
    const index = Array.from({ length: columns * rows }, (_, i) => i).find(i => k(i % columns, Math.floor(i / columns)) === 4)!;
    const column = index % columns, row = Math.floor(index / columns);
    const x0 = Math.round((column * 1920) / columns), x1 = Math.round(((column + 1) * 1920) / columns);
    const y0 = Math.round((row * 1080) / rows), y1 = Math.round(((row + 1) * 1080) / rows), mid = (x0 + x1) / 2, yc = (y0 + y1) / 2;
    const { spread, flip } = checkerWave(last, "standard"), centre = 0.5 + (4 / last - 0.5) * spread;
    const at = (local: number) => centre + (local - 0.5) * flip;
    const overlayAt = (local: number) => shapes(frame(at(local) * 0.5).overlay!, "overlay");
    // θ = 60°: A's face half the cell wide, untouched (no edge), with board at both sides.
    const front = Math.sqrt(1 / 6), half60 = ((x1 - x0) / 2) * 0.5;
    expect(checkerFlip(4, last, at(front), "standard").theta).toBeCloseTo(60, 6);
    const o60 = overlayAt(front);
    expect([valueAt(o60, x0 + 5, yc), valueAt(o60, mid, yc), valueAt(o60, mid - half60 + 5, yc), valueAt(o60, mid, y0 + 5)]).toEqual([1, 0, 0, 0]);
    // Edge-on: the whole cell is board and the matte has switched underneath.
    expect([valueAt(overlayAt(0.5), mid, yc), valueAt(shapes(frame(at(0.5) * 0.5).matte, "matte"), mid, yc)]).toEqual([1, 1]);
    // θ = 135°: B's face (no overlay) inside a deep edge on all four sides, board beyond it.
    const back = 1 - Math.sqrt(0.125), half135 = ((x1 - x0) / 2) * Math.SQRT1_2;
    expect(checkerFlip(4, last, at(back), "standard").theta).toBeCloseTo(135, 6);
    const o135 = overlayAt(back);
    expect([valueAt(o135, mid, yc), valueAt(o135, mid - half135 + 4, yc), valueAt(o135, mid + half135 - 4, yc), valueAt(o135, mid, y0 + 4), valueAt(o135, mid, y1 - 4), valueAt(o135, x0 + 5, yc)]).toEqual([0, 1, 1, 1, 1, 1]);
    // Landing flat: the edge has narrowed away and the board is gone, so B shows clean.
    const o178 = overlayAt(0.97);
    expect([valueAt(o178, mid, y0 + 2), valueAt(o178, x0 + 2, yc)]).toEqual([0, 0]);
    // One flat tone in the overlay, never partial opacity.
    for (let step = 1; step < 30; step += 1) {
      const overlay = frame((step / 30) * 0.5).overlay!;
      for (const [, fill] of overlay.matchAll(/fill="(#[0-9A-F]{6})"/g)) expect(fill).toBe(palette().accent2);
      expect(overlay).not.toContain("opacity");
    }
    expect(frame(0.25, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
