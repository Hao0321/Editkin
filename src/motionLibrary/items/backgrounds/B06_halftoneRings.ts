import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B06 Halftone Rings (ART_DIRECTION §10, base A): concentric rings of evenly spaced
 * dots on the accent card, alternating ink and cream, with neighbouring rings
 * turning in opposite directions like a set of gears. As in the reference, the
 * rings are ellipses that lean toward the frame's shape (wide in landscape, tall in
 * portrait; the ratio is (width / height)^0.6), so the rings fill the frame
 * evenly; the dots sit at equal arc length along each ring.
 *
 * Loop: a ring of n dots looks the same after any whole number of dot steps, so
 * every ring turns by a whole number of steps per loop: about the same linear speed
 * on every ring, a little faster outward, at least one step. Other speeds scale
 * every ring's rate alike and stretch the loop by 1, 2 or 4 so each ring still
 * turns whole steps (backgroundLoop); density sets the ring spacing and the dot spacing
 * along each ring. Energy scales the dot size; the seed picks which way the first
 * ring turns and where each ring's dots start.
 */

const ID = "B06";
/** Art revision: 1 = accent and deep-shade rings on dark; 2 = §10 reference recreation (ink and cream elliptical rings on the accent card). */
const REVISION = 2;
export const B06_LOOP_SECONDS = 6;
/** Loop cycles at speed 1: each ring turns its own whole number of steps per cycle (ringSteps). */
export const B06_LOOP_CYCLES = 1;
/** Authored px (1080 short side) between rings (along the ring "radius"), and the dot spacing along a ring (× ring spacing). */
const BASE_SPACING = 66, DOT_SPACING = 0.78;
/** Dot radius (× ring spacing). */
const DOT = 0.2;
/** Dot steps per loop on a ring at the reference radius; scaled by √(radius / reference). */
const BASE_STEPS = 3, REFERENCE_RADIUS = 420;
/** Ellipse aspect (major / minor along x / y) = (width / height)^ASPECT_POWER. */
const ASPECT_POWER = 0.6;
const TABLE_STEPS = 720;

/** Arc-length tables of the unit-area ellipse x = √A·cos θ, y = sin θ / √A, by aspect A (cached). */
const tables = new Map<string, { perimeter: number; theta: Float64Array }>();
function ellipseTable(aspect: number): { perimeter: number; theta: Float64Array } {
  const key = aspect.toFixed(6);
  const cached = tables.get(key);
  if (cached) return cached;
  const a = Math.sqrt(aspect), b = 1 / Math.sqrt(aspect);
  // Cumulative length at TABLE_STEPS equal angle steps (midpoint rule), then inverted to equal-length steps.
  const lengths = new Float64Array(TABLE_STEPS + 1);
  for (let step = 1; step <= TABLE_STEPS; step += 1) {
    const mid = ((step - 0.5) / TABLE_STEPS) * 2 * Math.PI;
    lengths[step] = lengths[step - 1] + Math.hypot(a * Math.sin(mid), b * Math.cos(mid)) * ((2 * Math.PI) / TABLE_STEPS);
  }
  const perimeter = lengths[TABLE_STEPS];
  const theta = new Float64Array(TABLE_STEPS + 1);
  let cursor = 0;
  for (let step = 0; step <= TABLE_STEPS; step += 1) {
    const target = (step / TABLE_STEPS) * perimeter;
    while (cursor < TABLE_STEPS - 1 && lengths[cursor + 1] < target) cursor += 1;
    const span = lengths[cursor + 1] - lengths[cursor];
    const fraction = span > 0 ? (target - lengths[cursor]) / span : 0;
    theta[step] = ((cursor + Math.min(1, Math.max(0, fraction))) / TABLE_STEPS) * 2 * Math.PI;
  }
  const table = { perimeter, theta };
  tables.set(key, table);
  return table;
}

/** Angle θ of the point at arc-length fraction s (any real; wrapped) on the table's ellipse. */
function thetaAt(table: { theta: Float64Array }, s: number): number {
  const wrapped = s - Math.floor(s);
  const position = wrapped * TABLE_STEPS, index = Math.floor(position), fraction = position - index;
  return table.theta[index] + (table.theta[Math.min(TABLE_STEPS, index + 1)] - table.theta[index]) * fraction;
}

/** Whole dot steps ring `ring` turns per loop of `cycles` cycles (signed: odd rings one way, even rings the other). */
export function ringSteps(ring: number, radius: number, unit: number, cycles: number, firstDirection: 1 | -1): number {
  const steps = Math.max(1, Math.round(BASE_STEPS * Math.sqrt(radius / (REFERENCE_RADIUS * unit)))) * cycles;
  return (ring % 2 === 1 ? firstDirection : -firstDirection) * steps;
}

export const B06_halftoneRings = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.75, 1.2);
  const spacing = (BASE_SPACING * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B06_LOOP_SECONDS, B06_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const firstDirection: 1 | -1 = rng.chance(0.5) ? 1 : -1;
  const aspect = (size.width / size.height) ** ASPECT_POWER;
  const table = ellipseTable(aspect);
  const ax = Math.sqrt(aspect), by = 1 / Math.sqrt(aspect);
  const cx = size.width / 2, cy = size.height / 2;
  const reach = Math.max(cx / ax, cy / by) * Math.SQRT2;
  const dotRadius = spacing * DOT * amplitude;
  let inkD = "", creamD = "";

  for (let ring = 1; ring * spacing <= reach + spacing; ring += 1) {
    const radius = ring * spacing;
    const count = Math.max(6, Math.round((table.perimeter * radius) / (spacing * DOT_SPACING)));
    const turn = (ringSteps(ring, radius, unit, cycles, firstDirection) * u + rng.next()) / count;
    let d = "";
    for (let index = 0; index < count; index += 1) {
      const theta = thetaAt(table, index / count + turn);
      const x = cx + radius * ax * Math.cos(theta), y = cy + radius * by * Math.sin(theta);
      if (x < -dotRadius || x > size.width + dotRadius || y < -dotRadius || y > size.height + dotRadius) continue;
      d += circlePathD(x, y, dotRadius, 1);
    }
    if (ring % 2 === 1) inkD += d;
    else creamD += d;
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(path(creamD, { fill: params.palette.paper }), path(inkD, { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B06_LOOP_SECONDS, loopCycles: B06_LOOP_CYCLES });
