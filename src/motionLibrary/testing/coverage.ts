import { flattenPathD, type FlatPoint } from "../svg/pathOps";
import type { MotionFrameSize } from "../types";

/**
 * Test utility: a scanline coverage probe for transition mattes and overlays (the
 * rasterizer the X02–X12 tests each carried). It reads the flat <rect>/<path>
 * frames these items draw and samples a grid at cell centres:
 * - "matte": painter's order; #FFFFFF paints 1 (B) and #000000 paints 0 (A); any other fill throws.
 * - "overlay": every opaque fill paints 1; fill="none" and translucent shapes are skipped.
 * Paths may use absolute M/L/H/V/Q/C/Z (circleBezierPathD for circles); fill-rule
 * is honoured. Anything it cannot read exactly (a transform, an arc, <circle>,
 * <polygon>, clip paths or gradients) throws instead of guessing.
 *
 * Usage:
 *   const b = paintedFraction(frame.matte, size, "matte");           // B share of the frame, 0..1
 *   expect(valueAt(frame.matte, "matte", 10, 10)).toBe(1);
 */

export type CoverageMode = "matte" | "overlay";

export interface CoverageShape {
  readonly rings: readonly FlatPoint[][];
  readonly evenOdd: boolean;
  /** What the shape paints: 1 or 0. */
  readonly value: 0 | 1;
}

const UNSUPPORTED = /<(circle|ellipse|polygon|polyline|line|image|text|clipPath|mask|linearGradient|radialGradient|pattern|use)\b|\stransform="|\sclip-path="|\smask="|\sfilter="/;

/** The shapes a frame paints, in document order. */
export function coverageShapes(svg: string, mode: CoverageMode): CoverageShape[] {
  const unsupported = UNSUPPORTED.exec(svg);
  if (unsupported) throw new Error(`coverage probe cannot read ${unsupported[0].trim()}`);
  const result: CoverageShape[] = [];
  for (const [, tag, attrs] of svg.matchAll(/<(rect|path)\b([^>]*?)\/?>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
    const fill = (attr("fill") ?? "#000000").toUpperCase();
    if (mode === "matte" && fill !== "#FFFFFF" && fill !== "#000000") throw new Error(`a matte may only paint #FFFFFF or #000000 (found ${fill})`);
    if (mode === "overlay" && (fill === "NONE" || Number(attr("opacity") ?? 1) < 1 || Number(attr("fill-opacity") ?? 1) < 1)) continue;
    const rings: FlatPoint[][] = tag === "rect"
      ? (() => {
        if (attr("rx") || attr("ry")) throw new Error("coverage probe cannot read rounded rects");
        const [x, y, w, h] = ["x", "y", "width", "height"].map(name => Number(attr(name) ?? 0));
        return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
      })()
      : flattenPathD(attr("d") ?? "", { segmentLength: 4, label: "coverage probe" });
    result.push({ rings, evenOdd: attr("fill-rule") === "evenodd", value: mode === "overlay" || fill === "#FFFFFF" ? 1 : 0 });
  }
  return result;
}

/** Spans [x0, x1) of the horizontal line y inside the shape. */
function spans(shape: CoverageShape, y: number): Array<readonly [number, number]> {
  const hits: Array<readonly [number, number]> = [];
  for (const ring of shape.rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const [ax, ay] = ring[index], [bx, by] = ring[(index + 1) % ring.length];
      if ((ay <= y) !== (by <= y)) hits.push([ax + ((y - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  const result: Array<readonly [number, number]> = [];
  let winding = 0;
  for (let index = 0; index + 1 < hits.length; index += 1) {
    winding += hits[index][1];
    if (shape.evenOdd ? index % 2 === 0 : winding !== 0) result.push([hits[index][0], hits[index + 1][0]]);
  }
  return result;
}

/** 0/1 grid (row-major, columns × rows) sampled at cell centres. */
export function coverageGrid(svg: string, size: MotionFrameSize, mode: CoverageMode, columns = 192, rows = 108): Uint8Array {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) throw new Error("coverage grid needs whole positive columns and rows");
  const grid = new Uint8Array(columns * rows);
  for (const shape of coverageShapes(svg, mode)) {
    for (let row = 0; row < rows; row += 1) {
      for (const [x0, x1] of spans(shape, ((row + 0.5) * size.height) / rows)) {
        const from = Math.max(0, Math.ceil((x0 * columns) / size.width - 0.5)), to = Math.min(columns - 1, Math.ceil((x1 * columns) / size.width - 0.5) - 1);
        for (let column = from; column <= to; column += 1) grid[row * columns + column] = shape.value;
      }
    }
  }
  return grid;
}

/** Share of the grid painted 1: for a matte, how much of the frame shows B. */
export function paintedFraction(svg: string, size: MotionFrameSize, mode: CoverageMode, columns = 192, rows = 108): number {
  const grid = coverageGrid(svg, size, mode, columns, rows);
  return grid.reduce((sum, cell) => sum + cell, 0) / grid.length;
}

/** What the frame paints at one point (frame px): the last shape covering it wins. */
export function valueAt(svg: string, mode: CoverageMode, x: number, y: number): 0 | 1 {
  let value: 0 | 1 = 0;
  for (const shape of coverageShapes(svg, mode)) if (spans(shape, y).some(([x0, x1]) => x >= x0 && x < x1)) value = shape.value;
  return value;
}
