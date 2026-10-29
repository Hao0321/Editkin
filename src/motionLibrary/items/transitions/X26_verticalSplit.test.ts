import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, MOTION_TRANSITION_DIRECTIONS, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { reelLayout, reelTravel } from "./X26_verticalSplit";

const ID = "X26";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "ec07d940bf89a5066c3747158a7082766b205c5b9312fb8d9ad740bbc4a4b8d7",
    "a87ce6dd83654eabe7ad730364e5352dd879cc0b12d3454b3da5c022d656b591",
    "d5eeb3ae7090c0e3cb10332e23a786419ee7a9d64d32541f629b55a106b5fa92",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "87f1703d359f842db10fd663d4013fcb4ea7b9583b857a64dbb1af941c00afb2",
    "62053024eb52ff5209380461cc5c4c6a0c3ad4b71ed1765c943e871cb5d3991a",
    "bd00bcecb9d3df30c086639d942727fc7fea7fb44d30b9c607dc7c2c037cfe30",
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

describe("X26 Vertical Split", () => {
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

  it("switches A to B at exactly 50% while both reels cover their halves (every energy, duration, direction, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const direction of MOTION_TRANSITION_DIRECTIONS) {
            const input = { energy, durationSeconds, direction }, label = `${energy} ${durationSeconds} ${direction} ${size.width}`;
            expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
            expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
            for (const p of [0.48, 0.5, 0.52]) expect(painted(frame(p * durationSeconds, input, size).overlay!, size, "overlay"), `${label} ${p}`).toBe(1);
            expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
            expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          }
        }
      }
    }
  });

  it("spins the left reel up and the right reel down (and the other splits by direction)", () => {
    const o = (direction: string, x: number, y: number) => valueAt(shapes(frame(0.1, { direction }).overlay!, "overlay"), x, y);
    // Default: the left reel's head enters from the bottom, the right reel's from the top.
    expect([o("bottom_to_top", 480, 1072), o("bottom_to_top", 480, 8), o("bottom_to_top", 1440, 8), o("bottom_to_top", 1440, 1072)]).toEqual([1, 0, 1, 0]);
    expect(frame(0.1).overlay).toBe(frame(0.1, { direction: "bottom_to_top" }).overlay);
    expect([o("top_to_bottom", 480, 8), o("top_to_bottom", 480, 1072), o("top_to_bottom", 1440, 1072), o("top_to_bottom", 1440, 8)]).toEqual([1, 0, 1, 0]);
    // Horizontal travel splits the frame into top and bottom halves.
    expect([o("left_to_right", 8, 270), o("left_to_right", 1912, 270), o("left_to_right", 1912, 810), o("left_to_right", 8, 810)]).toEqual([1, 0, 1, 0]);
    expect([o("right_to_left", 1912, 270), o("right_to_left", 8, 270), o("right_to_left", 8, 810), o("right_to_left", 1912, 810)]).toEqual([1, 0, 1, 0]);
    // After the switch B follows each tail from the same start edge.
    const m = shapes(frame(0.4).matte, "matte"), late = shapes(frame(0.4).overlay!, "overlay");
    expect(valueAt(m, 480, 1072)).toBe(1);
    expect([valueAt(late, 480, 1072), valueAt(late, 1440, 8)]).toEqual([0, 0]);
  });

  it("builds each reel from three two-tone panels of seeded heights with paper separators; the reels never line up", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { panels, tones } = reelLayout(seed);
      for (const reel of panels) {
        expect(reel.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12);
        for (const share of reel) { expect(share).toBeGreaterThanOrEqual(0.2); expect(share).toBeLessThanOrEqual(0.44); }
      }
      expect(Math.abs(panels[0][0] - panels[1][0]) + Math.abs(panels[0][1] - panels[1][1])).toBeGreaterThan(0);
      expect(tones[0]).toEqual([tones[0][0], tones[1][0], tones[0][0]]);
      expect(tones[1]).toEqual([tones[1][0], tones[0][0], tones[1][0]]);
      expect(new Set([tones[0][0], tones[1][0]])).toEqual(new Set(["accent", "ink"]));
    }
    expect(reelTravel(0.5, "standard")).toBeCloseTo(1.2, 12);
    expect([reelTravel(0, "hype"), reelTravel(1, "hype")]).toEqual([0, 2.4]);
    const overlay = frame(0.25).overlay!;
    expect([...overlay.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1])).toEqual([palette().accent, palette().ink, palette().paper]);
    expect(frame(0.25, { palette: { paper: "#ABCDEF" } }).overlay).toContain('fill="#ABCDEF"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
