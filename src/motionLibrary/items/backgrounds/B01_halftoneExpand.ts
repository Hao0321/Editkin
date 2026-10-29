import { mostContrasting } from "../../svg/color";
import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B01 Halftone Expand (ART_DIRECTION §10, base D): a square halftone screen on the
 * dark card, driven by circular fronts that travel out from the centre. Each pulse
 * a pink front leaves the centre and swells the dots it passes into large accent
 * dots, almost touching, until the pink disc fills the frame; then a dark front
 * follows it out and shrinks the dots back to the fine cream field, so the pink
 * becomes a ring that expands out of the frame. The next pink front leaves the
 * centre before that ring has gone. A dot changes size only as a front crosses it,
 * so the frame never changes luminance everywhere at once.
 *
 * As a dot swells it is cream first, then the deep shade (accent2), then the accent:
 * a ring of cream dots runs just ahead of the pink, as in the reference. Colours
 * switch per dot (no blends), so every dot is a crisp, full-strength role.
 *
 * Loop: pulses per loop come from backgroundLoop (2 at speed 1); every term is
 * periodic in its loop, so frame N (t = loop) equals frame 0. density sets the screen
 * pitch. Energy scales the disc dots; the seed shifts the pulse phase.
 */

const ID = "B01";
/**
 * Art revision: 1 = Phase 1 ring wave; 2 = §10 colours on the ring wave; 3 = §10 reference recreation
 * (expanding disc pulse, then a global exhale); 4 = travelling fronts (the pink disc becomes an expanding ring).
 */
const REVISION = 4;
export const B01_LOOP_SECONDS = 4;
/** Pulses per loop at speed 1. */
export const B01_LOOP_CYCLES = 2;
/** Authored px (1080 short side) between neighbouring dots. */
const BASE_PITCH = 36;
/** Dot radii (× pitch): the fine field and the full disc (0.5 touches). */
const FIELD_DOT = 0.09, DISC_DOT = 0.46;
/**
 * Pulse timing (fractions of one pulse): a front takes TRAVEL to run from the centre to `reach`, two pitches beyond
 * the farthest corner, so it passes the corner itself at about 0.62. The dark front leaves the centre at DARK_AT,
 * just after the pink has filled the frame; the dark front passes the corner at about DARK_AT + 0.62 > 1, so the
 * next pink front leaves the centre before the pink ring has left the frame.
 */
const TRAVEL = 0.72, DARK_AT = 0.66;
/** A dot swells (or shrinks) over SWAP of a pulse once a front reaches it. */
const SWAP = 0.12;
/** The front decelerates as it expands: radius = reach · (1 − (1 − τ/TRAVEL)^FRONT_EASE). */
const FRONT_EASE = 1.4;
/** Colour steps by dot radius (× pitch): below DEEP the dot is cream, below ACCENT the deep shade, above it the accent. */
const DEEP = 0.17, ACCENT = 0.31;

/** Time (fraction of a pulse) for a front to reach distance fraction `reach01` (0 = centre, 1 = past the farthest corner). */
export function frontArrival(reach01: number): number {
  return TRAVEL * (1 - (1 - Math.min(1, Math.max(0, reach01))) ** (1 / FRONT_EASE));
}

/** Swell 0..1 of a dot whose pulse phase is a ∈ [0, 1) (0 = the pink front has just reached it). */
export function pulseSwell(a: number): number {
  return smoothstep(0, SWAP, a) - smoothstep(DARK_AT, DARK_AT + SWAP, a);
}

export const B01_halftoneExpand = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const pitch = (BASE_PITCH * unit) / params.density;
  const { loopSeconds, cycles } = backgroundLoop(B01_LOOP_SECONDS, B01_LOOP_CYCLES, params.speed);
  const rng = createSeededRng(ID, params.seed);
  // Pulses since the loop start, plus a seeded phase.
  const pulses = cycles * loopPhase(t, loopSeconds) + rng.next();
  const disc = DISC_DOT * clamp(energyProfile(params.energy).amplitude, 0.85, 1.08);
  const cx = size.width / 2, cy = size.height / 2;
  const reach = Math.hypot(cx, cy) + 2 * pitch;
  const neutral = mostContrasting(params.palette.bg, [params.palette.paper, params.palette.ink]);
  let fieldD = "", deepD = "", accentD = "";

  const columns = Math.ceil(cx / pitch) + 1, rows = Math.ceil(cy / pitch) + 1;
  for (let row = -rows; row <= rows; row += 1) {
    const y = cy + row * pitch;
    for (let column = -columns; column <= columns; column += 1) {
      const x = cx + column * pitch;
      const phase = pulses - frontArrival(Math.hypot(x - cx, y - cy) / reach);
      const r = FIELD_DOT + (disc - FIELD_DOT) * pulseSwell(phase - Math.floor(phase));
      const dot = circlePathD(x, y, r * pitch, 2);
      if (r < DEEP) fieldD += dot;
      else if (r < ACCENT) deepD += dot;
      else accentD += dot;
    }
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(path(fieldD, { fill: neutral }), path(deepD, { fill: params.palette.accent2 }), path(accentD, { fill: params.palette.accent }));
}, { revision: REVISION, loopSeconds: B01_LOOP_SECONDS, loopCycles: B01_LOOP_CYCLES });
