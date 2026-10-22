import { createSvgDocument, path, polygonPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B19 Line Burst (ART_DIRECTION §10, base C): manga focus lines on the cream card,
 * as in the reference. Tapered strokes in ink and the accent's deep shade shoot out
 * of a calm centre toward the frame edges, accelerating as they go: each ray carries
 * one or two streaks that start as a point at the inner circle, stretch to full
 * length, and fly off the frame. Their lengths, speeds and angles are seeded, so the
 * burst feels like an impact, while the open centre holds a title.
 *
 * Loop: each streak flies out a whole number of times per cycle (1 or 2, seeded);
 * one cycle per loop at speed 1 (backgroundLoop). density sets the ray count.
 * Energy scales the stroke weight; the seed sets the rays.
 */

const ID = "B19";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B19_LOOP_SECONDS = 2;
/** Flight cycles per loop at speed 1 (each streak flies out once or twice per cycle). */
export const B19_LOOP_CYCLES = 1;
/** Rays at density 1. */
const BASE_RAYS = 84;
/** Clear centre (× short side) and streak length range (× the distance to the farthest corner). */
const CLEAR = 0.17, SHORT = 0.06, LONG = 0.2;
/** Stroke width at the outer end (authored px) and at the inner end (× outer). */
const WIDTH_MIN = 3, WIDTH_MAX = 9, TAPER = 0.15;
/** Flight acceleration: radius ∝ f^ACCEL. Share of streaks in the deep shade. */
const ACCEL = 1.6, DEEP_SHARE = 0.3;

/** Inner radius and length of a streak at flight phase f ∈ [0, 1) (it grows out of a point, then flies off). */
export function streakAt(f: number, clear: number, reach: number, length: number): { inner: number; length: number } {
  const grown = length * smoothstep(0, 0.18, f);
  return { inner: clear + (reach + length - clear) * f ** ACCEL, length: grown };
}

export const B19_lineBurst = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B19_LOOP_SECONDS, B19_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const weight = clamp(energyProfile(params.energy).amplitude, 0.75, 1.3);
  const rng = createSeededRng(ID, params.seed);
  const cx = size.width / 2, cy = size.height / 2;
  const reach = Math.hypot(cx, cy);
  const clear = CLEAR * Math.min(size.width, size.height);
  const rays = Math.round(BASE_RAYS * params.density);
  const ink: string[] = [], deep: string[] = [];

  for (let ray = 0; ray < rays; ray += 1) {
    const rayRng = rng.fork(ray);
    const angle = ((ray + rayRng.range(-0.4, 0.4)) / rays) * 2 * Math.PI;
    const ca = Math.cos(angle), sa = Math.sin(angle), na = -sa, nb = ca;
    const k = rayRng.chance(0.4) ? 2 : 1, offset = rayRng.next();
    const streaks = rayRng.chance(0.35) ? 2 : 1;
    for (let streak = 0; streak < streaks; streak += 1) {
      // Draw every random value first, so a streak that is skipped never shifts the next one's values.
      const fullLength = (SHORT + (LONG - SHORT) * rayRng.next()) * reach;
      const width = (WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * rayRng.next()) * unit * weight;
      const target = rayRng.chance(DEEP_SHARE) ? deep : ink;
      const f = (((k * p + offset + streak * 0.5) % 1) + 1) % 1;
      const { inner, length } = streakAt(f, clear, reach, fullLength);
      // Not yet grown, or already past the farthest corner: nothing to draw (on both sides of the wrap).
      if (length < 0.5 || inner >= reach) continue;
      const outer = inner + length, wo = width / 2, wi = (width * TAPER) / 2;
      const d = polygonPathD([
        [cx + ca * inner + na * wi, cy + sa * inner + nb * wi],
        [cx + ca * outer + na * wo, cy + sa * outer + nb * wo],
        [cx + ca * outer - na * wo, cy + sa * outer - nb * wo],
        [cx + ca * inner - na * wi, cy + sa * inner - nb * wi],
      ], 2);
      target.push(d);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(path(deep.join(""), { fill: params.palette.accent2 }), path(ink.join(""), { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B19_LOOP_SECONDS, loopCycles: B19_LOOP_CYCLES });
