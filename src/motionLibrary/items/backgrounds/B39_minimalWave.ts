import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type BackgroundMotionParams, type MotionFrameSize } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B39 Minimal Wave (ART_DIRECTION §10, base C): one thick accent wave and one thin
 * ink wave below it, undulating slowly across the cream card, as in the reference.
 * Both travel one wavelength per cycle; the thin line runs a little ahead in phase,
 * so the gap between them opens and closes along the frame, and the two breathe in
 * counterpoint (the thick wave swells while the thin one flattens). The pair sits
 * across the middle with wide cream margins above and below for a title.
 *
 * In a tall frame the pair is drawn up to 1.3× larger, so it still reads as a bold band.
 *
 * Loop: one wavelength of travel and one breath per cycle, one cycle per loop at
 * speed 1 (backgroundLoop). density sets the wavelength (more, lower waves across at
 * high density). Energy scales the amplitude; the seed sets the phase.
 */

const ID = "B39";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B39_LOOP_SECONDS = 6;
/** Wave cycles per loop at speed 1 (one wavelength of travel and one breath per cycle). */
export const B39_LOOP_CYCLES = 1;
/** Wavelength (× long side) at density 1. */
const WAVELENGTH = 0.62;
/** Thick wave: amplitude and stroke (× short side); thin wave: offset below, amplitude (× thick), stroke (× short side), phase lead (wavelengths). */
const AMPLITUDE = 0.115, THICK = 0.13, THIN_OFFSET = 0.21, THIN_AMPLITUDE = 0.9, THIN = 0.012, THIN_LEAD = 0.12;
/** Breath: thick swells by this share while the thin one flattens by the other. */
const BREATH = 0.1, THIN_BREATH = 0.14;
/** Pair centre (× height), and Hermite segments per wavelength. */
const CENTRE = 0.47, SEGMENTS = 16;
/** In a tall frame the pair grows with the height, up to this much (it stays a band across the middle). */
const TALL_SCALE = 1.3;

/** One wave: baseline (px), amplitude (px), phase (turns) and stroke width (px), for a shared wavelength. */
export interface WaveLine { readonly baseline: number; readonly amplitude: number; readonly phase: number; readonly width: number }

/** Height (px) of a wave at x (px). */
export function waveY(wave: WaveLine, wavelength: number, x: number): number {
  return wave.baseline + wave.amplitude * Math.sin((2 * Math.PI * x) / wavelength + 2 * Math.PI * wave.phase);
}

/** One stroked wave as cubic Hermite segments (exact tangents), over the frame width plus a margin. */
function wavePathD(size: MotionFrameSize, wavelength: number, wave: WaveLine): string {
  const k = (2 * Math.PI) / wavelength, step = wavelength / SEGMENTS, margin = wavelength / 8;
  const y = (x: number) => waveY(wave, wavelength, x);
  const slope = (x: number) => wave.amplitude * k * Math.cos(k * x + 2 * Math.PI * wave.phase);
  const builder = pathData(2).M(-margin, y(-margin));
  for (let x = -margin; x < size.width + margin; x += step) {
    const x1 = x + step;
    builder.C(x + step / 3, y(x) + (step / 3) * slope(x), x1 - step / 3, y(x1) - (step / 3) * slope(x1), x1, y(x1));
  }
  return builder.toString();
}

/** Thick and thin amplitudes (px) at cycle phase p, for a base amplitude. */
export function waveAmplitudes(p: number, base: number): { thick: number; thin: number } {
  const breath = Math.sin(2 * Math.PI * p);
  return { thick: base * (1 + BREATH * breath), thin: base * THIN_AMPLITUDE * (1 - THIN_BREATH * breath) };
}

/** The two waves at cycle phase p (the travel and the breath), for a frame and its params. */
export function waveLayout(size: MotionFrameSize, params: Pick<BackgroundMotionParams, "density" | "energy" | "seed">, p: number):
  { readonly wavelength: number; readonly thick: WaveLine; readonly thin: WaveLine } {
  const scale = 1080 * frameUnit(size) * Math.min(TALL_SCALE, size.height / Math.min(size.width, size.height));
  const phase = createSeededRng(ID, params.seed).next();
  const wavelength = (WAVELENGTH * Math.max(size.width, size.height)) / params.density;
  // Shorter waves (density above 1) are also lower, so they keep the same gentle slope rather than turning steep.
  const amplitudes = waveAmplitudes(p, (AMPLITUDE * scale * clamp(energyProfile(params.energy).amplitude, 0.6, 1.25)) / Math.sqrt(Math.max(1, params.density)));
  const centre = CENTRE * size.height;
  // Travel to the right: one wavelength per cycle (the phase in turns is wrapped, so whole cycles drop out).
  const travel = loopPhase(phase - p, 1);
  return {
    wavelength,
    thick: { baseline: centre, amplitude: amplitudes.thick, phase: travel, width: Number((THICK * scale).toFixed(2)) },
    thin: { baseline: centre + THIN_OFFSET * scale, amplitude: amplitudes.thin, phase: loopPhase(travel + THIN_LEAD, 1), width: Number((THIN * scale).toFixed(2)) },
  };
}

export const B39_minimalWave = defineBackgroundMotion(ID, (params, t, size) => {
  const { loopSeconds, cycles } = backgroundLoop(B39_LOOP_SECONDS, B39_LOOP_CYCLES, params.speed);
  const { wavelength, thick, thin } = waveLayout(size, params, cycles * loopPhase(t, loopSeconds));
  const stroke = (colour: string, wave: WaveLine) => ({ fill: "none", stroke: colour, "stroke-width": wave.width, "stroke-linecap": "round", "stroke-linejoin": "round" });
  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(path(wavePathD(size, wavelength, thick), stroke(params.palette.accent, thick)), path(wavePathD(size, wavelength, thin), stroke(params.palette.ink, thin)));
}, { revision: REVISION, loopSeconds: B39_LOOP_SECONDS, loopCycles: B39_LOOP_CYCLES });
