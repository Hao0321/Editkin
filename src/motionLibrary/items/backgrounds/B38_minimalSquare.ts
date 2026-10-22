import { createSvgDocument, path, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, energyProfile, loopPhase, sineInOut } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { springSettle } from "../text/scatter";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B38 Minimal Square (ART_DIRECTION §10, base A): a cream square inside an ink
 * outline square, centred on the accent card, as in the reference. On every beat
 * the outline winds up (a slight counter-turn), then snaps a quarter turn with a
 * springy overshoot and a small kick in size, and settles square again; the cream
 * square leans the other way during the wind-up and follows the snap a moment
 * later, so the two shapes rub against each other for an instant and then lock back
 * into the calm, aligned mark.
 *
 * Loop: one quarter turn per beat (a square looks the same after it), two beats per
 * loop at speed 1 (backgroundLoop). density sets extra echo outlines that snap in
 * cascade (one outline at density 1, three at 2) and shrinks the mark a little.
 * Energy sets the wind-up, overshoot and kick; the seed sets the turn direction.
 */

const ID = "B38";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B38_LOOP_SECONDS = 4;
/** Beats per loop at speed 1 (one quarter-turn snap per beat). */
export const B38_LOOP_CYCLES = 2;
/** Outline side and cream side (× short side) at density 1; outline stroke (× short side); echo outline growth. */
const OUTLINE = 0.5, CREAM = 0.34, STROKE = 0.021, ECHO_GROWTH = 0.2;
/** Beat timing (× beat): wind-up until SNAP, the spring settles within SETTLE after it; the cream follows FOLLOW later. */
const SNAP = 0.56, SETTLE = 0.34, FOLLOW = 0.05, ECHO_DELAY = 0.045;
/** Wind-up counter-turn (degrees) and size kick at standard energy. */
const WIND = 7, KICK = 0.07;

export interface SquarePose {
  /** Degrees, -45 … 45 (a square repeats every quarter turn). */
  readonly degrees: number;
  readonly scale: number;
}

/** Outline pose at beat phase f (0 … 1): wind-up, then a springy quarter-turn snap that settles exactly by the end. */
export function snapPose(f: number, wind: number, kick: number, damping: number): SquarePose {
  const local = f - Math.floor(f);
  let degrees: number, scale = 1;
  if (local < SNAP) {
    degrees = -wind * sineInOut(local / SNAP);
  } else {
    // Normalised spring time: the settle window maps to 1 "second" of springSettle.
    const s = (local - SNAP) / SETTLE;
    degrees = -wind + (90 + wind) * springSettle(s, { frequency: 1.35, damping, settleSeconds: 1 });
    scale = 1 + kick * Math.sin(Math.PI * clamp(s / 0.6, 0, 1));
  }
  // Fold into −45 … 45 so a finished quarter turn draws exactly what the start of the beat did.
  const folded = degrees - 90 * Math.round(degrees / 90);
  return { degrees: folded === 0 ? 0 : folded, scale };
}

/** Echo outlines at a density: 1 at 0.5–1, 2 at 1.25–1.5, 3 at 1.75–2. */
export function squareOutlines(density: number): number {
  return Math.max(1, Math.round(2 * density - 1));
}

function squarePathD(cx: number, cy: number, side: number, degrees: number): string {
  const half = side / 2, angle = (degrees * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
  const corners: Point2[] = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  return polygonPathD(corners, 2);
}

export const B38_minimalSquare = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B38_LOOP_SECONDS, B38_LOOP_CYCLES, params.speed);
  const beat = cycles * loopPhase(t, loopSeconds);
  const amplitude = clamp(energyProfile(params.energy).amplitude, 0.55, 1.7);
  const wind = WIND * amplitude, kick = KICK * amplitude, damping = clamp(0.62 / amplitude, 0.32, 0.9);
  const short = 1080 * unit, shrink = 1.15 - 0.15 * params.density;
  const cx = size.width / 2, cy = size.height / 2;
  const direction = createSeededRng(ID, params.seed).sign();
  const parts: string[] = [];

  // The cream square leans against the wind-up, then follows the snap a moment later with less kick.
  const cream = snapPose(beat - FOLLOW, -0.6 * wind, kick * 0.4, Math.min(0.9, damping * 1.15));
  parts.push(path(squarePathD(cx, cy, CREAM * short * shrink * cream.scale, direction * cream.degrees), { fill: params.palette.paper }));

  const outlines = squareOutlines(params.density);
  for (let echo = outlines - 1; echo >= 0; echo -= 1) {
    const pose = snapPose(beat - echo * ECHO_DELAY, wind, kick, damping);
    const side = OUTLINE * short * shrink * (1 + ECHO_GROWTH * echo) * pose.scale;
    parts.push(path(squarePathD(cx, cy, side, direction * pose.degrees), {
      fill: "none", stroke: params.palette.ink, "stroke-width": Number((STROKE * short).toFixed(2)), "stroke-linejoin": "miter",
    }));
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(parts);
}, { revision: REVISION, loopSeconds: B38_LOOP_SECONDS, loopCycles: B38_LOOP_CYCLES });
