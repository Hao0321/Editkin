import { mixHex } from "../../svg/color";
import { createSvgDocument, path, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B27 Shape Tunnel (ART_DIRECTION §10, base C): nested hexagon outlines on the cream
 * card, alternating ink and the accent, stream toward the camera while the tunnel
 * twists, as in the reference: each hexagon is turned a little more than the one in
 * front of it, so the stack spirals, and as the hexagons approach they turn back.
 * Every few steps a hexagon band is filled with a light tint of the accent. Lines are
 * never thinner than 3 px at 1080, and the tunnel stops before the hexagons crowd.
 *
 * Self-similar by construction: hexagon k sits at scale Z^(k − f), its turn, weight and
 * colour depend only on its scale and k (mod 4), and f advances four whole steps per
 * cycle; one cycle per loop at speed 1 (backgroundLoop). density sets the zoom step.
 * Energy scales the line weight; the seed sets the twist direction and the start.
 */

const ID = "B27";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B27_LOOP_SECONDS = 4;
/** Zoom cycles per loop at speed 1 (each cycle moves the tunnel four hexagon steps). */
export const B27_LOOP_CYCLES = 1;
/** Zoom per step at density 1, and the scale range drawn (1 = a hexagon spanning the frame). */
const BASE_STEP = 1.34, MIN_SCALE = 0.07, MAX_SCALE = 1.7;
/** Line width (authored px) at scale 1, its perspective falloff, and the floor (never a hairline). */
const WIDTH = 9, FALLOFF = 0.6, MIN_WIDTH = 3;
/** Turn per step (degrees): the twist. */
const TWIST = 11;
/** The tint band's fill: how far from cream toward the accent. */
const BAND_TINT = 0.32;

/** Scale of hexagon k at tunnel phase f (in steps), for zoom step z. */
export function hexScale(k: number, f: number, z: number): number {
  return z ** (k - f);
}

export const B27_shapeTunnel = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const z = BASE_STEP ** (1 / params.density);
  const { loopSeconds, cycles } = backgroundLoop(B27_LOOP_SECONDS, B27_LOOP_CYCLES, params.speed);
  const rng = createSeededRng(ID, params.seed);
  const twist = rng.sign() * TWIST;
  const f = 4 * cycles * loopPhase(t, loopSeconds) + 4 * rng.next();
  const weight = clamp(energyProfile(params.energy).amplitude, 0.85, 1.25);
  const cx = size.width / 2, cy = size.height / 2;
  // A flat-topped hexagon stretched to the frame's shape: it spans the frame at scale 1.
  const rx = size.width / 2, ry = size.height / 2 / (Math.sqrt(3) / 2);
  const logZ = Math.log(z);
  const first = Math.ceil(f + Math.log(MIN_SCALE) / logZ), last = Math.floor(f + Math.log(MAX_SCALE) / logZ);
  const band = mixHex(params.palette.paper, params.palette.accent, BAND_TINT);
  const outlines: string[] = [];
  const corners = (s: number): Point2[] => {
    const turn = ((twist * Math.log(s)) / logZ) * (Math.PI / 180), ca = Math.cos(turn), sa = Math.sin(turn);
    return Array.from({ length: 6 }, (_, index) => {
      const a = (index * Math.PI) / 3, x = Math.cos(a) * rx * s, y = Math.sin(a) * ry * s;
      return [cx + x * ca - y * sa, cy + x * sa + y * ca] as Point2;
    });
  };

  // Nearest (largest) first. The tint bands are rings between neighbouring hexagons, so they never overlap; all
  // bands go under all outlines.
  const shapes: string[] = [];
  for (let k = last; k >= first; k -= 1) {
    const s = hexScale(k, f, z), mod = ((k % 4) + 4) % 4;
    const ring = corners(s);
    // A light band between this hexagon and the next smaller one, on every fourth step.
    if (mod === 0 && k - 1 >= first) {
      const inner = corners(hexScale(k - 1, f, z));
      shapes.push(path(polygonPathD(ring, 2) + polygonPathD([...inner].reverse(), 2), { fill: band, "fill-rule": "evenodd" }));
    }
    const width = Math.max(MIN_WIDTH * unit, WIDTH * s ** FALLOFF * unit * weight);
    outlines.push(path(polygonPathD(ring, 2), { fill: "none", stroke: mod % 2 === 0 ? params.palette.ink : params.palette.accent,
      "stroke-width": Number(width.toFixed(3)), "stroke-linejoin": "miter" }));
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(shapes, outlines);
}, { revision: REVISION, loopSeconds: B27_LOOP_SECONDS, loopCycles: B27_LOOP_CYCLES });
