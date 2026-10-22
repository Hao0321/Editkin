import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B02 Halftone Wave (ART_DIRECTION §10, base A): two interleaved square halftone
 * screens on the accent card, ink on the grid points and cream on the cell
 * centres, whose dot sizes ride one wave travelling across the frame with gently
 * bending fronts. The cream screen trails the ink screen by a third of a cycle, so
 * the two layers undulate against each other: a bold band of ink dots, then a band
 * of cream dots, then a quieter stretch of small dots on the accent. Both screens
 * are crisp, full-strength roles; neither ever vanishes.
 *
 * Loop: the wave phase is periodic in its loop. One wavelength per loop at speed 1;
 * other speeds scale the travel and stretch the loop by 1, 2 or 4 so it still holds
 * whole wavelengths (backgroundLoop; the catalog's motionBackgroundLoopSeconds gives
 * the period). density sets the screen pitch only: the wave is measured in frame units.
 * Energy scales the dot size swing; the seed tilts the travel (±8°) and shifts the phase.
 */

const ID = "B02";
/** Art revision: 1 = dark card with accent and deep-shade screens; 2 = §10 reference recreation (accent card, square ink and cream screens). */
const REVISION = 2;
export const B02_LOOP_SECONDS = 4;
/** Authored px (1080 short side) between neighbouring dots of one screen. */
const BASE_PITCH = 44;
/** Wave cycles per loop at speed 1. */
export const B02_LOOP_CYCLES = 1;
const WAVELENGTH = 1000;
/** Travel direction (degrees from +x, SVG y-down): nearly horizontal, the fronts nearly vertical. */
const DIRECTION_DEGREES = -10;
/** Front bend: displacement (fraction of the wavelength) and its period along the fronts (authored px). */
const BEND = 0.07, BEND_PERIOD = 1700;
/** The cream screen's phase lag behind the ink screen (fraction of a cycle). */
const LAYER_LAG = 1 / 3;
/** Crest shape: w = ((1 + cos θ) / 2)^SHAPE (broad, bold crests). */
const SHAPE = 1.4;
/** Dot radius = pitch × (base + swing × w); diagonal neighbours (ink to cream) are 0.707 pitch apart, so the peaks never touch. */
const INK_DOT = { base: 0.08, swing: 0.28 }, CREAM_DOT = { base: 0.07, swing: 0.25 };

export const B02_halftoneWave = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.6, 1.1);
  const pitch = (BASE_PITCH * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B02_LOOP_SECONDS, B02_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const angle = ((DIRECTION_DEGREES + rng.range(-8, 8)) * Math.PI) / 180;
  const bendPhase = rng.next() * 2 * Math.PI, wavePhase = rng.next();
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const wavelength = WAVELENGTH * unit, bend = BEND * wavelength, bendK = (2 * Math.PI) / (BEND_PERIOD * unit);
  const cx = size.width / 2, cy = size.height / 2;
  const timePhase = wavePhase - cycles * u;

  /** Dot weight 0..1 of a screen at (x, y); lag in cycles (positive = behind the ink crest). */
  const weight = (x: number, y: number, lag: number) => {
    const dx = x - cx, dy = y - cy;
    const s = dx * ca + dy * sa, q = dy * ca - dx * sa;
    const theta = 2 * Math.PI * ((s + bend * Math.sin(bendK * q + bendPhase)) / wavelength + timePhase + lag);
    return ((1 + Math.cos(theta)) / 2) ** SHAPE;
  };

  let inkD = "", creamD = "";
  const columns = Math.ceil(cx / pitch) + 1, rows = Math.ceil(cy / pitch) + 1;
  for (let row = -rows; row <= rows; row += 1) {
    for (let column = -columns; column <= columns; column += 1) {
      const x = cx + column * pitch, y = cy + row * pitch;
      inkD += circlePathD(x, y, pitch * (INK_DOT.base + INK_DOT.swing * amplitude * weight(x, y, 0)), 1);
      // The cream screen sits on the cell centres, half a pitch off in both directions.
      const nx = x + pitch / 2, ny = y + pitch / 2;
      creamD += circlePathD(nx, ny, pitch * (CREAM_DOT.base + CREAM_DOT.swing * amplitude * weight(nx, ny, LAYER_LAG)), 1);
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(path(creamD, { fill: params.palette.paper }), path(inkD, { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B02_LOOP_SECONDS, loopCycles: B02_LOOP_CYCLES });
