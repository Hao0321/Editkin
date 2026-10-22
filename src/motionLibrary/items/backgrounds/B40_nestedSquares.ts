import { createSvgDocument, path, polygonPathD, type Point2 } from "../../svg/document";
import { clamp, energyProfile, loopPhase } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import { defineBackgroundMotion } from "../../types";
import { frameUnit } from "../shared";
import { backgroundLoop } from "./backgroundLoop";

/**
 * B40 Nested Squares (ART_DIRECTION §10, base D): nested square outlines on the
 * dark card, cream and the accent in turn from the centre out, each turned a little
 * more than the one inside it, as in the reference. The whole nest sways back and
 * forth: the twist swings from one side through square to the other, outer squares
 * swinging furthest and lagging a touch behind the inner ones, so it twists like a
 * spring. The largest squares run off the frame; cream lines are bolder than the
 * accent ones.
 *
 * Loop: one sway (there and back) per cycle, one cycle per loop at speed 1
 * (backgroundLoop). density sets the number of squares (9 at density 1). Energy
 * scales the twist; the seed sets which way the nest swings first.
 */

const ID = "B40";
/** Art revision: 1 = first implementation (p2p-bg4). */
const REVISION = 1;
export const B40_LOOP_SECONDS = 6;
/** Sways per loop at speed 1. */
export const B40_LOOP_CYCLES = 1;
/** Squares at density 1; smallest and largest side (× short side). */
const BASE_SQUARES = 9, SMALLEST = 0.1, LARGEST = 1.3;
/** Twist per square (degrees) at the peak of the sway, and the sway lag per square (cycles). */
const TWIST = 2.6, LAG = 0.018;
/** Strokes (× short side): cream and accent. */
const PAPER_STROKE = 0.0105, ACCENT_STROKE = 0.0068;

/** Squares at a density (9 at 1, 5 at 0.5, 18 at 2). */
export function nestedSquares(density: number): number {
  return Math.max(4, Math.round(BASE_SQUARES * density));
}

/** Rotation (degrees) of square k (0 = innermost) at cycle phase p. */
export function squareTwist(k: number, p: number, twist: number, direction: number): number {
  return direction * k * twist * Math.sin(2 * Math.PI * (p - k * LAG));
}

export const B40_nestedSquares = defineBackgroundMotion(ID, (params, t, size) => {
  const unit = frameUnit(size), short = 1080 * unit;
  const { loopSeconds, cycles } = backgroundLoop(B40_LOOP_SECONDS, B40_LOOP_CYCLES, params.speed);
  const p = cycles * loopPhase(t, loopSeconds);
  const direction = createSeededRng(ID, params.seed).sign();
  const twist = TWIST * clamp(energyProfile(params.energy).amplitude, 0.6, 1.5);
  const count = nestedSquares(params.density);
  const cx = size.width / 2, cy = size.height / 2;
  const paper: string[] = [], accent: string[] = [];

  for (let k = 0; k < count; k += 1) {
    const side = short * (SMALLEST + ((LARGEST - SMALLEST) * k) / (count - 1)), half = side / 2;
    const angle = (squareTwist(k, p, twist, direction) * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
    const corners: Point2[] = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
    (k % 2 === 0 ? paper : accent).push(polygonPathD(corners, 2));
  }

  const doc = createSvgDocument(size, { background: params.palette.bg });
  const stroke = (colour: string, width: number) => ({ fill: "none", stroke: colour, "stroke-width": Number((width * short).toFixed(2)), "stroke-linejoin": "miter" });
  return doc.render(path(accent.join(""), stroke(params.palette.accent, ACCENT_STROKE)), path(paper.join(""), stroke(params.palette.paper, PAPER_STROKE)));
}, { revision: REVISION, loopSeconds: B40_LOOP_SECONDS, loopCycles: B40_LOOP_CYCLES });
