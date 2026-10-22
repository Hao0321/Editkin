import { mixHex } from "../../svg/color";
import { circle, createSvgDocument, path, pathData } from "../../svg/document";
import { cubicInOut, expoInOut, loopPhase, quartInOut, sineInOut, smoothstep, type EasingFunction } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type MotionEnergy } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B10 Grid Zoom (ART_DIRECTION §10, base A): an endless push into a square ink grid
 * on the accent card, centred on a grid crossing that holds an ink dot. Each beat
 * the camera eases in by exactly 2×: every cell grows to twice its size while a
 * new level of fine lines fades in, halving each cell, so the end of a beat looks
 * exactly like its start. Lines get bolder as they grow, so the grid always shows
 * the same hierarchy: bold structure lines, regular lines, and the newborn fine
 * lines appearing between them, as in the reference.
 *
 * Self-similar by construction: a line's colour and width depend only on its
 * on-screen spacing, and the level that fades in starts at the card colour. One
 * beat per loop at speed 1; other speeds scale the beat rate and stretch the loop
 * by 1, 2 or 4 so it still holds whole beats (backgroundLoop). density sets the
 * cell size. Energy sets the push curve (calm sine, standard cubic, punchy quart, hype
 * expo); the seed only shifts the beat's start within the loop.
 */

const ID = "B10";
/** Art revision: 1 = 3× nest of accent tints on dark; 2 = §10 reference recreation (2× nest of ink lines on the accent card). */
const REVISION = 2;
export const B10_LOOP_SECONDS = 2;
/** Beats per loop at speed 1. */
export const B10_LOOP_CYCLES = 1;
/** Zoom per beat; the grid nests by the same factor (centred on a crossing, so each cell splits into 2 × 2). */
const FACTOR = 2;
/** On-screen cell size of the reference level at the start of a beat (authored px). */
const BASE_CELL = 112;
/** Line width (authored px) of a newborn line and of the structure lines (spacing ≥ BOLD_AT × the reference cell). */
const THIN = 1.5, BOLD = 4.2, BOLD_AT = 3;
const DOT = 11;

const PUSH: Record<MotionEnergy, EasingFunction> = { calm: sineInOut, standard: cubicInOut, punchy: quartInOut, hype: expoInOut };

export const B10_gridZoom = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles: beats } = backgroundLoop(B10_LOOP_SECONDS, B10_LOOP_CYCLES, params.speed);
  const shift = createSeededRng(ID, params.seed).next();
  const beat = loopPhase(beats * loopPhase(t, loopSeconds) + shift, 1);
  const zoom = PUSH[params.energy](beat);
  const cx = size.width / 2, cy = size.height / 2;
  const reference = (BASE_CELL * unit) / params.density;
  const newborn = reference / FACTOR, largest = Math.max(size.width, size.height) * 2;
  const doc = createSvgDocument(size, { background: params.palette.accent });
  const parts: string[] = [];
  // Level spacing on screen: reference · 2^(zoom − level). Draw from the coarsest level with any line in frame down to the newborn level.
  const levels: number[] = [];
  for (let level = -8; level <= 2; level += 1) {
    const spacing = reference * FACTOR ** (zoom - level);
    if (spacing >= newborn * 0.999 && spacing <= largest) levels.push(level);
  }
  for (const level of levels) {
    const spacing = reference * FACTOR ** (zoom - level);
    const birth = smoothstep(newborn, reference, spacing); // 0 for the level being born, 1 once it is a full level
    if (birth <= 0.002) continue;
    const width = unit * (THIN + (BOLD - THIN) * smoothstep(newborn, BOLD_AT * reference, spacing));
    const colour = mixHex(params.palette.accent, params.palette.ink, birth);
    const coarsest = level === levels[0];
    const builder = pathData(2);
    const count = Math.ceil(Math.max(cx, cy) / spacing) + 1;
    for (let m = -count; m <= count; m += 1) {
      // A level owns the odd lines; the even ones belong to the next level up (the coarsest drawn level owns all).
      if (!coarsest && m % FACTOR === 0) continue;
      const offset = m * spacing;
      if (Math.abs(offset) <= cx + width) {
        const x = cx + offset;
        builder.M(x - width / 2, 0).H(x + width / 2).V(size.height).H(x - width / 2).Z();
      }
      if (Math.abs(offset) <= cy + width) {
        const y = cy + offset;
        builder.M(0, y - width / 2).H(size.width).V(y + width / 2).H(0).Z();
      }
    }
    parts.push(path(builder.toString(), { fill: colour }));
  }
  parts.push(circle(cx, cy, DOT * unit, { fill: params.palette.ink }));
  return doc.render(parts);
}, { revision: REVISION, loopSeconds: B10_LOOP_SECONDS, loopCycles: B10_LOOP_CYCLES });
