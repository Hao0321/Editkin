import { Vector3 } from "three";
import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import { mesh3dObjectMatrixAtV1 } from "./mesh3dRasterizer";
import type { Mesh3dObject, Mesh3dSegment } from "./mesh3dScene";
import { previsHullV1, previsSubV1, type PrevisBoundsV1, type PrevisVectorV1 } from "../application/cameraPrevisMotionV1";

export function cameraPrevisObjectBoundsV1(object: Mesh3dObject, cache: Mesh3dGeometryCache, time?: number): PrevisBoundsV1 {
  const mesh = cache.get(object.geometry);
  if (time !== undefined || !object.keyframes.length) {
    const matrix = mesh3dObjectMatrixAtV1(object, time ?? 0), v = new Vector3();
    const min: PrevisVectorV1 = [Infinity, Infinity, Infinity], max: PrevisVectorV1 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(matrix);
      for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], v.getComponent(j)); max[j] = Math.max(max[j], v.getComponent(j)); }
    }
    return previsHullV1([min, max]);
  }
  // Translation/scale interpolation is convex; an origin sphere encloses any Euler rotation.
  const poses = [object.pose, ...object.keyframes.map(k => k.pose)], centers = previsHullV1(poses.map(p => p.position));
  let radius = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) radius = Math.max(radius, Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
  radius *= Math.max(...poses.flatMap(p => p.scale));
  return { min: centers.min.map(n => n - radius) as PrevisVectorV1, max: centers.max.map(n => n + radius) as PrevisVectorV1 };
}
function translationTrack(object: Mesh3dObject) {
  const start = object.pose;
  if (object.keyframes.some(k => k.pose.rotationDegrees.some((v, i) => v !== start.rotationDegrees[i]) || k.pose.scale.some((v, i) => v !== start.scale[i]))) throw Error("PREVIS_FOLLOW_ROTATION_OR_SCALE_UNSUPPORTED");
  return object.keyframes.map(k => ({ time: k.time, easing: k.easing, delta: previsSubV1(k.pose.position, start.position) }));
}
const GROUP_EPSILON = 1e-9;
function matchingTrack(a: ReturnType<typeof translationTrack>, b: ReturnType<typeof translationTrack> | undefined) {
  return b !== undefined && a.length === b.length && a.every((key, i) => key.time === b[i].time && key.easing === b[i].easing
    && key.delta.every((v, j) => Math.abs(v - b[i].delta[j]) <= GROUP_EPSILON));
}
export function prepareCameraPrevisBoundsV1(segment: Mesh3dSegment, cache: Mesh3dGeometryCache,
  options: { floorY: number; floorIds?: readonly string[]; nonblockingIds?: readonly string[]; followObjectId?: string; followGroupIds?: readonly string[] }) {
  const ids = new Set(segment.objects.map(o => o.id));
  for (const list of [options.floorIds ?? [], options.nonblockingIds ?? [], options.followGroupIds ?? []]) {
    if (new Set(list).size !== list.length || list.some(id => !ids.has(id))) throw Error("PREVIS_BOUND_IDS_INVALID");
  }
  const triangles = segment.objects.reduce((n, o) => n + cache.get(o.geometry).indices.length / 3, 0);
  if (triangles > 60_000) throw Error("PREVIS_TRIANGLE_BUDGET");
  const subject = options.followObjectId ? segment.objects.find(o => o.id === options.followObjectId) : undefined;
  if (options.followObjectId && !subject) throw Error("PREVIS_FOLLOW_OBJECT_MISSING");
  const track = subject ? translationTrack(subject) : undefined;
  const group = new Set(options.followGroupIds ?? (subject ? [subject.id] : []));
  if (subject && !group.has(subject.id)) throw Error("PREVIS_FOLLOW_GROUP_INVALID");
  if (!subject && group.size) throw Error("PREVIS_FOLLOW_GROUP_INVALID");
  const obstacles: PrevisBoundsV1[] = [], relativeObstacles: PrevisBoundsV1[] = [];
  for (const object of segment.objects) {
    if (options.floorIds?.includes(object.id)) {
      if (object.keyframes.length || cameraPrevisObjectBoundsV1(object, cache).max[1] > options.floorY + 1e-6 || group.has(object.id)) throw Error("PREVIS_FLOOR_INVALID");
      continue;
    }
    if (group.has(object.id)) {
      if (!matchingTrack(translationTrack(object), track)) throw Error("PREVIS_FOLLOW_GROUP_TRACK_MISMATCH");
      const b = cameraPrevisObjectBoundsV1(object, cache, 0);
      // Cover the admitted IEEE-754 translation tail over every convex interval.
      relativeObstacles.push({ min: b.min.map(n => n - GROUP_EPSILON) as PrevisVectorV1, max: b.max.map(n => n + GROUP_EPSILON) as PrevisVectorV1 });
    } else if (!options.nonblockingIds?.includes(object.id)) obstacles.push(cameraPrevisObjectBoundsV1(object, cache));
  }
  return { triangles, obstacles, relativeObstacles, followDeltas: track ? [[0, 0, 0] as PrevisVectorV1, ...track.map(k => k.delta)] : undefined };
}
