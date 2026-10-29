import { createSvgDocument, emptySvg, path, rect, rectPathD } from "../../svg/document";
import { clamp01, cubicInOut, expoInOut, quartInOut, sineInOut, type EasingFunction } from "../../svg/easing";
import { defineTransitionMotion, type MotionEnergy, type MotionFrameSize } from "../../types";
import { createMatteDocument, frameUnit, MATTE_SHOW_B } from "../shared";

/**
 * X39 Panel Zoom Out: nested panels, rectangles with the frame's own proportions, expand out from
 * the centre one inside the other: three flat rings in alternating tones (deep shade, accent,
 * deep shade from the inside out, so B always arrives inside a deep frame) and, last, B
 * itself, so B arrives as the innermost panel and expands until it fills the frame.
 *
 * Timing: B's panel is scaled by s = √ease(t / D) of the frame, so it covers s² = ease(t / D)
 * of the frame: exactly half at D/2 (ART_DIRECTION §4), and only growing. Ring k leads B by
 * k · 0.09 · sin(π t / D) of the progress (zero at both ends: pure A at t = 0, pure B at t = D;
 * 3 · 0.09 · π < 1 keeps every edge monotonic). All panels share the frame's aspect, so each
 * reaches the frame's four edges at once. Energy sets the curve (calm sine … hype expo in-out).
 * Each ring reaches 1.5 px (at 1080) under the panel inside it (and the innermost ring under B's
 * matte edge), so no seam opens. Not directional; the seed does not change it.
 */

const ID = "X39";
/** Art revision (part of the clip cache key): 1 = first render (seeded ring order put an accent ring against B, merging with it); 2 = fixed deep, accent, deep ring order, so B always arrives inside a deep frame. */
const REVISION = 2;
const RINGS = 3, LEAD = 0.09;
const TUCK = 1.5;

const EASE: Record<MotionEnergy, EasingFunction> = {
  calm: sineInOut,
  standard: cubicInOut,
  punchy: quartInOut,
  hype: expoInOut,
};

/** Palette roles of the rings, innermost first: deep, accent, deep. */
export const PANEL_ZOOM_TONES: readonly ("accent" | "accent2")[] = Object.freeze(["accent2", "accent", "accent2"]);

/** Scale (0 … 1 of the frame) of panel k at progress p: k = 0 is B, k = 1 … RINGS the rings outward. */
export function panelZoomScale(panel: number, p: number, energy: MotionEnergy): number {
  return Math.sqrt(EASE[energy](clamp01(p + panel * LEAD * Math.sin(Math.PI * clamp01(p)))));
}

/** The centred rectangle at scale s, grown by `grow` px on every side, as path data. */
function panelRect(s: number, grow: number, size: MotionFrameSize): string {
  const w = s * size.width + 2 * grow, h = s * size.height + 2 * grow;
  return rectPathD((size.width - w) / 2, (size.height - h) / 2, w, h, 2);
}

export const X39_panelZoomOut = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const tones = PANEL_ZOOM_TONES, tuck = TUCK * frameUnit(size);
  const scales = Array.from({ length: RINGS + 1 }, (_, panel) => panelZoomScale(panel, p, params.energy));
  const parts: string[] = [];
  // Outermost ring first, so each ring sits over the one outside it.
  for (let ring = RINGS; ring >= 1; ring -= 1) {
    const outer = scales[ring], inner = scales[ring - 1];
    if (!(outer > inner) || !(outer > 0)) continue;
    const innerGrow = -tuck;
    const hole = inner > 0 && inner * Math.min(size.width, size.height) > 2 * tuck ? panelRect(inner, innerGrow, size) : "";
    parts.push(path(panelRect(outer, 0, size) + hole, { fill: params.palette[tones[ring - 1]], "fill-rule": "evenodd" }));
  }
  return {
    matte: matte.render(scales[0] > 0 ? path(panelRect(scales[0], 0, size), { fill: MATTE_SHOW_B }) : ""),
    overlay: createSvgDocument(size).render(parts),
  };
}, { revision: REVISION });
