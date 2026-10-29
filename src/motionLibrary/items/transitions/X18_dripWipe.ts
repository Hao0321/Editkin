import { createSvgDocument, emptySvg, fmt, g, path, rect, rectPathD, type Point2 } from "../../svg/document";
import { clamp01, energyProfile, smoothstep } from "../../svg/easing";
import { flattenPathD } from "../../svg/pathOps";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X18 Drip Wipe: B is paint running down from the top. Its front is a gently
 * undulating edge with a row of drips hanging from it; each drip leaves the edge
 * through two concave fillets, runs down as a column and swells through a smooth
 * neck into a round head (a true circle), so the whole front is one smooth outline.
 * The drips have their own lengths and speeds (seeded). A quieter deep-shade (accent2)
 * undercoat runs a little ahead of B, with its own fewer, narrower and shorter drips
 * between B's, so the paint reads in two coats (the deep shade first, then the accent
 * over it) while B's drips stay the hero.
 *
 * Timing: the paint's state s (edge position and drip lengths together) runs through
 * a time warp: s = s½ · (2p)^a up to D/2, then a slope-matched ease-out to s = 1, where
 * s½ is solved from the exact area of the flattened outline inside the frame so that
 * B covers half the frame at exactly D/2 (ART_DIRECTION §4: switch at 45–55%). At s = 0
 * every drip is unborn and the edge is above the frame (pure A); at s = 1 the edge is
 * below the bottom (pure B). The undercoat leads by up to 2.2% of the frame height ×
 * sin(π t / D) × √amplitude, so it is gone at both ends (empty overlay), and it is
 * clipped to the frame outside B, reaching 1.5 px (at 1080) under B's edge so no
 * sliver of A shows between the coats. Energy sets the warp power a (calm 1.3 … hype
 * 2.0). The seed sets the drip layout. Not directional: paint drips down.
 */

const ID = "X18";
/** Art revision (part of the clip cache key): 1 = first render (an undercoat drip in every slot and a 3.2% lead: a busy barcode); 2 = a quieter undercoat (every second slot, shorter drips, 2.2% lead). */
const REVISION = 2;
const EASE_IN_POWER: Record<MotionEnergy, number> = { calm: 1.3, standard: 1.55, punchy: 1.8, hype: 2.0 };
/** Drip pitch as a fraction of the short side, and the slot jitter as a fraction of the pitch. */
const PITCH = 0.22, JITTER = 0.08;
/** Column half-width range (fraction of the short side) of B's drips; the undercoat's are UNDERCOAT_WIDTH as wide. */
const COLUMN: readonly [number, number] = [0.024, 0.042];
const UNDERCOAT_WIDTH = 0.62;
/** The undercoat keeps every second slot, with drips this share of B's lengths: a quieter layer under B's drips. */
const UNDERCOAT_EVERY = 2, UNDERCOAT_REACH = 0.55;
/** Paint-edge undulation (px at 1080). */
const WAVE_1 = 9, WAVE_2 = 4;
/** Undercoat lead at full bell, as a fraction of the frame height. */
const LEAD = 0.022;
const TUCK = 1.5;
/** Cubic Bézier quarter-circle handle. */
const KAPPA = 0.5522847498307936;

export interface Drip {
  /** Centre x (px). */
  readonly x: number;
  /** Column half-width, head radius and fillet radius (px). */
  readonly column: number;
  readonly head: number;
  readonly fillet: number;
  /** Full length from the edge to the head centre (px) and its growth curve power. */
  readonly length: number;
  readonly rate: number;
  /** State at which the drip starts to form. */
  readonly birth: number;
}

/**
 * A seeded row of drips: one per slot of PITCH × the short side (`offset` shifts the slots by a fraction of
 * the pitch, for the interleaved undercoat; `width` scales the drips, `every` keeps every n-th slot and `reach`
 * scales the lengths). Slot jitter stays small enough that two neighbours' fillets never touch.
 */
export function dripRow(seed: number, stream: string, size: MotionFrameSize, offset: number, width = 1, every = 1, reach = 1): Drip[] {
  const short = Math.min(size.width, size.height);
  const count = Math.max(3, Math.round(size.width / (PITCH * short)));
  const pitch = size.width / count;
  const rng = createSeededRng(ID, seed, stream);
  return Array.from({ length: count }, (_, index) => {
    const column = short * width * rng.range(COLUMN[0], COLUMN[1]);
    return {
      x: (index + 0.5 + offset) * pitch + rng.range(-JITTER, JITTER) * pitch,
      column, head: column * rng.range(1.2, 1.38), fillet: column * rng.range(0.7, 0.9),
      length: size.height * reach * rng.range(0.12, 0.5), rate: rng.range(0.9, 2.4), birth: rng.range(0, 0.2),
    };
  }).filter((_, index) => index % every === 0);
}

interface PaintState {
  /** The edge's mean y (px). */
  readonly edge: number;
  /** Each drip's length (px) at this state. */
  readonly lengths: readonly number[];
}

/** Edge and drip lengths at state s (0: unborn drips, edge above the frame; 1: edge below the bottom). */
function paintState(drips: readonly Drip[], s: number, size: MotionFrameSize, extra: number): PaintState {
  const unit = frameUnit(size);
  const reach = (WAVE_1 + WAVE_2) * unit + Math.max(...drips.map(drip => drip.head)) + extra;
  const edge = -reach + (size.height + 2 * reach) * s;
  const lengths = drips.map(drip => {
    const grown = clamp01((s - drip.birth) / (1 - drip.birth));
    return drip.length * (1 - (1 - grown) ** drip.rate);
  });
  return { edge, lengths };
}

/**
 * The outline of the paint above its front: the undulating edge with every drip
 * (fillet, column, neck, round head) as one closed path. `inset` shrinks the paint
 * by that many px (the edge rises, columns and heads narrow, fillets widen).
 */
export function paintOutline(drips: readonly Drip[], state: PaintState, size: MotionFrameSize, phases: readonly number[], inset = 0): string {
  const unit = frameUnit(size), n = (value: number) => fmt(value, 2);
  const pad = 8 * unit, top = -size.height - pad;
  const edgeAt = (x: number) => state.edge - inset + WAVE_1 * unit * Math.sin((2 * Math.PI * 2 * x) / size.width + phases[0])
    + WAVE_2 * unit * Math.sin((2 * Math.PI * 5 * x) / size.width + phases[1]);
  let d = `M${n(-pad)} ${n(top)}L${n(-pad)} ${n(edgeAt(-pad))}`;
  let cursor: Point2 = [-pad, edgeAt(-pad)];
  /** Run along the edge from the cursor to (x, y), as a Catmull–Rom spline through samples about 32 px apart. */
  const along = (x: number, y: number) => {
    const steps = Math.max(1, Math.ceil((x - cursor[0]) / (32 * unit)));
    const points: Point2[] = [cursor];
    for (let step = 1; step < steps; step += 1) {
      const sx = cursor[0] + ((x - cursor[0]) * step) / steps;
      points.push([sx, edgeAt(sx)]);
    }
    points.push([x, y]);
    for (let index = 0; index + 1 < points.length; index += 1) {
      const p0 = points[Math.max(0, index - 1)], p1 = points[index], p2 = points[index + 1], p3 = points[Math.min(points.length - 1, index + 2)];
      d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
    }
    cursor = [x, y];
  };
  const order = drips.map((_, index) => index).sort((a, b) => drips[a].x - drips[b].x);
  for (const index of order) {
    const drip = drips[index], length = state.lengths[index];
    const c = Math.max(0.5, drip.column - inset), head = Math.max(c, drip.head - inset);
    // A forming drip: the head grows from the column's width, the fillets and neck fit the length so far.
    const r = c + (head - c) * smoothstep(0, 2 * head, length);
    const f = Math.min(drip.fillet + inset, 0.4 * length);
    const neck = Math.min(1.3 * r, Math.max(0, length - f));
    const x0 = drip.x, y0 = edgeAt(drip.x), yn = y0 + length - neck, yh = y0 + length;
    along(x0 - c - f, y0);
    d += `C${n(x0 - c - f + KAPPA * f)} ${n(y0)} ${n(x0 - c)} ${n(y0 + f - KAPPA * f)} ${n(x0 - c)} ${n(y0 + f)}`
      + `L${n(x0 - c)} ${n(yn)}`
      + `C${n(x0 - c)} ${n(yn + neck / 2)} ${n(x0 - r)} ${n(yh - neck / 2)} ${n(x0 - r)} ${n(yh)}`
      + `C${n(x0 - r)} ${n(yh + KAPPA * r)} ${n(x0 - KAPPA * r)} ${n(yh + r)} ${n(x0)} ${n(yh + r)}`
      + `C${n(x0 + KAPPA * r)} ${n(yh + r)} ${n(x0 + r)} ${n(yh + KAPPA * r)} ${n(x0 + r)} ${n(yh)}`
      + `C${n(x0 + r)} ${n(yh - neck / 2)} ${n(x0 + c)} ${n(yn + neck / 2)} ${n(x0 + c)} ${n(yn)}`
      + `L${n(x0 + c)} ${n(y0 + f)}`
      + `C${n(x0 + c)} ${n(y0 + f - KAPPA * f)} ${n(x0 + c + f - KAPPA * f)} ${n(y0)} ${n(x0 + c + f)} ${n(y0)}`;
    cursor = [x0 + c + f, y0];
  }
  along(size.width + pad, edgeAt(size.width + pad));
  return `${d}L${n(size.width + pad)} ${n(top)}Z`;
}

/** Sutherland–Hodgman clip of a polygon against the rectangle [x0, x1] × [y0, y1]. */
function clipToRect(points: readonly Point2[], x0: number, y0: number, x1: number, y1: number): Point2[] {
  const planes: Array<[(p: Point2) => boolean, (a: Point2, b: Point2) => Point2]> = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + ((x0 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + ((x1 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + ((y0 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + ((y1 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y1]],
  ];
  let output: Point2[] = [...points];
  for (const [inside, cut] of planes) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index], previous = input[(index + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(cut(previous, current));
        output.push(current);
      } else if (inside(previous)) output.push(cut(previous, current));
    }
    if (!output.length) break;
  }
  return output;
}

function polygonArea(points: readonly Point2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index], [bx, by] = points[(index + 1) % points.length];
    twice += ax * by - bx * ay;
  }
  return Math.abs(twice) / 2;
}

interface Paint {
  readonly drips: readonly Drip[];
  readonly coat: readonly Drip[];
  readonly phases: readonly number[];
  readonly coatPhases: readonly number[];
}

function paint(seed: number, size: MotionFrameSize): Paint {
  const rng = createSeededRng(ID, seed, "edge");
  return {
    drips: dripRow(seed, "drips", size, 0), coat: dripRow(seed, "undercoat", size, 0.5, UNDERCOAT_WIDTH, UNDERCOAT_EVERY, UNDERCOAT_REACH),
    phases: [rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI)], coatPhases: [rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI)],
  };
}

/** Exact share of the frame B's paint (its flattened outline) covers at state s. */
export function dripCoverage(seed: number, s: number, size: MotionFrameSize): number {
  const { drips, phases } = paint(seed, size);
  let area = 0;
  for (const contour of flattenPathD(paintOutline(drips, paintState(drips, s, size, 0), size, phases), { segmentLength: 3 })) {
    area += polygonArea(clipToRect(contour, 0, 0, size.width, size.height));
  }
  return area / (size.width * size.height);
}

const halfStateCache = new Map<string, number>();
/** s½: the paint state that covers exactly half the frame. */
function halfState(seed: number, size: MotionFrameSize): number {
  const key = `${size.width}x${size.height}@${seed}`;
  const hit = halfStateCache.get(key);
  if (hit !== undefined) return hit;
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const middle = (low + high) / 2;
    if (dripCoverage(seed, middle, size) < 0.5) low = middle; else high = middle;
  }
  const result = (low + high) / 2;
  halfStateCache.set(key, result);
  if (halfStateCache.size > 64) halfStateCache.delete(halfStateCache.keys().next().value!);
  return result;
}

/** State at progress p: ease-in to s½ at p = ½, then a slope-matched ease-out to 1. */
export function dripState(p: number, half: number, power: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (p <= 0.5) return half * (2 * p) ** power;
  const x = 2 * p - 1, slope = (power * half) / (1 - half);
  const shaped = slope >= 1 ? 1 - (1 - x) ** slope : slope * x + (1 - slope) * x * x;
  return half + (1 - half) * shaped;
}

export const X18_dripWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const { drips, coat, phases, coatPhases } = paint(params.seed, size);
  const s = dripState(p, halfState(params.seed, size), EASE_IN_POWER[params.energy]);
  const state = paintState(drips, s, size, 0);
  const matteSvg = matte.render(path(paintOutline(drips, state, size, phases), { fill: MATTE_SHOW_B }));

  const lead = LEAD * size.height * Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  if (!(lead > 0.05)) return { matte: matteSvg, overlay: emptySvg(size) };
  const overlay = createSvgDocument(size);
  const coatState = paintState(coat, s, size, 0);
  const coatOutline = paintOutline(coat, { edge: coatState.edge + lead, lengths: coatState.lengths.map(length => length + 0.6 * lead) }, size, coatPhases);
  // The undercoat shows only outside B: clip it to the frame minus B shrunk by the tuck (so it reaches under B's edge).
  const unit = frameUnit(size);
  const outside = overlay.clipPath(path(rectPathD(-16 * unit, -2 * size.height, size.width + 32 * unit, 4 * size.height, 2)
    + paintOutline(drips, state, size, phases, TUCK * unit), { "clip-rule": "evenodd" }));
  return { matte: matteSvg, overlay: overlay.render(g({ "clip-path": outside }, path(coatOutline, { fill: params.palette.accent2 }))) };
}, { revision: REVISION });
