import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { zigzagTeeth } from "./X04_zigzagWipe";

const ID = "X04";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "625560701390aef5a855847da64ae3e05354c8bb5c90ab9676f6e1ba897bc6c5",
    "9376bd4857e3ced32deb2a141c87fb9d084328e32b95be2a6592a91b5d795263",
    "0bd6006a915591b6eabe4cb427e81af1f0009b7d1416cd3733393fef85ee762f",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "205111a88278a0d44853e212a4fc89d920408254643efd4a9f9f6eec1844838c",
    "0ca5bffd16c0ca7c6843815ac203c549700ab44cd73b6b6cea4e3e15b48235a0",
    "891aafec329dd9305b9d7e38453ff2965528aa091968716cf4e50a142660f3a4",
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

describe("X04 Zigzag Wipe", () => {
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
  });

  it("B covers half the frame at D/2 and crosses 50% inside 45–55% of the duration (every energy, duration, direction)", () => {
    for (const energy of MOTION_ENERGIES) {
      for (const durationSeconds of DURATIONS) {
        for (const direction of MOTION_TRANSITION_DIRECTIONS) {
          const input = { energy, durationSeconds, direction }, label = `${energy} ${durationSeconds} ${direction}`;
          expect(coverage(0.45 * durationSeconds, input), label).toBeLessThan(0.5);
          expect(Math.abs(coverage(0.5 * durationSeconds, input) - 0.5), label).toBeLessThan(0.01);
          expect(coverage(0.55 * durationSeconds, input), label).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it("B only grows, in portrait and landscape", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      let previous = 0;
      for (let step = 0; step <= 20; step += 1) {
        const value = coverage((step / 20) * 0.5, undefined, size);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
      expect(previous).toBe(1);
    }
  });

  it("has 5–6 right-angled teeth, led by an accent2 band that tucks under B", () => {
    const counts = new Set(Array.from({ length: 12 }, (_, seed) => zigzagTeeth(seed)));
    expect([...counts].sort()).toEqual([5, 6]);
    const teeth = zigzagTeeth(1), pitch = 1080 / teeth;
    const middle = frame(0.25);
    const front = flattenPathD(/<path d="([^"]+)"/.exec(middle.matte)![1])[0].filter(([x]) => x > 0).sort((a, b) => a[1] - b[1]);
    expect(front).toHaveLength(2 * teeth + 1);
    // Alternating tips and valleys, half a pitch apart and half a pitch deep (45° flanks).
    for (let index = 1; index < front.length; index += 1) {
      expect(front[index][1] - front[index - 1][1]).toBeCloseTo(pitch / 2, 1);
      expect(Math.abs(front[index][0] - front[index - 1][0])).toBeCloseTo(pitch / 2, 1);
    }
    const band = /<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/.exec(middle.overlay!)!;
    expect(band[2]).toBe(palette().accent2);
    const bandPoints = flattenPathD(band[1])[0];
    // The band's back edge sits 1.5 px under B; its front edge leads the B edge.
    const bTip = Math.max(...front.map(([x]) => x)), bandTip = Math.max(...bandPoints.map(([x]) => x)), bandBack = Math.min(...bandPoints.map(([x]) => x));
    expect(bandTip).toBeGreaterThan(bTip + 50);
    expect(bandBack).toBeCloseTo(Math.min(...front.map(([x]) => x)) - 1.5, 1);
    expect(frame(0.25, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
  });

  it("enters from the side the direction names", () => {
    const b = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.2, { direction }).matte, "matte"), x, y);
    expect([b("left_to_right", 8, 540), b("left_to_right", 1912, 540)]).toEqual([1, 0]);
    expect([b("right_to_left", 8, 540), b("right_to_left", 1912, 540)]).toEqual([0, 1]);
    expect([b("top_to_bottom", 960, 8), b("top_to_bottom", 960, 1072)]).toEqual([1, 0]);
    expect([b("bottom_to_top", 960, 8), b("bottom_to_top", 960, 1072)]).toEqual([0, 1]);
    expect(item().supportedDirections).toEqual(MOTION_TRANSITION_DIRECTIONS);
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
