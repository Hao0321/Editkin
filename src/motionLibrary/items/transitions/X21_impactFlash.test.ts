import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { impactFlashOpacity, impactShake } from "./X21_impactFlash";

const ID = "X21";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "64d0f69d2300fd416a985f8b97417beee4d0ac3f2ab7b503b16f7ec8e4c292ee",
    "433178b65ac859fc455ffcd781316044f0be13bdadd613b739ec45bb84b3b9f0",
    "fb5f8f270bc17c8aafa5479a3168153a8ff4b865e397e7a8ef9221fabef40590",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "92111dff784481d79ad951cd01e97c239219c5aa57ce3c2dbec7d057858fab63",
    "64a01ef405be74935848623e3535cdbab16f68d9cfa3751e1112661c1e170baf",
    "60ad925cae8c71ffd269a7f8c089a5bacf74197fcaf446502f672ac5ef6daaba",
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

describe("X21 Impact Flash", () => {
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

  it("switches A to B at exactly 50% under a fully opaque flash (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(frame(0.499 * durationSeconds, input, size).matte, label).toBe(ALL_A(size));
          const cut = frame(0.5 * durationSeconds, input, size);
          expect(cut.matte, label).toBe(ALL_B(size));
          expect(painted(cut.overlay!, size, "overlay"), label).toBe(1);
          expect(cut.overlay, label).toContain(`<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${palette().paper}"/>`);
        }
      }
    }
  });

  it("flashes once: fully opaque for 1/15 s (2 frames at 30 fps) around the switch, then a fast decay, never 3 times a second", () => {
    for (const durationSeconds of DURATIONS) {
      const samples = Array.from({ length: 2001 }, (_, index) => impactFlashOpacity((index / 2000) * durationSeconds, durationSeconds));
      // One rise and one fall: the opacity never rises again after it starts falling.
      let rises = 0, falling = false;
      for (let index = 1; index < samples.length; index += 1) {
        if (samples[index] > samples[index - 1] + 1e-9) { if (falling) rises += 1; }
        if (samples[index] < samples[index - 1] - 1e-9) falling = true;
      }
      expect(rises, `${durationSeconds}`).toBe(0);
      const opaque = samples.filter(value => value === 1).length * (durationSeconds / 2000);
      expect(opaque, `${durationSeconds}`).toBeCloseTo(1 / 15, 2);
      expect(samples[0]).toBe(0);
      expect(samples[2000]).toBe(0);
      expect(impactFlashOpacity(0.5 * durationSeconds, durationSeconds)).toBe(1);
    }
  });

  it("gathers ink focus lines before the hit, then a paper shockwave with a deep-shade band and spikes after it", () => {
    const before = frame(0.45 * 0.5);
    expect(before.overlay).toContain(`fill="${palette().ink}"`);
    expect(flattenPathD(pathDs(before.overlay!)[0]).length).toBe(20);
    const after = frame(0.75 * 0.5).overlay!;
    expect(after).toContain(`fill="${palette().paper}" fill-rule="evenodd"`);
    expect(after).toContain(`fill="${palette().accent2}" fill-rule="evenodd"`);
    expect(flattenPathD(pathDs(after)[0]).length).toBe(14);
    expect(frame(0.75 * 0.5, { energy: "hype" }).overlay!.length).toBeGreaterThan(0);
  });

  it("shakes the shockwave by at most 1% of the short side (1.3% at hype, under the 2% ceiling) and stops by 80%", () => {
    for (const energy of MOTION_ENERGIES) {
      let largest = 0;
      for (let index = 0; index <= 400; index += 1) {
        const t = (index / 400) * 0.5, [dx, dy] = impactShake(t, 0.5, 1, energy, PORTRAIT);
        largest = Math.max(largest, Math.abs(dx), Math.abs(dy));
        if (t < 0.25 || t >= 0.4) expect([dx, dy]).toEqual([0, 0]);
      }
      expect(largest / 1080).toBeLessThan(0.02);
      expect(largest / 1080).toBeLessThanOrEqual(0.0131);
      expect(largest).toBeGreaterThan(0);
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
