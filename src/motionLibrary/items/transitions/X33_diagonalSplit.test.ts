import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { diagonalSplitAngle, diagonalSplitLean, diagonalSplitLine } from "./X33_diagonalSplit";
const fillsOf = (svg: string) => [...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);

const ID = "X33";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "5a1e86af8e5d5ddba646edf9de2a2ff1b6f56f0415070bb43aa9e7b0d368f727",
    "0983af3dfd1104c3aac9f3fd8e49db667d34359191a7611e1dbb5a67ef024fdb",
    "518eccc2513b2d5e6bd83014e46340c1cfdbd92ad9b63672d9e876a6c92ec950",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "c0899bb0efd60adc94fa3b431df495290c4b578eea8ef7db30f70e0953188c94",
    "84210df87116c6793085aa97dec8a30b52de9717e1db3f60e548eb15207f4a34",
    "859261ad71f25e4aec775584b390beab8b0354a25bc3588034b789b5b59741d9",
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

describe("X33 Diagonal Split", () => {
  for (const [format, size] of Object.entries({ portrait: PORTRAIT, landscape: LANDSCAPE }) as Array<["portrait" | "landscape", MotionFrameSize]>) {
    it(`${format} matches its golden hashes at ${TIMES.join(", ")} s`, () => {
      expect(TIMES.map(t => { const f = frame(t, undefined, size); return sha256(`${f.matte}\n--overlay--\n${f.overlay ?? ""}`); })).toEqual(GOLDEN[format]);
    });
  }

  it("matte is strictly all A at t = 0 and all B at t = D, overlay empty, for every energy, duration and direction", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const direction of MOTION_TRANSITION_DIRECTIONS) {
            const input = { energy, durationSeconds, direction };
            const start = frame(0, input, size), end = frame(durationSeconds, input, size);
            expect([start.matte, start.overlay, end.matte, end.overlay]).toEqual([ALL_A(size), EMPTY(size), ALL_B(size), EMPTY(size)]);
          }
        }
      }
    }
    expect(item().supportedDirections).toEqual(MOTION_TRANSITION_DIRECTIONS);
  });

  it("B covers half the frame at D/2 and crosses 50% inside 45–55% of the duration (every energy, duration, every direction, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const direction of MOTION_TRANSITION_DIRECTIONS) {
            const input = { energy, durationSeconds, direction }, label = `${energy} ${durationSeconds} ${direction} ${size.width}`;
            expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
            expect(Math.abs(coverage(0.5 * durationSeconds, input, size) - 0.5), label).toBeLessThan(0.01);
            expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
          }
        }
      }
    }
  });

  it("B only grows, in portrait and landscape", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      let previous = 0;
      for (let step = 1; step <= 20; step += 1) {
        const value = coverage((step / 20) * 0.5, undefined, size);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
      }
      expect(previous).toBe(1);
    }
  });

  it("sweeps one straight split that turns from 60° to 75° off the travel axis, solved to the exact share of the frame", () => {
    expect([diagonalSplitAngle(0), diagonalSplitAngle(0.5), diagonalSplitAngle(1)]).toEqual([60, 67.5, 75]);
    expect(new Set(Array.from({ length: 8 }, (_, seed) => diagonalSplitLean(seed + 1)))).toEqual(new Set([1, -1]));
    for (const share of [0.1, 0.5, 0.9]) {
      const { offset, slope } = diagonalSplitLine(share, 67.5, 1, 1920, 1080);
      expect(slope).toBeCloseTo(1 / Math.tan((67.5 * Math.PI) / 180), 12);
      // The B side of the line covers exactly `share`: a coarse numerical integral of the clipped columns.
      let covered = 0;
      for (let row = 0; row < 1080; row += 1) covered += Math.min(1920, Math.max(0, offset + (row + 0.5 - 540) * slope));
      expect(covered / (1920 * 1080)).toBeCloseTo(share, 3);
    }
    // The matte's split edge runs at the current angle: two points on it at different heights.
    const p = 0.4, { offset, slope } = diagonalSplitLine(4 * 0.4 ** 3, diagonalSplitAngle(p), diagonalSplitLean(1), 1920, 1080);
    const m = shapes(frame(p * 0.5).matte, "matte");
    for (const y of [200, 880]) {
      const x = offset + (y - 540) * slope;
      expect([valueAt(m, x - 3, y), valueAt(m, x + 3, y)]).toEqual([1, 0]);
    }
  });

  it("rides a flat accent band ahead of the split with a thin deep-shade leading edge, swelling in and out", () => {
    const p = 0.5, angle = diagonalSplitAngle(p), sine = Math.sin((angle * Math.PI) / 180);
    const { offset } = diagonalSplitLine(0.5, angle, diagonalSplitLean(1), 1920, 1080);
    const accent = (0.16 * 1080) / sine, deep = (0.022 * 1080) / sine;
    const overlay = frame(p * 0.5).overlay!;
    expect(fillsOf(overlay)).toEqual([palette().accent, palette().accent2]);
    const o = shapes(overlay, "overlay");
    expect([valueAt(o, offset + accent / 2, 540), valueAt(o, offset + accent + deep / 2, 540), valueAt(o, offset + accent + deep + 8, 540)]).toEqual([1, 1, 0]);
    // The deep edge leads: its strip lies beyond the accent band.
    const deepOnly = shapes(overlay.replace(/<path[^>]*fill="#[0-9A-F]{6}"\/>/, ""), "overlay");
    expect([valueAt(deepOnly, offset + accent / 2, 540), valueAt(deepOnly, offset + accent + deep / 2, 540)]).toEqual([0, 1]);
    // The sweep runs the way the direction names.
    const b = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.225, { direction }).matte, "matte"), x, y);
    expect([b("left_to_right", 8, 540), b("left_to_right", 1912, 540)]).toEqual([1, 0]);
    expect([b("right_to_left", 8, 540), b("right_to_left", 1912, 540)]).toEqual([0, 1]);
    expect([b("top_to_bottom", 960, 8), b("top_to_bottom", 960, 1072)]).toEqual([1, 0]);
    expect([b("bottom_to_top", 960, 8), b("bottom_to_top", 960, 1072)]).toEqual([0, 1]);
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
