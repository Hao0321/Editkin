import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, quadInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X37 Band Split: the frame is cut into an even number of equal horizontal bands, and B flows
 * into every band from the same side at its own speed, each band led by a flat panel, accent and
 * deep shade in alternation (the seed swaps them); an accent panel carries a thin deep-shade
 * leading edge, so every band meets A with a crisp dark edge. Some bands
 * set off early and slowly, others late and fast, so the B edges stream past each other.
 *
 * Timing: the bands come in mirrored pairs: one runs over the window [a, b] of the duration and
 * its partner over [1 − b, 1 − a], both with the same symmetric ease, so at D/2 the pair's B
 * edges sum to exactly one band and B covers exactly half the frame (ART_DIRECTION §4); B only
 * grows. Windows are seeded (starts 0–0.15, ends 0.55–0.85 of the duration, so speeds differ by
 * up to about 2×), and pairs are shuffled across the bands. A panel lands on the far edge at
 * 70% of its band's window, so no sliver of A lingers ahead of B. Energy sets the curve (calm
 * sine … hype quart in-out). Bands and edges are whole pixels, so no seams. Directional: the
 * direction names the flow (left to right by default; vertical flows cut vertical bands).
 */

const ID = "X37";
/** Art revision (part of the clip cache key): 1 = first render (paper seams floating as white ticks between B and accent panels); 2 = deep leading edges on accent panels instead of seams. */
const REVISION = 2;
/** Target band thickness, as a fraction of the short side. */
const BAND = 0.17;
const LAND = 0.7;
/** Deep-shade leading edge on accent panels (px at 1080). */
const EDGE = 12;

const EASE: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: quadInOut,
  punchy: cubicInOut,
  hype: quartInOut,
};

/** An even band count, about 17% of the short side each. */
export function bandCount(size: MotionFrameSize, direction: MotionTransitionDirection = "left_to_right"): number {
  const { cross } = travelFrame(direction, size);
  return Math.max(2, 2 * Math.round(cross / (2 * BAND * Math.min(size.width, size.height))));
}

export interface BandLayout {
  /** Each band's window [start, end] (fractions of the duration). */
  readonly windows: readonly (readonly [number, number])[];
  readonly tones: readonly ("accent" | "accent2")[];
}

export function bandLayout(seed: number, count: number): BandLayout {
  const rng = createSeededRng(ID, seed, `bands-${count}`);
  const windows: Array<readonly [number, number]> = [];
  for (let pair = 0; pair < count / 2; pair += 1) {
    const a = rng.range(0, 0.15), b = rng.range(0.55, 0.85);
    windows.push([a, b], [1 - b, 1 - a]);
  }
  for (let index = windows.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [windows[index], windows[swap]] = [windows[swap], windows[index]];
  }
  const flip = rng.int(0, 1);
  return { windows, tones: windows.map((_, band) => ((band + flip) % 2 === 0 ? "accent" : "accent2")) };
}

/** B's edge and the panel's edge in a band with window [a, b] at progress p (fractions of the travel length). */
export function bandEdges(window: readonly [number, number], p: number, energy: MotionEnergy): { readonly b: number; readonly panel: number } {
  const [start, end] = window, ease = EASE[energy], local = (p - start) / (end - start);
  return { b: ease(clamp01(local)), panel: ease(clamp01(local / LAND)) };
}

export const X37_bandSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const direction = params.direction ?? "left_to_right";
  const frame = travelFrame(direction, size), { length, cross } = frame;
  const count = bandCount(size, direction), { windows, tones } = bandLayout(params.seed, count);
  const edgeMax = Math.round(EDGE * frameUnit(size));
  const box = (u0: number, u1: number, v0: number, v1: number): string => {
    if (!(u1 > u0)) return "";
    const corners: Point2[] = [frame.toFrame(u0, v0), frame.toFrame(u1, v0), frame.toFrame(u1, v1), frame.toFrame(u0, v1)];
    return polygonPathD(corners, 0);
  };
  let matteD = "";
  const fills: Record<string, string> = {};
  windows.forEach((window, band) => {
    const v0 = Math.round((band * cross) / count), v1 = Math.round(((band + 1) * cross) / count);
    const edges = bandEdges(window, p, params.energy);
    const b = Math.round(length * edges.b), lead = Math.round(length * edges.panel);
    matteD += box(0, b, v0, v1);
    // An accent panel's leading edge is the deep shade (at most a third of the panel).
    const edge = tones[band] === "accent" ? Math.min(edgeMax, Math.floor((lead - b) / 3)) : 0;
    fills[tones[band]] = (fills[tones[band]] ?? "") + box(b, lead - edge, v0, v1);
    if (edge > 0) fills.accent2 = (fills.accent2 ?? "") + box(lead - edge, lead, v0, v1);
  });
  return {
    matte: matte.render(path(matteD, { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(
      path(fills.accent ?? "", { fill: params.palette.accent }),
      path(fills.accent2 ?? "", { fill: params.palette.accent2 })),
  };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
