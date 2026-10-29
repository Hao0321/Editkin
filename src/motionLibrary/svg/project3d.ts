/**
 * Tiny perspective helper for depth effects drawn as projected 2D paths.
 *
 * Camera at (0, 0, cameraZ) looking toward -z; screen x grows right, y grows
 * down (SVG). A point's depth is cameraZ - z (distance in front of the camera);
 * scale = focal / depth. No meshes: callers project outlines and painter-sort.
 */

export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }
export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export interface Camera3D {
  /** Focal length in pixels (see focalForFov). */
  readonly focal: number;
  /** Screen position of the optical axis (usually the frame centre). */
  readonly cx: number;
  readonly cy: number;
  /** Camera z position (default 0). */
  readonly z?: number;
  /** Points closer than this depth are behind the near plane (default 1). */
  readonly near?: number;
}

export interface Projected {
  readonly x: number;
  readonly y: number;
  /** focal / depth: multiply object-space sizes by this to get pixels. */
  readonly scale: number;
  /** Distance in front of the camera (larger = farther). */
  readonly depth: number;
  readonly visible: boolean;
}

/** Focal length (px) for a vertical field of view over a viewport height. */
export function focalForFov(fovDegrees: number, viewportHeight: number): number {
  if (!(fovDegrees > 0 && fovDegrees < 179) || !(viewportHeight > 0)) throw new Error("focalForFov needs 0 < fov < 179 and a positive height");
  return viewportHeight / 2 / Math.tan((fovDegrees * Math.PI) / 360);
}

export function project(point: Vec3, camera: Camera3D): Projected {
  const depth = (camera.z ?? 0) - point.z;
  const near = camera.near ?? 1;
  if (depth < near) return { x: camera.cx, y: camera.cy, scale: 0, depth, visible: false };
  const scale = camera.focal / depth;
  return { x: camera.cx + point.x * scale, y: camera.cy + point.y * scale, scale, depth, visible: true };
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Rotation about the X axis (positive brings +y, screen-down, toward +z, the camera: the top leans away). */
export function rotateX(point: Vec3, degrees: number): Vec3 {
  const a = toRadians(degrees), c = Math.cos(a), s = Math.sin(a);
  return { x: point.x, y: point.y * c - point.z * s, z: point.y * s + point.z * c };
}
/** Rotation about the Y axis (positive turns +x toward -z). */
export function rotateY(point: Vec3, degrees: number): Vec3 {
  const a = toRadians(degrees), c = Math.cos(a), s = Math.sin(a);
  return { x: point.x * c + point.z * s, y: point.y, z: -point.x * s + point.z * c };
}
/** Rotation about the Z axis (clockwise on screen). */
export function rotateZ(point: Vec3, degrees: number): Vec3 {
  const a = toRadians(degrees), c = Math.cos(a), s = Math.sin(a);
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c, z: point.z };
}
export const translate3 = (point: Vec3, d: Vec3): Vec3 => ({ x: point.x + d.x, y: point.y + d.y, z: point.z + d.z });
export const scale3 = (point: Vec3, s: number): Vec3 => ({ x: point.x * s, y: point.y * s, z: point.z * s });

/** Painter's order: farthest first; equal depths keep input order (stable). */
export function depthSort<T>(items: readonly T[], depthOf: (item: T) => number): T[] {
  return items.map((item, index) => ({ item, index, depth: depthOf(item) }))
    .sort((a, b) => (b.depth - a.depth) || (a.index - b.index))
    .map(entry => entry.item);
}

export interface ProjectedPolygon {
  readonly points: ReadonlyArray<readonly [number, number]>;
  /** Mean depth of the (clipped) vertices, for painter sorting. */
  readonly depth: number;
  readonly visible: boolean;
}

/** Project a planar polygon, clipping it against the near plane first (Sutherland–Hodgman on depth). */
export function projectPolygon(points: readonly Vec3[], camera: Camera3D): ProjectedPolygon {
  const near = camera.near ?? 1, cameraZ = camera.z ?? 0;
  const depthOf = (point: Vec3) => cameraZ - point.z;
  const clipped: Vec3[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index], next = points[(index + 1) % points.length];
    const dc = depthOf(current), dn = depthOf(next);
    if (dc >= near) clipped.push(current);
    if ((dc >= near) !== (dn >= near)) {
      const t = (near - dc) / (dn - dc);
      clipped.push({ x: current.x + (next.x - current.x) * t, y: current.y + (next.y - current.y) * t, z: current.z + (next.z - current.z) * t });
    }
  }
  if (clipped.length < 3) return { points: [], depth: Infinity, visible: false };
  const projected = clipped.map(point => project(point, { ...camera, near: near * 0.999999 }));
  const depth = clipped.reduce((sum, point) => sum + depthOf(point), 0) / clipped.length;
  return { points: projected.map(point => [point.x, point.y] as const), depth, visible: true };
}

/** 1 at `near`, falling linearly to 0 at `far` (clamped): depth-based opacity or colour mix. */
export function depthFade(depth: number, near: number, far: number): number {
  if (far <= near) return depth <= near ? 1 : 0;
  return Math.max(0, Math.min(1, (far - depth) / (far - near)));
}

/** Signed screen-space area (positive = clockwise in y-down screen space): back-face test for projected faces. */
export function signedArea(points: ReadonlyArray<readonly [number, number]>): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index], [x2, y2] = points[(index + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}
