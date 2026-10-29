import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../../catalog";
import { generateTransitionFrame } from "../../frames";
import { resolveMotionLibraryParams } from "../../params";
import { flattenPathD, type FlatPoint } from "../../svg/pathOps";
import { MOTION_ENERGIES, type MotionFrameSize, type TransitionFrame, type TransitionMotionItem } from "../../types";
import { multiStripeCount } from "./X03_multiStripeWipe";

const ID = "X03";
const PORTRAIT: MotionFrameSize = { width: 1080, height: 1920 };
const LANDSCAPE: MotionFrameSize = { width: 1920, height: 1080 };
const DURATIONS = [0.2, 0.5, 1, 2];

/** Golden SVG SHA-256 (matte + overlay) at 5 fixed times × 2 formats, default params. Regenerate only for a reviewed art change and bump the revision. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5];
const GOLDEN: Record<"portrait" | "landscape", readonly string[]> = {
  portrait: [
    "4ee83d3d13afcff4bcf85a9a5c8b25d04cb7dc50723fcdb0d8574dbd4660a8fd",
    "f199c41631ec6b07fa90bf8fc0fd355b6c774fe790d3deca6da44152b424cc85",
    "8bb9f2e8acad0e23c0a4a744e07b167d7138d5410516be0e8d03f9bbbed7d682",
    "4b936566e1d2b1c61f147a29935d59ab20012e7a651fb67da730ed75bce95a20",
    "b7f18d04a593679d1eb2977d387af3b1c1dd31e2ca79f2240408625b2a215f7e",
  ],
  landscape: [
    "3eaa09242ada92cc8c34abd73e2167add7ae8bb1f5d89cc1d51f3c764840e37a",
    "269d45b7eb0aab584e7ab199fbaf4781d9021b0a37785f3f305921a412d8a63a",
    "ecd467663de97e52e8f399dd9996275d817d853fe4d9c303a843d48d1dc6703f",
    "33932d9f3d39deb62636997ca2c176b442a3f609f69e7aee27dc535afbb2cb3b",
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

describe("X03 Multi Stripe Wipe", () => {
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

  it("switches A to B at exactly 50% while the stripes cover the whole frame (every energy and duration)", () => {
    for (const energy of MOTION_ENERGIES) {
      for (const durationSeconds of DURATIONS) {
        const input = { energy, durationSeconds }, label = `${energy} ${durationSeconds}`;
        expect(frame(0.499 * durationSeconds, input).matte, label).toBe(ALL_A(LANDSCAPE));
        expect(frame(0.5 * durationSeconds, input).matte, label).toBe(ALL_B(LANDSCAPE));
        expect(painted(frame(0.49 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBe(1);
        expect(painted(frame(0.5 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBe(1);
        // Partly covered either side of the beat: the stripes are still moving.
        expect(painted(frame(0.25 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBeLessThan(1);
        expect(painted(frame(0.75 * durationSeconds, input).overlay!, LANDSCAPE, "overlay"), label).toBeLessThan(1);
      }
    }
  });

  it("lays 10–12 whole-pixel rows that alternate entry sides and colours", () => {
    expect([multiStripeCount(LANDSCAPE), multiStripeCount({ width: 1080, height: 1080 }), multiStripeCount(PORTRAIT)]).toEqual([10, 11, 12]);
    const overlay = frame(0.12).overlay!;
    const paths = [...overlay.matchAll(/<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/g)];
    expect(paths.map(([, , fill]) => fill)).toEqual([palette().accent2, palette().ink]); // the deep shade and ink (accent is B in the demo)
    const rects = paths.map(([, d]) => flattenPathD(d).map(ring => {
      const xs = ring.map(([x]) => x), ys = ring.map(([, y]) => y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }));
    // One colour enters from the left (x0 = 0), the other from the right (x1 = width), on alternating whole-pixel rows.
    const [left, right] = rects[0][0].x0 === 0 ? rects : [rects[1], rects[0]];
    for (const stripe of left) expect(stripe.x0).toBe(0);
    for (const stripe of right) expect(stripe.x1).toBe(1920);
    for (const stripe of [...left, ...right]) { expect(Number.isInteger(stripe.y0)).toBe(true); expect(Number.isInteger(stripe.y1)).toBe(true); }
    const rows = [...left, ...right].map(stripe => stripe.y0).sort((a, b) => a - b);
    expect(new Set(rows).size).toBe(rows.length);
    // The stagger runs top to bottom: the top rows are longer than the bottom ones early on.
    const reach = (stripe: { x0: number; x1: number }) => stripe.x1 - stripe.x0;
    const ordered = [...left, ...right].sort((a, b) => a.y0 - b.y0);
    expect(reach(ordered[0])).toBeGreaterThan(reach(ordered[ordered.length - 1]));
    // After the switch the stripes leave through the far side: a left-entering stripe now ends at the right edge.
    const late = [...frame(0.36).overlay!.matchAll(/<path d="([^"]+)"/g)].flatMap(([, d]) => flattenPathD(d));
    expect(late.some(ring => Math.max(...ring.map(([x]) => x)) === 1920 && Math.min(...ring.map(([x]) => x)) > 0)).toBe(true);
    expect(frame(0.12, { palette: { accent2: "#00AA00", ink: "#123456" } }).overlay).toMatch(/fill="#00AA00".*fill="#123456"/);
  });

  it("is deterministic, seeded, and generates a 1080×1920 frame well under the 20 ms budget (bound 60 ms)", () => {
    expect(frame(0.2, { seed: 7 }, PORTRAIT)).toEqual(frame(0.2, { seed: 7 }, PORTRAIT));
    const layouts = new Set(Array.from({ length: 8 }, (_, seed) => frame(0.2, { seed }).overlay));
    expect(layouts.size).toBeGreaterThan(1);
    frame(0.1, undefined, PORTRAIT);
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) frame((index / 29) * 0.5, undefined, PORTRAIT);
    expect((performance.now() - started) / 30).toBeLessThan(60);
  });
});
