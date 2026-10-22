import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { tripleSplitPanel, tripleSplitPlate, tripleSplitSwitch, tripleSplitTones } from "./X27_tripleSplit";

const ID = "X27";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "41a5c053f4f93df68551f9242c9f6c62af2ccdc651f2c90851587ada88adae6a",
    "c5a30314de99cf0e04660465e71a88a02ac98c3afb23116b9971be4f2a9c2d2e",
    "928dc2b7a84deb03af3c6366e2730a7109b7793422d4a9f4405230a6d9f7bbc5",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "8f83cbc1bdd9c5efdad4f168cead65c3ca3267c61f4592c004eca88f05d71887",
    "5e6cd1f720c4542569743d318cab4095c457206edf5236d5c22aaaa01df34dda",
    "85a7e46264486b46e24ff8c8ce0f7626e5ba2c1eef07b0f37d0a80b281e66f1c",
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

describe("X27 Triple Split", () => {
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

  it("switches its three equal panels to B one after another, the middle one at exactly D/2 (every energy, duration, direction, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const direction of MOTION_TRANSITION_DIRECTIONS) {
            const input = { energy, durationSeconds, direction }, label = `${energy} ${durationSeconds} ${direction} ${size.width}`;
            expect(coverage(0.499 * durationSeconds, input, size), label).toBeLessThan(0.5);
            expect(coverage(0.5 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
            expect(Math.abs(coverage(0.45 * durationSeconds, input, size) - 1 / 3), label).toBeLessThan(0.01);
            expect(Math.abs(coverage(0.55 * durationSeconds, input, size) - 2 / 3), label).toBeLessThan(0.01);
          }
        }
      }
    }
  });

  it("keeps the domino stagger at 0.16 of the duration (0.08 s at 0.5 s), so it scales with the duration", () => {
    expect([0, 1, 2].map(tripleSplitSwitch)).toEqual([0.5 - 0.16, 0.5, 0.5 + 0.16]);
    expect((tripleSplitSwitch(1) - tripleSplitSwitch(0)) * 0.5).toBeCloseTo(0.08, 12);
    const centre = (index: number, size: MotionFrameSize) => {
      const quad = tripleSplitPanel(index, size.height * 0.45, size.height * 0.55, size);
      return [quad.reduce((sum, [x]) => sum + x, 0) / 4, quad.reduce((sum, [, y]) => sum + y, 0) / 4] as const;
    };
    for (const durationSeconds of [0.5, 1, 2]) {
      for (const index of [0, 1, 2]) {
        const at = tripleSplitSwitch(index) * durationSeconds, [x, y] = centre(index, LANDSCAPE);
        expect(valueAt(shapes(frame(at * 0.998, { durationSeconds }).matte, "matte"), x, y)).toBe(0);
        expect(valueAt(shapes(frame(at, { durationSeconds }).matte, "matte"), x, y)).toBe(1);
        // At its switch the panel's plate covers it completely, so the switch is never seen.
        expect(tripleSplitPlate(index, tripleSplitSwitch(index), "standard")).toEqual({ head: 1, tail: 0 });
        expect(valueAt(shapes(frame(at, { durationSeconds }).overlay!, "overlay"), x, y)).toBe(1);
      }
    }
  });

  it("drops each plate in from the top of its 18° panel and out of the bottom, cascading from the start side", () => {
    // Panel 0 mid-drop: its top is covered, its bottom is not yet.
    const top = tripleSplitPanel(0, 40, 60, LANDSCAPE), bottom = tripleSplitPanel(0, 1020, 1040, LANDSCAPE);
    const mid = (quad: readonly (readonly [number, number])[]) => [quad.reduce((s, [x]) => s + x, 0) / 4, quad.reduce((s, [, y]) => s + y, 0) / 4] as const;
    const overlay = shapes(frame((tripleSplitSwitch(0) - 0.15) * 0.5).overlay!, "overlay");
    expect(valueAt(overlay, ...mid(top))).toBe(1);
    expect(valueAt(overlay, ...mid(bottom))).toBe(0);
    // The dividers lean 18° (both shift by tan 18° × height top to bottom) and cross mid-height at the frame's thirds.
    const quad = tripleSplitPanel(1, 0, 1080, LANDSCAPE), lean = 1080 * Math.tan((18 * Math.PI) / 180);
    expect(quad[3][0] - quad[0][0]).toBeCloseTo(lean, 9);
    expect(quad[2][0] - quad[1][0]).toBeCloseTo(lean, 9);
    const middle = tripleSplitPanel(1, 540, 540, LANDSCAPE);
    expect([middle[0][0], middle[1][0]]).toEqual([640, 1280]);
    // The cascade runs from the side the direction names.
    const b = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.2, { direction }).matte, "matte"), x, y);
    expect([b("left_to_right", 100, 540), b("left_to_right", 1820, 540)]).toEqual([1, 0]);
    expect([b("right_to_left", 100, 540), b("right_to_left", 1820, 540)]).toEqual([0, 1]);
    expect([b("top_to_bottom", 960, 60), b("top_to_bottom", 960, 1020)]).toEqual([1, 0]);
    expect([b("bottom_to_top", 960, 60), b("bottom_to_top", 960, 1020)]).toEqual([0, 1]);
  });

  it("alternates accent and ink plates (accent first by default; the seed swaps them) with a paper line on each tail", () => {
    expect(tripleSplitTones(1)).toEqual(["accent", "ink", "accent"]);
    expect(new Set(Array.from({ length: 8 }, (_, seed) => tripleSplitTones(seed + 1).join("/")))).toEqual(new Set(["accent/ink/accent", "ink/accent/ink"]));
    const overlay = frame(0.3).overlay!;
    expect(overlay).toContain(`fill="${palette().accent}"`);
    expect(overlay).toContain(`fill="${palette().ink}"`);
    expect(overlay).toContain(`fill="${palette().paper}"`);
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
