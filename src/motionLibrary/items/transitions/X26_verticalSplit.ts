import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, quadInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B, travelFrame } from "../shared";

/**
 * X26 Vertical Split: the frame splits into a left and a right half that spin like two slot
 * reels, the left scrolling up and the right scrolling down. Each reel is a strip of three
 * flat panels (two-tone: the left reel accent, ink, accent; the right ink, accent, ink; the
 * seed swaps them) with paper separator lines between the panels and along the strip's tail.
 * A strip's head sweeps across its half and covers A; the strips are 1.4 halves long, so the
 * frame is fully covered when the matte switches from A to B at exactly D/2 (ART_DIRECTION
 * §4); the tails then sweep across and reveal B behind them, a paper line riding each tail.
 *
 * Timing: each head travels ease(t / D) × (half length + strip length) from its start edge,
 * so both reels cover their halves for ease ∈ [1/2.4, 1.4/2.4] around D/2. The panels have
 * seeded heights (28–40% of the strip), different per reel, so the separators never line up
 * across the split and no periodic pattern can alias into a backward spin; every point sees
 * at most one dark-light-dark change (well under 3 flashes per second). Energy sets the curve
 * (calm sine … hype quart in-out). Edges are whole pixels and the halves meet on a whole-pixel
 * line. Directional: the direction names the first half's travel (the left half, upward, by
 * default); the second half travels the other way. For left_to_right and right_to_left the
 * split turns horizontal (top and bottom halves).
 */

const ID = "X26";
const REVISION = 1;
const SWITCH = 0.5;
/** Strip length in halves: > 1, so the strips fully cover their halves around the switch. */
const STRIP = 1.4;
/** Paper separator lines (px at 1080). */
const LINE = 12;

const EASE: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: quadInOut,
  punchy: cubicInOut,
  hype: quartInOut,
};

export interface ReelLayout {
  /** Panel heights of each reel, head first, as fractions of the strip (each sums to 1). */
  readonly panels: readonly [readonly number[], readonly number[]];
  /** Palette roles of each reel's panels, head first. */
  readonly tones: readonly [readonly ("accent" | "ink")[], readonly ("accent" | "ink")[]];
}

export function reelLayout(seed: number): ReelLayout {
  const rng = createSeededRng(ID, seed, "layout");
  const heights = () => { const a = rng.range(0.28, 0.4), b = rng.range(0.28, 0.4); return [a, b, 1 - a - b]; };
  const first = heights(), second = heights();
  const [one, two]: ["accent" | "ink", "accent" | "ink"] = rng.int(0, 1) === 0 ? ["accent", "ink"] : ["ink", "accent"];
  return { panels: [first, second], tones: [[one, two, one], [two, one, two]] };
}

/** Distance the strips' heads have travelled from their start edges, in halves (0 … 1 + STRIP). */
export function reelTravel(p: number, energy: MotionEnergy): number {
  return (1 + STRIP) * EASE[energy](clamp01(p));
}

export const X26_verticalSplit = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "bottom_to_top", size);
  const { length, cross } = frame, mid = Math.round(cross / 2);
  const strip = STRIP * length, head = reelTravel(p, params.energy) * length;
  const line = Math.max(1, Math.round(LINE * frameUnit(size)));
  const { panels, tones } = reelLayout(params.seed);
  // Travel-space box [u0, u1] (from the reel's own start edge) on half `reel`, clipped to the frame, in whole px.
  const box = (reel: 0 | 1, u0: number, u1: number): string => {
    const a = Math.max(0, Math.round(u0)), b = Math.min(length, Math.round(u1));
    if (!(b > a)) return "";
    const [a0, a1] = reel === 0 ? [a, b] : [length - b, length - a];
    const [v0, v1] = reel === 0 ? [0, mid] : [mid, cross];
    const corners: Point2[] = [frame.toFrame(a0, v0), frame.toFrame(a1, v0), frame.toFrame(a1, v1), frame.toFrame(a0, v1)];
    return polygonPathD(corners, 0);
  };
  const fills: Record<string, string> = {};
  let lines = "";
  for (const reel of [0, 1] as const) {
    let top = head;
    panels[reel].forEach((share, index) => {
      const bottom = top - share * strip, role = tones[reel][index];
      fills[role] = (fills[role] ?? "") + box(reel, bottom, top);
      // A separator below every panel: between panels, and on the strip's tail.
      lines += box(reel, bottom, bottom + line);
      top = bottom;
    });
  }
  const overlay = createSvgDocument(size).render(
    path(fills.accent ?? "", { fill: params.palette.accent }),
    path(fills.ink ?? "", { fill: params.palette.ink }),
    path(lines, { fill: params.palette.paper }),
  );
  return { matte: p < SWITCH ? matte.render() : allB(), overlay };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
