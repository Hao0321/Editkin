import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, energyProfile, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X04 Zigzag Wipe: B sweeps across behind a zigzag leading edge of 5–6 teeth
 * (45° flanks), led by an accent2 zigzag band of the same profile, so the teeth
 * read in two tones and trail off the far edge at the end.
 *
 * Timing: the zigzag centre line runs ease(t / D) from just before the start edge
 * (tips touching it) to just past the far edge (valleys touching it). Each tooth
 * has as much area ahead of the centre line as its valley has behind, so B covers
 * exactly half the frame at D/2 (ART_DIRECTION §4: switch at 45–55%). The band's
 * thickness is 11% of the travel length × sin(π t / D) × √amplitude: widest while
 * the edge is fastest, zero at both ends (t = 0 pure A, t = D pure B, empty
 * overlay). It tucks 1.5 px (at 1080) under B so no sliver of A shows between
 * them. Energy picks the curve (calm sine … hype expo, as X01). The seed picks 5
 * or 6 teeth. Directions: all four.
 */

const ID = "X04";
const REVISION = 1;
/** Tooth depth along the travel axis as a fraction of the tooth pitch (0.5 = 45° flanks), capped at a share of the travel length. */
const TOOTH_DEPTH = 0.5, MAX_TOOTH_DEPTH = 0.16;
const BAND = 0.11;
const TUCK = 1.5;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

interface TravelFrame {
  readonly length: number;
  readonly cross: number;
  readonly toFrame: (u: number, v: number) => Point2;
}

function travelFrame(direction: MotionTransitionDirection, size: MotionFrameSize): TravelFrame {
  const { width, height } = size;
  switch (direction) {
    case "left_to_right": return { length: width, cross: height, toFrame: (u, v) => [u, v] };
    case "right_to_left": return { length: width, cross: height, toFrame: (u, v) => [width - u, v] };
    case "top_to_bottom": return { length: height, cross: width, toFrame: (u, v) => [v, u] };
    case "bottom_to_top": return { length: height, cross: width, toFrame: (u, v) => [v, height - u] };
  }
}

/** 5 or 6 teeth (seeded). */
export function zigzagTeeth(seed: number): number {
  return createSeededRng(ID, seed, "teeth").chance(0.5) ? 5 : 6;
}

export const X04_zigzagWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const frame = travelFrame(params.direction ?? "left_to_right", size);
  const { length, cross } = frame;
  const teeth = zigzagTeeth(params.seed);
  const pitch = cross / teeth, half = Math.min(TOOTH_DEPTH * pitch, MAX_TOOTH_DEPTH * length) / 2;
  const centre = -half + (length + 2 * half) * EASING[params.energy](p);
  // Valleys at v = k · pitch, tips half a pitch later (both frame edges sit in valleys).
  const zigzag = (offset: number): Point2[] => Array.from({ length: 2 * teeth + 1 },
    (_, index) => [centre + offset + (index % 2 === 1 ? half : -half), (index * pitch) / 2] as const);
  const map = (points: readonly Point2[]) => polygonPathD(points.map(([u, v]) => frame.toFrame(u, v)), 2);

  const back = Math.min(0, centre - half) - 1;
  const matteSvg = matte.render(path(map([[back, 0], ...zigzag(0), [back, cross]]), { fill: MATTE_SHOW_B }));

  const band = BAND * length * Math.sin(Math.PI * p) * Math.sqrt(energyProfile(params.energy).amplitude);
  const tuck = TUCK * frameUnit(size);
  const visible = band > 0.05 && centre - tuck - half < length && centre + band + half > 0;
  const bandPath = visible ? map([...zigzag(band), ...zigzag(-tuck).reverse()]) : "";
  return { matte: matteSvg, overlay: createSvgDocument(size).render(path(bandPath, { fill: params.palette.accent2 })) };
}, { revision: REVISION, supportedDirections: MOTION_TRANSITION_DIRECTIONS });
