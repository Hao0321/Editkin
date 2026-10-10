import { z } from "zod";

const finite = z.number().finite();
const vector = z.tuple([finite.min(-100).max(100), finite.min(-100).max(100), finite.min(-100).max(100)]);
const size = finite.positive().max(20);
const color = z.string().regex(/^#[a-f\d]{6}$/i);
const pose = z.strictObject({ position: vector, rotationDegrees: vector, scale: z.tuple([size, size, size]) });
const camera = z.strictObject({ position: vector, target: vector, verticalFovDegrees: finite.min(15).max(100), near: finite.min(.01).max(2), far: finite.min(2).max(200) });
export const mesh3dGeometrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("box"), width: size, height: size, depth: size }),
  z.strictObject({ kind: z.literal("sphere"), radius: size, segments: z.number().int().min(8).max(64) }),
  z.strictObject({ kind: z.literal("curved_video"), radius: size, width: size, height: size, segments: z.number().int().min(4).max(64) }),
  z.strictObject({ kind: z.literal("torus"), radius: size, tube: finite.min(.01).max(1), segments: z.number().int().min(8).max(64) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().trim().min(1).max(24), fontFamily: z.literal("Noto Sans TC"), fontWeight: z.union([z.literal(700), z.literal(900)]), height: finite.min(.1).max(3), depth: finite.min(.01).max(.6), bevel: finite.min(0).max(.035) }),
]);
export const mesh3dObjectSchema = z.strictObject({
  id: z.string().min(1).max(80), name: z.string().min(1).max(100), geometry: mesh3dGeometrySchema,
  material: z.strictObject({ color, unlit: z.boolean(), clipId: z.string().min(1).max(160).optional(), grid: z.boolean().optional(), doubleSided: z.boolean().optional() }),
  pose, keyframes: z.array(z.strictObject({ time: finite.nonnegative(), pose, easing: z.enum(["linear", "smooth", "hold"]) })).max(16),
});
export const mesh3dSegmentSchema = z.strictObject({
  id: z.string().min(1).max(80), name: z.string().min(1).max(120), timelineStart: finite.nonnegative(), duration: finite.positive().max(600),
  camera, cameraKeyframes: z.array(z.strictObject({ time: finite.nonnegative(), camera, easing: z.enum(["linear", "smooth", "hold"]) })).max(16),
  objects: z.array(mesh3dObjectSchema).min(1).max(32),
});
export const mesh3dSceneSchema = z.strictObject({
  schema: z.literal("editkin.mesh-scene/v1"), enabled: z.boolean(),
  background: z.strictObject({ color, gridColor: color, spacing: finite.min(24).max(200), grid: z.boolean() }),
  light: z.strictObject({ direction: vector, ambient: finite.min(0).max(1), intensity: finite.min(0).max(2) }),
  segments: z.array(mesh3dSegmentSchema).min(1).max(16),
});
export type Mesh3dScene = z.infer<typeof mesh3dSceneSchema>;
export type Mesh3dSegment = z.infer<typeof mesh3dSegmentSchema>;
export type Mesh3dObject = z.infer<typeof mesh3dObjectSchema>;
export type Mesh3dPose = Mesh3dObject["pose"];
export type Mesh3dCamera = Mesh3dSegment["camera"];
export type Mesh3dGeometry = Mesh3dObject["geometry"];

function mix(a: number, b: number, t: number) { return a + (b - a) * t; }
function vectorMix(a: number[], b: number[], t: number): [number, number, number] { return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; }
function sample<T>(initial: T, keys: { time: number; easing: string }[], time: number, get: (index: number) => T, interpolate: (a: T, b: T, t: number) => T): T {
  let previous = initial, previousTime = 0;
  for (let i = 0; i < keys.length; i++) {
    const next = keys[i];
    if (time < next.time) {
      const amount = Math.max(0, Math.min(1, (time - previousTime) / Math.max(1e-9, next.time - previousTime)));
      const t = next.easing === "hold" ? 0 : next.easing === "smooth" ? amount * amount * (3 - 2 * amount) : amount;
      return interpolate(previous, get(i), t);
    }
    previous = get(i); previousTime = next.time;
  }
  return previous;
}
export function mesh3dPoseAt(object: Mesh3dObject, time: number): Mesh3dPose {
  return sample(object.pose, object.keyframes, time, i => object.keyframes[i].pose, (a, b, t) => ({ position: vectorMix(a.position, b.position, t), rotationDegrees: vectorMix(a.rotationDegrees, b.rotationDegrees, t), scale: vectorMix(a.scale, b.scale, t) }));
}
export function mesh3dCameraAt(segment: Mesh3dSegment, time: number): Mesh3dCamera {
  return sample(segment.camera, segment.cameraKeyframes, time, i => segment.cameraKeyframes[i].camera, (a, b, t) => ({ position: vectorMix(a.position, b.position, t), target: vectorMix(a.target, b.target, t), verticalFovDegrees: mix(a.verticalFovDegrees, b.verticalFovDegrees, t), near: mix(a.near, b.near, t), far: mix(a.far, b.far, t) }));
}
