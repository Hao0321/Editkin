import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { sliceCount } from "./X05_sliceWipe";

const ID = "X05";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "7b78ea54cada64e61a5af5904582a06457f0721023bc182a3a1cdb862a78f58c",
    "b201ac170b18951a439d636d8d1f2228616d0018b27b10e1ed54dab310f06743",
    "f72a521727f018cc73684ad393e1f468d38ce52dc0ef7261c0494a61828a2cfc",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "7e9ee70a51b939bfd9a995694eeaa7a4f65834dfc0b9d66cd19496c51db2449c",
    "f7cfdab5e1836d2ec92c128f5357adb26d19588c51daf8c23cafafc2977cc8ec",
    "96242c61292b84ae38d297f719d6982f9d4120f94112e9e4b386e60f6583f4c2",
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

describe("X05 Slice Wipe", () => {
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

  it("switches A to B at exactly 50% while the blades cover the whole frame (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          expect(painted(frame(0.48 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBe(1);
          expect(painted(frame(0.5 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBe(1);
          expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("cuts an even number of 20° slices that stab in alternately from the top and the bottom, left to right", () => {
    expect([sliceCount(PORTRAIT), sliceCount(LANDSCAPE), sliceCount({ width: 1080, height: 1080 })]).toEqual([6, 8, 6]);
    const early = frame(0.08).overlay!;
    // Seam strips come first (under the blades), then one path of blades per tone: the deep shade and paper (reference: accent and cream).
    const paths = [...early.matchAll(/<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/g)];
    expect(paths.slice(-2).map(([, , fill]) => fill)).toEqual([palette().accent2, palette().paper]);
    const seams = paths.slice(0, -2).flatMap(([, d]) => flattenPathD(d));
    expect(seams.length).toBeGreaterThan(0);
    for (const ring of seams) {
      const top = Math.min(...ring.map(([, y]) => y)), [p0, p1] = ring.filter(([, y]) => y === top);
      expect(Math.abs(p1[0] - p0[0])).toBeCloseTo(3, 1); // 2 × 1.5 px, centred on a slice boundary
    }
    const blades = paths.slice(-2).flatMap(([, d]) => flattenPathD(d)).map(ring => ({
      top: Math.min(...ring.map(([, y]) => y)), bottom: Math.max(...ring.map(([, y]) => y)), left: Math.min(...ring.map(([x]) => x)), ring,
    })).sort((a, b) => a.left - b.left);
    // Alternate ends: each blade touches the top or the bottom edge, and neighbours differ.
    const ends = blades.map(blade => (blade.top <= 0 ? "top" : blade.bottom >= 1080 ? "bottom" : "middle"));
    expect(ends).not.toContain("middle");
    for (let index = 1; index < ends.length; index += 1) expect(ends[index]).not.toBe(ends[index - 1]);
    // Left-to-right stagger: the first slice reaches further than the last one drawn this early.
    const reach = (blade: { top: number; bottom: number }) => blade.bottom - blade.top;
    expect(reach(blades[0])).toBeGreaterThan(reach(blades[blades.length - 1]));
    // The slant: a slice side (ring points 0 and 3, its left edge) runs 20° off vertical.
    const [p0, , , p3] = blades[0].ring;
    expect(Math.abs((p0[0] - p3[0]) / (p3[1] - p0[1]))).toBeCloseTo(Math.tan((20 * Math.PI) / 180), 2);
    // After the switch B takes each slice from the end its blade came in: the leftover blade touches the far end.
    const late = [...frame(0.33).overlay!.matchAll(/<path d="([^"]+)"/g)].slice(-2).flatMap(([, d]) => flattenPathD(d));
    expect(late.every(ring => Math.min(...ring.map(([, y]) => y)) <= 0 || Math.max(...ring.map(([, y]) => y)) >= 1080)).toBe(true);
    expect(frame(0.08, { palette: { accent2: "#00AA00", paper: "#ABCDEF" } }).overlay).toMatch(/fill="#00AA00".*fill="#ABCDEF"/);
  });

  it("is deterministic, seeded, and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.2, { seed: 7 }, PORTRAIT)).toEqual(frame(0.2, { seed: 7 }, PORTRAIT));
    expect(new Set(Array.from({ length: 8 }, (_, seed) => frame(0.2, { seed }).overlay)).size).toBeGreaterThan(1);
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
