import { mostContrasting } from "../../svg/color";
import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B04 Halftone Sweep (ART_DIRECTION §10, base D): a square screen of fine, crisp
 * cream dots on the dark card that a broad diagonal band of large accent dots
 * sweeps across, like a print roller inking the sheet: a short, steep leading
 * edge where the dots swell, the accent core, and a long trailing edge where the
 * dots relax back to the field. A dot switches from cream to the accent as it
 * swells past a third of its range (one colour or the other, never a blend). The
 * band lies along the frame's diagonal, so it runs corner to corner in portrait and
 * landscape alike, and travels toward the opposite corner; the next band enters as
 * the last one's tail leaves.
 *
 * Loop: the band train moves by exactly one spacing per cycle, so frame N equals
 * frame 0. One sweep per loop at speed 1; other speeds scale the sweep rate and
 * stretch the loop by 1, 2 or 4 so it still holds whole sweeps (backgroundLoop:
 * 0.5× is one sweep in 8 s, 2× two in 4 s). density sets the screen pitch
 * (the band is measured against the frame). Energy scales the swell; the seed
 * mirrors the diagonal and nudges its angle (±4°).
 */

const ID = "B04";
/** Art revision: 1 = deep-shade field on dark; 2 = §10 reference recreation (square screen, cream field, crisp accent band). */
const REVISION = 2;
export const B04_LOOP_SECONDS = 4;
/** Authored px (1080 short side) between neighbouring dots. */
const BASE_PITCH = 34;
/** Sweeps per loop at speed 1. */
export const B04_LOOP_CYCLES = 1;
/** Band profile: leading-edge and trailing-edge ramps around the band centre (fractions of the frame's extent along the sweep). */
const LEAD = 0.1, TRAIL = 0.42;
/** Band spacing: this multiple of the extent, plus the band's own width. */
const SPACING = 0.55;
/** Dot radius (× pitch) in the field and at the band core (square-screen dots touch at 0.5). */
const FIELD_DOT = 0.11, BAND_DOT = 0.45;
/** A dot wears the accent once the band strength passes this. */
const SWITCH = 0.3;

/** Band strength 0..1 at signed distance d ahead of the band centre (raised-cosine ramps, exactly 0 beyond them). */
export function sweepBandStrength(d: number, lead: number, trail: number): number {
  const x = d >= 0 ? d / lead : -d / trail;
  return x >= 1 ? 0 : (0.5 + 0.5 * Math.cos(Math.PI * x)) ** 1.2;
}

export const B04_halftoneSweep = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.7, 1.1);
  const pitch = (BASE_PITCH * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B04_LOOP_SECONDS, B04_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const mirror = rng.chance(0.5) ? 1 : -1;
  // Perpendicular to the frame diagonal: the band runs corner to corner and travels toward the far corner.
  const angle = Math.atan2(size.width, size.height) * mirror + (rng.range(-4, 4) * Math.PI) / 180;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const cx = size.width / 2, cy = size.height / 2;
  // Extent of the frame along the sweep, measured from the centre.
  const halfExtent = (Math.abs(ca) * size.width + Math.abs(sa) * size.height) / 2;
  const lead = LEAD * 2 * halfExtent, trail = TRAIL * 2 * halfExtent;
  const spacing = SPACING * 2 * halfExtent + lead + trail;
  // Band k sits at s = start + k · spacing + offset; offset runs one spacing per cycle.
  const offset = spacing * ((cycles * u) % 1);
  const start = -halfExtent - lead;
  const swell = (BAND_DOT - FIELD_DOT) * amplitude;
  const field = mostContrasting(params.palette.bg, [params.palette.paper, params.palette.ink]);
  let fieldD = "", accentD = "";

  const columns = Math.ceil(cx / pitch) + 1, rows = Math.ceil(cy / pitch) + 1;
  for (let row = -rows; row <= rows; row += 1) {
    for (let column = -columns; column <= columns; column += 1) {
      const x = cx + column * pitch, y = cy + row * pitch;
      const s = (x - cx) * ca + (y - cy) * sa;
      // Nearest band ahead or behind (bands are far apart, so at most two can touch a dot).
      const k = Math.floor((s - start - offset) / spacing);
      const centre = start + offset + k * spacing;
      const strength = Math.max(sweepBandStrength(s - centre, lead, trail), sweepBandStrength(s - centre - spacing, lead, trail));
      const dot = circlePathD(x, y, pitch * (FIELD_DOT + swell * strength), 1);
      if (strength > SWITCH) accentD += dot;
      else fieldD += dot;
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(fieldD, { fill: field }), path(accentD, { fill: params.palette.accent }));
}, { revision: REVISION, loopSeconds: B04_LOOP_SECONDS, loopCycles: B04_LOOP_CYCLES });
