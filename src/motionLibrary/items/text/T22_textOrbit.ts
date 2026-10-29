import { circle, g, path, pathData, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import type { GlyphBox } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, layoutFittedText, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox } from "../shared";
import { compactPathD } from "./T09_hugeTextScroll";

/**
 * T22 Text Orbit (軌道), DEPTH, designed on the accent plate: the word travels
 * around a thin dashed elliptical orbit, a circle tipped toward the camera. The
 * word moves at a constant angular speed in the orbit's plane (one lap per loop),
 * passing left to right in front and right to left behind. Depth comes from scale
 * and opacity: 0.7× and 45% at the back, 1.15× and fully opaque in front, and from
 * occlusion: the word circles a solid planet (a disc in the second tone, deep aqua on
 * the aqua card, wider than the orbit is deep) and the orbit is split at its widest
 * points, so the far half of the dashes and the word at the back pass behind the
 * planet, while the near half of the dashes and the word in front pass over it. Ink
 * word and ink orbit on the aqua card (textOnBackground: paper on a dark plate, where
 * the planet takes the accent).
 *
 * Layout: the orbit tilts a little in landscape (−10°) and stands steeply on end in
 * portrait (−62°), so the word swings through the frame's height there; the word is as large as the
 * orbit allows: its ink box stays inside the 5% title-safe box at every phase,
 * front scale included. The word is at least 9% of the short side tall.
 *
 * A seamless 3 s loop (catalog loopSeconds): the orbit angle is 2π × the loop
 * phase. Energy scales the depth range (scale and opacity contrast), never the period.
 */

const ID = "T22";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
export const T22_LOOP_SECONDS = 3;
/** Scale and opacity at the back and the front (standard energy). */
export const T22_BACK_SCALE = 0.7, T22_FRONT_SCALE = 1.15, T22_BACK_OPACITY = 0.45;
/** The body the word orbits: a solid disc in the second tone, radius × the orbit's rx (larger than ry, so it rises above and below the orbit like a planet). */
const BODY_RADIUS = 0.42;
/** Orbit stroke and dash pattern (× short side). */
const STROKE = 0.006, DASH = 0.03, GAP = 0.018;
const LINE_HEIGHT = 1.04;
/** Samples of the orbit used to fit the word inside the safe box. */
const FIT_STEPS = 180;

export interface OrbitPlan {
  readonly pathD: string;
  /** Ink box of the word in block coordinates and its centre. */
  readonly ink: GlyphBox;
  readonly inkCenter: readonly [number, number];
  readonly fontSize: number;
  readonly cx: number;
  readonly cy: number;
  /** Orbit radii (px) and tilt (degrees, clockwise). */
  readonly rx: number;
  readonly ry: number;
  readonly tilt: number;
  /** Scale at the back and front, opacity at the back (energy applied). */
  readonly backScale: number;
  readonly frontScale: number;
  readonly backOpacity: number;
  readonly color: string;
  /** The orbited body: radius (px) and colour (the second tone). */
  readonly bodyRadius: number;
  readonly bodyColor: string;
}

export interface OrbitPose {
  readonly x: number;
  readonly y: number;
  /** −1 at the back … +1 in front. */
  readonly depth: number;
  readonly scale: number;
  readonly opacity: number;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Orbit shape per aspect: half-width (× the word's ink width at scale 1), openness (ry / rx) and tilt (degrees).
 * A wide, gently tilted orbit in landscape; in portrait the orbit stands steeply on end, so the word swings through the
 * frame's height while its horizontal travel stays small (and the word big).
 */
function orbitShape(size: MotionFrameSize): { readonly width: number; readonly openness: number; readonly tilt: number } {
  const aspect = size.height / size.width;
  if (aspect >= 1.3) return { width: 1.1, openness: 0.38, tilt: -62 };
  if (aspect >= 0.9) return { width: 0.8, openness: 0.36, tilt: -18 };
  return { width: 0.8, openness: 0.3, tilt: -10 };
}

/** Point on the orbit at angle θ (0 = right end, +90° = the front, at the bottom before the tilt). */
function orbitPoint(rx: number, ry: number, tilt: number, theta: number): readonly [number, number] {
  const lx = rx * Math.cos(theta), ly = ry * Math.sin(theta), c = Math.cos(radians(tilt)), s = Math.sin(radians(tilt));
  return [lx * c - ly * s, lx * s + ly * c];
}

export function orbitPlan(params: TextMotionParams, size: MotionFrameSize): OrbitPlan {
  const safe = titleSafeBox(size);
  const energy = Math.min(1.4, energyProfile(params.energy).amplitude);
  const frontScale = 1 + (T22_FRONT_SCALE - 1) * energy, backScale = Math.max(0.4, 1 - (1 - T22_BACK_SCALE) * energy);
  const backOpacity = Math.max(0.15, 1 - (1 - T22_BACK_OPACITY) * energy);
  const { width, openness, tilt } = orbitShape(size);
  // Lay out at 100 px, then scale so the word (and its orbit, which grows with it) fits the safe box at every phase.
  const face = textFace(params.font, 900), tracking = displayTracking(params.lines);
  const reference = layoutFittedText(params.lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: 100, lineHeight: LINE_HEIGHT, tracking });
  const w = reference.ink.x1 - reference.ink.x0, h = reference.ink.y1 - reference.ink.y0;
  const rx = width * w, ry = openness * rx;
  let worstX = 0, worstY = 0;
  for (let step = 0; step < FIT_STEPS; step += 1) {
    const theta = (2 * Math.PI * step) / FIT_STEPS, depth = Math.sin(theta);
    const scale = depth >= 0 ? 1 + (frontScale - 1) * depth : 1 + (1 - backScale) * depth;
    const [x, y] = orbitPoint(rx, ry, tilt, theta);
    worstX = Math.max(worstX, Math.abs(x) + (scale * w) / 2);
    worstY = Math.max(worstY, Math.abs(y) + (scale * h) / 2);
  }
  const k = Math.min(safe.width / 2 / worstX, safe.height / 2 / worstY) * 0.995;
  const fontSize = Math.floor(100 * k * 1000) / 1000;
  const text = layoutFittedText(params.lines, face, { maxWidth: 1e6, maxHeight: 1e6, maxSize: fontSize, lineHeight: LINE_HEIGHT, tracking });
  const kk = text.fontSize / 100;
  return {
    pathD: compactPathD(text.block.pathD), ink: text.ink, inkCenter: text.inkCenter, fontSize: text.fontSize,
    cx: safe.cx, cy: safe.cy, rx: rx * kk, ry: ry * kk, tilt, backScale, frontScale, backOpacity,
    color: textOnBackground(params.palette, textBackdrop(params)),
    bodyRadius: BODY_RADIUS * rx * kk, bodyColor: secondaryTone(params.palette, textBackdrop(params)),
  };
}

/** The word's pose at loop phase u: θ = 2πu + 90°, so the word starts in front (θ = 90°) and goes round left to right in front. */
export function orbitPose(plan: OrbitPlan, u: number): OrbitPose {
  // Front (θ = 90°) moves toward +x when θ decreases: run θ = 90° − 2πu.
  const theta = Math.PI / 2 - 2 * Math.PI * u, depth = Math.sin(theta);
  const [x, y] = orbitPoint(plan.rx, plan.ry, plan.tilt, theta);
  const scale = depth >= 0 ? 1 + (plan.frontScale - 1) * depth : 1 + (1 - plan.backScale) * depth;
  const opacity = depth >= 0 ? 1 : 1 + (1 - plan.backOpacity) * depth;
  return { x: plan.cx + x, y: plan.cy + y, depth, scale, opacity };
}

/** Half of the orbit as an arc path: the far half (behind the centre, θ in (180°, 360°)) or the near half. */
function orbitHalfD(plan: OrbitPlan, near: boolean): string {
  const [x0, y0] = orbitPoint(plan.rx, plan.ry, plan.tilt, 0), [x1, y1] = orbitPoint(plan.rx, plan.ry, plan.tilt, Math.PI);
  const builder = pathData(2);
  // From the right end to the left end: through the front (sweep clockwise, y-down) or through the back.
  builder.M(plan.cx + x0, plan.cy + y0).A(plan.rx, plan.ry, plan.tilt, false, near, plan.cx + x1, plan.cy + y1);
  return builder.toString();
}

export const T22_textOrbit = defineTextMotion(ID, (params, t, size) => {
  const plan = orbitPlan(params, size);
  const short = Math.min(size.width, size.height);
  const pose = orbitPose(plan, loopPhase(t, T22_LOOP_SECONDS));
  const dash = { fill: "none", stroke: plan.color, "stroke-width": STROKE * short, "stroke-linecap": "round",
    "stroke-dasharray": `${(DASH * short).toFixed(1)} ${(GAP * short).toFixed(1)}` };
  const far = path(orbitHalfD(plan, false), dash), near = path(orbitHalfD(plan, true), dash);
  const word = path(plan.pathD, {
    fill: plan.color,
    opacity: pose.opacity < 0.999 ? pose.opacity : undefined,
    transform: transform(tf.translate(pose.x, pose.y), tf.scale(pose.scale), tf.translate(-plan.inkCenter[0], -plan.inkCenter[1])),
  });
  const body = circle(plan.cx, plan.cy, plan.bodyRadius, { fill: plan.bodyColor });
  // Paint order by depth: far dashes, the word when it is behind, the body, the near dashes, the word when it is in front.
  const layers = pose.depth >= 0 ? [far, body, near, word] : [far, word, body, near];
  return createTextDocument(size, params).render(g(undefined, layers));
}, { revision: REVISION });
