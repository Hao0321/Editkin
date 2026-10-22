import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { backIn, clamp, energyProfile, loopPhase, smoothstep, spring } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B25 Circle Pop (ART_DIRECTION §10, base D): flat circles pop onto the dark card one
 * after another, as in the reference: each springs from nothing to a little over its
 * size and settles (0 → 1.1 → 1), holds, then shrinks away. They come in the accent,
 * cream and the accent's deep shade, in a spread of sizes, and the newest is always on
 * top, so overlapping circles stack crisply (no transparency).
 *
 * Loop: every circle pops once per cycle at its own seeded phase, evenly staggered; the
 * spring runs on cycle phase, so speed is an exact rate. One cycle per loop at speed 1
 * (backgroundLoop). density sets the circle count. Energy sets the spring's overshoot;
 * the seed sets the places, sizes, colours and order.
 */

const ID = "B25";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B25_LOOP_SECONDS = 4;
/** Pop cycles per loop at speed 1. */
export const B25_LOOP_CYCLES = 1;
/** Circles per million px² of frame at density 1 (about 15 in a 1080×1920 frame). */
const PER_MEGAPIXEL = 7;
/** Radius range (authored px, 1080 short side). */
const SMALL = 70, LARGE = 230;
/** A circle's life (fractions of a cycle): spring in from 0, shrink out between SHRINK and GONE. */
const SHRINK = 0.72, GONE = 0.84;
/** Seconds of spring per cycle (the spring runs on cycle phase). */
const SPRING_SECONDS = 4;
/** Colour shares: accent, then cream, then deep shade. */
const ACCENT_SHARE = 0.5, CREAM_SHARE = 0.3;

/** Scale 0..~1.1 of a circle at life phase φ ∈ [0, 1) (0 = just appearing), for a spring damping. */
export function popScale(phase: number, damping: number): number {
  if (phase >= GONE) return 0;
  const grown = spring(phase * SPRING_SECONDS, 170, damping);
  return phase < SHRINK ? grown : grown * (1 - backIn(smoothstep(SHRINK, GONE, phase), 1.2));
}

export const B25_circlePop = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B25_LOOP_SECONDS, B25_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  // Lower damping = more overshoot: about 1.1 at standard energy.
  const damping = 14 / clamp(energyProfile(params.energy).amplitude, 0.7, 1.4);
  const rng = createSeededRng(ID, params.seed);
  const count = Math.max(4, Math.round(((size.width * size.height) / 1e6) * PER_MEGAPIXEL * params.density));
  const circles = Array.from({ length: count }, (_, index) => {
    const circle = rng.fork(index);
    const r = (SMALL + (LARGE - SMALL) * circle.next() ** 1.6) * unit / Math.sqrt(params.density);
    const pick = circle.next();
    const colour = pick < ACCENT_SHARE ? params.palette.accent : pick < ACCENT_SHARE + CREAM_SHARE ? params.palette.paper : params.palette.accent2;
    return { x: circle.range(-0.05, 1.05) * size.width, y: circle.range(-0.05, 1.05) * size.height, r, colour, start: (index + circle.range(0, 0.5)) / count };
  });

  // Oldest first, so the newest circle is drawn on top; one <path> per circle keeps the stacking order exact.
  const live = circles.map(circle => ({ ...circle, life: p - circle.start - Math.floor(p - circle.start) }))
    .filter(circle => popScale(circle.life, damping) > 0.002)
    .sort((a, b) => b.life - a.life);
  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(live.map(circle => path(circlePathD(circle.x, circle.y, circle.r * popScale(circle.life, damping), 1), { fill: circle.colour })));
}, { revision: REVISION, loopSeconds: B25_LOOP_SECONDS, loopCycles: B25_LOOP_CYCLES });
