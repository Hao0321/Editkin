import { mostContrasting } from "../../svg/color";
import { createSvgDocument, path, pathData } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B12 Rotating Grid (ART_DIRECTION §10, base D): two open square lattices on the
 * dark card, one of crisp cream lines and one of accent lines, laid over each
 * other at the frame centre and turning in opposite directions, as in the
 * reference. Where they cross they print a moiré: large, slow flowers near
 * alignment, a plain plaid for the instant they coincide, a busier lattice as
 * they part. The turn eases: it lingers near alignment, where the flowers are
 * largest, and passes the 45° crossing faster.
 *
 * Loop: a square lattice repeats every 90°, so each lattice turns a whole 90° per
 * cycle (the cream one way, the accent the other); their relative angle sweeps
 * through alignment twice per cycle. One cycle per loop at speed 1; other speeds
 * scale the turn and stretch the loop by 1, 2 or 4 so it still holds whole cycles
 * (backgroundLoop); density sets the line pitch. Energy scales the
 * line weight; the seed turns the pair as a whole.
 */

const ID = "B12";
/** Art revision: 1 = two accent lattices at 55% opacity swapping places; 2 = §10 reference recreation (cream and accent lattices, 90° counter-turn). */
const REVISION = 2;
export const B12_LOOP_SECONDS = 12;
/** 90° counter-turn cycles per loop at speed 1. */
export const B12_LOOP_CYCLES = 1;
/** Line pitch and width (authored px). */
const BASE_PITCH = 76, LINE = 3.2;
/**
 * Turn easing: each lattice turns 45° · G(φ) from its start, G(φ) = φ − LINGER · sin(2πφ) / 2π, with φ running two
 * whole units per cycle. The relative angle is 90° · G(φ): aligned at whole φ, where G moves at 1 − LINGER of the
 * mean rate, and 45° apart at half φ, where it moves at 1 + LINGER.
 */
const LINGER = 0.6;

/**
 * Path data for a square lattice of pitch `pitch` turned `degrees` about (cx, cy), covering a disc of radius `reach`.
 * shift 0 puts lines through the centre; shift 0.5 puts the centre in the middle of a cell. Both line sets are symmetric
 * about the centre, so a 90° turn maps the lattice onto itself.
 */
function latticeD(cx: number, cy: number, pitch: number, degrees: number, reach: number, shift: 0 | 0.5): string {
  const builder = pathData(2);
  const count = Math.ceil(reach / pitch);
  for (const angle of [degrees, degrees + 90]) {
    const radians = (angle * Math.PI) / 180, ca = Math.cos(radians), sa = Math.sin(radians);
    for (let index = -count; index <= count - (shift ? 1 : 0); index += 1) {
      // A line through cx + (index + shift) · pitch · normal, running along (ca, sa) for ± reach.
      const offset = (index + shift) * pitch;
      const ox = cx - offset * sa, oy = cy + offset * ca;
      builder.M(ox - reach * ca, oy - reach * sa).L(ox + reach * ca, oy + reach * sa);
    }
  }
  return builder.toString();
}

export const B12_rotatingGrid = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const weight = clamp(energyProfile(params.energy).amplitude, 0.7, 1.3);
  const { loopSeconds, cycles } = backgroundLoop(B12_LOOP_SECONDS, B12_LOOP_CYCLES, params.speed);
  const u = loopPhase(t, loopSeconds);
  const base = createSeededRng(ID, params.seed).next() * 90;
  const phi = 2 * cycles * u;
  const turn = 45 * (phi - (LINGER * Math.sin(2 * Math.PI * phi)) / (2 * Math.PI));
  const cx = size.width / 2, cy = size.height / 2;
  const pitch = (BASE_PITCH * unit) / params.density;
  const reach = Math.hypot(cx, cy) + pitch;
  const stroke = (colour: string) => ({ fill: "none", stroke: colour, "stroke-width": LINE * unit * weight });
  const cream = mostContrasting(params.palette.bg, [params.palette.paper, params.palette.ink]);
  const doc = createSvgDocument(size, { background: params.palette.bg });
  return doc.render(
    // Half a pitch apart, so at alignment the two lattices interleave into a plaid instead of hiding each other.
    path(latticeD(cx, cy, pitch, base + turn, reach, 0), stroke(cream)),
    path(latticeD(cx, cy, pitch, base - turn, reach, 0.5), stroke(params.palette.accent)),
  );
}, { revision: REVISION, loopSeconds: B12_LOOP_SECONDS, loopCycles: B12_LOOP_CYCLES });
