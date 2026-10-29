import { createSvgDocument, path, polygonPathD } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B30 Confetti Fall (ART_DIRECTION §10, base A): paper confetti tumbles down the accent
 * card, as in the reference: small cream and ink rectangles (a few in the deep shade)
 * fall at their own pace, sway from side to side, spin, and flip in 3D (the width is
 * scaled by cos of the flip angle, so a piece turns edge-on and back). The pieces are
 * kept chunky (38–62 px at 1080), and a flip never goes fully edge-on (the width stays at
 * least 28%), so no piece turns into a sliver that would shimmer after compression.
 *
 * Loop: every piece falls through the frame a whole number of times per cycle (1 or 2)
 * and sways, spins and flips whole numbers of times; a piece wraps from the bottom to
 * the top only while it is fully off-frame. One cycle per loop at speed 1
 * (backgroundLoop). density sets the piece count. Energy scales the sway; the seed sets
 * everything else.
 */

const ID = "B30";
/** Art revision: 1 = first implementation (p2o-bg3). */
const REVISION = 1;
export const B30_LOOP_SECONDS = 4;
/** Fall cycles per loop at speed 1. */
export const B30_LOOP_CYCLES = 1;
/** Pieces per million px² at density 1 (about 60 in a 1080×1920 frame). */
const PER_MEGAPIXEL = 30;
/** Piece size: long side (authored px) and aspect range. */
const SIZE = [38, 62], ASPECT = [0.5, 0.85];
/** A flipping piece never turns fully edge-on: its width stays at least this share (no slivers, H.264-safe). */
const MIN_FLIP = 0.28;
/** Sway amplitude (authored px) at standard energy. */
const SWAY = 36;
/** Colour shares: cream, then ink, then deep shade. */
const CREAM_SHARE = 0.5, INK_SHARE = 0.35;

/** Fall position 0..1 (0 = above the frame, 1 = below it) of a piece falling `k` times per cycle at cycle phase p. */
export function fallPosition(p: number, k: number, offset: number): number {
  const f = k * p + offset;
  return f - Math.floor(f);
}

export const B30_confettiFall = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size);
  const { loopSeconds, cycles } = backgroundLoop(B30_LOOP_SECONDS, B30_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const sway = SWAY * unit * clamp(energyProfile(params.energy).amplitude, 0.6, 1.4);
  const rng = createSeededRng(ID, params.seed);
  const count = Math.max(8, Math.round(((size.width * size.height) / 1e6) * PER_MEGAPIXEL * params.density));
  const margin = (SIZE[1] + 6) * unit;
  const fills = { cream: [] as string[], ink: [] as string[], deep: [] as string[] };

  for (let index = 0; index < count; index += 1) {
    const piece = rng.fork(index);
    const long = piece.range(SIZE[0], SIZE[1]) * unit, wide = long * piece.range(ASPECT[0], ASPECT[1]);
    const x0 = piece.range(0, 1) * size.width;
    const k = piece.chance(0.5) ? 2 : 1, offset = piece.next();
    const swayTimes = piece.int(1, 2), swayPhase = piece.next();
    const spins = piece.pick([-1, 1] as const), spinStart = piece.range(0, 2 * Math.PI);
    const flips = piece.int(1, 3), flipStart = piece.next();
    const pick = piece.next();
    const colour = pick < CREAM_SHARE ? "cream" : pick < CREAM_SHARE + INK_SHARE ? "ink" : "deep";
    const y = -margin + fallPosition(p, k, offset) * (size.height + 2 * margin);
    // Fully off-frame above or below: skip (this is where a piece wraps, so the loop stays seamless).
    if (y < -long || y > size.height + long) continue;
    const x = x0 + sway * Math.sin(2 * Math.PI * (swayTimes * p + swayPhase));
    const spin = spinStart + spins * 2 * Math.PI * p;
    const cosFlip = Math.cos(2 * Math.PI * (flips * p + flipStart));
    const flip = Math.sign(cosFlip || 1) * (MIN_FLIP + (1 - MIN_FLIP) * Math.abs(cosFlip));
    const hw = (wide / 2) * flip, hh = long / 2, ca = Math.cos(spin), sa = Math.sin(spin);
    fills[colour].push(polygonPathD([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => [x + px * ca - py * sa, y + px * sa + py * ca] as const), 1));
  }

  const doc = createSvgDocument(size, { background: params.palette.accent });
  return doc.render(path(fills.deep.join(""), { fill: params.palette.accent2 }), path(fills.ink.join(""), { fill: params.palette.ink }),
    path(fills.cream.join(""), { fill: params.palette.paper }));
}, { revision: REVISION, loopSeconds: B30_LOOP_SECONDS, loopCycles: B30_LOOP_CYCLES });
