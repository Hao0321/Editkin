import { Matrix4, Vector4 } from "three";
import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import { mesh3dCameraAt, mesh3dSceneSchema, type Mesh3dScene } from "./mesh3dScene";
import { mesh3dObjectMatrixAtV1, mesh3dProjection, renderMesh3dFrame, type Mesh3dFrame, type Mesh3dTexture } from "./mesh3dRasterizer";
import { mesh3dRayDepthV1 } from "./mesh3dRayDepthV1";

export interface Mesh3dWorldAnchorV1 {
  id: string;
  segmentId: string;
  objectId: string;
  localPoint: [number, number, number];
}
export type Mesh3dAnchorVisibilityV1 = "visible" | "occluded" | "outside_frustum" | "behind_camera" | "inactive";
export interface Mesh3dAnchorSampleV1 {
  readonly id: string;
  readonly objectId: string;
  readonly visibility: Mesh3dAnchorVisibilityV1;
  readonly x: number | null;
  readonly y: number | null;
  readonly depthNdc: number | null;
}
export interface Mesh3dAnchorFrameV1 {
  readonly schema: "editkin.mesh-anchor-frame/v1";
  readonly width: number;
  readonly height: number;
  readonly timelineFrame: number;
  readonly fps: number;
  readonly segmentId: string;
  readonly depthBiasNdc: number;
  readonly frame: Mesh3dFrame;
  readonly anchors: readonly Mesh3dAnchorSampleV1[];
}

const DEPTH_BIAS = 1e-10;
const issued = new WeakMap<Mesh3dAnchorFrameV1, { rgba: Uint8ClampedArray; depth: Float32Array; precise: Float64Array }>();
const validId = (s: string) => typeof s === "string" && s.trim().length > 0 && s.length <= 160;

/** This in-process frame handle is not a serializable v4/native admission receipt. */
export function assertMesh3dAnchorFrameV1(value: Mesh3dAnchorFrameV1): void {
  const original = issued.get(value);
  if (!original || value.frame.rgba !== original.rgba || value.frame.depth !== original.depth || value.frame.depthPrecise !== original.precise
    || original.rgba.length !== value.width * value.height * 4 || original.depth.length !== value.width * value.height) {
    throw new Error("MESH_ANCHOR_FRAME_NOT_ISSUED_OR_CHANGED");
  }
}

function validateBindings(scene: Mesh3dScene, bindings: readonly Mesh3dWorldAnchorV1[]): void {
  if (!Array.isArray(bindings) || bindings.length > 128) throw new Error("MESH_ANCHOR_BINDING_BUDGET");
  const ids = new Set<string>();
  if (new Set(scene.segments.map(s => s.id)).size !== scene.segments.length) throw new Error("MESH_ANCHOR_SEGMENT_AMBIGUOUS");
  for (const segment of scene.segments) {
    if (new Set(segment.objects.map(o => o.id)).size !== segment.objects.length) throw new Error("MESH_ANCHOR_OBJECT_AMBIGUOUS");
  }
  for (const binding of bindings) {
    if (!validId(binding.id) || ids.has(binding.id) || !validId(binding.segmentId) || !validId(binding.objectId)
      || !Array.isArray(binding.localPoint) || binding.localPoint.length !== 3
      || Array.from(binding.localPoint).some((n: unknown) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100)) throw new Error("MESH_ANCHOR_BINDING_INVALID");
    ids.add(binding.id);
    const segment = scene.segments.find(s => s.id === binding.segmentId);
    if (!segment || !segment.objects.some(o => o.id === binding.objectId)) throw new Error("MESH_ANCHOR_TARGET_MISSING");
  }
}

function project(binding: Mesh3dWorldAnchorV1, activeId: string, scene: Mesh3dScene, local: number,
  projection: Matrix4, rayDepth: (x: number, y: number) => number): Mesh3dAnchorSampleV1 {
  const result = (visibility: Mesh3dAnchorVisibilityV1, x: number | null = null, y: number | null = null,
    depthNdc: number | null = null): Mesh3dAnchorSampleV1 => Object.freeze({ id: binding.id, objectId: binding.objectId, visibility, x, y, depthNdc });
  if (binding.segmentId !== activeId) return result("inactive");
  const segment = scene.segments.find(s => s.id === activeId)!;
  const object = segment.objects.find(o => o.id === binding.objectId)!;
  const mvp = new Matrix4().multiplyMatrices(projection, mesh3dObjectMatrixAtV1(object, local));
  const clip = new Vector4(...binding.localPoint, 1).applyMatrix4(mvp);
  if (![clip.x, clip.y, clip.z, clip.w].every(Number.isFinite)) throw new Error("MESH_ANCHOR_PROJECTION_INVALID");
  if (clip.w <= 1e-9) return result("behind_camera");
  const x = clip.x / clip.w * .5 + .5, y = .5 - clip.y / clip.w * .5, z = clip.z / clip.w;
  if (x < 0 || x >= 1 || y < 0 || y >= 1 || z < -1 || z > 1) return result("outside_frustum");
  const depth = rayDepth(x, y);
  return result(z > depth + DEPTH_BIAS ? "occluded" : "visible", x, y, z);
}

/** Same camera, pose, frame clock and actual z-buffer as the existing CPU renderer. */
export function renderMesh3dAnchorFrameV1(input: Mesh3dScene, clock: { timelineFrame: number; fps: number },
  width: number, height: number, cache: Mesh3dGeometryCache, bindings: readonly Mesh3dWorldAnchorV1[],
  textures = new Map<string, Mesh3dTexture>()): Mesh3dAnchorFrameV1 {
  if (!Number.isSafeInteger(clock.timelineFrame) || clock.timelineFrame < 0 || !Number.isFinite(clock.fps)
    || clock.fps <= 0 || clock.fps > 240 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || width * height > 3840 * 2160) throw new Error("MESH_ANCHOR_CLOCK_OR_SIZE_INVALID");
  const scene = mesh3dSceneSchema.parse(input);
  validateBindings(scene, bindings);
  const seconds = clock.timelineFrame / clock.fps;
  const active = scene.segments.filter(s => seconds >= s.timelineStart && seconds < s.timelineStart + s.duration);
  if (!scene.enabled || active.length !== 1) throw new Error("MESH_ANCHOR_NO_UNIQUE_ACTIVE_SEGMENT");
  const segment = active[0], local = seconds - segment.timelineStart;
  const projection = mesh3dProjection(mesh3dCameraAt(segment, local), width / height);
  const frame = renderMesh3dFrame(scene, seconds, width, height, cache, textures, { depthPrecision: "float64" });
  const rayDepth = mesh3dRayDepthV1(projection, segment.objects.map(object => ({ object, time: local, mesh: cache.get(object.geometry) })));
  const anchors = Object.freeze(bindings.map(b => project(b, segment.id, scene, local, projection, rayDepth)));
  Object.freeze(frame);
  const value: Mesh3dAnchorFrameV1 = Object.freeze({ schema: "editkin.mesh-anchor-frame/v1", width, height,
    timelineFrame: clock.timelineFrame, fps: clock.fps, segmentId: segment.id, depthBiasNdc: DEPTH_BIAS, frame, anchors });
  issued.set(value, { rgba: frame.rgba, depth: frame.depth, precise: frame.depthPrecise! });
  return value;
}
