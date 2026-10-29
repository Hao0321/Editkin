import type { Mesh3dRenderReceipt } from "./mesh3dReceipt";
import { mesh3dMaterialExtendedV1, mesh3dSceneExtendedV1 } from "../motion/mesh3dShading";
import type { Mesh3dScene } from "../motion/mesh3dScene";

/** Objects drawn per pixel in a per-vertex scene: extended materials, band_text glyph masks and "front" UV boxes
 * (their untextured faces shade per pixel). Shared by the export receipt (mesh3dRender.ts) and the preview. */
export function mesh3dPerPixelObjectsV1(scene: Mesh3dScene): boolean {
  return scene.segments.some(segment => segment.objects.some(object => mesh3dMaterialExtendedV1(object.material) || object.geometry.kind === "band_text"
    || ((object.geometry.kind === "box" || object.geometry.kind === "rounded_box") && object.geometry.uvMode === "front")));
}

/**
 * Which shared CPU executor draws a mesh scene. The export receipt (mesh3dShadingReceiptV1) takes its `executor` from
 * here, and code that must not load the Node-only renderer module (the preview's data-executor) calls it directly.
 * v2 when the scene opts into scene-level shading or any object is drawn per pixel; v1 otherwise.
 */
export function mesh3dShadingExecutorV1(scene: Mesh3dScene): Mesh3dRenderReceipt["executor"] {
  return mesh3dSceneExtendedV1(scene) || mesh3dPerPixelObjectsV1(scene) ? "shared-cpu-triangle-zbuffer/v2" : "shared-cpu-triangle-zbuffer/v1";
}
