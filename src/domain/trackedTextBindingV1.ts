import type { MotionGraphic } from "./types";

/** W3-4 uses the existing optional binding. Physical layout is verified by the
 * renderer, never inferred from a font name or admitted through native paint. */
export function assertTrackedTextBindingV1(graphic: MotionGraphic): void {
  if (!graphic.vectorTrackingV1 || graphic.schema !== "hao.motion-composition/v2" || graphic.vectorV2
    || !graphic.text.trim() || graphic.trackId !== undefined || graphic.trackingMode !== undefined
    || graphic.paintV1 || graphic.visualStyle === "native_paint" || graphic.clipRegion || graphic.holdBeatV3
    || graphic.compositeLayer === "background" || graphic.offsetX !== 0 || graphic.offsetY !== 0) {
    throw Error("TRACKED_TEXT_GRAPHIC_CONTRACT");
  }
}
