import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, expoInOut, quadInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X15 Pinwheel Wipe: 6–8 blades fan out of the frame centre and spin. Each blade is
 * a wedge whose angular width grows from nothing to its full share (360°/N) while
 * the pinwheel turns; the blades are B, so B covers the frame once they close. The
 * blade edges swirl gently (each edge lags the turn by 26° at the half-diagonal), so
 * the pinwheel reads as spinning, and every blade's leading edge carries a
 * deep-shade (accent2) lip: a narrow wedge riding ahead of it, the item's second tone.
 *
 * Timing: the blades' share of the frame follows an in-out curve (calm sine … hype
 * quart), so it is exactly a half at D/2 (ART_DIRECTION §4: switch at 45–55%) and only
 * ever grows: every frame the blade width is solved (bisection on the exact
 * blade–rectangle areas) for that share at the current turn, because turning swirled
 * blades across a non-square frame changes how much of it they cover. The turn
 * (110° × √amplitude) follows its own in-out curve. The lips are 7° × sin(π t / D) ×
 * √amplitude × √(the gap's share of a blade slot), clipped to the gap ahead, so they
 * vanish at both ends and melt away as the blades close (t = 0 pure A, t = D pure B,
 * empty overlay); each lip tucks up to 0.35° (at most half its width) under its blade.
 * The seed picks the blade count (6–8), the resting angle and the turning direction.
 * Not directional.
 */

const ID = "X15";
/** Art revision (part of the clip cache key): 1 = first render (lips kept their full swell until the blades closed, leaving dark hairlines on B); 2 = lips shrink with the gap they ride in. */
const REVISION = 2;
const SPIN = 110;
const SWIRL = 26;
const LIP = 7;
const LIP_TUCK = 0.35;
const EDGE_SAMPLES = 24;
const ARC_SAMPLES = 4;
/** The blades' share of the frame over the wipe (symmetric in-outs: exactly ½ at D/2). */
const COVER_EASE: Record<MotionEnergy, EasingFunction> = { calm: sineInOut, standard: quadInOut, punchy: cubicInOut, hype: quartInOut };
const SPIN_EASE: Record<MotionEnergy, EasingFunction> = { calm: sineInOut, standard: cubicInOut, punchy: quartInOut, hype: expoInOut };

export interface PinwheelLayout {
  readonly blades: number;
  /** Trailing-edge angle of blade 0 at rest (degrees, clockwise from 3 o'clock). */
  readonly base: number;
  /** +1 turns clockwise on screen, −1 counter-clockwise. */
  readonly sign: 1 | -1;
}

export function pinwheelLayout(seed: number): PinwheelLayout {
  const rng = createSeededRng(ID, seed, "layout");
  return { blades: rng.int(6, 8), base: rng.range(0, 360), sign: rng.sign() };
}

/**
 * One blade: from the centre out along its trailing edge to `reach`, round an outer
 * arc, and back along its leading edge. `start` is the trailing edge's angle at the
 * centre; the blade spans sign · width from it. Both edges lag by the swirl.
 */
function bladePoints(cx: number, cy: number, reach: number, halfDiagonal: number, start: number, width: number, sign: 1 | -1): Point2[] {
  const at = (angle: number, r: number): Point2 => {
    const radians = ((angle - sign * SWIRL * (r / halfDiagonal)) * Math.PI) / 180;
    return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
  };
  const trailing: Point2[] = [], leading: Point2[] = [], arc: Point2[] = [];
  for (let k = 1; k <= EDGE_SAMPLES; k += 1) {
    const r = (reach * k) / EDGE_SAMPLES;
    trailing.push(at(start, r));
    leading.push(at(start + sign * width, r));
  }
  for (let k = 1; k < ARC_SAMPLES; k += 1) arc.push(at(start + (sign * width * k) / ARC_SAMPLES, reach));
  return [[cx, cy], ...trailing, ...arc, ...leading.reverse()];
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

interface Pinwheel {
  readonly layout: PinwheelLayout;
  readonly cx: number;
  readonly cy: number;
  readonly halfDiagonal: number;
  /** Polygon reach: past the frame corners even across the outer arc's chords. */
  readonly reach: number;
  /** The full share 360°/N. */
  readonly share: number;
}

function pinwheel(seed: number, size: MotionFrameSize): Pinwheel {
  const layout = pinwheelLayout(seed), halfDiagonal = Math.hypot(size.width, size.height) / 2;
  return { layout, cx: size.width / 2, cy: size.height / 2, halfDiagonal, reach: 1.3 * halfDiagonal + 4, share: 360 / layout.blades };
}

function blades(wheel: Pinwheel, turn: number, width: number): Point2[][] {
  const { layout, cx, cy, reach, halfDiagonal, share } = wheel;
  return Array.from({ length: layout.blades }, (_, index) =>
    bladePoints(cx, cy, reach, halfDiagonal, layout.base + layout.sign * (turn + index * share), width, layout.sign));
}

/** Exact share of the frame the blades of `width` degrees cover at `turn` degrees. */
export function pinwheelCoverage(seed: number, turn: number, width: number, size: MotionFrameSize): number {
  if (!(width > 0)) return 0;
  const wheel = pinwheel(seed, size);
  let area = 0;
  for (const blade of blades(wheel, turn, width)) area += polygonArea(clipToRect(blade, 0, 0, size.width, size.height));
  return area / (size.width * size.height);
}

/** The blade width (degrees) whose blades cover `share` of the frame at `turn` degrees: bisection (coverage grows with width). */
export function pinwheelWidthFor(seed: number, turn: number, share: number, size: MotionFrameSize): number {
  const full = 360 / pinwheelLayout(seed).blades;
  if (share <= 0) return 0;
  if (share >= 1) return full;
  let low = 0, high = full;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const middle = (low + high) / 2;
    if (pinwheelCoverage(seed, turn, middle, size) < share) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

export const X15_pinwheelWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const wheel = pinwheel(params.seed, size);
  const amplitude = Math.sqrt(energyProfile(params.energy).amplitude);
  const turn = SPIN * amplitude * SPIN_EASE[params.energy](p);
  const width = pinwheelWidthFor(params.seed, turn, COVER_EASE[params.energy](p), size);
  // The lip shrinks with the gap it rides in (√ of the gap's share), so none is left as the blades close.
  const gap = Math.max(0, wheel.share - width);
  const lip = Math.min(LIP * amplitude * Math.sin(Math.PI * p) * Math.sqrt(gap / wheel.share), gap);

  let bladesPath = "", lipsPath = "";
  for (const blade of blades(wheel, turn, width)) bladesPath += polygonPathD(blade, 2);
  if (lip > 0.02) {
    const { layout, cx, cy, reach, halfDiagonal, share } = wheel;
    // The tuck shrinks with the lip, so no sliver of the deep shade is left over B as the blades close.
    const tuck = Math.min(LIP_TUCK, lip / 2);
    for (let index = 0; index < layout.blades; index += 1) {
      const leading = layout.base + layout.sign * (turn + index * share + width - tuck);
      lipsPath += polygonPathD(bladePoints(cx, cy, reach, halfDiagonal, leading, lip + tuck, layout.sign), 2);
    }
  }
  return {
    matte: matte.render(path(bladesPath, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(lipsPath, { fill: params.palette.accent2 })),
  };
}, { revision: REVISION });
