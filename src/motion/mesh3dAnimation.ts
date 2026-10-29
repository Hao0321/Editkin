import type { Mesh3dObject, Mesh3dPose } from "./mesh3dScene";

/**
 * Pose generators that compile physical-looking motion into ordinary mesh3d pose
 * keyframes (engine extension 2026-10-23). The output is plain data, so a
 * template stays editable keyframe by keyframe and saves/reopens like any scene.
 */
type Vec3 = [number, number, number];
export type Mesh3dKeyframe = Mesh3dObject["keyframes"][number];
export interface Mesh3dPoseTrackV1 { pose: Mesh3dPose; keyframes: Mesh3dKeyframe[]; }
const MAX_KEYS = 16;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const v3 = (a: readonly number[]): Vec3 => [round(a[0]), round(a[1]), round(a[2])];
const finite = (...values: number[]) => values.every(Number.isFinite);

export interface Mesh3dBounceOptionsV1 {
  /** Pose at `startTime` (the drop point). Rotation/scale are the rest pose. */
  start: Mesh3dPose;
  floorY: number;
  /** Distance from the object's origin to its lowest point at rest scale (a sphere's radius). */
  contactOffset: number;
  /** Seconds before the drop starts (the object holds still). Default 0. */
  startTime?: number;
  /** Velocity kept per impact, 0.05–0.95 (each rebound peaks at restitution² of the previous height). */
  restitution: number;
  /** Rebounds after the first impact, 0–4 (16 keyframes in all). */
  bounces: number;
  /** World units per second² (default 9.8). */
  gravity?: number;
  /** Squash at impact, 0–0.45: height × (1 − squash), width × 1/√(1 − squash). */
  squash?: number;
  /** Seconds the object stays squashed on the floor (default 0.05). */
  contactSeconds?: number;
  /** Horizontal travel [dx, dz] over the whole bounce. */
  drift?: [number, number];
  /** Extra rotation in degrees accumulated by the final impact (tumbling blocks). */
  spinDegrees?: Vec3;
  /** Keys after this local time are dropped (the segment duration). */
  until?: number;
}
/**
 * Free fall and rise are exact parabolas: falling keys use easeIn (t²), rising keys
 * easeOut. Impacts squash with the base resting on the floor.
 */
export function mesh3dBounceKeyframesV1(o: Mesh3dBounceOptionsV1): Mesh3dPoseTrackV1 {
  const g = o.gravity ?? 9.8, squash = o.squash ?? 0, contact = o.contactSeconds ?? .05, startTime = o.startTime ?? 0;
  if (!finite(o.floorY, o.contactOffset, o.restitution, g, squash, contact, startTime) || o.contactOffset <= 0 || g <= 0 || o.restitution < .05 || o.restitution > .95
    || !Number.isInteger(o.bounces) || o.bounces < 0 || o.bounces > 4 || squash < 0 || squash > .45 || contact < 0 || contact > .5 || startTime < 0) throw new Error("MESH_BOUNCE_OPTIONS_INVALID");
  const rest = o.floorY + o.contactOffset, drop = o.start.position[1] - rest;
  if (!(drop > 1e-6)) throw new Error("MESH_BOUNCE_START_MUST_BE_ABOVE_FLOOR");
  const [sx, sy, sz] = o.start.scale, wide = 1 / Math.sqrt(1 - squash);
  const squashed: Vec3 = v3([sx * wide, sy * (1 - squash), sz * wide]), restScale: Vec3 = v3(o.start.scale);
  // Event times: impacts, lift-offs and peaks.
  const events: { time: number; kind: "impact" | "lift" | "peak"; height: number }[] = [];
  let t = startTime + Math.sqrt(2 * drop / g), velocity = g * Math.sqrt(2 * drop / g);
  for (let i = 0; i <= o.bounces; i++) {
    events.push({ time: t, kind: "impact", height: 0 });
    t += contact; events.push({ time: t, kind: "lift", height: 0 });
    if (i === o.bounces) break;
    velocity *= o.restitution;
    const up = velocity / g;
    events.push({ time: t + up, kind: "peak", height: velocity * velocity / (2 * g) });
    t += 2 * up;
  }
  const end = events[events.length - 1].time, drift = o.drift ?? [0, 0], spin = o.spinDegrees ?? [0, 0, 0];
  const at = (time: number, height: number, scale: Vec3, kind: string): Mesh3dPose => {
    const progress = Math.max(0, Math.min(1, (time - startTime) / Math.max(1e-9, end - startTime)));
    const y = kind === "impact" ? o.floorY + o.contactOffset * (1 - squash) : rest + height;
    return { position: v3([o.start.position[0] + drift[0] * progress, y, o.start.position[2] + drift[1] * progress]),
      rotationDegrees: v3(o.start.rotationDegrees.map((r, i) => r + spin[i] * progress)), scale };
  };
  const keyframes: Mesh3dKeyframe[] = [];
  if (startTime > 0) keyframes.push({ time: round(startTime), pose: structuredClone(o.start), easing: "linear" });
  for (const event of events) {
    const scale = event.kind === "impact" ? squashed : restScale;
    keyframes.push({ time: round(event.time), pose: at(event.time, event.height, scale, event.kind), easing: event.kind === "impact" ? "easeIn" : event.kind === "peak" ? "easeOut" : "linear" });
  }
  const limit = o.until ?? Infinity;
  const kept = keyframes.filter(k => k.time > 0 && k.time <= limit + 1e-9).slice(0, MAX_KEYS);
  return { pose: structuredClone(o.start), keyframes: kept };
}

export interface Mesh3dOrbitOptionsV1 {
  center: Vec3; radius: number;
  /** Axis the orbit turns around (the orbit plane is perpendicular to it). Default "y". */
  axis?: "x" | "y" | "z";
  startDegrees: number; endDegrees: number;
  startTime: number; endTime: number;
  /** Keyframes along the path (2–16). Linear segments; the chord sag is reported. */
  keyframes: number;
  /** Turn the object with the orbit (its rotation about the axis follows the angle). */
  faceTravel?: boolean;
  rotationDegrees?: Vec3; scale?: Vec3;
}
/**
 * Circular orbit sampled into keyframes. Positions interpolate linearly, so the path
 * is a polygon: `maxRadialError` is the chord sag. For exact rings use one object
 * (band_text / torus) rotating with two keyframes instead.
 */
export function mesh3dOrbitKeyframesV1(o: Mesh3dOrbitOptionsV1): Mesh3dPoseTrackV1 & { maxRadialError: number } {
  if (!finite(o.radius, o.startDegrees, o.endDegrees, o.startTime, o.endTime, ...o.center) || o.radius <= 0 || o.startTime < 0 || o.endTime <= o.startTime
    || !Number.isInteger(o.keyframes) || o.keyframes < 2 || o.keyframes > MAX_KEYS) throw new Error("MESH_ORBIT_OPTIONS_INVALID");
  const axis = o.axis ?? "y", rotation = o.rotationDegrees ?? [0, 0, 0], scale = o.scale ?? [1, 1, 1];
  const point = (degrees: number): Mesh3dPose => {
    const a = degrees * Math.PI / 180, c = Math.cos(a) * o.radius, s = Math.sin(a) * o.radius;
    const offset: Vec3 = axis === "y" ? [s, 0, c] : axis === "x" ? [0, c, s] : [c, s, 0];
    const turn: Vec3 = [...rotation];
    if (o.faceTravel) turn[axis === "x" ? 0 : axis === "y" ? 1 : 2] += axis === "y" ? degrees : -degrees;
    return { position: v3(o.center.map((v, i) => v + offset[i])), rotationDegrees: v3(turn), scale: v3(scale) };
  };
  // With startTime = 0 the start pose is the object's own pose; otherwise it holds there until startTime.
  const keyframes: Mesh3dKeyframe[] = [];
  const steps = o.startTime > 0 ? o.keyframes - 1 : o.keyframes;
  if (o.startTime > 0) keyframes.push({ time: round(o.startTime), pose: point(o.startDegrees), easing: "linear" });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    keyframes.push({ time: round(o.startTime + (o.endTime - o.startTime) * f), pose: point(o.startDegrees + (o.endDegrees - o.startDegrees) * f), easing: "linear" });
  }
  const step = Math.abs(o.endDegrees - o.startDegrees) / steps * Math.PI / 180;
  return { pose: point(o.startDegrees), keyframes, maxRadialError: o.radius * (1 - Math.cos(step / 2)) };
}
