import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { circleAreaInFrame, circleWipeCentre, circleWipeRadius } from "./X09_circleWipe";

const ID = "X09";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "4a81b59727aa1436740e8843c01925f49c523edd1b73808e1112c3da9be93ad5",
    "8c710edaad97bfa3a9344fac3241493ed4ec21f313ea366790aa79da3d6a2505",
    "9c35cc65477da85e8e1830f0471af002401ed64c535d9b4369b9f142e13b6ca4",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "2ce4c13579137c60f1c910b6c401881c83b04d80e7361a187df8fbe657b456c4",
    "03949e01e2d574fe6639ff814bdbeb214eabecfd90a6f5e02bc36cd7c7b81c68",
    "0287a091c7373af2987af9543f0b7144b9e9b75efbf51c58cc6436efdf95bfef",
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

describe("X09 Circle Wipe", () => {
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

  it("B covers half the frame at D/2 and crosses 50% inside 45–55% (every energy, duration, several seeds, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const seed of [1, 2, 3, 4]) {
            const input = { energy, durationSeconds, seed }, label = `${energy} ${durationSeconds} ${seed} ${size.width}`;
            expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
            expect(Math.abs(coverage(0.5 * durationSeconds, input, size) - 0.5), label).toBeLessThan(0.01);
            expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
          }
        }
      }
    }
  });

  it("grows only, easing in from a point, and finishes on the farthest corner", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      let previous = 0;
      for (let step = 1; step <= 20; step += 1) {
        const value = coverage((step / 20) * 0.5, undefined, size);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
    const [half, full_] = [600, 1500];
    for (const power of [1.25, 1.6, 1.9, 2.2]) {
      const radii = Array.from({ length: 101 }, (_, index) => circleWipeRadius(index / 100, half, full_, power));
      expect(radii[0]).toBe(0);
      expect(radii[50]).toBeCloseTo(half, 9);
      expect(radii[100]).toBe(full_);
      for (let index = 1; index <= 100; index += 1) expect(radii[index]).toBeGreaterThan(radii[index - 1]);
      // Ease in: the first steps are the smallest.
      expect(radii[1] - radii[0]).toBeLessThan(radii[50] - radii[49]);
      // The slope is continuous through D/2.
      expect((radii[51] - radii[50]) / (radii[50] - radii[49])).toBeCloseTo(1, 1);
    }
  });

  it("starts in the lower-left third for seed 1 and moves to other off-centre zones with the seed", () => {
    const [x, y] = circleWipeCentre(1, LANDSCAPE);
    expect(x).toBeLessThan(1920 / 3);
    expect(y).toBeGreaterThan(1080 / 2);
    const zones = new Set([1, 2, 3, 4].map(seed => { const [cx, cy] = circleWipeCentre(seed, LANDSCAPE); return `${cx < 960 ? "L" : "R"}${cy < 540 ? "T" : "B"}`; }));
    expect(zones).toEqual(new Set(["LB", "RT", "RB", "LT"]));
    // Exact area helper agrees with geometry: a circle wholly inside, and one clipped to a quarter.
    expect(circleAreaInFrame(960, 540, 200, LANDSCAPE)).toBeCloseTo(Math.PI * 200 * 200, 0);
    expect(circleAreaInFrame(0, 0, 300, LANDSCAPE)).toBeCloseTo((Math.PI * 300 * 300) / 4, 0);
  });

  it("leads B with a thin accent2 ring that tucks 1.5 px under it", () => {
    const middle = frame(0.2);
    const ring = /<path d="([^"]+)" fill="(#[0-9A-F]{6})" fill-rule="evenodd"\/>/.exec(middle.overlay!)!;
    expect(ring[2]).toBe(palette().accent2); // the deep shade
    const [outer, inner] = flattenPathD(ring[1]);
    const matte = flattenPathD(/<path d="([^"]+)"/.exec(middle.matte)![1])[0];
    const [cx, cy] = circleWipeCentre(1, LANDSCAPE);
    const radius = (points: readonly FlatPoint[]) => Math.max(...points.map(([px, py]) => Math.hypot(px - cx, py - cy)));
    expect(radius(inner)).toBeCloseTo(radius(matte) - 1.5, 1);
    expect(radius(outer)).toBeGreaterThan(radius(matte) + 20);
    expect(frame(0.2, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    expect(frame(0.3, { seed: 7 })).not.toEqual(frame(0.3, { seed: 8 }));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, { seed: index }, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
