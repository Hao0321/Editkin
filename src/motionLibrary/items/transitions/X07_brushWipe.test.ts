import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { brushStrokeCount } from "./X07_brushWipe";

const ID = "X07";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "8db5530704a2c5c6319ae92936e3d7c8bed8e4e9b0441b902155749063559cd0",
    "bca0b6b3ec17c7dd27939e2d3d6b11b17a9f4edf4ba9df59a2b4a5d3beee7613",
    "4f8dc8347151afdcdaa859cf8e08f294f60ceec21675a22ff1a105d1d6ba6e05",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "144ae3d65ce965373b50cd2f3d7c359ab19c8258f11b3246b8c9cc7203352222",
    "84832e28123de69e65b21d703a350b8a6cbe21c344aebfdaaca81331d30001c8",
    "e8eb89ac5a6f14461792248dcb3419f13e735b28b27f5fc0ccaf235aeb3d0c2b",
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
const strokes = (svg: string) => [...svg.matchAll(/<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/g)]
  .flatMap(([, d, fill]) => flattenPathD(d).map(ring => ({ fill, ring })));

describe("X07 Brush Wipe", () => {
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

  it("switches A to B at exactly 50% while the strokes cover the whole frame (every energy, duration, direction)", () => {
    for (const energy of MOTION_ENERGIES) {
      for (const durationSeconds of DURATIONS) {
        for (const direction of MOTION_TRANSITION_DIRECTIONS) {
          const input = { energy, durationSeconds, direction }, label = `${energy} ${durationSeconds} ${direction}`;
          expect(frame(0.499 * durationSeconds, input).matte, label).toBe(ALL_A(LANDSCAPE));
          expect(frame(0.5 * durationSeconds, input).matte, label).toBe(ALL_B(LANDSCAPE));
          expect(painted(frame(0.48 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBe(1);
          expect(painted(frame(0.5 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBe(1);
          expect(painted(frame(0.25 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.75 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("paints 2–4 round-headed capsule strokes back and forth in ink and accent2", () => {
    expect([brushStrokeCount(1920, 1080), brushStrokeCount(1080, 1920), brushStrokeCount(1080, 1080)]).toEqual([3, 4, 3]);
    const painting = strokes(frame(0.11).overlay!);
    expect(new Set(painting.map(stroke => stroke.fill))).toEqual(new Set([palette().ink, palette().accent2])); // ink and the deep shade
    // Each capsule spans its band (pitch + 2 × 1.5 px) and has a round head (many points).
    for (const { ring } of painting) {
      const ys = ring.map(([, y]) => y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(360 + 3, 0);
      expect(ring.length).toBeGreaterThan(30);
    }
    // Back and forth: each capsule is anchored just off one side (radius 181.5 + 2 px), and the first two bands use opposite sides.
    const anchor = ({ ring }: { ring: readonly FlatPoint[] }) => ring.some(([x]) => Math.abs(x + 183.5) < 0.01) ? "left"
      : ring.some(([x]) => Math.abs(x - 2103.5) < 0.01) ? "right" : "none";
    const byBand = [...painting].sort((a, b) => Math.min(...a.ring.map(([, y]) => y)) - Math.min(...b.ring.map(([, y]) => y)));
    expect(byBand.length).toBe(2);
    expect(new Set(byBand.map(anchor))).toEqual(new Set(["left", "right"]));
    // Vertical wipes paint in columns.
    const columns = strokes(frame(0.11, { direction: "top_to_bottom" }).overlay!);
    for (const { ring } of columns) expect(Math.max(...ring.map(([x]) => x)) - Math.min(...ring.map(([x]) => x))).toBeCloseTo(1920 / 4 + 3, 0);
    expect(frame(0.11, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
    expect(item().supportedDirections).toEqual(MOTION_TRANSITION_DIRECTIONS);
  });

  it("starts the first stroke from the side the direction names", () => {
    const covered = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.05, { direction, seed: 2 }).overlay!, "overlay"), x, y);
    const first = (direction: string) => [covered(direction, 8, 60), covered(direction, 1912, 60)];
    const sides = MOTION_TRANSITION_DIRECTIONS.map(direction => first(direction).join(""));
    // A horizontal stroke starts at one side; right_to_left mirrors left_to_right.
    expect(sides[0]).not.toBe(sides[1]);
    expect([...sides[0]].reverse().join("")).toBe(sides[1]);
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
