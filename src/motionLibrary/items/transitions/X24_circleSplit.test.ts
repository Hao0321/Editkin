import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { circleSplitLayout, circleSplitPose, halfDiscD, halfDiscRimD } from "./X24_circleSplit";

const ID = "X24";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "dcb65c463825323a0432bed068548a5af2c20b8a1e8f408723f1d951ea1962a1",
    "64c1def02e74e532ba54a5cb235aaf9304744ec45216db912c3b438201b91efc",
    "ea6885d70dbaa79f1dfa28e02331a2084c913ed064cc4f7e4191d8376fcfe329",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "51104785d127c5bcf5c9a96de1ee0a5a69bd0b5ba5867bc2e9aed07fddb1af97",
    "bd7fe3dcb7520bdfe296861112d22d90e2ea0a10e9c7923bc89a963250f6f6bc",
    "74c2b509dac128fc2c9faff34aba02e5615b5ac6aa11c55fcad999b3f7fb29c3",
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

describe("X24 Circle Split", () => {
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

  it("switches A to B at exactly 50% while the two halves cover the frame (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          expect(frame(0.5 * durationSeconds, input, size).matte, label).toBe(ALL_B(size));
          for (const p of [0.46, 0.48, 0.5]) expect(painted(frame(p * durationSeconds, input, size).overlay!, size, "overlay"), `${label} ${p}`).toBe(1);
          expect(painted(frame(0.25 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
          expect(painted(frame(0.75 * durationSeconds, input, size).overlay!, size, "overlay"), label).toBeLessThan(1);
        }
      }
    }
  });

  it("grows an accent-and-ink split disc on thin deep-shade rims whose halves turn in opposite directions into line as it covers the frame", () => {
    const { tones } = circleSplitLayout(1);
    const fills = [...frame(0.1).overlay!.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);
    expect(fills).toEqual([palette().accent2, palette().accent2, palette()[tones[0]], palette()[tones[1]]]);
    expect(new Set(tones)).toEqual(new Set(["accent", "ink"]));
    expect(new Set(Array.from({ length: 8 }, (_, seed) => circleSplitLayout(seed + 1).tones[0]))).toEqual(new Set(["accent", "ink"]));
    // A rim: 10 px round the arc and a 10 px strip past the diameter.
    const rim = flattenPathD(halfDiscRimD(500, 400, 0, -1, 200, 10), { segmentLength: 2 });
    for (const [x, y] of rim[0].filter(([, py]) => py < 399)) expect(Math.hypot(x - 500, y - 400)).toBeCloseTo(210, 0);
    expect(Math.max(...rim[1].map(([, y]) => y))).toBeCloseTo(410, 6);
    const early = circleSplitPose(0.2, "standard", LANDSCAPE), shut = circleSplitPose(0.46, "standard", LANDSCAPE);
    expect(early.turn).toBeGreaterThan(5);
    expect(shut.turn).toBeCloseTo(0, 9);
    expect(shut.radius).toBeGreaterThan(Math.hypot(960, 540));
    expect(early.radius).toBeLessThan(shut.radius);
    // While it grows and its halves are out of line, the disc does not yet cover the frame.
    expect(painted(frame(0.2 * 0.5).overlay!, LANDSCAPE, "overlay")).toBeLessThan(1);
    // A half-disc: the semicircle round from one end of the diameter to the other (true circle points).
    const half = flattenPathD(halfDiscD(500, 400, 0, -1, 200), { segmentLength: 2 })[0];
    for (const [x, y] of half.filter(([, py]) => py < 399)) expect(Math.hypot(x - 500, y - 400)).toBeCloseTo(200, 0);
  });

  it("then splits: the halves slide apart, still turning in opposite directions, until both have left the frame", () => {
    const parting = circleSplitPose(0.75, "standard", LANDSCAPE);
    expect(parting.turn).toBeLessThan(0);
    expect(parting.slide).toBeGreaterThan(0);
    const out = circleSplitPose(0.96, "standard", LANDSCAPE);
    // Past the half-diagonal by more than the rim strip (10 px) and the first half's tuck (1.5 px), so the rims are out too.
    expect(out.slide).toBeGreaterThan(Math.hypot(960, 540) + 10 + 1.5);
    // B shows along the split as the gap opens, and the overlay is gone once the halves are out.
    expect(valueAt(shapes(frame(0.8 * 0.5).overlay!, "overlay"), 960, 540)).toBe(0);
    expect(frame(0.97 * 0.5).overlay).toBe(EMPTY(LANDSCAPE));
    expect(new Set(Array.from({ length: 8 }, (_, seed) => Math.sign(circleSplitLayout(seed + 1).angle)))).toEqual(new Set([1, -1]));
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
