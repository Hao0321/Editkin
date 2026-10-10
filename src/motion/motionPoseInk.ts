import type { MotionGraphicV2SegmentFrame } from "./compositionV2";

export interface MotionInkBox { xMin: number; yMin: number; xMax: number; yMax: number }

/** libass and CSS gaussian blur visibly spread about three radii past the ink. */
export const MOTION_BLUR_INK_SPREAD = 3;

/**
 * Screen-space ink bounds of one posed segment, matching every renderer:
 * local ink rotates about the segment box center, scales about the segment
 * origin, then translates. Without rotation/blur this is the historical
 * origin + ink * scale box, so existing safe-area decisions do not change.
 */
export function posedSegmentInkBounds(ink: MotionInkBox, origin: { x: number; y: number }, state: Pick<MotionGraphicV2SegmentFrame, "scale" | "rotationDegrees" | "blurPixels">,
  pivot: { width: number; height: number }): MotionInkBox {
  const rotation = state.rotationDegrees ?? 0, blur = state.blurPixels ?? 0;
  let box = ink;
  if (rotation !== 0) {
    const radians = rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const cx = pivot.width / 2, cy = pivot.height / 2;
    const corners = [[ink.xMin, ink.yMin], [ink.xMax, ink.yMin], [ink.xMin, ink.yMax], [ink.xMax, ink.yMax]].map(([x, y]) => ({
      x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos }));
    box = { xMin: Math.min(...corners.map(p => p.x)), yMin: Math.min(...corners.map(p => p.y)),
      xMax: Math.max(...corners.map(p => p.x)), yMax: Math.max(...corners.map(p => p.y)) };
  }
  const spread = blur * MOTION_BLUR_INK_SPREAD;
  return { xMin: origin.x + box.xMin * state.scale - spread, yMin: origin.y + box.yMin * state.scale - spread,
    xMax: origin.x + box.xMax * state.scale + spread, yMax: origin.y + box.yMax * state.scale + spread };
}
