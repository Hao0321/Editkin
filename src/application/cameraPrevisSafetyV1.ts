import { cameraPrevisMotionSchemaV1, prepareCameraPrevisMotionV1, previsAddV1, previsHullV1,
  type CameraPrevisMotionV1, type PrevisBoundsV1, type PrevisVectorV1 } from "./cameraPrevisMotionV1";
import type { Mesh3dCamera } from "../motion/mesh3dScene";

export interface CameraPrevisSafetyInputV1 {
  floorY: number; radius: number; obstacles: readonly PrevisBoundsV1[];
  /** Translation control points of the actual legacy pose sampler, including time zero. */
  followDeltas?: readonly PrevisVectorV1[];
  /** Bounds fixed relative to a proven translation-only follow group. */
  relativeObstacles?: readonly PrevisBoundsV1[];
}
function validBounds(b: PrevisBoundsV1) {
  return b?.min?.length === 3 && b?.max?.length === 3 && b.min.every((n, i) => Number.isFinite(n) && Number.isFinite(b.max[i]) && n <= b.max[i]);
}
const inside = (p: PrevisVectorV1, b: PrevisBoundsV1) => p.every((n, i) => n >= b.min[i] && n <= b.max[i]);
const disjoint = (a: PrevisBoundsV1, b: PrevisBoundsV1) => a.min.some((n, i) => n > b.max[i] || a.max[i] < b.min[i]);
/** Slab test of the complete segment, not a sparse camera sample. Touch is unsafe. */
export function previsLineIntersectsV1(a: PrevisVectorV1, b: PrevisVectorV1, box: PrevisBoundsV1): boolean {
  let enter = 0, exit = 1;
  for (let i = 0; i < 3; i++) {
    const delta = b[i] - a[i];
    if (Math.abs(delta) < 1e-12) { if (a[i] < box.min[i] || a[i] > box.max[i]) return false; }
    else {
      const x = (box.min[i] - a[i]) / delta, y = (box.max[i] - a[i]) / delta;
      enter = Math.max(enter, Math.min(x, y)); exit = Math.min(exit, Math.max(x, y));
      if (enter > exit) return false;
    }
  }
  return true;
}
function validate(input: CameraPrevisSafetyInputV1) {
  if (!Number.isFinite(input.floorY) || input.floorY < -100 || input.floorY > 100 || !Number.isFinite(input.radius)
    || input.radius < .01 || input.radius > 2 || input.obstacles.length > 32 || !input.obstacles.every(validBounds)
    || (input.relativeObstacles && (input.relativeObstacles.length > 32 || !input.relativeObstacles.every(validBounds)))) throw Error("PREVIS_SAFETY_INVALID");
}
function certified(path: ReturnType<typeof prepareCameraPrevisMotionV1>, input: CameraPrevisSafetyInputV1): boolean {
  const base = path.descriptor.base, motion = path.motion;
  const expanded = (b: PrevisBoundsV1): PrevisBoundsV1 => ({ min: b.min.map(n => n - input.radius) as PrevisVectorV1, max: b.max.map(n => n + input.radius) as PrevisVectorV1 });
  if (motion.kind === "follow") {
    if (!input.followDeltas?.length || input.followDeltas.length > 17) throw Error("PREVIS_FOLLOW_CONTEXT_REQUIRED");
    const positions = input.followDeltas.map(d => path.sample(0, d).position);
    // Validate every control point; legacy interpolation is convex on each interval.
    for (const d of input.followDeltas) path.sample(0, d);
    if (Math.min(...positions.map(p => p[1])) - input.radius <= input.floorY) return false;
    if (input.relativeObstacles?.some(b => inside(base.position, expanded(b)))) return false;
    return input.obstacles.every(b => positions.every((p, i) => !previsLineIntersectsV1(i ? positions[i - 1] : p, p, expanded(b))));
  }
  if (path.positionHull().min[1] - input.radius <= input.floorY) return false;
  if (motion.kind !== "orbit") return input.obstacles.every(b => !previsLineIntersectsV1(path.sample(0).position, path.sample(path.descriptor.duration).position, expanded(b)));
  // Orbit hulls bound every angle. Ambiguous intervals fail closed at finite depth.
  function clear(box: PrevisBoundsV1, from: number, to: number, depth: number): boolean {
    if (disjoint(path.positionHull(from, to), box)) return true;
    const middle = (from + to) / 2;
    const angle = motion.kind === "orbit" ? motion.degrees * Math.PI / 180 : 0;
    const pivot = motion.kind === "orbit" ? motion.pivot ?? base.target : base.target;
    const dx = base.position[0] - pivot[0], dz = base.position[2] - pivot[2];
    const point: PrevisVectorV1 = [pivot[0] + dx * Math.cos(angle * middle) + dz * Math.sin(angle * middle), base.position[1], pivot[2] + dz * Math.cos(angle * middle) - dx * Math.sin(angle * middle)];
    if (inside(point, box) || depth >= 12) return false;
    return clear(box, from, middle, depth + 1) && clear(box, middle, to, depth + 1);
  }
  return input.obstacles.every(b => clear(expanded(b), 0, 1, 0));
}
export function prepareSafeCameraPrevisV1(base: Mesh3dCamera, inputMotion: unknown, duration: number, safety: CameraPrevisSafetyInputV1) {
  validate(safety);
  const motion = cameraPrevisMotionSchemaV1.parse(inputMotion);
  for (const scale of [1, .75, .5, .25, .125]) {
    const candidate: CameraPrevisMotionV1 = "distance" in motion ? { ...motion, distance: motion.distance * scale }
      : "degrees" in motion ? { ...motion, degrees: motion.degrees * scale } : motion;
    let path: ReturnType<typeof prepareCameraPrevisMotionV1>;
    try { path = prepareCameraPrevisMotionV1(base, candidate, duration); }
    catch (error) { if ((error as Error).message === "PREVIS_PATH_INVALID") continue; throw error; }
    if (certified(path, safety)) return { ...path, amplitudeScale: scale, warnings: scale === 1 ? [] : ["PREVIS_AMPLITUDE_REDUCED"] };
    if (motion.kind === "follow" || motion.kind === "locked") break;
  }
  throw Error("PREVIS_NO_SAFE_PATH");
}
/** Bounds translation helper used by callers constructing conservative control hulls. */
export function translatePrevisBoundsV1(bounds: PrevisBoundsV1, delta: PrevisVectorV1): PrevisBoundsV1 {
  return previsHullV1([previsAddV1(bounds.min, delta), previsAddV1(bounds.max, delta)]);
}
