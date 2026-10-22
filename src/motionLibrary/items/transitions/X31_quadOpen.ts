import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X31 Quad Open: A splits along a centred cross and its four quarters slide out to the four
 * corners, each along the frame's diagonal, opening onto B in the widening cross. The matte
 * is exactly the opening: B inside the cross, A in the quarters. Each quarter carries a
 * deep-shade (accent2) edge band along its two inner edges, so the quarters read as flat
 * panels being pulled apart; the bands grow in over the first 8% of the opening, so the
 * split starts as a hairline.
 *
 * Timing: with the quarters moved out by a share s of the half-frame, B covers 1 − (1 − s)²
 * of the frame; s = 1 − √(1 − ease(t / D)) makes that ease(t / D) exactly, so B covers half
 * the frame exactly at D/2 (ART_DIRECTION §4) and only ever grows. The quarters start slowly,
 * glide out and settle into the corners. Energy sets the curve (calm sine … hype expo in-out).
 * The cross is snapped to whole pixels, so matte, quarters and bands meet without an
 * antialiased seam. Not directional (the quarters open to all four corners).
 */

const ID = "X31";
const REVISION = 1;
/** Deep-shade edge band on each quarter's inner edges (px at 1080), grown in over the first GROW of the opening. */
const BAND = 22, GROW = 0.08;

const EASE: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

/** Share s (0 … 1) of the half-frame by which the quarters have moved out at progress p: B covers 1 − (1 − s)². */
export function quadOpenShare(p: number, energy: MotionEnergy): number {
  return 1 - Math.sqrt(1 - EASE[energy](clamp01(p)));
}

/** The cross at progress p, in whole px: half-widths of its vertical and horizontal arms about the frame centre. */
export function quadOpenCross(p: number, energy: MotionEnergy, size: MotionFrameSize): { readonly cx: number; readonly cy: number; readonly dx: number; readonly dy: number } {
  const s = quadOpenShare(p, energy), cx = Math.round(size.width / 2), cy = Math.round(size.height / 2);
  return { cx, cy, dx: Math.min(Math.round(s * cx), cx, size.width - cx), dy: Math.min(Math.round(s * cy), cy, size.height - cy) };
}

export const X31_quadOpen = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const { width, height } = size;
  const { cx, cy, dx, dy } = quadOpenCross(p, params.energy, size);
  const s = quadOpenShare(p, params.energy);
  const band = Math.round(BAND * frameUnit(size) * Math.min(1, s / GROW));
  // The quarters' inner edges: x = cx ∓ dx and y = cy ∓ dy. Each band is an L along a quarter's two inner edges.
  const left = cx - dx, right = cx + dx, top = cy - dy, bottom = cy + dy;
  let bands = "";
  if (band > 0) {
    for (const [x0, x1] of [[0, left], [right, width]] as const) {
      for (const [y0, y1] of [[0, top], [bottom, height]] as const) {
        if (!(x1 > x0) || !(y1 > y0)) continue;
        const bx = x0 === 0 ? x1 - band : x0, by = y0 === 0 ? y1 - band : y0;
        bands += rectPathD(Math.max(x0, bx), y0, Math.min(band, x1 - x0), y1 - y0, 0)
          + rectPathD(x0, Math.max(y0, by), x1 - x0, Math.min(band, y1 - y0), 0);
      }
    }
  }
  return {
    matte: matte.render(path(rectPathD(left, 0, right - left, height, 0) + rectPathD(0, top, width, bottom - top, 0), { fill: MATTE_SHOW_B })),
    overlay: createSvgDocument(size).render(path(bands, { fill: params.palette.accent2 })),
  };
}, { revision: REVISION });
