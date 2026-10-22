import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B21 Ripple Rings (ART_DIRECTION §10, base D): ripples spread from two centres on
 * the dark card, as in the reference: cream rings from one, accent rings from the
 * other. Each ring leaves its centre as a bold outline and thins out as it grows, so
 * it fades without any transparency, and the two families cross into a calm
 * interference pattern. The centres sit on a diagonal, leaving open card between
 * them for a title.
 *
 * Loop: the cream ripple emits two rings per cycle and the accent ripple three, so
 * the overlap keeps changing; every ring moves by whole ring spacings per cycle, one
 * cycle per loop at speed 1 (backgroundLoop). density sets the ring spacing. Energy
 * scales the line weight; the seed nudges the centres.
 */

const ID = "B21";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B21_LOOP_SECONDS = 4;
/** Cycles per loop at speed 1 (the cream ripple emits two rings per cycle, the accent ripple three). */
export const B21_LOOP_CYCLES = 1;
/** Ring spacing (authored px, 1080 short side) and outline width at the centre (authored px). */
const BASE_SPACING = 120, BASE_WIDTH = 4.6;
/** Rings thin out with radius: width = base × (1 − r / reach)^FADE. */
const FADE = 0.9;
/** The two centres (fractions of the frame), and how far the seed may nudge them. */
const CENTRES = [{ x: 0.3, y: 0.36, rings: 2 }, { x: 0.7, y: 0.64, rings: 3 }] as const;
const NUDGE = 0.04;

/** Outline width of a ring of radius r (px) with a fade-out reach, for a base width. */
export function ringWidth(r: number, reach: number, base: number): number {
  return r >= reach ? 0 : base * (1 - r / reach) ** FADE;
}

export const B21_rippleRings = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const spacing = (BASE_SPACING * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B21_LOOP_SECONDS, B21_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const base = BASE_WIDTH * unit * clamp(energyProfile(params.energy).amplitude, 0.75, 1.25);
  const rng = createSeededRng(ID, params.seed);
  const parts: string[] = [];

  CENTRES.forEach((centre, index) => {
    const x = (centre.x + rng.range(-NUDGE, NUDGE)) * size.width, y = (centre.y + rng.range(-NUDGE, NUDGE)) * size.height;
    // Fade out by the farthest corner from this centre.
    const reach = Math.max(Math.hypot(x, y), Math.hypot(size.width - x, y), Math.hypot(x, size.height - y), Math.hypot(size.width - x, size.height - y));
    // Rings sit at (n + f) spacings; f advances `rings` whole spacings per cycle.
    const f = centre.rings * p - Math.floor(centre.rings * p);
    const colour = index === 0 ? params.palette.paper : params.palette.accent;
    // One <path> per ring: each ring has its own outline width.
    for (let n = 0; (n + f) * spacing < reach; n += 1) {
      const r = (n + f) * spacing, width = ringWidth(r, reach, base);
      if (width < 0.4 * unit) break;
      parts.push(path(circlePathD(x, y, r, 1), { fill: "none", stroke: colour, "stroke-width": Number(width.toFixed(2)) }));
    }
  });

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(parts);
}, { revision: REVISION, loopSeconds: B21_LOOP_SECONDS, loopCycles: B21_LOOP_CYCLES });
