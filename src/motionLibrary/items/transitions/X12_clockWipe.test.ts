import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { clockEdgePoint, clockSector } from "./X12_clockWipe";

const ID = "X12";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "68770e3bb1ebebd6a93a3f70cd85daa3fbcbc2fe13ab18801ec2fbf13cdbb8b8",
    "35fb66d937a00fe850abf288049b34e03daba785f29a8e1fb27c521d5397586c",
    "b05339f305887ee8973ea46e81a342a3fa9ecb9e6046f3820c95812bf5b9f09a",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "00585d1569b27385f27229e28e8fce7a2cdbffadf92639218b876a96d50e2500",
    "a103a0e18ee3d7de1d1e9524a5f04627f9fcde1e082f6ef3accb5f83e811ab0f",
    "5c6385965031c850131307cfb4450c71e804df616ed7192bd452c3b8f4922f31",
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
const coverage = (t: number, input?: Record<string, unknown>, size = LANDSCAPE) => painted(frame(t, input, size).matte, size, "matte");
/** Shoelace area of a polygon. */
const area = (points: readonly FlatPoint[]) => Math.abs(points.reduce((sum, [x, y], index) => {
  const [nx, ny] = points[(index + 1) % points.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;

describe("X12 Clock Wipe", () => {
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

  it("B covers exactly the right half at D/2 and crosses 50% inside 45–55% (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
          expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
          const half = flattenPathD(/<path d="([^"]+)"/.exec(frame(0.5 * durationSeconds, input, size).matte)![1])[0];
          expect(area(half) / (size.width * size.height), label).toBeCloseTo(0.5, 9);
        }
      }
    }
  });

  it("sweeps clockwise from 12 o'clock, exactly, at any aspect", () => {
    for (const size of [PORTRAIT, LANDSCAPE, { width: 1080, height: 1080 }]) {
      let previous = 0;
      for (let degrees = 5; degrees < 360; degrees += 5) {
        const sector = clockSector(degrees, size), fraction = area(sector) / (size.width * size.height);
        expect(fraction).toBeGreaterThan(previous);
        previous = fraction;
        const [x, y] = clockEdgePoint(degrees, size);
        expect(Math.abs(x) < 1e-9 || Math.abs(y) < 1e-9 || Math.abs(x - size.width) < 1e-9 || Math.abs(y - size.height) < 1e-9).toBe(true);
      }
      expect(area(clockSector(90, size)) / (size.width * size.height)).toBeCloseTo(0.25, 9);
      expect(area(clockSector(270, size)) / (size.width * size.height)).toBeCloseTo(0.75, 9);
    }
    // Early on B is a thin wedge just right of 12 o'clock.
    const b = (x: number, y: number) => valueAt(shapes(frame(0.15).matte, "matte"), x, y);
    expect([b(1000, 20), b(920, 20), b(1000, 1060)]).toEqual([1, 0, 0]);
  });

  it("rides a thin ink hand on the edge that fades in and out", () => {
    const hand = (t: number) => /<path d="([^"]+)" fill="(#[0-9A-F]{6})"(?: opacity="([\d.]+)")?\/>/.exec(frame(t).overlay!)!;
    const middle = hand(0.25);
    expect(middle[2]).toBe(palette().ink); // ink
    expect(middle[3]).toBeUndefined();
    const [quad] = flattenPathD(middle[1]);
    // 0.7% of the short side wide, from the centre out past the frame along 6 o'clock at D/2.
    expect(Math.hypot(quad[0][0] - quad[3][0], quad[0][1] - quad[3][1])).toBeCloseTo(0.007 * 1080, 1);
    expect((quad[0][0] + quad[3][0]) / 2).toBeCloseTo(960, 1);
    expect(Math.max(...quad.map(([, y]) => y))).toBeGreaterThan(1080);
    expect(Number(hand(0.02)[3])).toBeLessThan(0.5);
    expect(Number(hand(0.48)[3])).toBeLessThan(0.5);
    expect(frame(0.25, { palette: { ink: "#123456" } }).overlay).toContain('fill="#123456"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, undefined, PORTRAIT)).toEqual(frame(0.3, undefined, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
