import { Vector3 } from "three";
import { Mesh3dGeometryCache, mesh3dObjectDrawsV1 } from "./mesh3dGeometry";
import { mesh3dCameraAt, type Mesh3dScene, type Mesh3dCamera } from "./mesh3dScene";
import { mesh3dKernelFactoryV1 } from "./mesh3dKernel";
import { mesh3dObjectMatrixAtV1, mesh3dPlanFrameV1, mesh3dProjection, mesh3dSerialAllocatorV1, type Mesh3dDraw, type Mesh3dFrame, type Mesh3dFramePlanV1, type Mesh3dPlanPassV1, type Mesh3dPlanPostV1, type Mesh3dRasterOptionsV1, type Mesh3dTexture } from "./mesh3dFramePlan";

export type { Mesh3dTexture, Mesh3dDraw, Mesh3dFrame, Mesh3dRasterOptionsV1 } from "./mesh3dFramePlan";
export { mesh3dObjectMatrixAtV1, mesh3dProjection, MESH3D_MAX_OBJECTS, MESH3D_MAX_SCENE_TRIANGLES, MESH3D_MAX_TEXTURES } from "./mesh3dFramePlan";
type Vertex = number[]; // homogeneous x,y,z,w, texture u,v, light intensity
const clipDistance = (v: Vertex, side: number) => side === 0 ? v[0] + v[3] : side === 1 ? v[3] - v[0] : side === 2 ? v[1] + v[3] : side === 3 ? v[3] - v[1] : side === 4 ? v[2] + v[3] : v[3] - v[2];
/** Clip in homogeneous space before division, preserving UV/light attributes. */
export function clipMeshTriangle(input: Vertex[]): Vertex[] {
  let polygon = input;
  for (let side = 0; side < 6; side++) {
    if (!polygon.length) break;
    const next: Vertex[] = [];
    let a = polygon[polygon.length - 1], da = clipDistance(a, side);
    for (const b of polygon) {
      const db = clipDistance(b, side);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db); next.push(a.map((value, i) => value + (b[i] - value) * t));
      }
      if (db >= 0) next.push(b);
      a = b; da = db;
    }
    polygon = next;
  }
  return polygon;
}

/** The calling thread's kernel instance (worker threads build their own from the same source). */
const kernel = mesh3dKernelFactoryV1();
export function mesh3dRunPlanSerialV1(plan: Mesh3dFramePlanV1): Mesh3dFrame {
  return plan.finish(kernel.runFrame(plan.job, kernel.serialCtx()));
}

/** Shared CPU executor. Opaque Rec.709 textures, z-buffer and perspective-correct UVs. */
export function rasterizeMesh3d(scene: Mesh3dScene, camera: Mesh3dCamera, draws: Mesh3dDraw[], width: number, height: number, textures = new Map<string, Mesh3dTexture>(), options: Mesh3dRasterOptionsV1 = {}): Mesh3dFrame {
  return mesh3dRunPlanSerialV1(mesh3dPlanFrameV1(scene, [{ camera, draws }], width, height, textures, options, undefined, mesh3dSerialAllocatorV1));
}

/**
 * Raster passes and post chain of a frame. Post-effect frames: motion blur averages
 * `samples` sub-frame renders across the shutter (inside the same segment), then
 * AO / DOF / bloom / fisheye / vignette run once; the returned depth is the sample
 * nearest the frame time.
 */
export function mesh3dFrameRequestV1(scene: Mesh3dScene, time: number, width: number, height: number, cache: Mesh3dGeometryCache): { passes: Mesh3dPlanPassV1[]; post?: Mesh3dPlanPostV1 } {
  const segment = scene.segments.find(s => time >= s.timelineStart && time < s.timelineStart + s.duration) ?? scene.segments[scene.segments.length-1];
  const local = Math.max(0, Math.min(segment.duration, time-segment.timelineStart));
  // One draw per object of every kind but tube_set, whose growth and reveal are sampled at `at` and whose tips add a
  // draw per colour role (mesh3dObjectDrawsV1); nothing shown yet means no draw.
  const draws = (at: number) => mesh3dObjectDrawsV1(segment.objects, at, cache);
  if (!scene.post) return { passes: [{ camera: mesh3dCameraAt(segment, local), draws: draws(local) }] };
  const post = scene.post;
  if (scene.overlaysV1 && (post.fisheye || post.motionBlur)) throw new Error("MESH_POST_DISTORTION_WITH_OVERLAYS_UNSUPPORTED: 魚眼／動態模糊會讓錨點覆蓋層錯位");
  const blur = post.motionBlur, count = blur ? blur.samples : 1;
  const times = Array.from({ length: count }, (_, i) => blur ? Math.max(0, Math.min(segment.duration, local + blur.shutterSeconds * ((i + .5) / count - .5))) : local);
  const centre = times.reduce((best, t, i) => Math.abs(t - local) < Math.abs(times[best] - local) ? i : best, 0);
  const passes = times.map(t => ({ camera: mesh3dCameraAt(segment, t), draws: draws(t) }));
  const camera = mesh3dCameraAt(segment, local);
  let gap: { sx: number; sy: number } | undefined;
  if (count > 1) {
    // Screen shift of the look-at point between neighbouring sub-frames (a whip pan's streak step).
    const target = new Vector3(...camera.target), first = target.clone().applyMatrix4(mesh3dProjection(mesh3dCameraAt(segment, times[0]), width / height));
    const last = target.clone().applyMatrix4(mesh3dProjection(mesh3dCameraAt(segment, times[count - 1]), width / height));
    if ([first.x, first.y, last.x, last.y].every(Number.isFinite)) gap = { sx: (last.x - first.x) * width / 2 / (count - 1), sy: (last.y - first.y) * height / 2 / (count - 1) };
  }
  return { passes, post: { post, camera, gap, centre } };
}
export function renderMesh3dFrame(scene: Mesh3dScene, time: number, width: number, height: number, cache: Mesh3dGeometryCache, textures = new Map<string, Mesh3dTexture>(), options: Mesh3dRasterOptionsV1 = {}): Mesh3dFrame {
  const request = mesh3dFrameRequestV1(scene, time, width, height, cache);
  return mesh3dRunPlanSerialV1(mesh3dPlanFrameV1(scene, request.passes, width, height, textures, options, request.post, mesh3dSerialAllocatorV1));
}
