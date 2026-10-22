import { circlePathD, g, path, tf, transform } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { polylineSampler, type PathSampler } from "../../svg/glyphs";
import { placeAlongPath, type FollowPath } from "../../svg/pathFollow";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  createTextDocument, displayTracking, layoutFittedText, placeWordGlyphs, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
  type WordGlyph,
} from "../shared";

/**
 * T71 Roller Path (無限軌道), RHYTHM, shown on the paper plate: a bold dotted ∞ track
 * and the characters riding it like a roller-coaster train: car i sits at arc length
 * s − i·gap (1.3 em apart, rigidly coupled) and turns to the track's tangent, upside
 * down through the far side of each loop. The train speeds up through the crossing
 * and slows in the loops: s(u) = L·(u − k·sin(4πu)/(4π)), k = 0.5, so the speed is
 * L·(1 − k·cos 4πu): slowest at the tips (u = 0, ½), fastest at the crossings (L/4
 * and 3L/4). One lap per loop: a seamless 3 s loop (catalog loopSeconds), frame 0
 * equals the frame at 3 s.
 *
 * r2 (Claude's p2k review: "small on a mostly empty cream frame"): the track is a
 * lemniscate of Bernoulli with its loops widened to round ones (the half-width across
 * the track is half the half-length along it), arc-length sampled. It spans 85% of
 * the safe width: along its length in landscape and square frames, across it in
 * portrait, where the ∞ stands upright (the loop uses the long side, as T40 does). It
 * shrinks only as far as needed for every car, turned to the tangent, to stay inside
 * the 5% title-safe box. The characters are 13% of the short side (never below 12%).
 * Rounder loops also open the tips, so the cars ride them without crowding.
 *
 * Colours: ink cars alternating with the deep teal on the cream card (teal itself is
 * 1.6:1 on cream, so §0 gives its deep shade); cream and teal on the dark card. The
 * track is the second tone (the deep teal on cream) at 60%, in dots 12% of the glyph
 * height across, one every 0.45 glyph heights. Energy scales the speed swing, never the
 * lap time.
 */

const ID = "T71";
const REVISION = 2;
export const T71_LOOP_SECONDS = 3;
/** Speed swing k (standard energy), track dot pitch and radius (× glyph height), dot opacity. */
export const T71_SPEED_SWING = 0.5, T71_DOT_PITCH = 0.45, T71_DOT_RADIUS = 0.06, T71_DOT_OPACITY = 0.75;
/** Track span (share of the safe width), glyph height (× the short side), loop roundness (half-width across ÷ half-length along). */
export const T71_TRACK_FILL = 0.85, T71_GLYPH = 0.16, T71_ROUNDNESS = 0.5;
/** Car spacing (em) and the chords the track is drawn with. */
const CAR_GAP = 1.3, LINE_HEIGHT = 1, STEPS = 1440;
/** max |sin t·cos t / (1 + sin² t)|: the half-width of a lemniscate of Bernoulli with half-length 1. */
const LEMNISCATE_HALF_WIDTH = Math.SQRT2 / 4;

/** The ∞ about (0, 0): half-length `along` (horizontal, or vertical when upright), half-width `across`. Point 0 is the right
 * (upright: bottom) tip, heading down (upright: left) into its loop; the crossing is a quarter of the way round. */
function trackPoints(along: number, across: number, upright: boolean): Array<[number, number]> {
  const stretch = across / LEMNISCATE_HALF_WIDTH, points: Array<[number, number]> = [];
  for (let index = 0; index < STEPS; index += 1) {
    const t = (2 * Math.PI * index) / STEPS, s = Math.sin(t), c = Math.cos(t), d = 1 + s * s;
    const x = (along * c) / d, y = (stretch * s * c) / d;
    points.push(upright ? [-y, x] : [x, y]);
  }
  return points;
}

/** The round-loop ∞ centred on (cx, cy), as an arc-length FollowPath. */
export function rollerTrack(cx: number, cy: number, along: number, upright: boolean): FollowPath {
  const sampler = polylineSampler(trackPoints(along, T71_ROUNDNESS * along, upright).map(([x, y]) => [cx + x, cy + y] as const), true);
  return Object.assign(((distance: number) => sampler(distance)) as PathSampler, { totalLength: sampler.totalLength, closed: true });
}

export interface RollerPlan {
  readonly cars: readonly (WordGlyph & { readonly color: string })[];
  /** Pen offset from each car's ink centre (frame px, before rotation) is car.x − car.cx, car.y − car.cy. */
  readonly track: FollowPath;
  /** Half-length of the ∞ along its long axis (px); upright in portrait. */
  readonly along: number;
  readonly upright: boolean;
  readonly dots: readonly { readonly x: number; readonly y: number }[];
  readonly glyphHeight: number;
  readonly gap: number;
  readonly swing: number;
  readonly dotColor: string;
  readonly dotRadius: number;
}

export function rollerPlan(params: TextMotionParams, size: MotionFrameSize): RollerPlan {
  const safe = titleSafeBox(size), short = Math.min(size.width, size.height);
  const face = textFace(params.font, 900), lines = [params.lines.join("")];
  const options = { maxWidth: 1e6, maxHeight: 1e6, lineHeight: LINE_HEIGHT, tracking: displayTracking(lines) };
  // Glyphs at T71_GLYPH of the short side (measured at 100 px, rounded down).
  const reference = placeWordGlyphs(layoutFittedText(lines, face, { ...options, maxSize: 100 }), 0, 0);
  const text = layoutFittedText(lines, face, { ...options, maxSize: Math.floor(((100 * T71_GLYPH * short) / reference.glyphHeight) * 1000) / 1000 });
  const { glyphs, glyphHeight } = placeWordGlyphs(text, 0, 0);
  const halfWidth = Math.max(...glyphs.map(glyph => Math.max(glyph.cx - glyph.box.x0, glyph.box.x1 - glyph.cx)));
  const halfHeight = Math.max(...glyphs.map(glyph => Math.max(glyph.cy - glyph.box.y0, glyph.box.y1 - glyph.cy)));
  // The ∞ spans T71_TRACK_FILL of the safe width (its length in landscape and square, its width when upright in portrait)
  // and shrinks only as far as every car, turned to the tangent of its chord, needs to stay inside the safe box.
  const upright = size.height > size.width * 1.1;
  const target = upright ? (T71_TRACK_FILL * safe.width) / 2 / T71_ROUNDNESS : (T71_TRACK_FILL * safe.width) / 2;
  const unit = trackPoints(target, T71_ROUNDNESS * target, upright);
  let fit = 1;
  for (let index = 0; index < unit.length; index += 1) {
    const [x0, y0] = unit[index], [x1, y1] = unit[(index + 1) % unit.length];
    const angle = Math.atan2(y1 - y0, x1 - x0), c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const roomX = safe.width / 2 - (halfWidth * c + halfHeight * s), roomY = safe.height / 2 - (halfWidth * s + halfHeight * c);
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      if (Math.abs(x) > 1e-9) fit = Math.min(fit, roomX / Math.abs(x));
      if (Math.abs(y) > 1e-9) fit = Math.min(fit, roomY / Math.abs(y));
    }
  }
  const along = target * fit * 0.999;
  const backdrop = textBackdrop(params);
  const first = textOnBackground(params.palette, backdrop), second = secondaryTone(params.palette, backdrop);
  const track = rollerTrack(safe.cx, safe.cy, along, upright);
  return {
    cars: glyphs.map((glyph, index) => ({ ...glyph, color: index % 2 === 0 ? first : second })),
    track, along, upright, dots: placeAlongPath(track, Math.round(track.totalLength / (T71_DOT_PITCH * glyphHeight))).map(point => ({ x: point.x, y: point.y })),
    glyphHeight, gap: CAR_GAP * text.fontSize, swing: Math.min(0.85, T71_SPEED_SWING * energyProfile(params.energy).amplitude),
    dotColor: second, dotRadius: T71_DOT_RADIUS * glyphHeight,
  };
}

/** Arc length of the train's head at loop phase u: s = L·(u − k·sin(4πu)/(4π)) (fast at the crossings, slow at the tips). */
export function headDistance(plan: RollerPlan, u: number): number {
  return plan.track.totalLength * (u - (plan.swing * Math.sin(4 * Math.PI * u)) / (4 * Math.PI));
}

/** Position and tangent angle of car `index` at loop phase u. */
export function carPose(plan: RollerPlan, index: number, u: number): { readonly x: number; readonly y: number; readonly angle: number } {
  const length = plan.track.totalLength;
  const distance = (((headDistance(plan, u) - index * plan.gap) % length) + length) % length;
  const sample = plan.track(distance);
  return { x: sample.x, y: sample.y, angle: sample.angle };
}

export const T71_rollerPath = defineTextMotion(ID, (params, t, size) => {
  const plan = rollerPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T71_LOOP_SECONDS);
  let dots = "";
  for (const dot of plan.dots) dots += circlePathD(dot.x, dot.y, plan.dotRadius, 1);
  // The last car first, the head on top.
  const cars = [...plan.cars].reverse().map(car => {
    const pose = carPose(plan, car.index, u);
    return path(car.pathD, {
      fill: car.color,
      transform: transform(tf.translate(pose.x, pose.y), tf.rotate(pose.angle), tf.translate(car.x - car.cx, car.y - car.cy)),
    });
  });
  return doc.render(path(dots, { fill: plan.dotColor, "fill-opacity": T71_DOT_OPACITY }), g(undefined, cars));
}, { revision: REVISION });
