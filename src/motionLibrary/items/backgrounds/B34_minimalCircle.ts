import { circlePathD, createSvgDocument, path } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion, type MotionFrameSize } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B34 Minimal Circle (ART_DIRECTION §10, base A): one big cream disc on the accent
 * card travels a wide, flat orbit, and an ink outline circle of the same size
 * follows a little behind it on the same orbit, as in the reference. Where the disc
 * pulls ahead the outline cuts across it, and where the orbit turns the two close
 * up again, so the pair drifts like a planet and its shadow ring. The orbit runs
 * along the frame's long side (across in landscape, up and down in portrait), so
 * the card around it stays open for a title.
 *
 * Loop: one orbit per cycle, one cycle per loop at speed 1 (backgroundLoop).
 * density sets the disc size (a bigger disc at low density). Energy sets how far the
 * outline trails; the seed sets the start point and the direction of travel.
 */

const ID = "B34";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B34_LOOP_SECONDS = 8;
/** Orbits per loop at speed 1. */
export const B34_LOOP_CYCLES = 1;
/** Disc radius (× short side) at density 1, and the orbit half-axes (× long side along it, × short side across). */
const RADIUS = 0.36, ORBIT_ALONG = 0.22, ORBIT_ACROSS = 0.075;
/** Outline: stroke (× short side) and how far it trails the disc (orbits) at standard energy. */
const OUTLINE = 0.017, LAG = 0.075;

/** Disc radius scale at a density: 1.1 at 0.5, 1 at 1, 0.8 at 2. */
export function discScale(density: number): number {
  return 1.2 - 0.2 * density;
}

/** Centre on the orbit at orbit phase `phase` (turns): clockwise on screen, along the long side. */
export function orbitPoint(size: MotionFrameSize, phase: number): readonly [number, number] {
  const landscape = size.width >= size.height;
  const long = Math.max(size.width, size.height), short = Math.min(size.width, size.height);
  const angle = 2 * Math.PI * phase, along = ORBIT_ALONG * long * Math.cos(angle), across = ORBIT_ACROSS * short * Math.sin(angle);
  return landscape ? [size.width / 2 + along, size.height / 2 + across] : [size.width / 2 - across, size.height / 2 + along];
}

export const B34_minimalCircle = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B34_LOOP_SECONDS, B34_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const rng = createSeededRng(ID, params.seed);
  const start = rng.next(), direction = rng.sign();
  const lag = LAG * clamp(energyProfile(params.energy).amplitude, 0.6, 1.5);
  const radius = RADIUS * 1080 * unit * discScale(params.density);
  // Orbit phase in turns: wrapped to [0, 1) so whole turns never change the numbers.
  const phase = (offset: number) => loopPhase(direction * p + start - offset, 1);
  const [dx, dy] = orbitPoint(size, phase(0)), [ox, oy] = orbitPoint(size, phase(direction * lag));

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(
    path(circlePathD(dx, dy, radius, 2), { fill: params.palette.paper }),
    path(circlePathD(ox, oy, radius, 2), { fill: "none", stroke: params.palette.ink, "stroke-width": Number((OUTLINE * 1080 * unit).toFixed(2)) }),
  );
}, { revision: REVISION, loopSeconds: B34_LOOP_SECONDS, loopCycles: B34_LOOP_CYCLES });
