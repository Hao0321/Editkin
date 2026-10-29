import { createSvgDocument, emptySvg, fmt, path, rect } from "../../svg/document";
import { clamp01, cubicIn, cubicInOut, cubicOut, quadIn, quadOut, quartIn, quartInOut, quartOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X24 Circle Split: a disc made of two half-discs, one in the accent and one in ink,
 * split along a seeded diameter, grows out of the frame centre while its halves turn
 * in opposite directions; they come into line exactly as the disc covers the frame.
 * Each half sits on a thin deep-shade (accent2) rim, 10 px (at 1080) round its arc and
 * along its diameter, drawn under both halves: the rims outline the halves against A
 * while they grow and, once the circle cracks, line the two cut faces. Under full
 * cover B is switched in, and the circle splits: the halves slide apart along their
 * own normals, still turning in opposite directions, so B opens in the widening,
 * twisting crack until both halves have left.
 *
 * Timing: the disc grows over 0–46% to past the frame corners while each half turns
 * from 40° out of line to in line; the frame is fully covered from 46% and the matte
 * switches at exactly D/2 (ART_DIRECTION §4); the halves part over 50–96%, each sliding
 * out by more than the half-diagonal plus its rim (a half-disc wider than the frame lies
 * wholly past its own diameter, so it is then off-frame) and turning a further 30°. The first
 * half reaches 1.5 px (at 1080) past the diameter under the second, so no seam opens
 * on the split line. Energy sets the curves (calm sine … hype quart). The seed sets
 * the split angle and swaps the tones. t = 0 is pure A and t = D pure B with an empty
 * overlay. Not directional.
 */

const ID = "X24";
/** Art revision (part of the clip cache key): 1 = first render (deep-shade and ink halves: heavy and muddy in the yellow family); 2 = accent and ink halves on thin deep-shade rims. */
const REVISION = 2;
const SWITCH = 0.5;
const GROW_END = 0.46, PART_END = 0.96;
/** How far out of line each half starts (degrees), and how much further each turns while parting. */
const CLOSE_TURN = 40, OPEN_TURN = 30;
const TUCK = 1.5;
/** The deep-shade rim round each half (px at 1080). */
const RIM = 10;
/** Cubic Bézier quarter-circle handle. */
const KAPPA = 0.5522847498307936;

interface SplitTiming { readonly grow: EasingFunction; readonly close: EasingFunction; readonly part: EasingFunction }
const TIMING: Record<MotionEnergy, SplitTiming> = {
  calm: { grow: sineInOut, close: sineInOut, part: sineInOut },
  standard: { grow: quadOut, close: cubicOut, part: quadIn },
  punchy: { grow: cubicOut, close: cubicInOut, part: cubicIn },
  hype: { grow: quartOut, close: quartInOut, part: quartIn },
};

export interface CircleSplitLayout {
  /** Angle of the split diameter (degrees, clockwise from 3 o'clock). */
  readonly angle: number;
  /** Palette roles of the two halves (each on a deep-shade rim). */
  readonly tones: readonly ["accent" | "ink", "accent" | "ink"];
}

export function circleSplitLayout(seed: number): CircleSplitLayout {
  const rng = createSeededRng(ID, seed, "layout");
  return { angle: rng.range(20, 70) * rng.sign(), tones: rng.int(0, 1) === 0 ? ["accent", "ink"] : ["ink", "accent"] };
}

/**
 * Half-disc of radius r on the side of (ox, oy) that its unit normal (nx, ny) points to: the semicircle
 * round from one end of the diameter to the other, then back along the diameter.
 */
export function halfDiscD(ox: number, oy: number, nx: number, ny: number, r: number): string {
  if (!(r > 0)) return "";
  const n = (value: number) => fmt(value, 2), k = KAPPA * r;
  const tx = -ny, ty = nx;
  const a: readonly [number, number] = [ox + tx * r, oy + ty * r], m: readonly [number, number] = [ox + nx * r, oy + ny * r], b: readonly [number, number] = [ox - tx * r, oy - ty * r];
  return `M${n(a[0])} ${n(a[1])}C${n(a[0] + nx * k)} ${n(a[1] + ny * k)} ${n(m[0] + tx * k)} ${n(m[1] + ty * k)} ${n(m[0])} ${n(m[1])}`
    + `C${n(m[0] - tx * k)} ${n(m[1] - ty * k)} ${n(b[0] + nx * k)} ${n(b[1] + ny * k)} ${n(b[0])} ${n(b[1])}Z`;
}

/**
 * A half-disc's rim: the half-disc of radius r + w with a strip w wide past its diameter, so it shows w px round the
 * arc and along the diameter of the half-disc (ox, oy, n, r) drawn over it.
 */
export function halfDiscRimD(ox: number, oy: number, nx: number, ny: number, r: number, w: number): string {
  if (!(r > 0) || !(w > 0)) return "";
  const outer = halfDiscD(ox, oy, nx, ny, r + w), R = r + w, tx = -ny, ty = nx, n = (value: number) => fmt(value, 2);
  // The strip under the diameter, as its own rectangle (same winding as the half-disc, so the two unite).
  const corners = [[ox - tx * R, oy - ty * R], [ox - tx * R - nx * w, oy - ty * R - ny * w], [ox + tx * R - nx * w, oy + ty * R - ny * w], [ox + tx * R, oy + ty * R]];
  return `${outer}M${corners.map(([x, y]) => `${n(x)} ${n(y)}`).join("L")}Z`;
}

/** Turn (degrees, + for the first half; the second turns the other way) and slide (px) of the halves at progress p. */
export function circleSplitPose(p: number, energy: MotionEnergy, size: MotionFrameSize): { readonly radius: number; readonly turn: number; readonly slide: number } {
  const { grow, close, part } = TIMING[energy];
  const halfDiagonal = Math.hypot(size.width, size.height) / 2, cover = halfDiagonal + 4 * frameUnit(size);
  if (p < SWITCH) {
    const q = clamp01(p / GROW_END);
    return { radius: cover * grow(q), turn: CLOSE_TURN * (1 - close(q)), slide: 0 };
  }
  const q = clamp01((p - SWITCH) / (PART_END - SWITCH));
  return { radius: cover, turn: -OPEN_TURN * part(q), slide: (halfDiagonal + (RIM + 8) * frameUnit(size)) * part(q) };
}

export const X24_circleSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { angle, tones } = circleSplitLayout(params.seed);
  const { radius, turn, slide } = circleSplitPose(p, params.energy, size);
  const cx = size.width / 2, cy = size.height / 2, tuck = TUCK * frameUnit(size), rim = RIM * frameUnit(size);
  // Half i: normal at angle + 90° (+ 180° for the second), turned +turn (first) or −turn (second), slid out along it.
  const pose = (index: 0 | 1, reach: number) => {
    const degrees = angle + 90 + 180 * index + (index === 0 ? turn : -turn), radians = (degrees * Math.PI) / 180;
    const nx = Math.cos(radians), ny = Math.sin(radians);
    return { ox: cx + nx * (slide - reach), oy: cy + ny * (slide - reach), nx, ny };
  };
  const first = pose(0, tuck), second = pose(1, 0);
  // Hidden once both halves are past the frame (they slide out by more than the half-diagonal plus the rim).
  const done = p >= PART_END;
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    // Both rims under both halves: in line, the halves cover each other's rim strips (a clean split); apart, the rims line the crack.
    overlay: done ? emptySvg(size) : createSvgDocument(size).render(
      path(halfDiscRimD(first.ox, first.oy, first.nx, first.ny, radius, rim), { fill: params.palette.accent2 }),
      path(halfDiscRimD(second.ox, second.oy, second.nx, second.ny, radius, rim), { fill: params.palette.accent2 }),
      path(halfDiscD(first.ox, first.oy, first.nx, first.ny, radius), { fill: params.palette[tones[0]] }),
      path(halfDiscD(second.ox, second.oy, second.nx, second.ny, radius), { fill: params.palette[tones[1]] })),
  };
}, { revision: REVISION });
