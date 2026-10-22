import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B07 Halftone Checker (ART_DIRECTION §10, base C): a coarse square dot screen on
 * the cream card, about 13 dots across the short side, printed as a one-dot
 * checkerboard: big accent dots (0.85 of the pitch across) alternate with small
 * accent dots (0.25 across), so the checker reads at phone size. A diagonal band
 * sweeps across the board and swaps it: inside the band every dot is ink and
 * changes size (big to small, small to big), so the band reads as one dark diagonal
 * stripe; behind it the checker rests, flipped. Only one band is on screen at a time:
 * the next enters as the last one leaves.
 *
 * Loop: two band passes per cycle (the board flips and flips back), one cycle per
 * loop at speed 1, from backgroundLoop. density sets the pitch (the band is measured
 * against the frame). Energy scales the size contrast; the seed sets the band's lean
 * (±10°) and phase.
 */

const ID = "B07";
/**
 * Art revision: 1 = deep-shade 3 × 3 checker on dark; 2 = §10 one-dot checker (accent and ink on cream);
 * 3 = phone-size legibility (13 dots across, 0.85 / 0.25 dots, one ink swap band).
 */
const REVISION = 3;
export const B07_LOOP_SECONDS = 4;
/** Swap cycles per loop at speed 1 (each cycle is two band passes). */
export const B07_LOOP_CYCLES = 1;
/** Dots across the frame's short side at density 1. */
const DOTS_ACROSS = 13;
/** Dot diameters as fractions of the pitch at rest: big and small. */
const BIG = 0.85, SMALL = 0.25;
/** Band travel direction (degrees from +x, SVG y-down) and the band's width in pitches. */
const BAND_DEGREES = 35, BAND_PITCHES = 2.6;
/** A dot is ink while its swap progress is between these (the visible stripe). */
const INK_FROM = 0.04, INK_TO = 0.96;

/** Swap progress 0..1 of a dot the band entered `f` band-spacings ago (w = band width / spacing). */
export function bandProgress(f: number, w: number): number {
  return smoothstep(0, w, f);
}

export const B07_halftoneChecker = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const contrast = clamp(energyProfile(params.energy).amplitude, 0.75, 1.1);
  const pitch = (1080 * unit) / DOTS_ACROSS / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B07_LOOP_SECONDS, B07_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const angle = ((BAND_DEGREES + rng.range(-10, 10)) * Math.PI) / 180;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const phase = rng.next();
  const cx = size.width / 2, cy = size.height / 2;
  // Bands: one on screen at a time, so the spacing is the frame's extent along the travel plus the band.
  const extent = Math.abs(ca) * size.width + Math.abs(sa) * size.height;
  const band = BAND_PITCHES * pitch, spacing = extent + band, w = band / spacing;
  // Radii at rest; the swap interpolates between them.
  const mid = ((BIG + SMALL) / 4) * pitch, swing = ((BIG - SMALL) / 4) * pitch * contrast;
  let accentD = "", inkD = "";

  // Dots sit at cell centres; the board is centred on the frame.
  const columns = Math.ceil(cx / pitch) + 1, rows = Math.ceil(cy / pitch) + 1;
  for (let row = -rows; row < rows; row += 1) {
    const y = cy + (row + 0.5) * pitch;
    for (let column = -columns; column < columns; column += 1) {
      const x = cx + (column + 0.5) * pitch;
      // Band passes so far at this dot (two per cycle; the train enters from the far side of the frame).
      const s = (x - cx) * ca + (y - cy) * sa;
      const p = 2 * cycles * u + phase - (s + extent / 2) / spacing;
      const passes = Math.floor(p), f = p - passes;
      const parity = (row + column) & 1 ? -1 : 1;
      // The state after `passes` band passes is parity · (−1)^passes; the band now crossing flips it.
      const before = passes & 1 ? -parity : parity;
      const progress = bandProgress(f, w);
      const state = before * (1 - 2 * progress);
      const dot = circlePathD(x, y, mid + swing * state, 1);
      if (progress > INK_FROM && progress < INK_TO) inkD += dot;
      else accentD += dot;
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.paper });
  return doc.render(path(accentD, { fill: params.palette.accent }), path(inkD, { fill: params.palette.ink }));
}, { revision: REVISION, loopSeconds: B07_LOOP_SECONDS, loopCycles: B07_LOOP_CYCLES });
