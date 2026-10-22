import { circlePathD, createSvgDocument, path, polygonPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B28 Orbit Shapes (ART_DIRECTION §10, base D): a set of concentric, tilted elliptical
 * orbits drawn as dotted cream lines on the dark card, as in the reference, with small
 * shapes travelling along them: accent squares that tumble as they go and a cream dot,
 * each orbit at its own speed and direction. The dots of the orbits are round and
 * spaced well apart (no fine dashes), so they hold up after compression.
 *
 * Loop: every shape goes round its orbit a whole number of times per cycle (1–2, either
 * way), and the squares turn whole quarter turns; one cycle per loop at speed 1
 * (backgroundLoop). density sets the orbit count. Energy scales the shapes; the seed
 * sets the speeds, directions and starting places.
 */

const ID = "B28";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B28_LOOP_SECONDS = 6;
/** Orbit cycles per loop at speed 1. */
export const B28_LOOP_CYCLES = 1;
/** Orbits at density 1; the outermost orbit's half width (× frame width) and every orbit's height/width ratio. */
const BASE_ORBITS = 4, OUTER = 0.47, FLATTEN = 0.3;
/** The system's tilt (degrees). */
const TILT = -9;
/** Orbit dots: radius and spacing along the orbit (authored px). */
const DOT = 4.6, DOT_SPACING = 34;
/** Square half size and dot radius (authored px) at standard energy. */
const SQUARE = 28, BALL = 21;

/** Point on an ellipse (half axes a, b) tilted by `tilt` radians about (cx, cy), at parameter angle θ. */
export function orbitPoint(cx: number, cy: number, a: number, b: number, tilt: number, theta: number): readonly [number, number] {
  const x = a * Math.cos(theta), y = b * Math.sin(theta);
  return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)];
}

export const B28_orbitShapes = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B28_LOOP_SECONDS, B28_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const grow = clamp(energyProfile(params.energy).amplitude, 0.8, 1.25);
  const rng = createSeededRng(ID, params.seed);
  const cx = size.width / 2, cy = size.height / 2, tilt = (TILT * Math.PI) / 180;
  const orbits = Math.max(2, Math.round(BASE_ORBITS * params.density));
  const dots: string[] = [], squares: string[] = [], balls: string[] = [];

  for (let index = 0; index < orbits; index += 1) {
    const orbit = rng.fork(index);
    // In portrait the system grows past the side edges and opens up, so it isn't a thin band across the middle.
    const a = OUTER * Math.max(size.width, 0.75 * size.height) * (0.34 + (0.66 * (index + 1)) / orbits);
    const b = a * FLATTEN * Math.sqrt(Math.max(1, size.height / size.width));
    // Round dots evenly spaced by arc length (approximately: the ellipse's Ramanujan perimeter).
    const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const count = Math.max(24, Math.round(perimeter / (DOT_SPACING * unit)));
    for (let step = 0; step < count; step += 1) {
      const [x, y] = orbitPoint(cx, cy, a, b, tilt, (step / count) * 2 * Math.PI);
      dots.push(circlePathD(x, y, DOT * unit, 1));
    }
    // One or two travellers per orbit, each a whole number of laps per cycle.
    const travellers = orbit.chance(0.5) ? 2 : 1;
    for (let traveller = 0; traveller < travellers; traveller += 1) {
      const laps = orbit.pick([-2, -1, 1, 2] as const), start = orbit.next();
      const [x, y] = orbitPoint(cx, cy, a, b, tilt, 2 * Math.PI * (laps * p + start));
      if (orbit.chance(0.7)) {
        const half = SQUARE * unit * grow * orbit.range(0.75, 1.15), turn = (Math.PI / 2) * (orbit.int(1, 2) * p * Math.sign(laps)) + start;
        squares.push(polygonPathD([0, 1, 2, 3].map(corner => {
          const angle = turn + Math.PI / 4 + (corner * Math.PI) / 2;
          return [x + Math.SQRT2 * half * Math.cos(angle), y + Math.SQRT2 * half * Math.sin(angle)] as const;
        }), 2));
      } else {
        balls.push(circlePathD(x, y, BALL * unit * grow, 2));
      }
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(dots.join(""), { fill: params.palette.paper }), path(squares.join(""), { fill: params.palette.accent }),
    path(balls.join(""), { fill: params.palette.paper }));
}, { revision: REVISION, loopSeconds: B28_LOOP_SECONDS, loopCycles: B28_LOOP_CYCLES });
