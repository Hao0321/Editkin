import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B31 Blob Shapes (ART_DIRECTION §10, base C): soft, rounded blobs drift and morph on the
 * cream card, as in the reference: a few in the accent and a few in ink, each a smooth
 * closed curve whose outline swells and dents with two slow travelling bulges, so the
 * blobs wobble like something gooey while they float along gentle looping paths.
 * Flat, crisp colour, no blur or filters.
 *
 * Loop: each blob's path and its bulges go round a whole number of times per cycle; one
 * cycle per loop at speed 1 (backgroundLoop). density sets the blob count. Energy
 * scales the wobble; the seed sets the blobs.
 */

const ID = "B31";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B31_LOOP_SECONDS = 8;
/** Morph cycles per loop at speed 1. */
export const B31_LOOP_CYCLES = 1;
/** Blobs per million px² at density 1 (about 6 in a 1080×1920 frame), and their radius range (authored px). */
const PER_MEGAPIXEL = 2.9, RADIUS = [80, 190];
/** Bulge sizes (× radius) at standard energy, and the outline sample count. */
const BULGE2 = 0.075, BULGE3 = 0.05, SAMPLES = 36;
/** Drift radius (× short side). */
const DRIFT = 0.07;
/** Share of blobs in the accent (the rest in ink). */
const ACCENT_SHARE = 0.55;

/** Radius factor of a blob outline at angle θ and cycle phase p (two bulges travelling round at whole speeds). */
export function blobRadius(theta: number, p: number, wobble: number, phase: number): number {
  return 1 + wobble * (BULGE2 * Math.sin(2 * theta + 2 * Math.PI * (p + phase)) + BULGE3 * Math.sin(3 * theta - 2 * Math.PI * (2 * p + phase)));
}

export const B31_blobShapes = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const short = Math.min(size.width, size.height);
  const { loopSeconds, cycles } = backgroundLoop(B31_LOOP_SECONDS, B31_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const wobble = clamp(energyProfile(params.energy).amplitude, 0.6, 1.5);
  const rng = createSeededRng(ID, params.seed);
  const count = Math.max(3, Math.round(((size.width * size.height) / 1e6) * PER_MEGAPIXEL * params.density));
  const accent = pathData(1), ink = pathData(1);

  for (let index = 0; index < count; index += 1) {
    const blob = rng.fork(index);
    const r = blob.range(RADIUS[0], RADIUS[1]) * unit / Math.sqrt(params.density);
    const phase = blob.next(), fx = blob.int(1, 2), fy = blob.int(1, 2), pathPhase = blob.next();
    const x = blob.range(0.08, 0.92) * size.width + DRIFT * short * Math.cos(2 * Math.PI * (fx * p + pathPhase));
    const y = blob.range(0.06, 0.94) * size.height + DRIFT * short * Math.sin(2 * Math.PI * (fy * p + pathPhase * 1.3));
    const builder = blob.chance(ACCENT_SHARE) ? accent : ink;
    // Sample the outline, then join the samples with a closed Catmull–Rom spline (as cubic Béziers): a smooth blob.
    const points = Array.from({ length: SAMPLES }, (_, k) => {
      const theta = (k / SAMPLES) * 2 * Math.PI, rr = r * blobRadius(theta, p, wobble, phase);
      return [x + rr * Math.cos(theta), y + rr * Math.sin(theta)] as const;
    });
    builder.M(points[0][0], points[0][1]);
    for (let k = 0; k < SAMPLES; k += 1) {
      const p0 = points[(k - 1 + SAMPLES) % SAMPLES], p1 = points[k], p2 = points[(k + 1) % SAMPLES], p3 = points[(k + 2) % SAMPLES];
      builder.C(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    builder.Z();
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(path(accent.toString(), { fill: params.palette.accent }), path(ink.toString(), { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B31_LOOP_SECONDS, loopCycles: B31_LOOP_CYCLES });
