import { assertMesh3dAnchorFrameV1, type Mesh3dAnchorFrameV1 } from "./mesh3dAnchorV1";

export interface HybridBillboardV1 {
  anchorId: string;
  /** Already authored 2D pixels. This API does not synthesize fonts or a replacement Motion engine. */
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  opacity: number;
  offsetPixels: [number, number];
  pivot: [number, number];
  occlusion: "depth_test" | "hide_with_anchor" | "always_front";
}
export interface HybridBillboardFrameV1 {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  timelineFrame: number;
  fps: number;
  drawnPixels: number;
  depthRejectedPixels: number;
  contract: "screen-facing-fixed-pixel-billboard/encoded-rec709-rgba/v1";
}

function validate(frame: Mesh3dAnchorFrameV1, layers: readonly HybridBillboardV1[]): void {
  assertMesh3dAnchorFrameV1(frame);
  if (!Array.isArray(layers) || layers.length > 128) throw new Error("HYBRID_BILLBOARD_LAYER_BUDGET");
  let sourcePixels = 0;
  for (const layer of layers) {
    if (!Number.isSafeInteger(layer.width) || !Number.isSafeInteger(layer.height) || layer.width < 1 || layer.height < 1
      || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1
      || !Array.isArray(layer.offsetPixels) || layer.offsetPixels.length !== 2
      || Array.from(layer.offsetPixels).some((n: unknown) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 32768)
      || !Array.isArray(layer.pivot) || layer.pivot.length !== 2 || Array.from(layer.pivot).some((n: unknown) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
      || !["depth_test", "hide_with_anchor", "always_front"].includes(layer.occlusion)
      || !(layer.rgba instanceof Uint8Array || layer.rgba instanceof Uint8ClampedArray)
      || layer.rgba.length !== layer.width * layer.height * 4) throw new Error("HYBRID_BILLBOARD_LAYER_INVALID");
    sourcePixels += layer.width * layer.height;
    if (sourcePixels > 8_388_608) throw new Error("HYBRID_BILLBOARD_PIXEL_BUDGET");
    if (!frame.anchors.some(a => a.id === layer.anchorId)) throw new Error("HYBRID_BILLBOARD_ANCHOR_MISSING");
  }
}

/** Opt-in CPU composite; reads the renderer's depth and leaves both original buffers unchanged. */
export function compositeHybridBillboardsV1(frame: Mesh3dAnchorFrameV1, layers: readonly HybridBillboardV1[]): HybridBillboardFrameV1 {
  validate(frame, layers);
  const rgba = new Uint8ClampedArray(frame.frame.rgba);
  let drawnPixels = 0, depthRejectedPixels = 0;
  for (const layer of layers) {
    const anchor = frame.anchors.find(a => a.id === layer.anchorId)!;
    if (anchor.x === null || anchor.y === null || anchor.depthNdc === null
      || (layer.occlusion === "hide_with_anchor" && anchor.visibility !== "visible") || layer.opacity === 0) continue;
    const left = Math.round(anchor.x * frame.width + layer.offsetPixels[0] - layer.width * layer.pivot[0]);
    const top = Math.round(anchor.y * frame.height + layer.offsetPixels[1] - layer.height * layer.pivot[1]);
    const minX = Math.max(0, left), maxX = Math.min(frame.width, left + layer.width);
    const minY = Math.max(0, top), maxY = Math.min(frame.height, top + layer.height);
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
      const p = (y * frame.width + x) * 4, q = ((y - top) * layer.width + x - left) * 4;
      const alpha = layer.rgba[q + 3] / 255 * layer.opacity;
      if (!alpha) continue;
      if (layer.occlusion === "depth_test" && anchor.depthNdc > frame.frame.depthPrecise![y * frame.width + x] + frame.depthBiasNdc) {
        depthRejectedPixels++; continue;
      }
      for (let channel = 0; channel < 3; channel++) rgba[p + channel] = layer.rgba[q + channel] * alpha + rgba[p + channel] * (1 - alpha);
      drawnPixels++;
    }
  }
  return { rgba, width: frame.width, height: frame.height, timelineFrame: frame.timelineFrame, fps: frame.fps,
    drawnPixels, depthRejectedPixels, contract: "screen-facing-fixed-pixel-billboard/encoded-rec709-rgba/v1" };
}
