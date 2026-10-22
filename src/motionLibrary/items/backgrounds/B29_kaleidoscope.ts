import { circlePathD, createSvgDocument, path, polygonPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B29 Kaleidoscope (ART_DIRECTION §10, base D): a burst of long triangles on the dark
 * card, mirrored eight ways like a kaleidoscope, as in the reference. In each 45°
 * sector a cream triangle and its mirror image in the accent lean toward and away from
 * the sector's mirror line, and each carries an ink dot that slides along it, so the
 * figure opens and closes like a flower while the whole kaleidoscope slowly turns.
 *
 * Loop: the whole figure turns one sector (45°, which maps it onto itself) per cycle and
 * the triangles breathe once per cycle; one cycle per loop at speed 1 (backgroundLoop).
 * density sets the number of triangle pairs per sector (1 or 2). Energy scales the
 * breathing (capped so neighbouring triangles never leave a hairline sliver) and the
 * dots; the seed sets the turn direction and the phases.
 */

const ID = "B29";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B29_LOOP_SECONDS = 8;
/** Turn cycles per loop at speed 1 (one 45° sector per cycle). */
export const B29_LOOP_CYCLES = 1;
/** Symmetry order and the figure's reach (× half the frame diagonal). */
const ORDER = 8, REACH = 1.02;
/** A triangle's half width at its base (radians), and how far its axis leans off the mirror line (radians, mean ± swing). */
const HALF_WIDTH = 0.11, LEAN = 0.2, SWING = 0.05;
/** Ink dot radius (× reach) and its travel along the triangle (fractions of the reach). */
const DOT = 0.034, DOT_FROM = 0.42, DOT_TO = 0.72;

/** Lean (radians) of the cream triangle off its sector's mirror line at cycle phase p (the accent one mirrors it). */
export function leanAt(p: number, phase: number, swing: number): number {
  return LEAN + swing * Math.sin(2 * Math.PI * (p + phase));
}

export const B29_kaleidoscope = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B29_LOOP_SECONDS, B29_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  // Capped so neighbouring triangles never come within ~0.065 rad of each other: no hairline slivers (H.264-safe).
  const amplitude = energyProfile(params.energy).amplitude;
  const swing = SWING * clamp(amplitude, 0.6, 1);
  const dotScale = clamp(amplitude, 0.8, 1.25);
  const rng = createSeededRng(ID, params.seed);
  const direction = rng.sign(), phase = rng.next();
  const cx = size.width / 2, cy = size.height / 2;
  const reach = (REACH * Math.hypot(size.width, size.height)) / 2;
  const sector = (2 * Math.PI) / ORDER;
  const rotation = direction * sector * p + rng.next() * sector;
  const pairs = params.density >= 1.5 ? 2 : 1;
  const cream: string[] = [], accent: string[] = [], dots: string[] = [];

  for (let s = 0; s < ORDER; s += 1) {
    const axis = rotation + s * sector;
    for (let pair = 0; pair < pairs; pair += 1) {
      const lean = leanAt(p, phase + pair * 0.37, swing) * (pair ? 0.45 : 1);
      const length = reach * (pair ? 0.62 : 1), width = HALF_WIDTH * (pair ? 1.3 : 1);
      for (const side of [1, -1] as const) {
        // The triangle: apex at the centre, base at `length`, its axis at the mirror line ± lean.
        const a = axis + side * lean;
        const tri = polygonPathD([[cx, cy], [cx + length * Math.cos(a - width), cy + length * Math.sin(a - width)],
          [cx + length * Math.cos(a + width), cy + length * Math.sin(a + width)]], 1);
        (side > 0 ? cream : accent).push(tri);
        // The dot slides out and back along the triangle once per cycle (mirrored on the other side).
        const along = length * (DOT_FROM + (DOT_TO - DOT_FROM) * (0.5 - 0.5 * Math.cos(2 * Math.PI * (p + phase + pair * 0.5))));
        dots.push(circlePathD(cx + along * Math.cos(a), cy + along * Math.sin(a), DOT * reach * dotScale * (pair ? 0.7 : 1) * (along / length + 0.35), 1));
      }
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(accent.join(""), { fill: params.palette.accent }), path(cream.join(""), { fill: params.palette.paper }),
    path(dots.join(""), { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B29_LOOP_SECONDS, loopCycles: B29_LOOP_CYCLES });
