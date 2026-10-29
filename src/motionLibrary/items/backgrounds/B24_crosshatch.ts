import { createSvgDocument, path, pathData, type PathBuilder } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B24 Crosshatch (ART_DIRECTION §10, base D): two crosshatch layers on the dark
 * card, as in the reference's diamond lattice: one in the accent, one in cream. The
 * cream layer is turned a few degrees against the accent one, so where their lines
 * nearly coincide they beat into broad, soft moiré bands. The cream layer slides
 * across its own hatch, so the moiré shimmers and drifts over the frame while every
 * line stays crisp and straight. Lines are at least 3 px wide at 1080 at every energy,
 * on a wide pitch, so nothing aliases or turns to mush after H.264 compression. (The
 * catalog's optional hand-drawn waver is left out: wavering polylines cost librsvg
 * about 4× the raster time of straight lines.)
 *
 * Loop: the cream layer slides exactly one hatch pitch per cycle (its lattice repeats
 * every pitch), one cycle per loop at speed 1 (backgroundLoop). density sets the
 * pitch. Energy scales the line weight; the seed sets the turn direction.
 */

const ID = "B24";
/** Art revision: 1 = first implementation (p2n-bg2); 2 = ≥ 3 px lines on a wider pitch (H.264-safe). */
const REVISION = 2;
export const B24_LOOP_SECONDS = 4;
/** Slide cycles per loop at speed 1. */
export const B24_LOOP_CYCLES = 1;
/** Hatch pitch (authored px, 1080 short side), the hatch angle (degrees), and the cream layer's turn against it. */
const BASE_PITCH = 84, ANGLE = 45, TURN = 6;
/** Line widths (authored px): accent layer and cream layer. Energy scales them by 0.85–1.25, so they never drop below 3 px. */
const ACCENT_LINE = 4.4, CREAM_LINE = 3.6;

/** Straight lines of one hatch direction: angle (radians), pitch, offset across the hatch (px), centred on (cx, cy), covering `reach`. */
function hatch(builder: PathBuilder, cx: number, cy: number, angle: number, pitch: number, offset: number, reach: number): void {
  const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
  // The lines whose offset lies in [−reach, reach]: the same set of positions whatever the slide (seamless at the wrap).
  for (let k = Math.ceil((-reach - offset) / pitch); k * pitch + offset <= reach; k += 1) {
    const o = k * pitch + offset;
    builder.M(cx + nx * o - dx * reach, cy + ny * o - dy * reach).L(cx + nx * o + dx * reach, cy + ny * o + dy * reach);
  }
}

/** Offset (px) of the sliding layer at cycle phase p: one pitch per cycle. */
export function slideOffset(p: number, pitch: number): number {
  return pitch * (p - Math.floor(p));
}

export const B24_crosshatch = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const pitch = (BASE_PITCH * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B24_LOOP_SECONDS, B24_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const weight = clamp(energyProfile(params.energy).amplitude, 0.85, 1.25);
  const turn = createSeededRng(ID, params.seed).sign() * TURN;
  const cx = size.width / 2, cy = size.height / 2, reach = Math.hypot(cx, cy) + pitch;
  const accent = pathData(1), cream = pathData(1);
  const rad = (degrees: number) => (degrees * Math.PI) / 180;

  hatch(accent, cx, cy, rad(ANGLE), pitch, 0, reach);
  hatch(accent, cx, cy, rad(-ANGLE), pitch, 0, reach);
  // The cream layer: turned against the accent layer, sliding one pitch per cycle across both of its hatches.
  const slide = slideOffset(p, pitch);
  hatch(cream, cx, cy, rad(ANGLE + turn), pitch, slide, reach);
  hatch(cream, cx, cy, rad(-ANGLE + turn), pitch, slide, reach);

  const doc = createSvgDocument(size, { background: params.palette.bg });
  const stroke = (colour: string, width: number) => ({ fill: "none", stroke: colour, "stroke-width": width * unit * weight });
  return doc.render(path(cream.toString(), stroke(params.palette.paper, CREAM_LINE)), path(accent.toString(), stroke(params.palette.accent, ACCENT_LINE)));
}, { revision: REVISION, loopSeconds: B24_LOOP_SECONDS, loopCycles: B24_LOOP_CYCLES });
