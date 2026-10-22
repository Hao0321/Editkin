import { clamp01, lerp, smoothstep } from "../../svg/easing";
import { createSeededRng } from "../../svg/random";
import type { MotionFrameSize } from "../../types";

/**
 * Scatter helper (DESIGN §8): seeded per-character offsets between a character's
 * home position and a scattered one, plus a spring settle. Users: T44 Explode Out
 * (radial), T61 Magnet Pull (sides), T77 Letter Assemble (field).
 *
 * Modes:
 * - "radial": along the line from the word centre through the character, ± spreadDegrees,
 *   travelling `distance` px (default 0.6–0.9 frame widths, T44).
 * - "field": a uniform random point in a disc around home, radius `distance` px
 *   (default 0–0.5 × the frame's short side, T77 "within half a frame").
 * - "sides": the first half of the characters leaves past the left frame edge, the second
 *   half past the right (a middle character picks a seeded side), ± verticalJitter × frame
 *   height (T61). halfWidth keeps the glyph entirely off-frame; margin adds more.
 *
 * Each character draws from its own stream fork (index), so adding characters never
 * changes earlier characters' offsets. Deterministic and browser-safe.
 *
 * Usage (T44 out-phase):
 *   const targets = glyphs.map(g => ({ x: g.cx, y: g.cy, halfWidth: g.w / 2 }));
 *   const out = scatterOffsets(targets, { mode: "radial", itemId: ID, seed: params.seed, stream: "out", frame: size,
 *     spreadDegrees: 25, rotation: [90, 200], scale: [1.8, 1.8] });
 *   const pose = scatterPose(out[i], 1 - expoIn(p));   // p = 0 home … 1 gone; pose.dx/dy/rotation/scale
 * and T61's snap: x = home + overshootOffset · (1 − springSettle(t − snapAt, { damping: 0.5 })).
 */

export type ScatterMode = "radial" | "field" | "sides";

export interface ScatterTarget {
  /** Character centre (home) in frame px. */
  readonly x: number;
  readonly y: number;
  /** Half extents, used by "sides" to clear the frame edge (default 0). */
  readonly halfWidth?: number;
  readonly halfHeight?: number;
}

export interface ScatterOptions {
  readonly mode: ScatterMode;
  readonly itemId: string;
  readonly seed: number;
  /** Stream name (e.g. "in" / "out" for two different scatters). Default "scatter". */
  readonly stream?: string;
  readonly frame: MotionFrameSize;
  /** Word centre for "radial" (default: the mean of the targets). */
  readonly center?: { readonly x: number; readonly y: number };
  /** "radial": travel distance range in px; "field": disc radius range in px. */
  readonly distance?: readonly [number, number];
  /** "radial": ± degrees around the centre → character direction (default 25). */
  readonly spreadDegrees?: number;
  /** "sides": ± vertical jitter as a fraction of the frame height (default 0.1). */
  readonly verticalJitter?: number;
  /** "sides": extra px beyond the frame edge (default 0). */
  readonly margin?: number;
  /** Rotation magnitude range in degrees at the scattered end; the sign is seeded (default [0, 0]). */
  readonly rotation?: readonly [number, number];
  /** Scale range at the scattered end (default [1, 1]). */
  readonly scale?: readonly [number, number];
}

export interface ScatterOffset {
  readonly index: number;
  /** Home → scattered displacement in px. */
  readonly dx: number;
  readonly dy: number;
  /** Rotation (degrees, clockwise) and scale at the scattered end. */
  readonly rotation: number;
  readonly scale: number;
  /** Travel direction in degrees (0 = +x, clockwise). */
  readonly directionDegrees: number;
}

export function scatterOffsets(targets: readonly ScatterTarget[], options: ScatterOptions): readonly ScatterOffset[] {
  const { frame } = options;
  if (!frame || !(frame.width > 0) || !(frame.height > 0)) throw new Error("scatterOffsets needs the frame size");
  const center = options.center ?? (targets.length
    ? { x: targets.reduce((sum, target) => sum + target.x, 0) / targets.length, y: targets.reduce((sum, target) => sum + target.y, 0) / targets.length }
    : { x: frame.width / 2, y: frame.height / 2 });
  const short = Math.min(frame.width, frame.height);
  const distance = options.distance ?? (options.mode === "radial" ? [0.6 * frame.width, 0.9 * frame.width] as const : [0, 0.5 * short] as const);
  if (!(distance[0] >= 0) || !(distance[1] >= distance[0])) throw new Error("scatterOffsets distance must be a non-negative [min, max]");
  const rotation = options.rotation ?? [0, 0], scale = options.scale ?? [1, 1];
  const spread = options.spreadDegrees ?? 25, jitter = options.verticalJitter ?? 0.1, margin = options.margin ?? 0;
  const root = createSeededRng(options.itemId, options.seed, options.stream ?? "scatter");
  return Object.freeze(targets.map((target, index) => {
    const rng = root.fork(index);
    let dx: number, dy: number;
    if (options.mode === "radial") {
      const away = target.x === center.x && target.y === center.y ? rng.range(0, 360) : (Math.atan2(target.y - center.y, target.x - center.x) * 180) / Math.PI;
      const direction = ((away + rng.range(-spread, spread)) * Math.PI) / 180, travel = rng.range(distance[0], distance[1]);
      dx = Math.cos(direction) * travel; dy = Math.sin(direction) * travel;
    } else if (options.mode === "field") {
      const angle = rng.range(0, 2 * Math.PI);
      const radius = Math.sqrt(lerp(distance[0] ** 2, distance[1] ** 2, rng.next()));
      dx = Math.cos(angle) * radius; dy = Math.sin(angle) * radius;
    } else {
      const middle = targets.length % 2 === 1 && index === (targets.length - 1) / 2;
      const left = middle ? rng.chance(0.5) : index < targets.length / 2;
      const halfWidth = target.halfWidth ?? 0;
      dx = left ? -(target.x + halfWidth + margin) : frame.width + halfWidth + margin - target.x;
      dy = rng.range(-jitter, jitter) * frame.height;
    }
    const spin = rng.sign() * rng.range(rotation[0], rotation[1]);
    return Object.freeze({ index, dx, dy, rotation: spin, scale: rng.range(scale[0], scale[1]),
      directionDegrees: (Math.atan2(dy, dx) * 180) / Math.PI });
  }));
}

/** Pose at progress p: 0 = scattered (offset, rotation, scale), 1 = home (0, 0, 1). p is clamped. */
export function scatterPose(offset: ScatterOffset, p: number): { readonly dx: number; readonly dy: number; readonly rotation: number; readonly scale: number } {
  const k = 1 - clamp01(p);
  return { dx: offset.dx * k, dy: offset.dy * k, rotation: offset.rotation * k, scale: lerp(1, offset.scale, k) };
}

/**
 * Damped spring settle from 0 to 1 (t in seconds since release). damping is the
 * damping ratio ζ (0.5 overshoots about 16%, T61); frequency the undamped Hz.
 * The residual is blended out over the last 20% of settleSeconds (default: the 1%
 * envelope, 4.6 / (ζ·ω)), so the value is exactly 1 from settleSeconds on: holds
 * and loops stay byte-identical.
 */
export function springSettle(t: number, options: { readonly frequency?: number; readonly damping?: number; readonly settleSeconds?: number } = {}): number {
  const frequency = options.frequency ?? 2.2, zeta = options.damping ?? 0.5;
  if (!(frequency > 0) || !(zeta > 0)) throw new Error("springSettle needs frequency > 0 and damping > 0");
  if (t <= 0) return 0;
  const omega = 2 * Math.PI * frequency;
  const settle = options.settleSeconds ?? 4.6 / (zeta * omega);
  if (t >= settle) return 1;
  let raw: number;
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    raw = 1 - Math.exp(-zeta * omega * t) * (Math.cos(omegaD * t) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(omegaD * t));
  } else if (zeta === 1) {
    raw = 1 - Math.exp(-omega * t) * (1 + omega * t);
  } else {
    const root = Math.sqrt(zeta * zeta - 1), r1 = -omega * (zeta - root), r2 = -omega * (zeta + root);
    const c2 = r1 / (r1 - r2);
    raw = 1 - ((1 - c2) * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
  }
  return 1 - (1 - raw) * (1 - smoothstep(0.8 * settle, settle, t));
}
