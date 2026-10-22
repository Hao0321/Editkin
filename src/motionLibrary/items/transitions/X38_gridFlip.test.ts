import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { gridFlip, gridFlipOrder } from "./X38_gridFlip";
const fillsOf = (svg: string) => [...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);

const ID = "X38";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "a8abcc3675e9858b74e56ee5cff47ca053ec460ce5c3fecc1764f8a38a0b23de",
    "82164a22c3a2e753e3f185dd9c54dd7e87ec2aee1912a21ca0b9deefe2c64375",
    "7aba0a54d1c6244214057e9df1bc0e54d0cfccf2eb6d1be998f74b861b2773d9",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "58aed2d64c1afa3d55fa55ce325d4f6f8f048b4a30f85e1e4280d4f84bc8f7d4",
    "2bf67b55f9b7af6c3e79e4749e94e2f229953f72dd81d9a02aaf7dbf347b47f7",
    "b3b2ad60ee4158facf92f298929d10845f1baa352d48033d3a4e48c560c61f18",
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

describe("X38 Grid Flip", () => {
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

  it("switches each panel when it is edge-on, the fifth at exactly D/2, so B crosses half the frame there (every energy, duration, seed, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          for (const seed of [1, 2, 3]) {
            const input = { energy, durationSeconds, seed }, label = `${energy} ${durationSeconds} ${seed} ${size.width}`;
            expect(Math.abs(coverage(0.499 * durationSeconds, input, size) - 4 / 9), label).toBeLessThan(0.01);
            expect(Math.abs(coverage(0.5 * durationSeconds, input, size) - 5 / 9), label).toBeLessThan(0.01);
            expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
            expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
          }
        }
      }
    }
    for (const energy of MOTION_ENERGIES) expect(gridFlip(4, 0.5, energy).local).toBe(0.5);
  });

  it("flips the nine panels of a 3 × 3 grid in a seeded order, at most three turning at once, B only growing", () => {
    expect([...gridFlipOrder(1)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(Array.from({ length: 6 }, (_, seed) => gridFlipOrder(seed + 1).join(","))).size).toBeGreaterThan(1);
    for (const energy of MOTION_ENERGIES) {
      for (let step = 0; step <= 1000; step += 1) {
        let turning = 0;
        for (let k = 0; k < 9; k += 1) { const { local } = gridFlip(k, step / 1000, energy); if (local > 0 && local < 1) turning += 1; }
        expect(turning).toBeLessThanOrEqual(3);
      }
    }
    let previous = 0;
    for (let step = 1; step <= 40; step += 1) { const value = coverage((step / 40) * 0.5); expect(value).toBeGreaterThanOrEqual(previous); previous = value; }
  });

  it("draws two flat tones only: A's face untouched, B's face inside a crisp deep edge, deep board at the sides, edge-on cells all board", () => {
    const order = gridFlipOrder(1), cell = order[4], column = cell % 3, row = Math.floor(cell / 3);
    const x0 = Math.round((column * 1920) / 3), x1 = Math.round(((column + 1) * 1920) / 3), y0 = Math.round((row * 1080) / 3), y1 = Math.round(((row + 1) * 1080) / 3);
    const mid = (x0 + x1) / 2, yc = (y0 + y1) / 2;
    const spread = 0.9 / (1 + 2.2 / 8), flip = 0.9 - spread, at = (local: number) => 0.5 + (local - 0.5) * flip;
    const overlayAt = (local: number) => shapes(frame(at(local) * 0.5).overlay!, "overlay");
    const front = Math.sqrt(1 / 6), back = 1 - Math.sqrt(0.125);
    expect(gridFlip(4, at(front), "standard").theta).toBeCloseTo(60, 6);
    expect(gridFlip(4, at(back), "standard").theta).toBeCloseTo(135, 6);
    const o60 = overlayAt(front), o135 = overlayAt(back), half60 = (x1 - x0) / 4, half135 = ((x1 - x0) / 2) * Math.SQRT1_2;
    expect([valueAt(o60, x0 + 5, yc), valueAt(o60, mid, yc), valueAt(o60, mid - half60 + 5, yc)]).toEqual([1, 0, 0]);
    expect([valueAt(o135, mid, yc), valueAt(o135, mid - half135 + 4, yc), valueAt(o135, mid, y0 + 4), valueAt(o135, mid, y1 - 4), valueAt(o135, x0 + 5, yc)]).toEqual([0, 1, 1, 1, 1]);
    expect(valueAt(overlayAt(0.5), mid, yc)).toBe(1);
    for (let step = 1; step < 30; step += 1) {
      const overlay = frame((step / 30) * 0.5).overlay!;
      for (const fill of fillsOf(overlay)) expect(fill).toBe(palette().accent2);
      expect(overlay).not.toContain("opacity");
    }
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
