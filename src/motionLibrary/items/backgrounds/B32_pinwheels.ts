import { createSvgDocument, path, polygonPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B32 Pinwheels (ART_DIRECTION §10, base D): paper pinwheels of different sizes on the
 * dark card, as in the reference: four triangular blades each, alternating the accent
 * and cream, every pinwheel turning at its own speed and direction. They are scattered
 * with room between them, so the card stays open.
 *
 * Loop: a pinwheel looks the same after half a turn (its blades alternate two colours),
 * so each turns a whole number of half turns per cycle (1–3, either way); one cycle per
 * loop at speed 1 (backgroundLoop). density sets the pinwheel count. Energy scales the
 * size; the seed sets the places, sizes and speeds.
 */

const ID = "B32";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B32_LOOP_SECONDS = 6;
/** Turn cycles per loop at speed 1. */
export const B32_LOOP_CYCLES = 1;
/** Pinwheels per million px² at density 1 (about 12 in a 1080×1920 frame), and their radius range (authored px). */
const PER_MEGAPIXEL = 6, RADIUS = [60, 170];
/** Blade shape: the blade's outer corner sits at this radius (× R) and angle (radians) past the blade's leading edge. */
const CORNER = 0.72, SWEEP = 0.78;

/** Blade polygons of a pinwheel at (x, y) with radius R, turned `angle`: four triangles, alternately coloured. */
export function bladePoints(x: number, y: number, r: number, angle: number): Array<readonly (readonly [number, number])[]> {
  return [0, 1, 2, 3].map(blade => {
    const a = angle + (blade * Math.PI) / 2;
    return [[x, y], [x + r * Math.cos(a), y + r * Math.sin(a)], [x + CORNER * r * Math.cos(a + SWEEP), y + CORNER * r * Math.sin(a + SWEEP)]] as const;
  });
}

export const B32_pinwheels = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B32_LOOP_SECONDS, B32_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const grow = clamp(energyProfile(params.energy).amplitude, 0.85, 1.2);
  const rng = createSeededRng(ID, params.seed);
  const count = Math.max(3, Math.round(((size.width * size.height) / 1e6) * PER_MEGAPIXEL * params.density));
  const placed: Array<{ x: number; y: number; r: number }> = [];
  for (let attempt = 0; placed.length < count && attempt < count * 60; attempt += 1) {
    const r = rng.range(RADIUS[0], RADIUS[1]) * unit * grow / Math.sqrt(params.density);
    const x = rng.range(-0.04, 1.04) * size.width, y = rng.range(-0.04, 1.04) * size.height;
    if (placed.some(other => Math.hypot(other.x - x, other.y - y) < (other.r + r) * 1.15)) continue;
    placed.push({ x, y, r });
  }
  const accent: string[] = [], cream: string[] = [];
  placed.forEach((wheel, index) => {
    const spin = rng.fork(index);
    const halfTurns = spin.pick([-3, -2, -1, 1, 2, 3] as const), start = spin.range(0, Math.PI);
    bladePoints(wheel.x, wheel.y, wheel.r, start + halfTurns * Math.PI * p)
      .forEach((blade, b) => (b % 2 === 0 ? accent : cream).push(polygonPathD(blade, 1)));
  });

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(accent.join(""), { fill: params.palette.accent }), path(cream.join(""), { fill: params.palette.paper }));
}, { revision: REVISION, loopSeconds: B32_LOOP_SECONDS, loopCycles: B32_LOOP_CYCLES });
