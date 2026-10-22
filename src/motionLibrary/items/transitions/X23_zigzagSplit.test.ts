import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { zigzagProfile } from "./X23_zigzagSplit";

const ID = "X23";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "e9d92aa7a876c4a7ed355cc9a7c1a50f7457277ead0394a5dcd1093440acd0c9",
    "01d61c2145b9546b60472b16038c709fe2555e046f1b27b2295db0dbd5a3dbae",
    "d54712dc193a25e8f62fe4ae39029e6710a8d75171b132d1ab7e6e77bf3dbfe9",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "dd00c01ddf1e26ee92203b1b9414a25c6a46f298e29bc47cbe72bbab0ca3eab2",
    "48fb68966adcbf7839eb2dd5a195cc4409e82729b23ab731ecdb1411007e97bd",
    "9b89a98228ef8c1878d7e16315c3457c4cd09f883845b4ce8550827a0e3ff79d",
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

describe("X23 Zigzag Split", () => {
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

  it("B covers half the frame at D/2 and crosses 50% inside 45–55% of the duration (every energy, duration, direction, both formats)", () => {
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

  it("B only grows (within 0.3% where boiling teeth cross the frame edges), in portrait and landscape", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      let previous = 0;
      for (let step = 1; step <= 20; step += 1) {
        const value = coverage((step / 20) * 0.5, undefined, size);
        expect(value).toBeGreaterThanOrEqual(previous - 0.003);
        previous = value;
      }
      expect(previous).toBe(1);
    }
  });

  it("enters from the side the direction names", () => {
    const b = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.225, { direction }).matte, "matte"), x, y);
    expect([b("left_to_right", 8, 540), b("left_to_right", 1912, 540)]).toEqual([1, 0]);
    expect([b("right_to_left", 8, 540), b("right_to_left", 1912, 540)]).toEqual([0, 1]);
    expect([b("top_to_bottom", 960, 8), b("top_to_bottom", 960, 1072)]).toEqual([1, 0]);
    expect([b("bottom_to_top", 960, 8), b("bottom_to_top", 960, 1072)]).toEqual([0, 1]);
  });

  it("jitters its teeth 12 times a second while their offsets keep a zero integral (no area added)", () => {
    const a = zigzagProfile(1, 3, 1080, 1080), b = zigzagProfile(1, 3, 1080, 1080), c = zigzagProfile(1, 4, 1080, 1080);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const profile of [a, c, zigzagProfile(5, 9, 1920, 1080)]) {
      let integral = 0;
      for (let index = 0; index + 1 < profile.length; index += 1) integral += ((profile[index + 1][1] - profile[index][1]) * (profile[index][0] + profile[index + 1][0])) / 2;
      expect(Math.abs(integral)).toBeLessThan(1e-6);
      expect(profile[0][1]).toBe(0);
    }
    expect(a).toHaveLength(2 * Math.round(1 / 0.11) + 1);
    // A new boil step every 1/12 s of real time: the teeth change shape across a step boundary.
    const teeth = (t: number) => flattenPathD(pathDs(frame(t, { durationSeconds: 1 }).matte)[0])[0].slice(1, 2 * Math.round(1 / 0.11) + 2).map(([x]) => x);
    const shape = (t: number) => { const xs = teeth(t), mean = xs.reduce((sum, x) => sum + x, 0) / xs.length; return xs.map(x => Math.round(x - mean)); };
    expect(shape(1 / 12 + 0.001)).not.toEqual(shape(1 / 12 - 0.001));
    const band = /<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/.exec(frame(0.25).overlay!)!;
    expect(band[2]).toBe(palette().ink);
    expect(frame(0.25, { palette: { ink: "#123456" } }).overlay).toContain('fill="#123456"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
