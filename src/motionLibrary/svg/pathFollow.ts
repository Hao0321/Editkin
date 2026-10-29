import { circleSampler, polylineSampler, type PathSample, type PathSampler } from "./glyphs";

/**
 * Path-follow helpers (DESIGN §8): arc-length-parameterised paths that return a
 * point and its tangent (degrees, 0 = +x, clockwise positive in SVG y-down) for a
 * distance in px. Users: T22 orbit (ellipse), T40 / T71 figure-8 (lemniscate),
 * T56 / T68 rings (circle), T64 fan (circle arc), T73 spiral arms.
 *
 * Every path is a PathSampler, so it plugs straight into glyphs.layoutOnPath, and
 * carries totalLength and closed. Closed paths wrap any distance; open paths
 * extend along their end segments (use placeAlongPath's wrap to respawn).
 * Curves are approximated by `steps` chords (default 720) and resampled by arc
 * length, so equal distances are equal visible spacing. Deterministic, browser-safe.
 *
 * Usage (T71: characters ride a figure-8 like a train):
 *   const track = lemniscatePath(cx, cy, 0.4 * size.width);
 *   const cars = placeAlongPath(track, glyphs.length, { spacing: -gap, phase: t / loopSeconds });
 *   cars.map(car => path(glyphPathD[car.index], { transform: `translate(${car.x} ${car.y}) rotate(${car.angle})` }));
 */

export type FollowPath = PathSampler & { readonly totalLength: number; readonly closed: boolean };

const radians = (degrees: number) => (degrees * Math.PI) / 180;

function withMeta(sampler: PathSampler, totalLength: number, closed: boolean): FollowPath {
  return Object.assign(((distance: number) => sampler(distance)) as PathSampler, { totalLength, closed });
}

function closedCurve(fn: (u: number) => readonly [number, number], steps: number): FollowPath {
  if (!Number.isInteger(steps) || steps < 8 || steps > 100_000) throw new Error("path steps must be an integer in 8..100000");
  const points: Array<[number, number]> = [];
  for (let index = 0; index < steps; index += 1) { const [x, y] = fn(index / steps); points.push([x, y]); }
  const sampler = polylineSampler(points, true);
  return withMeta(sampler, sampler.totalLength, true);
}

function rotateAbout(cx: number, cy: number, degrees: number): (x: number, y: number) => readonly [number, number] {
  const c = Math.cos(radians(degrees)), s = Math.sin(radians(degrees));
  return (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
}

/** Exact circle: distance 0 at startDegrees (−90 = top), clockwise by default; tangent angle = travel direction. */
export function circlePath(cx: number, cy: number, radius: number, options: { readonly startDegrees?: number; readonly clockwise?: boolean } = {}): FollowPath {
  if (!(radius > 0)) throw new Error("circlePath needs a positive radius");
  return withMeta(circleSampler(cx, cy, radius, options.startDegrees ?? -90, options.clockwise ?? true), 2 * Math.PI * radius, true);
}

/** Ellipse with radii rx, ry, rotated by rotationDegrees; distance 0 at parametric angle startDegrees (−90 = top). */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number, options: { readonly startDegrees?: number; readonly clockwise?: boolean;
  readonly rotationDegrees?: number; readonly steps?: number } = {}): FollowPath {
  if (!(rx > 0) || !(ry > 0)) throw new Error("ellipsePath needs positive radii");
  const start = radians(options.startDegrees ?? -90), direction = (options.clockwise ?? true) ? 1 : -1;
  const place = rotateAbout(cx, cy, options.rotationDegrees ?? 0);
  return closedCurve(u => { const a = start + direction * 2 * Math.PI * u; return place(rx * Math.cos(a), ry * Math.sin(a)); }, options.steps ?? 720);
}

/**
 * Lemniscate of Bernoulli (figure-8) spanning x in [−halfWidth, +halfWidth]:
 * x = a·cos t / (1 + sin² t), y = a·sin t·cos t / (1 + sin² t). Distance 0 is the
 * right tip ("right", heading down into the right loop) or the crossing ("center", heading up-right).
 */
export function lemniscatePath(cx: number, cy: number, halfWidth: number, options: { readonly start?: "right" | "center";
  readonly rotationDegrees?: number; readonly steps?: number } = {}): FollowPath {
  if (!(halfWidth > 0)) throw new Error("lemniscatePath needs a positive halfWidth");
  const offset = options.start === "center" ? -Math.PI / 2 : 0;
  const place = rotateAbout(cx, cy, options.rotationDegrees ?? 0);
  return closedCurve(u => {
    const t = offset + 2 * Math.PI * u, s = Math.sin(t), c = Math.cos(t), k = halfWidth / (1 + s * s);
    return place(k * c, k * s * c);
  }, options.steps ?? 720);
}

export interface SpiralOptions {
  readonly innerRadius: number;
  readonly outerRadius: number;
  /** Revolutions between the inner and outer radius (> 0). */
  readonly turns: number;
  /** Number of arms and which one (arm k is rotated k · 360 / arms). Default 1 arm, arm 0. */
  readonly arms?: number;
  readonly arm?: number;
  /** Winding direction going outward (default clockwise). */
  readonly clockwise?: boolean;
  /** Angle of arm 0 at the outer end (degrees, 0 = +x). */
  readonly startDegrees?: number;
  /** Where distance 0 sits: the outer end (default, distances run inward) or the inner end. */
  readonly from?: "outer" | "inner";
  readonly steps?: number;
}

/** One arm of an Archimedean spiral r(θ) = inner + (outer − inner) · θ / (2π · turns). Open path. */
export function spiralPath(cx: number, cy: number, options: SpiralOptions): FollowPath {
  const { innerRadius, outerRadius, turns } = options;
  if (!(innerRadius >= 0) || !(outerRadius > innerRadius) || !(turns > 0)) throw new Error("spiralPath needs 0 ≤ innerRadius < outerRadius and turns > 0");
  const arms = options.arms ?? 1, arm = options.arm ?? 0;
  if (!Number.isInteger(arms) || arms < 1 || !Number.isInteger(arm) || arm < 0 || arm >= arms) throw new Error("spiralPath arm must be an integer in 0..arms-1");
  const steps = options.steps ?? 720;
  if (!Number.isInteger(steps) || steps < 8 || steps > 100_000) throw new Error("path steps must be an integer in 8..100000");
  const sweep = 2 * Math.PI * turns, direction = (options.clockwise ?? true) ? 1 : -1;
  // θ measured from the outer end; the angle grows outward in the winding direction.
  const outerAngle = radians(options.startDegrees ?? 0) + (2 * Math.PI * arm) / arms;
  const points: Array<[number, number]> = [];
  for (let index = 0; index <= steps; index += 1) {
    const fraction = options.from === "inner" ? index / steps : 1 - index / steps; // 1 = outer end
    const radius = innerRadius + (outerRadius - innerRadius) * fraction;
    const angle = outerAngle - direction * sweep * (1 - fraction);
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  const sampler = polylineSampler(points);
  return withMeta(sampler, sampler.totalLength, false);
}

export interface PathPlacement extends PathSample {
  readonly index: number;
  /** Distance along the path actually sampled (after wrapping). */
  readonly distance: number;
}

/**
 * Place `count` items along a path: item k sits at offset + phase·totalLength +
 * k·spacing. spacing defaults to totalLength / count (even spacing over the whole
 * path; negative spacing puts later items behind, like train cars). With wrap
 * (default true) distances are taken modulo totalLength, so items leaving the end
 * of an open path re-enter at its start (T73 respawn).
 */
export function placeAlongPath(path: FollowPath, count: number, options: { readonly spacing?: number; readonly offset?: number;
  readonly phase?: number; readonly wrap?: boolean } = {}): readonly PathPlacement[] {
  if (!Number.isInteger(count) || count < 0 || count > 100_000) throw new Error("placeAlongPath count must be an integer in 0..100000");
  const length = path.totalLength, spacing = options.spacing ?? (count ? length / count : 0);
  const start = (options.offset ?? 0) + (options.phase ?? 0) * length, wrap = options.wrap ?? true;
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    let distance = start + index * spacing;
    if (wrap && length > 0) distance = ((distance % length) + length) % length;
    const sample = path(distance);
    return Object.freeze({ index, distance, x: sample.x, y: sample.y, angle: sample.angle });
  }));
}
