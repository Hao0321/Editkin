import { mostContrasting } from "../../svg/color";
import { circle, circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B08 Halftone Sun (ART_DIRECTION §10, base D): as in the reference, a flat,
 * full accent sun low in the dark card, with rays of crisp cream dots radiating
 * from it in every direction. Along each ray the dots sit at even steps, so they
 * also line up on arcs around the sun; they are largest next to the sun and shrink
 * to nothing with distance, so the burst dissolves into the card instead of
 * reaching the frame edges, leaving the upper part open for a title. The rays
 * slowly turn about the sun's centre.
 *
 * Loop: the rays are evenly spaced, so turning by whole ray spacings per loop is
 * seamless. One ray spacing per loop at speed 1; other speeds scale the turn and
 * stretch the loop by 1, 2 or 4 so it still turns whole spacings (backgroundLoop).
 * density sets the dot step along the rays and the ray count. Energy scales the
 * dots; the seed turns the rays.
 */

const ID = "B08";
/**
 * Art revision: 1 = half sun on a horizon, rays fading into the deep shade, deep-shade water; 2 = §10 reference
 * recreation (full sun, cream ray dots, no water).
 */
const REVISION = 2;
export const B08_LOOP_SECONDS = 8;
/** Ray spacings turned per loop at speed 1. */
export const B08_LOOP_CYCLES = 1;
const BASE_RAYS = 28;
/** Sun centre height (fraction of the frame height) and radius (fraction of the short side). */
const SUN_Y = 0.74, SUN = 0.15;
/** Authored px (1080 short side) between dots along a ray. */
const BASE_STEP = 36;
/** Ray dots start this far out (× sun radius) and shrink to nothing by REACH of the short side from the sun. */
const RAY_START = 1.35, REACH = 1.05;
/** Dot radius next to the sun (× step). */
const RAY_DOT = 0.3;

export const B08_halftoneSun = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.75, 1.2);
  const step = (BASE_STEP * unit) / params.density;
  const rays = Math.max(12, Math.round(BASE_RAYS * Math.sqrt(params.density)));
  const { loopSeconds, cycles } = backgroundLoop(B08_LOOP_SECONDS, B08_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rayStep = (2 * Math.PI) / rays;
  const rayPhase = createSeededRng(ID, params.seed).next() * rayStep;
  const short = Math.min(size.width, size.height);
  const sunR = short * SUN;
  const sx = size.width / 2, sy = size.height * SUN_Y;
  const start = sunR * RAY_START, reach = short * REACH;
  const cream = mostContrasting(params.palette.bg, [params.palette.paper, params.palette.ink]);
  // Turn by whole ray spacings per loop (the slowest seamless turn is one spacing).
  const turn = cycles * rayStep * u;
  let raysD = "";
  for (let ray = 0; ray < rays; ray += 1) {
    const angle = rayPhase + ray * rayStep + turn;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let distance = start; distance < reach; distance += step) {
      const r = step * RAY_DOT * amplitude * (1 - smoothstep(start, reach, distance)) ** 1.25;
      if (r < 0.35) break;
      const x = sx + ca * distance, y = sy + sa * distance;
      if (x < -r || x > size.width + r || y < -r || y > size.height + r) continue;
      raysD += circlePathD(x, y, r, 1);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(raysD, { fill: cream }), circle(sx, sy, sunR, { fill: params.palette.accent }));
}, { revision: REVISION, loopSeconds: B08_LOOP_SECONDS, loopCycles: B08_LOOP_CYCLES });
