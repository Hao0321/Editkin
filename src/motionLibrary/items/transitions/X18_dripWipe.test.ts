import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { dripCoverage, dripRow, dripState, paintOutline } from "./X18_dripWipe";

const ID = "X18";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "428e750adbf17c6c3085b99e598baa26484217c6a9850c8b91ce909b53a71a99",
    "0136d722a10ced8e41c8c473c6bfbe56f8c1940da3d234264210be133354f3f9",
    "27842912202d15edff7e063dd9c9f916c802d1ab23c013f99b37a64df35d6482",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "aa218c2d4daa45777d4057a1b22aa29d48eb7cfc9c7cc8e91794a54342e2c50d",
    "a5957fa355c9a8417bd39f3f95d7b04647fafe520a748b1f3eb872becaa674cd",
    "1bef774a8f9fdc80b5ee83c8c036c35c3ac8e6c4f4a3f80079117e6955aff9de",
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

describe("X18 Drip Wipe", () => {
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

  it("B covers half the frame at D/2 and crosses 50% inside 45–55% of the duration (every energy, duration, two seeds, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const seed of [1, 2]) {
            const input = { energy, durationSeconds, seed }, label = `${energy} ${durationSeconds} ${seed} ${size.width}`;
            expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
            expect(Math.abs(coverage(0.5 * durationSeconds, input, size) - 0.5), label).toBeLessThan(0.01);
            expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
          }
        }
      }
    }
  });

  it("B only grows, in portrait and landscape", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      let previous = 0;
      for (let step = 1; step <= 20; step += 1) {
        const value = coverage((step / 20) * 0.5, undefined, size);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
      }
      expect(previous).toBe(1);
    }
  });

  it("hangs drips with round heads (true circles) from a smooth outline, with varied lengths", () => {
    const size = LANDSCAPE, drips = dripRow(1, "drips", size, 0);
    expect(drips.length).toBeGreaterThanOrEqual(6);
    expect(new Set(drips.map(drip => Math.round(drip.length))).size).toBe(drips.length);
    const lengths = drips.map(drip => drip.length);
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThan(1.5);
    // A full-grown drip: every outline point below its head centre lies on the head circle.
    const state = { edge: 300, lengths: drips.map(drip => drip.length) };
    const outline = paintOutline(drips, state, size, [0, 0]);
    const points = flattenPathD(outline, { segmentLength: 2 })[0];
    for (const [index, drip] of drips.entries()) {
      const y0 = 300 + 9 * Math.sin((2 * Math.PI * 2 * drip.x) / 1920) + 4 * Math.sin((2 * Math.PI * 5 * drip.x) / 1920);
      const centre = [drip.x, y0 + state.lengths[index]] as const;
      const head = points.filter(([x, y]) => y > centre[1] + 0.5 && Math.abs(x - drip.x) <= drip.head + 0.5);
      expect(head.length, `drip ${index}`).toBeGreaterThan(8);
      for (const [x, y] of head) expect(Math.hypot(x - centre[0], y - centre[1]), `drip ${index}`).toBeCloseTo(drip.head, 0);
    }
    // Neighbouring drips never touch: fillets of two drips stay apart.
    const sorted = [...drips].sort((a, b) => a.x - b.x);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index].x - sorted[index - 1].x).toBeGreaterThan(sorted[index].column + sorted[index].fillet + sorted[index - 1].column + sorted[index - 1].fillet);
    }
    expect([dripState(0, 0.4, 1.5), dripState(0.5, 0.4, 1.5), dripState(1, 0.4, 1.5)]).toEqual([0, 0.4, 1]);
    expect(dripCoverage(1, 0, size)).toBe(0);
    expect(dripCoverage(1, 1, size)).toBeCloseTo(1, 6);
  });

  it("runs a deep-shade undercoat with its own drips ahead of B, clipped to the frame outside B", () => {
    const middle = frame(0.2);
    expect(middle.overlay).toContain("clip-path=");
    expect(middle.overlay).toContain('clip-rule="evenodd"');
    expect(middle.overlay).toContain(`fill="${palette().accent2}"`);
    const coat = dripRow(1, "undercoat", LANDSCAPE, 0.5, 0.62), drips = dripRow(1, "drips", LANDSCAPE, 0);
    // The undercoat's drips sit between B's and are narrower.
    expect(Math.max(...coat.map(drip => drip.column))).toBeLessThan(Math.max(...drips.map(drip => drip.column)));
    expect(frame(0.2, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, { seed: index % 3 }, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
