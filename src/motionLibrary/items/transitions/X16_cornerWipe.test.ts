import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { cornerFront, cornerLayout } from "./X16_cornerWipe";

const ID = "X16";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "7098cdd3b3af2812fc450a8c3a7143181512d492bd3f279f06e925c129c1664b",
    "ec9048e06ce275ab8979fcd262d02c176810f4bc58cf1300746a4ccc59b09e63",
    "edc4f965d9e88a33bc20fc530753fe553790010bef048e88c19b89b4a977dd71",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "0523b5dcb29ba20f056a10a31c3e11f38b234a76b11729f7256410525313e0c8",
    "82f902df1fb6520ff0ef3e5a4571fad4d25f35a7646e01e770f287e181e2772d",
    "4fed9a1eac6e9534421663054ddfec6befc267babd6a91738d6b0ccdf23b8b4f",
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

describe("X16 Corner Wipe", () => {
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

  it("switches A to B at exactly 50% while the four triangles cover the frame (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          for (const p of [0.45, 0.48, 0.5]) expect(painted(frame(p * durationSeconds, input, size).overlay!, size, "overlay"), `${label} ${p}`).toBe(1);
          expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("pushes four triangles in from the corners (staggered) and closes A to a convex shape at the centre", () => {
    const { order } = cornerLayout(1);
    const first = order.indexOf(0), last = order.indexOf(3);
    const corners: FlatPoint[] = [[30, 30], [1890, 30], [1890, 1050], [30, 1050]];
    const covered = (t: number, corner: number) => valueAt(shapes(frame(t).overlay!, "overlay"), corners[corner][0], corners[corner][1]);
    // Early on, the first corner in the order is covered and the last is not yet.
    const early = 0.5 * 0.13;
    expect(covered(early, first)).toBe(1);
    expect(covered(early, last)).toBe(0);
    // Mid-close, A is one convex shape round the centre, bounded by the four fronts (at most 8 vertices).
    const body = pathDs(frame(0.17).overlay!)[0];
    const open = flattenPathD(body)[1];
    expect(open.length).toBeGreaterThanOrEqual(3);
    expect(open.length).toBeLessThanOrEqual(8);
    expect(valueAt(shapes(frame(0.17).overlay!, "overlay"), 960, 540)).toBe(0);
    // Fronts: u + v from a corner is 0 there and 2 at the centre; every point is within 2 of some corner.
    expect(cornerFront(0, 0, 0, LANDSCAPE)).toBe(0);
    expect(cornerFront(2, 960, 540, LANDSCAPE)).toBe(2);
    for (const [x, y] of [[100, 900], [1500, 300], [960, 0]]) expect(Math.min(...[0, 1, 2, 3].map(c => cornerFront(c, x, y, LANDSCAPE)))).toBeLessThanOrEqual(2);
  });

  it("opens B from the corners after the switch while the deep shade collapses into the centre, with ink edge bands", () => {
    const late = frame(0.4);
    for (const [x, y] of [[20, 20], [1900, 20], [1900, 1060], [20, 1060]]) expect(valueAt(shapes(late.overlay!, "overlay"), x, y)).toBe(0);
    expect(valueAt(shapes(late.overlay!, "overlay"), 960, 540)).toBe(1);
    const fills = [...frame(0.17).overlay!.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);
    const { body, edge } = cornerLayout(1);
    expect([body, edge]).toEqual(["accent2", "ink"]);
    expect(fills).toEqual([palette()[body], palette()[edge]]);
    expect(new Set(Array.from({ length: 8 }, (_, seed) => cornerLayout(seed + 1).body))).toEqual(new Set(["accent2", "ink"]));
    expect(new Set(Array.from({ length: 8 }, (_, seed) => cornerLayout(seed + 1).order.indexOf(0))).size).toBeGreaterThan(1);
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
