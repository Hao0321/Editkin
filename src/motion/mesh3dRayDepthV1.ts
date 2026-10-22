import { Box3, Matrix4, Ray, Vector3, Vector4 } from "three";
import { mesh3dObjectMatrixAtV1, type Mesh3dDraw } from "./mesh3dRasterizer";
import type { Mesh3dBuffers } from "./mesh3dGeometry";

const bounds = new WeakMap<Mesh3dBuffers, Box3>();
function boundsFor(mesh: Mesh3dBuffers): Box3 {
  let box = bounds.get(mesh);
  if (!box) {
    box = new Box3();
    const point = new Vector3();
    for (let i = 0; i < mesh.positions.length; i += 3) box.expandByPoint(point.fromArray(mesh.positions, i));
    bounds.set(mesh, box);
  }
  return box;
}

/** Exact subpixel visibility against the same geometry/transforms; a pixel-centre z sample is insufficient on a slope. */
export function mesh3dRayDepthV1(projection: Matrix4, draws: readonly Mesh3dDraw[]): (x: number, y: number) => number {
  if (draws.length > 32 || draws.reduce((n, d) => n + d.mesh.indices.length / 3, 0) > 60_000) throw new Error("MESH_RAY_BUDGET");
  const inverseProjection = projection.clone().invert();
  const prepared = draws.map(draw => {
    const model = mesh3dObjectMatrixAtV1(draw.object, draw.time);
    return { ...draw, model, inverse: model.clone().invert(), bounds: boundsFor(draw.mesh) };
  });
  return (x, y) => {
    if (![x, y].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error("MESH_RAY_COORDINATES_INVALID");
    const start = new Vector3(x * 2 - 1, 1 - y * 2, -1).applyMatrix4(inverseProjection);
    const end = new Vector3(x * 2 - 1, 1 - y * 2, 1).applyMatrix4(inverseProjection);
    const world = new Ray(start, end.sub(start).normalize());
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
    let nearest = Infinity;
    for (const draw of prepared) {
      const ray = world.clone().applyMatrix4(draw.inverse);
      if (!ray.intersectsBox(draw.bounds)) continue;
      for (let i = 0; i < draw.mesh.indices.length; i += 3) {
        a.fromArray(draw.mesh.positions, draw.mesh.indices[i] * 3);
        b.fromArray(draw.mesh.positions, draw.mesh.indices[i + 1] * 3);
        c.fromArray(draw.mesh.positions, draw.mesh.indices[i + 2] * 3);
        if (!ray.intersectTriangle(a, b, c, !draw.object.material.doubleSided, hit)) continue;
        hit.applyMatrix4(draw.model);
        const clip = new Vector4(hit.x, hit.y, hit.z, 1).applyMatrix4(projection), z = clip.z / clip.w;
        if (clip.w > 0 && z >= -1 - 1e-10 && z <= 1 + 1e-10) nearest = Math.min(nearest, z);
      }
    }
    return nearest;
  };
}
