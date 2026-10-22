import { createSvgDocument, emptySvg, path, polygonPathD, rect, rectPathD, type Point2 } from "../../svg/document";
import { clamp01, cubicInOut, quadIn, sineInOut, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineTransitionMotion, type MotionEnergy } from "../../types";
import { createMatteDocument, MATTE_SHOW_B } from "../shared";

/**
 * X11 Shutter Wipe: a six-blade camera aperture closes over A and opens on B. The
 * opening is a regular hexagon; each blade is the 60° wedge that starts at one
 * hexagon corner and runs out along the two sides meeting there (the classic
 * pinwheel iris), so the six blade seams sweep round as the iris turns 40° while
 * it closes. Blades alternate ink and the deep shade (accent2), the item's
 * two-tone, so they read as overlapping leaves.
 *
 * Timing: the hexagon starts just large enough to clear the frame corners and its
 * apothem shrinks almost linearly to a point over 0–47% (a big hexagon is mostly
 * off-frame, so an even shrink reads as an even close), the iris is shut over
 * 47–53% while the matte switches at exactly 50% under full cover (ART_DIRECTION
 * §4), and it opens over 53–100% as the exact reverse, turning back. Energy blends
 * the closure from softened (calm: half sine in-out) through even (punchy) to a
 * snapping close (hype: accelerating). The dark base is one path (the frame minus
 * the hexagon) with the lifted blades on top, so no seam of A or B shows between
 * blades. The seed sets the iris's resting angle and which way it turns. Not
 * directional.
 */

const ID = "X11";
/** Art revision (part of the clip cache key): 1 = first render (ink and lifted-ink blades); 2 = reference-palette pass: ink and accent2 (deep shade) blades. */
const REVISION = 2;
const SWITCH = 0.5;
const CLOSE_END = 0.47, OPEN_START = 0.53;
const BLADES = 6;
/** Iris rotation while it closes (degrees). */
const TURN = 40;

/** Closure 0 → 1 over the close window (the opening plays it backwards). */
const CLOSURE: Record<MotionEnergy, EasingFunction> = {
  calm: p => 0.5 * clamp01(p) + 0.5 * sineInOut(p),
  standard: p => 0.75 * clamp01(p) + 0.25 * cubicInOut(p),
  punchy: p => clamp01(p),
  hype: p => 0.6 * clamp01(p) + 0.4 * quadIn(p),
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export const X11_shutterWipe = defineTransitionMotion(ID, (params, t, size) => {
  const p = clamp01(t / params.durationSeconds);
  const matte = createMatteDocument(size);
  const allB = () => matte.render(rect(0, 0, size.width, size.height, { fill: MATTE_SHOW_B }));
  if (p <= 0) return { matte: matte.render(), overlay: emptySvg(size) };
  if (p >= 1) return { matte: allB(), overlay: emptySvg(size) };

  const curve = CLOSURE[params.energy];
  // Closure 0 (open, hexagon clears the corners) … 1 (shut); the opening is the close played backwards.
  const closure = p < SWITCH ? curve(p / CLOSE_END) : curve(1 - (p - OPEN_START) / (1 - OPEN_START));
  const { width, height } = size;
  const cx = width / 2, cy = height / 2, diagonal = Math.hypot(width, height);
  // Circumradius whose apothem (R cos 30°) just clears the frame corners (+2 px).
  const open = (diagonal / 2 + 2) / Math.cos(toRadians(30));
  const rng = createSeededRng(ID, params.seed, "iris");
  const rest = rng.range(0, 60), spin = rng.sign() * TURN;
  const radius = open * (1 - closure), turn = rest + spin * closure;
  const corner = (k: number): Point2 => [cx + radius * Math.cos(toRadians(turn + 60 * k)), cy + radius * Math.sin(toRadians(turn + 60 * k))];
  const reach = 3 * diagonal;
  const along = (from: Point2, degrees: number): Point2 => [from[0] + reach * Math.cos(toRadians(degrees)), from[1] + reach * Math.sin(toRadians(degrees))];

  let lifted = "";
  for (let k = 1; k < BLADES; k += 2) {
    // Blade k: the wedge at corner k between the continuations of the sides k−1 and k (60° apart).
    const apex = corner(k), side = turn + 60 * k + 120;
    lifted += polygonPathD([apex, along(apex, side - 60), along(apex, side)], 2);
  }
  const hexagon = polygonPathD(Array.from({ length: BLADES }, (_, k) => corner(k)), 2);
  const base = rectPathD(-2, -2, width + 4, height + 4, 2) + (radius > 0.01 ? hexagon : "");
  return {
    matte: p < SWITCH ? matte.render() : allB(),
    overlay: createSvgDocument(size).render(
      path(base, { fill: params.palette.ink, "fill-rule": "evenodd" }),
      path(lifted, { fill: params.palette.accent2 }),
    ),
  };
}, { revision: REVISION });
