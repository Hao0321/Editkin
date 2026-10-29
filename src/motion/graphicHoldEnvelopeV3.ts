import { graphicHoldEnvelopeV3Schema } from "../domain/graphicHoldBeatV3";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { MotionGraphicV2FrameReceipt, MotionGraphicV2LayoutReceipt, MotionGraphicV2SegmentFrame } from "./compositionV2";

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** A single group affine transform after the original pose; absent and neutral states keep the exact receipt. */
export function applyGraphicHoldEnvelopeV3(project: EditProject, graphic: MotionGraphic, timelineFrame: number,
  layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt): MotionGraphicV2FrameReceipt {
  if (!graphic.holdBeatV3) return frame;
  const marker = graphicHoldEnvelopeV3Schema.parse(graphic.holdBeatV3);
  const localFrame = timelineFrame - Math.round(graphic.timelineStart * project.fps);
  if (graphic.schema !== "hao.motion-composition/v2" || marker.toFrame >= Math.round(graphic.duration * project.fps)
    || marker.originXPixels > project.width || marker.originYPixels > project.height
    || Math.abs(marker.translateXPixels) > project.width || Math.abs(marker.translateYPixels) > project.height)
    throw Object.assign(new Error("第二拍需要有效的 v2 圖形、畫布原點與圖形內時間範圍。"), { code: "HOLD_BEAT_ENVELOPE" });
  if (!frame.visible || localFrame <= marker.fromFrame || localFrame >= marker.toFrame) return frame;
  const weight = localFrame <= marker.peakFrame
    ? (localFrame - marker.fromFrame) / (marker.peakFrame - marker.fromFrame)
    : (marker.toFrame - localFrame) / (marker.toFrame - marker.peakFrame);
  const scale = 1 + (marker.peakScale - 1) * weight;
  const dx = marker.translateXPixels * weight, dy = marker.translateYPixels * weight;
  const pose = (state: MotionGraphicV2SegmentFrame, x: number, y: number): MotionGraphicV2SegmentFrame => ({ ...state,
    scale: round(state.scale * scale),
    translateXPixels: round(state.translateXPixels * scale + (scale - 1) * (x - marker.originXPixels) + dx),
    translateYPixels: round(state.translateYPixels * scale + (scale - 1) * (y - marker.originYPixels) + dy),
  });
  return { ...frame,
    segments: frame.segments.map((state, index) => pose(state, layout.segments[index].x, layout.segments[index].y)),
    ...(frame.vectorState ? { vectorState: pose(frame.vectorState, layout.box.x, layout.box.y) } : {}),
  };
}
