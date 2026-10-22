import { z } from "zod";
import { mesh3dSegmentSchema, type Mesh3dCamera } from "../motion/mesh3dScene";

export type PrevisVectorV1 = [number, number, number];
const number = z.number().finite();
const vector = z.tuple([number.min(-100).max(100), number.min(-100).max(100), number.min(-100).max(100)]);
const easing = z.enum(["linear", "smooth"]);
export const cameraPrevisMotionSchemaV1 = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("locked") }),
  ...(["dolly", "truck", "pedestal"] as const).map(kind => z.strictObject({ kind: z.literal(kind), distance: number.min(-40).max(40), easing })),
  z.strictObject({ kind: z.literal("orbit"), degrees: number.min(-150).max(150), pivot: vector.optional(), easing }),
  ...(["pan", "tilt"] as const).map(kind => z.strictObject({ kind: z.literal(kind), degrees: number.min(-150).max(150), easing })),
  z.strictObject({ kind: z.literal("follow"), objectId: z.string().min(1).max(80) }),
]);
export type CameraPrevisMotionV1 = z.infer<typeof cameraPrevisMotionSchemaV1>;
export interface PrevisBoundsV1 { min: PrevisVectorV1; max: PrevisVectorV1; }
export const previsAddV1 = (a: PrevisVectorV1, b: PrevisVectorV1): PrevisVectorV1 => a.map((n, i) => n + b[i]) as PrevisVectorV1;
export const previsSubV1 = (a: PrevisVectorV1, b: PrevisVectorV1): PrevisVectorV1 => a.map((n, i) => n - b[i]) as PrevisVectorV1;
export const previsScaleV1 = (a: PrevisVectorV1, n: number): PrevisVectorV1 => a.map(v => v * n) as PrevisVectorV1;
export const previsRotateYV1 = (p: PrevisVectorV1, radians: number): PrevisVectorV1 => [p[0] * Math.cos(radians) + p[2] * Math.sin(radians), p[1], p[2] * Math.cos(radians) - p[0] * Math.sin(radians)];
export function previsHullV1(points: readonly PrevisVectorV1[]): PrevisBoundsV1 {
  if (!points.length || points.some(p => p.length !== 3 || p.some(n => !Number.isFinite(n)))) throw Error("PREVIS_BOUNDS_INVALID");
  return { min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))) as PrevisVectorV1,
    max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) as PrevisVectorV1 };
}
/** Exact extrema of a Y arc; safety must inspect the interior, not just endpoints. */
export function previsArcHullV1(point: PrevisVectorV1, pivot: PrevisVectorV1, from: number, to: number): PrevisBoundsV1 {
  const p = previsSubV1(point, pivot), lo = Math.min(from, to), hi = Math.max(from, to), angles = [lo, hi];
  for (const phase of [Math.atan2(p[2], p[0]), Math.atan2(-p[0], p[2])]) {
    for (let k = Math.ceil((lo - phase) / Math.PI); phase + k * Math.PI < hi; k++) angles.push(phase + k * Math.PI);
  }
  return previsHullV1(angles.map(a => previsAddV1(pivot, previsRotateYV1(p, a))));
}
export function validatePrevisCameraV1(input: unknown): Mesh3dCamera {
  const c = mesh3dSegmentSchema.shape.camera.parse(input), d = previsSubV1(c.target, c.position);
  if (c.near >= c.far || Math.hypot(...d) < .1 || Math.hypot(d[0], d[2]) < .01) throw Error("PREVIS_CAMERA_INVALID");
  return c;
}
export function previsCameraBasisV1(camera: Mesh3dCamera) {
  const delta = previsSubV1(camera.target, camera.position), length = Math.hypot(...delta);
  const forward = previsScaleV1(delta, 1 / length), horizontal = Math.hypot(forward[0], forward[2]);
  const right: PrevisVectorV1 = [-forward[2] / horizontal, 0, forward[0] / horizontal];
  const up: PrevisVectorV1 = [-forward[1] * right[2], forward[0] * right[2] - forward[2] * right[0], forward[1] * right[0]];
  return { forward, right, up, length };
}
export function prepareCameraPrevisMotionV1(baseInput: unknown, motionInput: unknown, duration: number) {
  const base = validatePrevisCameraV1(baseInput), motion = cameraPrevisMotionSchemaV1.parse(motionInput);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw Error("PREVIS_DURATION_INVALID");
  const { forward, right, length } = previsCameraBasisV1(base);
  const angle = "degrees" in motion ? motion.degrees * Math.PI / 180 : 0;
  const elevation = Math.asin(forward[1]);
  if (motion.kind === "dolly" && length - motion.distance < .1) throw Error("PREVIS_PATH_INVALID");
  if (motion.kind === "tilt" && Math.max(Math.abs(elevation), Math.abs(elevation + angle)) > 80 * Math.PI / 180) throw Error("PREVIS_PATH_INVALID");
  function atProgress(u: number, followDelta?: PrevisVectorV1): Mesh3dCamera {
    let position: PrevisVectorV1 = [...base.position], target: PrevisVectorV1 = [...base.target];
    if (motion.kind === "dolly") position = previsAddV1(position, previsScaleV1(forward, motion.distance * u));
    if (motion.kind === "truck") position = previsAddV1(position, previsScaleV1(right, motion.distance * u));
    if (motion.kind === "pedestal") position[1] += motion.distance * u;
    if (motion.kind === "orbit") {
      const pivot = motion.pivot ?? base.target;
      position = previsAddV1(pivot, previsRotateYV1(previsSubV1(position, pivot), angle * u));
      target = previsAddV1(pivot, previsRotateYV1(previsSubV1(target, pivot), angle * u));
    }
    if (motion.kind === "pan") target = previsAddV1(position, previsRotateYV1(previsSubV1(target, position), angle * u));
    if (motion.kind === "tilt") {
      const horizontal = Math.hypot(forward[0], forward[2]), a = elevation + angle * u;
      target = previsAddV1(position, [length * forward[0] / horizontal * Math.cos(a), length * Math.sin(a), length * forward[2] / horizontal * Math.cos(a)]);
    }
    if (motion.kind === "follow") {
      if (!followDelta || followDelta.length !== 3 || followDelta.some(n => !Number.isFinite(n))) throw Error("PREVIS_FOLLOW_CONTEXT_REQUIRED");
      position = previsAddV1(position, followDelta); target = previsAddV1(target, followDelta);
    }
    return { ...base, position, target };
  }
  function sample(seconds: number, followDelta?: PrevisVectorV1) {
    if (!Number.isFinite(seconds)) throw Error("PREVIS_TIME_INVALID");
    let u = Math.min(1, Math.max(0, seconds / duration));
    // One ease over the whole move. No per-key velocity discontinuities.
    if ("easing" in motion && motion.easing === "smooth") u = u * u * u * (u * (u * 6 - 15) + 10);
    return validatePrevisCameraV1(atProgress(u, followDelta));
  }
  const positionHull = (from = 0, to = 1): PrevisBoundsV1 => motion.kind === "orbit"
    ? previsArcHullV1(base.position, motion.pivot ?? base.target, angle * from, angle * to)
    : previsHullV1([atProgress(from, [0, 0, 0]).position, atProgress(to, [0, 0, 0]).position]);
  if (motion.kind !== "follow") {
    const bounds = positionHull();
    let targets: PrevisBoundsV1;
    if (motion.kind === "orbit") targets = previsArcHullV1(base.target, motion.pivot ?? base.target, 0, angle);
    else if (motion.kind === "pan") targets = previsArcHullV1(base.target, base.position, 0, angle);
    else if (motion.kind === "tilt") {
      // Tilt stays within a sphere; conservative world-bound admission.
      targets = { min: base.position.map(n => n - length) as PrevisVectorV1, max: base.position.map(n => n + length) as PrevisVectorV1 };
    } else targets = previsHullV1([base.target]);
    if ([...bounds.min, ...bounds.max, ...targets.min, ...targets.max].some(n => Math.abs(n) > 100)) throw Error("PREVIS_PATH_INVALID");
  }
  return { sample, positionHull, descriptor: structuredClone({ base, motion, duration }), motion: structuredClone(motion) };
}
