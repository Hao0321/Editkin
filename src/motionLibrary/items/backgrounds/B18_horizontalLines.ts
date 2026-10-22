import { createSvgDocument, path, rectPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase, sineInOut } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B18 Horizontal Lines (ART_DIRECTION §10, base A): yellow-and-black stripes, as in
 * the reference. On the accent card every row carries one horizontal stripe, ink or
 * the accent's deep shade, whose thickness pulses like an equalizer: rows beat at
 * one or two pulses per cycle, and their phases drift down the frame with a seeded
 * jitter, so the stripes swell and thin in a rolling, musical pattern. Crisp flat
 * bands, no blends.
 *
 * Loop: every row pulses a whole number of times per cycle (1 or 2, seeded); one
 * cycle per loop at speed 1 (backgroundLoop). density sets the row pitch. Energy
 * scales how far the stripes swell; the seed sets each row's beat, phase and colour.
 */

const ID = "B18";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B18_LOOP_SECONDS = 2;
/** Pulse cycles per loop at speed 1 (each row beats once or twice per cycle). */
export const B18_LOOP_CYCLES = 1;
/** Row pitch (authored px, 1080 short side). */
const BASE_ROW = 60;
/** Stripe thickness at its thinnest and fullest (× row pitch, standard energy). */
const MIN_STRIPE = 0.1, MAX_STRIPE = 0.7;
/** Phase drift down the frame (cycles per row) and per-row jitter (± cycles). */
const DRIFT = 0.055, JITTER = 0.12;
/** Share of rows in the deep shade (the rest in ink). */
const DEEP_SHARE = 0.3;

/** Stripe thickness 0..1 (of the swell range) for a row beating `beats` times per cycle at cycle phase `p` with phase `phi`. */
export function stripeLevel(p: number, beats: number, phi: number): number {
  const f = (((beats * p + phi) % 1) + 1) % 1;
  // Quick swell, slower fall, like an equalizer bar.
  return f < 0.3 ? sineInOut(f / 0.3) : 1 - sineInOut((f - 0.3) / 0.7);
}

export const B18_horizontalLines = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const pitch = (BASE_ROW * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B18_LOOP_SECONDS, B18_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const swell = (MAX_STRIPE - MIN_STRIPE) * clamp(energyProfile(params.energy).amplitude, 0.7, 1.15);
  const rng = createSeededRng(ID, params.seed);
  const cy = size.height / 2, rows = Math.ceil(cy / pitch) + 1;
  const ink: string[] = [], deep: string[] = [];

  for (let row = -rows; row <= rows; row += 1) {
    const rowRng = rng.fork(row);
    const beats = rowRng.chance(0.35) ? 2 : 1;
    const phi = row * DRIFT + rowRng.range(-JITTER, JITTER);
    const thickness = pitch * Math.min(0.92, MIN_STRIPE + swell * stripeLevel(p, beats, phi));
    const d = rectPathD(0, cy + row * pitch - thickness / 2, size.width, thickness, 2);
    (rowRng.chance(DEEP_SHARE) ? deep : ink).push(d);
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(path(deep.join(""), { fill: params.palette.accent2 }), path(ink.join(""), { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B18_LOOP_SECONDS, loopCycles: B18_LOOP_CYCLES });
