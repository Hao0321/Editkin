import { createSvgDocument, path, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B23 Line Tunnel (ART_DIRECTION §10, base C): a tunnel of nested outline
 * rectangles on the cream card, as in the reference: frame-shaped outlines, ink and
 * the accent's deep shade in turn, crowd toward a vanishing point at the centre and
 * stream toward the camera, thickening as they come and sliding off the frame edges.
 * Each outline's tilt depends on its depth, so the tunnel twists gently as the
 * frames travel through it.
 *
 * Self-similar by construction: outline k sits at scale Z^(k − f), its tilt and
 * weight are functions of that scale only, and f advances two whole steps per cycle
 * (two, so the ink / deep-shade alternation lines up), one cycle per loop at speed 1
 * (backgroundLoop). density sets the zoom step (more outlines). Energy scales the
 * line weight; the seed sets the twist direction and where in the zoom the loop starts.
 */

const ID = "B23";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B23_LOOP_SECONDS = 2;
/** Zoom cycles per loop at speed 1 (each cycle moves the tunnel two outline steps). */
export const B23_LOOP_CYCLES = 1;
/** Zoom per outline step at density 1, and the scale range drawn (1 = the frame's own edges). */
const BASE_STEP = 1.3, MIN_SCALE = 0.035, MAX_SCALE = 1.55;
/** Line width at scale 1 (authored px) and its perspective falloff (width ∝ scale^FALLOFF). */
const WIDTH = 10, FALLOFF = 0.85;
/** Tilt per outline step (degrees). */
const TWIST = 1.4;

/** Scale of outline k at tunnel phase f (in steps), for zoom step z. */
export function outlineScale(k: number, f: number, z: number): number {
  return z ** (k - f);
}

export const B23_lineTunnel = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const z = BASE_STEP ** (1 / params.density);
  const { loopSeconds, cycles } = backgroundLoop(B23_LOOP_SECONDS, B23_LOOP_CYCLES, params.speed);
  const rng = createSeededRng(ID, params.seed);
  const twist = rng.sign() * TWIST;
  // Tunnel phase in steps: two whole steps per cycle, plus a seeded start (0–2 steps).
  const f = 2 * cycles * loopPhase(t, loopSeconds) + 2 * rng.next();
  const weight = clamp(energyProfile(params.energy).amplitude, 0.75, 1.25);
  const cx = size.width / 2, cy = size.height / 2;
  const logZ = Math.log(z);
  const first = Math.ceil(f + Math.log(MIN_SCALE) / logZ), last = Math.floor(f + Math.log(MAX_SCALE) / logZ);
  const parts: string[] = [];

  for (let k = first; k <= last; k += 1) {
    const s = outlineScale(k, f, z);
    // Tilt is a function of the scale alone (self-similar): it turns as the outline travels.
    const angle = ((twist * Math.log(s)) / logZ) * (Math.PI / 180), ca = Math.cos(angle), sa = Math.sin(angle);
    const hw = (size.width / 2) * s, hh = (size.height / 2) * s;
    const corners: Point2[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
    const width = WIDTH * unit * weight * s ** FALLOFF;
    // Even outlines in ink, odd in the deep shade (k mod 2 is stable: f moves by whole pairs per cycle).
    const colour = ((k % 2) + 2) % 2 === 0 ? params.palette.ink : params.palette.accent2;
    parts.push(path(polygonPathD(corners, 2), { fill: "none", stroke: colour, "stroke-width": Number(width.toFixed(3)), "stroke-linejoin": "miter" }));
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(parts);
}, { revision: REVISION, loopSeconds: B23_LOOP_SECONDS, loopCycles: B23_LOOP_CYCLES });
