import { mixHex } from "../../svg/color";
import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B26 Floating Shapes (ART_DIRECTION §10, base A): soft pills and squiggles drift over
 * the accent card, as in the reference. Fat capsules in cream, a light tint of the
 * accent, the deep shade and ink float on gentle looping paths, each slowly turning;
 * short cream squiggles bob and rock between them. Everything is a crisp flat shape,
 * and nothing is thinner than a bold stroke, so it reads at phone size.
 *
 * Loop: each shape's drift path, bob and turn are whole numbers of cycles (pills turn
 * whole half-turns: a capsule looks the same after 180°); one cycle per loop at speed 1
 * (backgroundLoop). density sets the shape count. Energy scales the drift; the seed
 * sets the shapes, paths and colours.
 */

const ID = "B26";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B26_LOOP_SECONDS = 8;
/** Drift cycles per loop at speed 1. */
export const B26_LOOP_CYCLES = 1;
/** Pills and squiggles per million px² at density 1 (about 7 and 4 in a 1080×1920 frame). */
const PILLS = 3.4, SQUIGGLES = 2;
/** Pill length and thickness ranges (authored px). */
const PILL_LENGTH = [300, 540], PILL_THICK = [84, 128];
/** Squiggle: length, wave amplitude (authored px), stroke (authored px). */
const SQUIGGLE_LENGTH = 230, SQUIGGLE_AMPLITUDE = 22, SQUIGGLE_STROKE = 11;
/** Drift radius range (× short side) at standard energy. */
const DRIFT = [0.05, 0.12];
/** How far the light tint goes from the accent toward cream. */
const TINT = 0.5;

/** Offset (in drift radii) of a shape on its looping path at cycle phase p: a Lissajous figure with whole frequencies. */
export function driftOffset(p: number, fx: number, fy: number, phase: number): readonly [number, number] {
  return [Math.cos(2 * Math.PI * (fx * p + phase)), Math.sin(2 * Math.PI * (fy * p + phase * 1.7))];
}

/** Path data of a capsule centred on (cx, cy): length along `angle`, thickness across it. */
function capsule(cx: number, cy: number, length: number, thick: number, turn: number): string {
  // A capsule is the same shape after half a turn: reduce the angle to [0, π) so the path itself is identical too.
  const angle = ((turn % Math.PI) + Math.PI) % Math.PI;
  const r = thick / 2, half = Math.max(0, length / 2 - r);
  const ca = Math.cos(angle), sa = Math.sin(angle), nx = -sa * r, ny = ca * r;
  const ax = cx - ca * half, ay = cy - sa * half, bx = cx + ca * half, by = cy + sa * half;
  return pathData(1).M(ax + nx, ay + ny).L(bx + nx, by + ny).A(r, r, 0, false, false, bx - nx, by - ny)
    .L(ax - nx, ay - ny).A(r, r, 0, false, false, ax + nx, ay + ny).Z().toString();
}

export const B26_floatingShapes = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const short = Math.min(size.width, size.height);
  const { loopSeconds, cycles } = backgroundLoop(B26_LOOP_SECONDS, B26_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const drift = clamp(energyProfile(params.energy).amplitude, 0.6, 1.3);
  const rng = createSeededRng(ID, params.seed);
  const area = (size.width * size.height) / 1e6;
  const tint = mixHex(params.palette.accent, params.palette.paper, TINT);
  const colours = [params.palette.paper, tint, params.palette.accent2, params.palette.ink];
  const fills: Record<string, string[]> = Object.fromEntries(colours.map(colour => [colour, []]));
  const squiggles = pathData(1);
  const scale = unit / Math.sqrt(params.density);

  const pills = Math.max(3, Math.round(area * PILLS * params.density));
  for (let index = 0; index < pills; index += 1) {
    const shape = rng.fork(`pill${index}`);
    const x = shape.range(0, 1) * size.width, y = shape.range(0, 1) * size.height;
    const radius = shape.range(DRIFT[0], DRIFT[1]) * short * drift;
    const [ox, oy] = driftOffset(p, shape.int(1, 2), shape.int(1, 2), shape.next());
    const turn = shape.int(-1, 1) * Math.PI * p + shape.range(0, Math.PI);
    const length = shape.range(PILL_LENGTH[0], PILL_LENGTH[1]) * scale, thick = shape.range(PILL_THICK[0], PILL_THICK[1]) * scale;
    fills[colours[index % colours.length]].push(capsule(x + ox * radius, y + oy * radius, length, thick, turn));
  }
  const squiggleCount = Math.max(2, Math.round(area * SQUIGGLES * params.density));
  for (let index = 0; index < squiggleCount; index += 1) {
    const shape = rng.fork(`squiggle${index}`);
    const x = shape.range(0, 1) * size.width, y = shape.range(0, 1) * size.height;
    const radius = shape.range(DRIFT[0], DRIFT[1]) * short * drift;
    const [ox, oy] = driftOffset(p, shape.int(1, 2), shape.int(1, 2), shape.next());
    // A squiggle rocks (±14°) rather than turning: it has no rotational symmetry.
    const angle = shape.range(-0.4, 0.4) + 0.25 * Math.sin(2 * Math.PI * (p + shape.next()));
    const ca = Math.cos(angle), sa = Math.sin(angle), length = SQUIGGLE_LENGTH * scale, amplitude = SQUIGGLE_AMPLITUDE * scale;
    for (let step = 0; step <= 18; step += 1) {
      const s = (step / 18 - 0.5) * length, w = amplitude * Math.sin((step / 18) * 3 * Math.PI);
      const px = x + ox * radius + ca * s - sa * w, py = y + oy * radius + sa * s + ca * w;
      if (step === 0) squiggles.M(px, py);
      else squiggles.L(px, py);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(
    colours.map(colour => path(fills[colour].join(""), { fill: colour })),
    path(squiggles.toString(), { fill: "none", stroke: params.palette.paper, "stroke-width": SQUIGGLE_STROKE * scale, "stroke-linecap": "round", "stroke-linejoin": "round" }),
  );
}, { revision: REVISION, loopSeconds: B26_LOOP_SECONDS, loopCycles: B26_LOOP_CYCLES });
