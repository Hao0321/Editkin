import type { Mesh3dBuffers } from "./mesh3dGeometry";
import type { Mesh3dMaterial, Mesh3dObject, Mesh3dScene } from "./mesh3dScene";

/**
 * Routing of the CPU rasterizer's per-pixel shading path (engine extension 2026-10-23;
 * polish 2026-10-23). The shading itself lives in mesh3dKernel.ts.
 *
 * Used only by scenes or materials that opt into a new field; the original per-vertex
 * path is untouched. Per pixel: perspective-correct normals, world positions and UVs;
 * key + fill + hemisphere light, Blinn-Phong or GGX specular (material roughness, key
 * light size), a studio reflection (chrome), rim/edge light, emission, key-light soft
 * shadows; antialiased procedural edges (stripes, wireframe and grid lines, band-text
 * masks) and filtered textures with alpha.
 */
export function mesh3dSceneExtendedV1(scene: Mesh3dScene): boolean {
  return Boolean(scene.post || scene.light.fill || scene.light.hemisphere || scene.background.radial || scene.light.shadow || scene.light.size !== undefined || scene.light.distance !== undefined);
}
export function mesh3dMaterialExtendedV1(m: Mesh3dMaterial): boolean {
  return Boolean(m.emissive || m.stripes || m.gradient || m.edgeLight || m.specular || m.reflection || m.wireframe || m.roughness !== undefined || m.texture || m.gridStyle);
}
/** Draws whose coverage is fractional (line-only wireframe, band text, alpha textures) composite after the opaque pass. */
export function mesh3dDrawBlendedV1(object: Mesh3dObject, mesh: Mesh3dBuffers): boolean {
  return Boolean(mesh.mask || (object.material.wireframe && !object.material.wireframe.fill) || (object.material.texture?.alpha && object.material.clipId));
}

const bounds = new WeakMap<Mesh3dBuffers, Float64Array>();
export function mesh3dMeshBoundsV1(mesh: Mesh3dBuffers): Float64Array {
  let box = bounds.get(mesh);
  if (!box) {
    box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], mesh.positions[i + k]); box[k + 3] = Math.max(box[k + 3], mesh.positions[i + k]); }
    bounds.set(mesh, box);
  }
  return box;
}
