import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X25 Horizontal Split: the frame splits into a top and a bottom band. B enters the top
 * band from the left and the bottom band from the right at the same time, each behind a
 * flat panel that leads it in: one band's panel in the accent, the other's in ink (seeded).
 * A thin deep-shade (accent2) seam runs down each panel's trailing edge, where B follows,
 * so panel and B stay two crisp planes even when they share a colour.
 *
 * Timing: B's edge in both bands is ease(t / D) of the frame width, so B covers half the
 * frame exactly at D/2 (ART_DIRECTION §4). Each panel leads B by lead · sin(π t / D) of
 * the progress (zero at both ends: pure A at t = 0, pure B at t = D; lead < 1/π keeps the
 * panel edge monotonic), about a third of the frame at mid-transition. Energy sets the
 * curve and the lead (calm sine … hype expo in-out). Edges snap to whole pixels and the
 * bands meet on a whole-pixel line, so matte, panels and seams meet without an antialiased
 * gap. Directional: the direction names the first band's travel (top band, left to right,
 * by default); the second band travels the other way. For top_to_bottom and bottom_to_top
 * the split turns vertical (left and right bands).
 */

const ID = "X25";
const REVISION = 1;
/** Seam on each panel's trailing edge (px at 1080). */
const SEAM = 18;

interface SplitTiming { readonly ease: EasingFunction; readonly land: number }
const TIMING: Record<MotionEnergy, SplitTiming> = {
  calm: { ease: sineInOut, land: 0.8 },
  standard: { ease: cubicInOut, land: 0.76 },
  punchy: { ease: quartInOut, land: 0.74 },
  hype: { ease: expoInOut, land: 0.72 },
};

/** Palette roles of the first and second band's panels: one accent, one ink. */
export function horizontalSplitTones(seed: number): readonly ["accent" | "ink", "accent" | "ink"] {
  return createSeededRng(ID, seed, "layout").int(0, 1) === 0 ? ["accent", "ink"] : ["ink", "accent"];
}

/** B's edge and the panel's edge (fractions of the travel length) at progress p. */
export function horizontalSplitEdges(p: number, energy: MotionEnergy): { readonly b: number; readonly panel: number } {
  const { ease, land } = TIMING[energy];
  return { b: ease(clamp01(p)), panel: ease(clamp01(p / land)) };
}

export const X25_horizontalSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size);
  const { length, cross } = frame, mid = Math.round(cross / 2);
  const edges = horizontalSplitEdges(p, params.energy);
  const b = Math.round(length * edges.b), lead = Math.round(length * edges.panel);
  const seam = Math.min(Math.round(SEAM * frameUnit(size)), Math.floor((lead - b) / 3));
  // A travel-space box [u0, u1] × [v0, v1] in frame px. The second band runs from the far end (u → length − u).
  const box = (band: 0 | 1, u0: number, u1: number): string => {
    if (!(u1 > u0)) return "";
    const [a0, a1] = band === 0 ? [u0, u1] : [length - u1, length - u0];
    const [v0, v1] = band === 0 ? [0, mid] : [mid, cross];
    const corners: Point2[] = [frame.toFrame(a0, v0), frame.toFrame(a1, v0), frame.toFrame(a1, v1), frame.toFrame(a0, v1)];
    return polygonPathD(corners, 0);
  };
  const tones = horizontalSplitTones(params.seed);
  const overlay = createSvgDocument(size).render(
    path(box(0, b, lead), { fill: params.palette[tones[0]] }),
    path(box(1, b, lead), { fill: params.palette[tones[1]] }),
    seam > 0 && path(box(0, b, b + seam) + box(1, b, b + seam), { fill: params.palette.paper }),
  );
  return { matte: matte.render(path(box(0, 0, b) + box(1, 0, b), { fill: MATTE_SHOW_B })), overlay };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
