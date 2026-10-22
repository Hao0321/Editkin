import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { frameStackLayout, frameStackRects, frameStackShift } from "./X35_frameStack";
const fillsOf = (svg: string) => [...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);

const ID = "X35";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "d9c3734f8bd3d69fc182ec52f8ab36858bb72ea14189a0db2341af606a48fb5b",
    "64508a1e87f0e2d45b15501f9f932b8e18581be787edcddbe52b9b49d81bf367",
    "e2e71947fe127ce7630c7e47c4561eebfae10cbf3a989636a25b47c5bdea398b",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "bd0faabea6b80718f8e72ecc6d29053d7ccbb52d1cc36bc30b45240305c7a079",
    "03ba73b26577a54f3513afd7847777b1cae30571a120e1552d7d715e8095c327",
    "50c9a50ee0442f2227d37fcf76f9c73b4d5d96c15e6b42deff564e0ce9a33f5a",
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

describe("X35 Frame Stack", () => {
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

  it("switches A to B at exactly 50% while the stacked frames close the window (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          for (const p of [0.48, 0.49, 0.5]) expect(painted(frame(p * durationSeconds, input, size).overlay!, size, "overlay"), `${label} ${p}`).toBe(1);
          expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("stacks four proportional frames, one from each side, the fourth closing the window; then lets B fill the centre as they leave innermost first", () => {
    const { sides, tones } = frameStackLayout(1);
    expect(new Set(sides)).toEqual(new Set([0, 1, 2, 3]));
    expect(tones).toEqual([tones[0], tones[1], tones[0], tones[1]]);
    expect(new Set(tones)).toEqual(new Set(["accent", "accent2"]));
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (let k = 0; k < 4; k += 1) {
        const { outer, inner } = frameStackRects(k, size);
        expect(outer).toEqual([Math.round((k * size.width) / 8), Math.round((k * size.height) / 8), size.width - Math.round((k * size.width) / 8), size.height - Math.round((k * size.height) / 8)]);
        if (k < 3) expect(inner).toEqual(frameStackRects(k + 1, size).outer);
      }
      // The fourth frame's window is closed (zero width and height).
      const { inner } = frameStackRects(3, size);
      expect([inner[2] - inner[0], inner[3] - inner[1]]).toEqual([0, 0]);
    }
    // In order, outermost first; out in reverse, innermost first.
    for (let k = 0; k < 4; k += 1) {
      expect(frameStackShift(k, 0.03 + k * 0.105 - 0.001, "standard")).toBe(-1);
      expect(Math.abs(frameStackShift(k, 0.03 + k * 0.105 + 0.131, "standard"))).toBe(0);
    }
    expect(frameStackShift(3, 0.56, "standard")).toBeGreaterThan(0);
    expect(frameStackShift(0, 0.56, "standard")).toBe(0);
    // Once the innermost frame has left, B shows in the centre window, framed by the rest.
    const later = frame(0.33);
    expect(valueAt(shapes(later.overlay!, "overlay"), 960, 540)).toBe(0);
    expect(valueAt(shapes(later.matte, "matte"), 960, 540)).toBe(1);
    expect(valueAt(shapes(later.overlay!, "overlay"), 30, 30)).toBe(1);
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
