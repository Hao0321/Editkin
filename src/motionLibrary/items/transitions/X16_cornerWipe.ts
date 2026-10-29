import { createSvgDocument, emptySvg, path, polygonPathD, rect, rectPathD, type Point2 } from "../../svg/document";
import { clamp01, cubicIn, cubicOut, energyProfile, expoOut, quadIn, quadOut, sineInOut, smoothstep, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X16 Corner Wipe: four triangles push in from the frame corners toward the centre,
 * one after another (seeded start corner and turning order), in the deep shade
 * (accent2), each led by an ink edge band. A corner's front is the line u + v = a,
 * where u and v run 0 → 1 from that corner to the centre along the two edges, so a
 * triangle's hypotenuse stays parallel to the frame's other diagonal. The triangles
 * merge as they meet: the A still showing is the convex shape inside all four fronts
 * (a rhombus once every front has passed the edge midpoints), which closes to a point
 * at the centre. Under full cover B is switched in and the triangles carry on into
 * the centre: B opens as four triangles from the corners behind the same fronts, each
 * trailing an ink band, and the deep shade, now the convex shape inside the four back
 * edges, collapses into the centre.
 *
 * Timing: the corners start 0.07–0.1 of the duration apart (a slight stagger, so all
 * four read as pushing in together), the fronts accelerate into the centre and arrive
 * by 45% (stagger + push = 0.45 at every energy); the back edges start at 50%, leaving
 * the corners fast and settling into the centre by 95%. So the frame is fully covered
 * when the matte switches at exactly D/2 (ART_DIRECTION §4). Every point of the frame
 * is within u + v ≤ 2 of some corner, so fronts at 2.02 cover it all. The edge bands
 * share one swell to 30 px (at 1080) × √amplitude over each phase, tapering at each
 * corner's own start and end, and form one mitred outline: the convex shape shrunk (A's
 * opening) or grown (the collapsing shade) by each edge's band, so the four edges read
 * as an even outline, never a drop shadow; the outline reaches 1.5 px under the deep
 * shade. The covered shape is one path (the
 * frame minus the convex A), so no seam shows anywhere. Energy sets the stagger and
 * the curves (calm sine in-out … hype cubic in, expo out). Not directional (it comes
 * from all four corners); the seed can also swap the two tones.
 */

const ID = "X16";
/** Art revision (part of the clip cache key): 1 = first render (each edge band swelled on its own corner's timing, so the collapsing shade read as drop-shadowed); 2 = one shared swell; 3 = the bands form one mitred outline (they overshot the vertices as prongs). */
const REVISION = 3;
const SWITCH = 0.5;
const TUCK = 1.5;
/** Edge band at full swell (px at 1080). */
const EDGE = 30;
/** The front value that covers the whole frame (every point has u + v ≤ 2 for some corner). */
const FULL = 2.02;

interface CornerTiming {
  /** Delay of the last corner after the first. */
  readonly spread: number;
  /** One push (in, or the back edge following), fraction of the duration. */
  readonly push: number;
  /** The fronts accelerate into the centre and meet; the back edges leave the corners fast and settle into the centre. */
  readonly enter: EasingFunction;
  readonly exit: EasingFunction;
}

const TIMING: Record<MotionEnergy, CornerTiming> = {
  calm: { spread: 0.07, push: 0.38, enter: sineInOut, exit: sineInOut },
  standard: { spread: 0.08, push: 0.37, enter: quadIn, exit: quadOut },
  punchy: { spread: 0.09, push: 0.36, enter: cubicIn, exit: cubicOut },
  hype: { spread: 0.1, push: 0.35, enter: cubicIn, exit: expoOut },
};

/** Corners clockwise from the top left: [x side, y side] as 0 (left/top) or 1 (right/bottom). */
const CORNERS: readonly (readonly [0 | 1, 0 | 1])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

export interface CornerLayout {
  /** Place of each corner (TL, TR, BR, BL) in the push order. */
  readonly order: readonly number[];
  /** Palette roles of the triangles and of their edge bands. */
  readonly body: "accent2" | "ink";
  readonly edge: "accent2" | "ink";
}

export function cornerLayout(seed: number): CornerLayout {
  const rng = createSeededRng(ID, seed, "layout");
  const start = rng.int(0, 3), turn = rng.sign(), flip = rng.int(0, 1);
  return {
    order: CORNERS.map((_, corner) => (((corner - start) * turn) % 4 + 4) % 4),
    body: flip === 0 ? "accent2" : "ink",
    edge: flip === 0 ? "ink" : "accent2",
  };
}

/** u + v of a frame point, measured from corner `corner` (0 at the corner, 2 at the frame centre). */
export function cornerFront(corner: number, x: number, y: number, size: MotionFrameSize): number {
  const [sideX, sideY] = CORNERS[corner];
  return (sideX === 0 ? x : size.width - x) / (size.width / 2) + (sideY === 0 ? y : size.height - y) / (size.height / 2);
}

/** A half-plane in front units: keep the points whose u + v from `corner` is ≥ value ("far") or ≤ value ("near"). */
interface HalfPlane { readonly corner: number; readonly value: number; readonly keep: "far" | "near" }

/** Sutherland–Hodgman clip of a convex polygon by half-planes (every boundary is a straight front line). */
function clipByFronts(points: readonly Point2[], planes: readonly HalfPlane[], size: MotionFrameSize): Point2[] {
  let output: Point2[] = [...points];
  for (const { corner, value, keep } of planes) {
    const side = (point: Point2) => (cornerFront(corner, point[0], point[1], size) - value) * (keep === "far" ? 1 : -1);
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index], previous = input[(index + input.length - 1) % input.length];
      const sc = side(current), sp = side(previous);
      const cut = (): Point2 => {
        const k = sp / (sp - sc);
        return [previous[0] + k * (current[0] - previous[0]), previous[1] + k * (current[1] - previous[1])];
      };
      if (sc >= 0) {
        if (sp < 0) output.push(cut());
        output.push(current);
      } else if (sp >= 0) output.push(cut());
    }
    if (output.length < 3) return [];
  }
  return output;
}

export const X16_cornerWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { spread, push, enter, exit } = TIMING[params.energy];
  const { order, body, edge } = cornerLayout(params.seed);
  const tuck = TUCK * frameUnit(size);
  // Pixels → front units: neighbouring fronts u + v = c and c + 1 are 1 / perPixel px apart.
  const perPixel = Math.hypot(2 / size.width, 2 / size.height);
  const edgeMax = EDGE * frameUnit(size) * Math.sqrt(energyProfile(params.energy).amplitude) * perPixel;
  const tuckFront = tuck * perPixel;
  const frame: Point2[] = [[-2, -2], [size.width + 2, -2], [size.width + 2, size.height + 2], [-2, size.height + 2]];
  const covering = p < SWITCH;
  // Each corner's front (before the switch) or back edge (after it), and its edge band's width: one swell shared by
  // all four edges over the phase (so they read as an even outline, never a drop shadow), tapered in and out at each
  // corner's own start and end.
  const swell = edgeMax * Math.sin(Math.PI * clamp01((covering ? p : p - SWITCH) / (spread + push)));
  const corners = CORNERS.map((_, corner) => {
    const local = ((covering ? p : p - SWITCH) - (spread * order[corner]) / 3) / push;
    const value = local > 0 ? FULL * (covering ? enter(local) : exit(local)) : covering ? 0 : -1;
    return { corner, value, band: local > 0 && local < 1 ? swell * smoothstep(0, 0.2, local) * smoothstep(0, 0.2, 1 - local) : 0 };
  });

  // Every shape here is the frame cut by the four fronts shifted by some amount: convex, so outlines mitre cleanly.
  const shifted = (shift: (band: number) => number) =>
    clipByFronts(frame, corners.map(({ corner, value, band }) => ({ corner, value: value + shift(band), keep: "far" as const })), size);
  const parts: string[] = [];
  if (covering) {
    // Still A: inside every front. The triangles are the frame minus that convex opening; the ink outline is the
    // opening minus the opening shrunk by each front's band, reaching 1.5 px under the triangles.
    const open = shifted(() => 0);
    parts.push(path(rectPathD(-2, -2, size.width + 4, size.height + 4, 2) + (open.length ? polygonPathD(open, 2) : ""),
      { fill: params.palette[body], "fill-rule": "evenodd" }));
    if (open.length && corners.some(({ band }) => band > 0.002)) {
      const outer = shifted(() => -tuckFront), inner = shifted(band => band);
      parts.push(path(polygonPathD(outer, 2) + (inner.length ? polygonPathD(inner, 2) : ""), { fill: params.palette[edge], "fill-rule": "evenodd" }));
    }
  } else {
    // Still the deep shade: outside every back edge (a convex shape collapsing into the centre). The ink outline is the
    // shade grown by each back edge's band, drawn first so the shade covers its inner side.
    const left = shifted(() => 0);
    if (left.length && corners.some(({ band }) => band > 0.002)) parts.push(path(polygonPathD(shifted(band => -band), 2), { fill: params.palette[edge] }));
    if (left.length) parts.push(path(polygonPathD(left, 2), { fill: params.palette[body] }));
  }
  return { matte: covering ? matte.render() : allB(), overlay: createSvgDocument(size).render(parts) };
}, { revision: REVISION });
