import { createSvgDocument, emptySvg, path, polygonPathD, rect, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X12 Clock Wipe: B is revealed by a radial sweep about the frame centre,
 * starting at 12 o'clock and running clockwise, with a thin ink hand riding the
 * sweep's edge from the centre out past the frame.
 *
 * Timing: the sweep angle is 360° × ease(t / D). Half a turn (12 to 6 o'clock)
 * covers exactly the right half of the frame, so B covers half the frame at D/2
 * (ART_DIRECTION §4: switch at 45–55%). The sector is the exact polygon of the
 * centre, the frame corners already passed and the edge point, so coverage is
 * exact at any aspect. The hand (0.7% of the short side) sits centred on the
 * sweep edge, hiding its antialiasing, and fades in and out over the first and
 * last 12%, so t = 0 is pure A and t = D pure B with an empty overlay. Energy picks
 * the sweep curve (calm sine … hype expo). Not directional (always clockwise from
 * 12, like a clock); the seed is unused.
 */

const ID = "X12";
const REVISION = 1;
const HAND = 0.007;
const FADE = 0.12;

const EASING: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Where the ray from the frame centre at a clock angle (degrees clockwise from 12 o'clock) leaves the frame. */
export function clockEdgePoint(degrees: number, size: MotionFrameSize): Point2 {
  const cx = size.width / 2, cy = size.height / 2;
  const dx = Math.sin(toRadians(degrees)), dy = -Math.cos(toRadians(degrees));
  const reach = Math.min(Math.abs(dx) > 1e-12 ? cx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-12 ? cy / Math.abs(dy) : Infinity);
  return [cx + dx * reach, cy + dy * reach];
}

/** The swept sector inside the frame: centre, 12 o'clock edge point, the corners passed, the current edge point. */
export function clockSector(degrees: number, size: MotionFrameSize): Point2[] {
  const { width, height } = size;
  const corner = (Math.atan2(width / 2, height / 2) * 180) / Math.PI;
  const corners: Array<[number, Point2]> = [[corner, [width, 0]], [180 - corner, [width, height]], [180 + corner, [0, height]], [360 - corner, [0, 0]]];
  return [[width / 2, height / 2], [width / 2, 0], ...corners.filter(([angle]) => angle < degrees).map(([, point]) => point), clockEdgePoint(degrees, size)];
}

export const X12_clockWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B })), overlay: emptySvg(size) };

  const sweep = 360 * EASING[params.energy](p);
  const matteSvg = matte.render(sweep > 0 ? path(polygonPathD(clockSector(sweep, size), 2), { fill: MATTE_SHOW_B }) : "");

  const cx = size.width / 2, cy = size.height / 2;
  const half = (HAND * 1080 * frameUnit(size)) / 2, reach = Math.hypot(size.width, size.height);
  const dx = Math.sin(toRadians(sweep)), dy = -Math.cos(toRadians(sweep));
  const nx = -dy * half, ny = dx * half;
  const hand = polygonPathD([[cx - nx, cy - ny], [cx + dx * reach - nx, cy + dy * reach - ny], [cx + dx * reach + nx, cy + dy * reach + ny], [cx + nx, cy + ny]], 2);
  const fade = Math.min(1, p / FADE, (1 - p) / FADE);
  return {
    matte: matteSvg,
    overlay: createSvgDocument(size).render(path(hand, { fill: params.palette.ink, opacity: fade < 1 ? Number(fade.toFixed(3)) : undefined })),
  };
}, { revision: REVISION });
