import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B20 Wave Lines (ART_DIRECTION §10, base D): a stack of thin wave lines on the
 * dark card, alternating the accent and cream, as in the reference. Each line is the
 * same two travelling waves (a long swell and a shorter ripple moving the other
 * way), shifted a little in phase from its neighbour, so the stack fans out, bunches
 * into bright ridges where the phases line up, and rolls like a range of mountains
 * or a silk ribbon in the wind.
 *
 * Loop: the swell travels one wavelength and the ripple two per cycle, one cycle per
 * loop at speed 1 (backgroundLoop). density sets the line count (12 at density 1,
 * within the catalog's 8–12 at 0.75–1). Energy scales the amplitude; the seed sets
 * the phases.
 */

const ID = "B20";
/** Art revision: 1 = first implementation (p2n-bg2). */
const REVISION = 1;
export const B20_LOOP_SECONDS = 4;
/** Wave cycles per loop at speed 1 (the swell travels one wavelength per cycle, the ripple two). */
export const B20_LOOP_CYCLES = 1;
/** Lines at density 1, and their stroke (authored px). */
const BASE_LINES = 12, STROKE = 2.8;
/** Swell and ripple: wavelength (× frame width), amplitude (× the stack spacing), phase step per line (cycles). */
const SWELL = { wavelength: 1.25, amplitude: 1.1, step: 0.045 };
const RIPPLE = { wavelength: 0.48, amplitude: 0.32, step: -0.07 };
/** Sampling step along a line (authored px). */
const SAMPLE = 10;

/** Vertical offset (× stack spacing) of line `i` at x (fraction of the frame width) and cycle phase p. */
export function waveOffset(x01: number, i: number, p: number, phase: number, amplitude: number): number {
  const swell = Math.sin(2 * Math.PI * (x01 / SWELL.wavelength - p + i * SWELL.step + phase));
  const ripple = Math.sin(2 * Math.PI * (x01 / RIPPLE.wavelength + 2 * p + i * RIPPLE.step + 2 * phase));
  return amplitude * (SWELL.amplitude * swell + RIPPLE.amplitude * ripple);
}

export const B20_waveLines = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B20_LOOP_SECONDS, B20_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.6, 1.3);
  const phase = createSeededRng(ID, params.seed).next();
  const lines = Math.max(4, Math.round(BASE_LINES * params.density));
  // The stack fills the frame height with a margin of one swell above and below.
  const spacing = size.height / (lines + 1);
  const step = SAMPLE * unit, samples = Math.ceil(size.width / step);
  const accent = pathData(1), paper = pathData(1);

  for (let i = 0; i < lines; i += 1) {
    const builder = i % 2 === 0 ? accent : paper;
    const base = (i + 1) * spacing;
    for (let sample = 0; sample <= samples; sample += 1) {
      const x = Math.min(size.width, sample * step) + (sample === 0 ? -2 * unit : sample === samples ? 2 * unit : 0);
      const y = base + spacing * waveOffset(x / size.width, i, p, phase, amplitude);
      if (sample === 0) builder.M(x, y);
      else builder.L(x, y);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  const stroke = (colour: string) => ({ fill: "none", stroke: colour, "stroke-width": STROKE * unit, "stroke-linejoin": "round" });
  return doc.render(path(paper.toString(), stroke(params.palette.paper)), path(accent.toString(), stroke(params.palette.accent)));
}, { revision: REVISION, loopSeconds: B20_LOOP_SECONDS, loopCycles: B20_LOOP_CYCLES });
