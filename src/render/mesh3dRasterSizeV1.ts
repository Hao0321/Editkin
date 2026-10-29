/** Keep existing 1.5x SSAA when it fits; the rasterizer accepts at most 4K pixels. */
export function mesh3dRasterSizeV1(width: number, height: number): { width: number; height: number } {
  const limit = 3840 * 2160;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width * height > limit) throw new Error("MESH_RASTER_DELIVERY_SIZE_INVALID");
  if (Math.ceil(width * 1.5) * Math.ceil(height * 1.5) <= limit) return { width: Math.ceil(width * 1.5), height: Math.ceil(height * 1.5) };
  const scale = Math.sqrt(limit / (width * height));
  return { width: Math.max(width, Math.floor(width * scale)), height: Math.max(height, Math.floor(height * scale)) };
}
