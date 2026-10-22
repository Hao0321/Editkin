import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { titleSafeBox } from "../shared";
import { textWipeCoverage, textWipeEntry, textWipeScale, textWipeShape, textWipeWarp } from "./X20_textWipe";

const ID = "X20";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "ef6c9e2636c1e971df3db954e87ab6f8fd324910244690d4421e163017347c10",
    "5ae1b4868961f7c0ecb9ea2c48207247f2a6d9aae3cdc24571a59787122b6aad",
    "84ed9b2d6f26e8039484a1f92ff8e85d071f0e99a8e28ddc86c286876f4c809f",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "051216edb82bb02790a52a18e244440bd3e15029259473a381caa14b7f66fd40",
    "1b53f44d920780ec9df53731b18fce9675413edb71502aad9bf7a2b67107e263",
    "7bac3878a84e762e8f915cf3d94794bdec825cb83a0176526454f8eedeff14b1",
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

describe("X20 Text Wipe", () => {
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

  it("B covers half the frame at D/2 and crosses 50% inside 45–55% of the duration (every energy, duration, both formats)", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      for (const energy of MOTION_ENERGIES) {
        for (const durationSeconds of DURATIONS) {
          const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds} ${size.width}`;
          expect(coverage(0.45 * durationSeconds, input, size), label).toBeLessThan(0.5);
          expect(Math.abs(coverage(0.5 * durationSeconds, input, size) - 0.5), label).toBeLessThan(0.015);
          expect(coverage(0.55 * durationSeconds, input, size), label).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it("pops 「轉場」 out at hero size (about 86% of the title-safe width), then zooms into a stroke until B fills the frame", () => {
    for (const size of [PORTRAIT, LANDSCAPE]) {
      // At the push the word sits at hero size: its ink spans most of the title-safe width (or the height cap in landscape).
      const hero = flattenPathD(pathDs(frame(0.17 * 0.5, undefined, size).matte)[0]).flat();
      const width = Math.max(...hero.map(([x]) => x)) - Math.min(...hero.map(([x]) => x));
      const height = Math.max(...hero.map(([, y]) => y)) - Math.min(...hero.map(([, y]) => y));
      const safe = titleSafeBox(size);
      expect(Math.max(width / safe.width / 0.86, height / safe.height / 0.62)).toBeCloseTo(1, 1);
      // The zoom ends with the whole frame covered, before the end of the transition.
      expect(coverage(0.9 * 0.5, undefined, size)).toBeGreaterThan(0.9);
      expect(frame(0.95 * 0.5, undefined, size).matte).toBe(ALL_B(size));
    }
    const shape = textWipeShape();
    expect(shape.entries).toHaveLength(2);
    expect(shape.entries[0].radius).toBeGreaterThanOrEqual(shape.entries[1].radius);
    expect(textWipeEntry(1)).toBe(shape.entries[0]);
    expect(textWipeEntry(2)).toBe(shape.entries[1]);
    // Scale: 0 at the start, about 1 (hero) at the push, then up by more than 20×; the warp hits its midpoint value.
    expect(textWipeScale(0, 1, "standard", LANDSCAPE).scale).toBe(0);
    expect(textWipeScale(0.17, 1, "standard", LANDSCAPE).scale).toBeCloseTo(1.02, 1);
    expect(textWipeScale(0.93, 1, "standard", LANDSCAPE).scale).toBeGreaterThan(20);
    expect(textWipeWarp(0.4, 0.4, 0.3, 1.3)).toBeCloseTo(0.3, 12);
    expect(textWipeCoverage(1, 1, LANDSCAPE)).toBeGreaterThan(0.15);
  });

  it("draws an outside-only deep-shade keyline: a stroke masked by the word's own fill, fading with the zoom", () => {
    const pushed = frame(0.17 * 0.5);
    expect(pushed.overlay).toContain("<mask");
    expect(pushed.overlay).toContain('paint-order="stroke"');
    expect(pushed.overlay).toContain(`fill="${palette().accent2}"`);
    // The matte is the fill plus a 1.5 px stroke under the keyline.
    expect(pushed.matte).toContain('stroke="#FFFFFF" stroke-width="3"');
    expect(frame(0.17 * 0.5, { palette: { accent2: "#00AA00" } }).overlay).toContain('fill="#00AA00"');
    const keyline = (t: number) => Number(/stroke-width="([0-9.]+)"/.exec(frame(t).overlay!)?.[1] ?? 0);
    expect(keyline(0.17 * 0.5)).toBeGreaterThan(keyline(0.7 * 0.5));
  });

  it("is deterministic and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.3, { seed: 7 }, PORTRAIT)).toEqual(frame(0.3, { seed: 7 }, PORTRAIT));
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
