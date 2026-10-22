import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B11 Grid Wave: a square accent grid on bg, deformed like cloth by two
 * travelling transverse waves crossing at about 95° (a long slow swell and a
 * shorter ripple). Every grid point is displaced across each wave's travel
 * direction, so the lines bend, bunch and spread as the swell rolls through,
 * like a flag or a sheet catching the wind. The displacement stays well below
 * the fold limit, so lines never cross. On the cream card (ART_DIRECTION §10,
 * base C) the grid is drawn crisp: minor lines in the accent's deep shade
 * (accent2) and every fourth line in ink, as on graph paper.
 *
 * Loop: each wave advances a whole number of wavelengths per loop, so frame N
 * equals frame 0: one swell and two ripple cycles per loop at speed 1. Other speeds
 * scale both waves alike and stretch the loop by 1, 2 or 4 so each still advances
 * whole wavelengths (backgroundLoop); density sets the cell size (the waves
 * are measured in frame units). Energy scales the displacement; the seed sets the
 * wave directions (±10°) and phases.
 */

const ID = "B11";
/** Art revision: 1 = deep-shade and accent lines on dark; 2 = §10 restyle (cream card, deep-shade and ink lines). */
const REVISION = 2;
export const B11_LOOP_SECONDS = 4;
/** Loop cycles at speed 1; each wave advances its own whole number of wavelengths per cycle (SWELL, RIPPLE). */
export const B11_LOOP_CYCLES = 1;
/** Cell size (authored px), and the sampling step along each line (authored px). */
const BASE_CELL = 60, SAMPLE = 10;
/** Waves: travel direction (degrees), wavelength and amplitude (authored px), wavelengths per loop cycle. */
const SWELL = { degrees: 18, wavelength: 1500, amplitude: 52, cycles: 1 };
const RIPPLE = { degrees: 113, wavelength: 760, amplitude: 16, cycles: 2 };
const LINE = 2, MAJOR_LINE = 3;
const MAJOR_EVERY = 4;

export const B11_gridWave = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.55, 1.4);
  const { loopSeconds, cycles: loopCycles } = backgroundLoop(B11_LOOP_SECONDS, B11_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const waves = [SWELL, RIPPLE].map(spec => {
    const angle = ((spec.degrees + rng.range(-10, 10)) * Math.PI) / 180;
    const cycles = spec.cycles * loopCycles;
    return { ca: Math.cos(angle), sa: Math.sin(angle), k: (2 * Math.PI) / (spec.wavelength * unit), amplitude: spec.amplitude * unit * amplitude,
      phase: rng.next() * 2 * Math.PI - 2 * Math.PI * cycles * u };
  });
  const cx = size.width / 2, cy = size.height / 2;
  const cell = (BASE_CELL * unit) / params.density;
  const step = SAMPLE * unit;
  const margin = (SWELL.amplitude + RIPPLE.amplitude) * unit * amplitude + cell;

  /** Displaced position of the rest point (x, y): each wave pushes across its own travel direction. */
  const displaced = (x: number, y: number): readonly [number, number] => {
    let dx = 0, dy = 0;
    for (const wave of waves) {
      const offset = wave.amplitude * Math.sin(wave.k * ((x - cx) * wave.ca + (y - cy) * wave.sa) + wave.phase);
      dx -= offset * wave.sa;
      dy += offset * wave.ca;
    }
    return [x + dx, y + dy];
  };

  const minor = pathData(1), major = pathData(1);
  const lines = (count: number, along: number, place: (index: number, s: number) => readonly [number, number]) => {
    for (let index = -count; index < count; index += 1) {
      const builder = ((index % MAJOR_EVERY) + MAJOR_EVERY) % MAJOR_EVERY === 0 ? major : minor;
      const samples = Math.ceil((along + 2 * margin) / step);
      for (let sample = 0; sample <= samples; sample += 1) {
        const [x, y] = place(index, -margin + sample * step);
        if (sample === 0) builder.M(x, y);
        else builder.L(x, y);
      }
    }
  };
  // Vertical lines (x fixed at rest), then horizontal lines; the grid is centred on a crossing.
  lines(Math.ceil((cx + margin) / cell), size.height, (index, s) => displaced(cx + index * cell, s));
  lines(Math.ceil((cy + margin) / cell), size.width, (index, s) => displaced(s, cy + index * cell));

  const doc = createSvgDocument(size, { background: params.palette.paper });
  const stroke = (colour: string, width: number) => ({ fill: "none", stroke: colour,
    "stroke-width": width * unit, "stroke-linejoin": "round", "stroke-linecap": "round" });
  return doc.render(path(minor.toString(), stroke(params.palette.accent2, LINE)), path(major.toString(), stroke(params.palette.ink, MAJOR_LINE)));
}, { revision: REVISION, loopSeconds: B11_LOOP_SECONDS, loopCycles: B11_LOOP_CYCLES });
