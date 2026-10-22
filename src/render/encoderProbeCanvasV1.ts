export interface EncoderProbeCanvasV1 { width: number; height: number }
/** Preserve small target axes while retaining the old one-frame probe's maximum allocation. Not a maximum-size capability proof. */
export function encoderProbeCanvasV1(target?: EncoderProbeCanvasV1): EncoderProbeCanvasV1 {
  if (target === undefined) return { width: 640, height: 360 };
  if (!target || ![target.width, target.height].every(v => Number.isSafeInteger(v) && v > 0)) throw Error("ENCODER_PROBE_CANVAS_INVALID");
  return { width: Math.min(target.width, 640), height: Math.min(target.height, 360) };
}
/** Explicit scaling prevents lavfi's subsampled color source from silently rounding odd requested axes. */
export function encoderProbeFiltersV1(canvas: EncoderProbeCanvasV1, hdr: boolean): string {
  return `scale=${canvas.width}:${canvas.height},format=${hdr ? "p010le" : "yuv420p"}`;
}
