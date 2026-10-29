import { mostContrasting } from "../../svg/color";
import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B05 Spiral Dots (ART_DIRECTION §10, base D): a golden-angle phyllotaxis disc (dot
 * n at angle n · 137.5°, radius c·√n) in the middle of the dark card, as in the
 * reference: the disc spans the frame's short side and leaves open card above and
 * below it in portrait (beside it in landscape) for a title. Even dots are the
 * accent and odd dots crisp cream, so the sunflower spirals (parastichies) read in
 * two colours. Dots are small in the eye and grow toward the rim, where they taper
 * away inside the disc's edge.
 *
 * Motion without breaking the loop: phyllotaxis has no rotational symmetry, so a
 * plain rotation could only loop after 360°. Instead every dot slides outward
 * along its 34-arm to the place of the dot 34·m positions further out, which turns
 * the whole pattern by m × −4.74° (34 × 137.5° = 13 turns − 4.74°) while new dots
 * grow out of the eye and the oldest taper away at the rim. After one loop every
 * dot sits where a dot of the same colour sat (34·m is even), so frame N equals
 * frame 0: a slow spiralling drift.
 *
 * m is 2 arm steps per loop at speed 1; other speeds scale the drift and stretch the
 * loop by 1, 2 or 4 so m stays whole (backgroundLoop). density sets the radial
 * scale c. Energy scales the dot size; the seed turns the pattern.
 */

const ID = "B05";
/**
 * Art revision: 1 = accent and deep-shade arms over the whole frame; 2 = §10 reference recreation (accent and cream
 * disc); 3 = the disc spans the short side and its dots are bolder.
 */
const REVISION = 3;
export const B05_LOOP_SECONDS = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** The spiral family the dots flow along (even, so the even/odd colours survive the shift). */
const FAMILY = 34;
/** Arm steps per loop at speed 1 (each turns the pattern by −4.74°). */
export const B05_LOOP_CYCLES = 2;
/** Disc radius as a fraction of the frame's short side (the disc spans it, as in the reference). */
const DISC = 0.5;
/** Radial scale c as a fraction of the disc radius (dot n sits at c·√n): about 300 dots fill the disc. */
const SCALE = 1 / 17.5;
/** Dot radius in units of c: small in the eye, full size toward the rim; cream dots are drawn a little smaller. */
const EYE_DOT = 0.16, RIM_DOT = 0.48, CREAM_SIZE = 0.82;
/** The rim taper: dots shrink away between RIM_FADE and 1 of the disc radius. */
const RIM_FADE = 0.86;

/** Rotation of the whole pattern after `steps` dots of index shift, reduced to (−π, π]. */
export function phyllotaxisTurn(steps: number): number {
  const angle = steps * GOLDEN_ANGLE;
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

export const B05_spiralDots = defineBackgroundMotion(ID, (params, t, size) => {
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.8, 1.15);
  const disc = DISC * Math.min(size.width, size.height);
  const scale = (disc * SCALE) / Math.sqrt(params.density);
  const { loopSeconds, cycles } = backgroundLoop(B05_LOOP_SECONDS, B05_LOOP_CYCLES, params.speed);
  const steps = FAMILY * cycles;
  const turn = phyllotaxisTurn(steps);
  const f = loopPhase(t, loopSeconds);
  const shift = steps * f;
  const rotation = createSeededRng(ID, params.seed).next() * 2 * Math.PI + f * turn;
  const cx = size.width / 2, cy = size.height / 2;
  const last = (disc / scale) ** 2;
  const cream = mostContrasting(params.palette.bg, [params.palette.paper, params.palette.ink]);
  let accentD = "", creamD = "";

  for (let index = Math.ceil(-shift); index <= Math.floor(last - shift); index += 1) {
    const n = index + shift;
    if (n <= 0) continue;
    const r = scale * Math.sqrt(n);
    const grow = smoothstep(0.05 * disc, 0.8 * disc, r), rim = 1 - smoothstep(RIM_FADE * disc, disc, r);
    const dotRadius = scale * amplitude * (EYE_DOT + (RIM_DOT - EYE_DOT) * grow) * rim * smoothstep(0, 2.5 * scale, r);
    if (dotRadius < 0.3) continue;
    const angle = index * GOLDEN_ANGLE + rotation;
    const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
    // index and its shifted place differ by 34·m (even), so a dot keeps its colour through the loop.
    if ((index & 1) === 0) accentD += circlePathD(x, y, dotRadius, 1);
    else creamD += circlePathD(x, y, dotRadius * CREAM_SIZE, 1);
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(creamD, { fill: cream }), path(accentD, { fill: params.palette.accent }));
}, { revision: REVISION, loopSeconds: B05_LOOP_SECONDS, loopCycles: B05_LOOP_CYCLES });
