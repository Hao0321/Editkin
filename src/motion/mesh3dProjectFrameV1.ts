import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import type { Mesh3dScene } from "./mesh3dScene";
import { mesh3dOverlaysV1Schema } from "./mesh3dOverlayV1";
import { renderMesh3dFrame, type Mesh3dTexture, type Mesh3dFrame } from "./mesh3dRasterizer";
import { renderMesh3dAnchorFrameV1 } from "./mesh3dAnchorV1";
import { compositeHybridBillboardsV1 } from "./hybridBillboardV1";

/** Bilinear in premultiplied alpha, returned as straight RGBA for the compositor. */
export function resizeMeshOverlayV1(source: Mesh3dTexture, width: number, height: number): Uint8ClampedArray {
  if (![source.width, source.height, width, height].every(n => Number.isSafeInteger(n) && n > 0)
    || source.width * source.height > 8_388_608 || width * height > 8_388_608
    || !(source.rgba instanceof Uint8Array || source.rgba instanceof Uint8ClampedArray)
    || source.rgba.length !== source.width * source.height * 4) throw new Error("MESH_OVERLAY_PIXELS_INVALID_OR_OVER_BUDGET");
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.max(0, Math.min(source.width - 1, (x + .5) * source.width / width - .5));
    const sy = Math.max(0, Math.min(source.height - 1, (y + .5) * source.height / height - .5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), dx = sx - x0, dy = sy - y0;
    const pixels = [y0 * source.width + x0, y0 * source.width + Math.min(x0 + 1, source.width - 1),
      Math.min(y0 + 1, source.height - 1) * source.width + x0,
      Math.min(y0 + 1, source.height - 1) * source.width + Math.min(x0 + 1, source.width - 1)];
    const weights = [(1 - dx) * (1 - dy), dx * (1 - dy), (1 - dx) * dy, dx * dy];
    const alpha = pixels.reduce((sum, p, i) => sum + source.rgba[p * 4 + 3] * weights[i], 0), q = (y * width + x) * 4;
    output[q + 3] = alpha;
    if (alpha) for (let c = 0; c < 3; c++) output[q + c] = pixels.reduce((sum, p, i) => sum + source.rgba[p * 4 + c] * source.rgba[p * 4 + 3] * weights[i], 0) / alpha;
  }
  return output;
}

/** Shared preview/export adapter. The old route is byte-for-byte unchanged without opt-in bindings. */
export function renderMesh3dProjectFrameV1(scene: Mesh3dScene, clock: { timelineFrame: number; fps: number },
  width: number, height: number, cache: Mesh3dGeometryCache, textures = new Map<string, Mesh3dTexture>(),
  legacySeconds = clock.timelineFrame / clock.fps): Mesh3dFrame {
  if (!scene.overlaysV1) return renderMesh3dFrame(scene, legacySeconds, width, height, cache, textures);
  const bindings = mesh3dOverlaysV1Schema.parse(scene.overlaysV1);
  // Check the whole active allocation budget before rendering or allocating any sprite.
  const seconds = clock.timelineFrame / clock.fps;
  const segment = scene.segments.find(s => seconds >= s.timelineStart && seconds < s.timelineStart + s.duration);
  if (!segment) throw new Error("MESH_OVERLAY_ACTIVE_SEGMENT_MISSING");
  const ids = new Set(bindings.anchors.filter(a => a.segmentId === segment.id).map(a => a.id));
  const layers = bindings.layers.filter(l => ids.has(l.anchorId));
  const dimensions = layers.map(l => [Math.max(1, Math.round(l.size[0] * width)), Math.max(1, Math.round(l.size[1] * height))]);
  if (dimensions.reduce((n, [w, h]) => n + w * h, 0) > 8_388_608) throw new Error("MESH_OVERLAY_PIXEL_BUDGET");
  const sprites = layers.map((l, i) => {
    const source = textures.get(l.clipId);
    if (!source) throw new Error(`MESH_OVERLAY_SOURCE_MISSING: ${l.clipId}`);
    const [w, h] = dimensions[i];
    return { anchorId: l.anchorId, rgba: resizeMeshOverlayV1(source, w, h), width: w, height: h, opacity: l.opacity,
      offsetPixels: [l.offset[0] * width, l.offset[1] * height] as [number, number], pivot: l.pivot, occlusion: l.occlusion };
  });
  const frame = renderMesh3dAnchorFrameV1(scene, clock, width, height, cache, bindings.anchors, textures);
  const composite = compositeHybridBillboardsV1(frame, sprites);
  return { ...frame.frame, rgba: composite.rgba };
}
