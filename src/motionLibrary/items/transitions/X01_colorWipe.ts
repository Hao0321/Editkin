import { mixHex, tint } from "../../svg/color";
import { createSvgDocument, rect } from "../../svg/document";
import { cubicInOut, energyProfile, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { defineTransitionMotion, MOTION_TRANSITION_DIRECTIONS, type MotionEnergy, type MotionFrameSize, type MotionTransitionDirection } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X01 Color Wipe: three planes sweep across in order, as in its reference: a cool
 * neutral grey (ink mixed toward paper), a light tint of the accent (mixed toward
 * paper), then B itself (accent in the demo). The matte is B's plane; the overlay
 * holds the two leading coloured strips.
 *
 * Timing: B's edge is ease(t / D), so B covers half the frame exactly at D/2
 * (ART_DIRECTION §4: the switch lands at 45–55%). Each leading plane is ahead of B
 * by a bell-shaped share of progress, lead · sin(π t / D) per plane, which is the
 * reference's ~0.06 s stagger (0.06 / 0.45 of the progress) at mid-transition and
 * zero at both ends: pure A at t = 0, pure B at t = D. lead · 2π ≤ 1 keeps every
 * edge monotonic. Edges snap to whole pixels so matte and overlay meet without an
 * antialiased seam of A.
 */

const ID = "X01";
/** Art revision (part of the clip cache key): 1 = first render; 2 = the reference's planes: neutral grey → light accent tint → accent. */
const REVISION = 2;
/** Neutral plane: ink mixed this far toward paper. Light plane: the accent mixed this far toward paper. */
const NEUTRAL_MIX = 0.58, LIGHT_TINT = 0.5;
const REFERENCE_DURATION = 0.45, REFERENCE_STAGGER = 0.06;
const MAX_LEAD = 0.15;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

interface Region { x: number; y: number; width: number; height: number }

/** Region covered by a plane whose leading edge has travelled `edge` pixels. */
function covered(direction: MotionTransitionDirection, size: MotionFrameSize, edge: number): Region {
  switch (direction) {
    case "left_to_right": return { x: 0, y: 0, width: edge, height: size.height };
    case "right_to_left": return { x: size.width - edge, y: 0, width: edge, height: size.height };
    case "top_to_bottom": return { x: 0, y: 0, width: size.width, height: edge };
    case "bottom_to_top": return { x: 0, y: size.height - edge, width: size.width, height: edge };
  }
}

/** The strip a plane shows between its own edge and the next plane's edge (both measured from the start side). */
function strip(direction: MotionTransitionDirection, size: MotionFrameSize, from: number, to: number): Region | null {
  if (to <= from) return null;
  switch (direction) {
    case "left_to_right": return { x: from, y: 0, width: to - from, height: size.height };
    case "right_to_left": return { x: size.width - to, y: 0, width: to - from, height: size.height };
    case "top_to_bottom": return { x: 0, y: from, width: size.width, height: to - from };
    case "bottom_to_top": return { x: 0, y: size.height - to, width: size.width, height: to - from };
  }
}

export const X01_colorWipe = defineTransitionMotion(ID, (params, t, size) => {
  const direction = params.direction ?? "left_to_right";
  const extent = direction === "left_to_right" || direction === "right_to_left" ? size.width : size.height;
  const progress = Math.max(0, Math.min(1, t / params.durationSeconds));
  const lead = Math.min(MAX_LEAD, (REFERENCE_STAGGER / REFERENCE_DURATION) * energyProfile(params.energy).time);
  const bell = Math.sin(Math.PI * progress);
  const ease = EASING[params.energy];
  // Edge of plane i (0 neutral, 1 light accent, 2 = B), in whole pixels from the start side.
  const edges = [0, 1, 2].map(index => Math.round(extent * ease(Math.max(0, Math.min(1, progress + (2 - index) * lead * bell)))));
  const neutral = mixHex(params.palette.ink, params.palette.paper, NEUTRAL_MIX);
  const light = tint(params.palette.accent, LIGHT_TINT, params.palette.paper);

  const matteRegion = covered(direction, size, edges[2]);
  const matteSvg = createMatteDocument(size).render(rect(matteRegion.x, matteRegion.y, matteRegion.width, matteRegion.height, { fill: MATTE_SHOW_B }));

  const overlay = createSvgDocument(size);
  const lightStrip = strip(direction, size, edges[2], edges[1]);
  const neutralStrip = strip(direction, size, edges[1], edges[0]);
  const overlaySvg = overlay.render(
    neutralStrip && rect(neutralStrip.x, neutralStrip.y, neutralStrip.width, neutralStrip.height, { fill: neutral }),
    lightStrip && rect(lightStrip.x, lightStrip.y, lightStrip.width, lightStrip.height, { fill: light }),
  );
  return { matte: matteSvg, overlay: overlaySvg };
}, { supportedDirections: MOTION_TRANSITION_DIRECTIONS, revision: REVISION });
