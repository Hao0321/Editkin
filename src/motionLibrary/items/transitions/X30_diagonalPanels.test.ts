import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { diagonalPanelPart, diagonalPanelSlide, diagonalPanelTones } from "./X30_diagonalPanels";

const ID = "X30";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "a1a18f777eb2abf8987582aa37f3fc6ade1e3d1205857e8325f59654cfefdbe7",
    "9fbb5c9952baba51b1765e1b7b7b83af2c31492ca857944652d8d0f697d4c849",
    "1009fb9839b6f083278d75b80457807eaf4eea1a14b0dbaa9ecdc57f0ae05236",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "cb3c03e47ac12e55f11ebf68e2c52da1b02b4cc1c7a73fa96861c96a964cf3af",
    "0cfb6c2f680c124231375f53dbf201e011ffd1e74045cceb7d4224e49def5514",
    "06798164efd35ce76f2f9a56d719680fa977f69b6c392084c76f92d9e9c70080",
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

describe("X30 Diagonal Panels", () => {
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

  it("switches A to B at exactly 50% while the bands cover the frame (every energy, duration, direction, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const direction of MOTION_TRANSITION_DIRECTIONS) {
            const input = { energy, durationSeconds, direction }, label = `${energy} ${durationSeconds} ${direction} ${size.width}`;
            expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
            expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
            for (const p of [0.49, 0.5]) expect(painted(frame(p * durationSeconds, input, size).overlay!, size, "overlay"), `${label} ${p}`).toBe(1);
            expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
            expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          }
        }
      }
    }
  });

  it("slides eight 45° bands in from the start corner in fast succession, each from its lower-left end", () => {
    const overlay = shapes(frame(0.05).overlay!, "overlay");
    // Band 0 is half in: its lower-left end is covered, its upper-right end and the far corner are not.
    expect([valueAt(overlay, 8, 100), valueAt(overlay, 100, 8), valueAt(overlay, 1900, 1060)]).toEqual([1, 0, 0]);
    // 45°: band 0 is the corner triangle u + v ≤ (1920 + 1080) / 8.
    const corner = diagonalPanelPart(0, 0, 1, LANDSCAPE);
    for (const [x, y] of corner) expect(x + y).toBeLessThanOrEqual(375 + 1e-9);
    expect(Math.max(...corner.map(([x, y]) => x + y))).toBeCloseTo(375, 9);
    // Succession: every band starts 0.035 after the previous one and all are in by 48.5%.
    for (let band = 1; band < 8; band += 1) {
      expect(diagonalPanelSlide(band, 0.04 + band * 0.035 - 0.001, "standard")).toBe(0);
      expect(diagonalPanelSlide(band, 0.04 + band * 0.035 + 0.1, "standard")).toBeGreaterThan(0);
    }
    expect(diagonalPanelSlide(7, 0.486, "hype")).toBe(1);
    // The succession starts at the corner the direction names.
    const o = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.08, { direction }).overlay!, "overlay"), x, y);
    expect([o("left_to_right", 20, 20), o("left_to_right", 1900, 20)]).toEqual([1, 0]);
    expect([o("right_to_left", 20, 20), o("right_to_left", 1900, 20)]).toEqual([0, 1]);
    expect([o("bottom_to_top", 20, 1060), o("bottom_to_top", 20, 20)]).toEqual([1, 0]);
  });

  it("then lets B take the bands over by the same slides, from the same corner", () => {
    const overlay = shapes(frame(0.3).overlay!, "overlay");
    expect(valueAt(overlay, 8, 100)).toBe(0);
    expect(valueAt(overlay, 1900, 1060)).toBe(1);
    expect(diagonalPanelSlide(0, 0.5, "standard")).toBe(0);
    expect(diagonalPanelSlide(7, 0.946, "standard")).toBe(1);
  });

  it("alternates the accent and its deep shade (seeded order)", () => {
    const tones = diagonalPanelTones(1);
    expect(tones).toHaveLength(8);
    for (let band = 1; band < 8; band += 1) expect(tones[band]).not.toBe(tones[band - 1]);
    expect(new Set(tones)).toEqual(new Set(["accent", "accent2"]));
    expect(new Set(Array.from({ length: 8 }, (_, seed) => diagonalPanelTones(seed + 1)[0]))).toEqual(new Set(["accent", "accent2"]));
    const overlay = frame(0.2).overlay!;
    expect([...overlay.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1])).toEqual([palette().accent, palette().accent2]);
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
