import type { MotionGraphic } from "../domain/types";
import type { MotionGraphicV2FrameReceipt, MotionGraphicV2LayoutReceipt } from "./compositionV2";
import { motionPanelPaths } from "./panelGeometry";
import { sampleSpringGeometryTrack } from "./springGeometryTrack";

export interface SpringGeometryVectorPath { color: string; ass: string; svg: string }

/**
 * One original rounded contour feeds SVG preview and ASS export. The authored
 * fixed envelope owns layout; the sampled edges change only its local geometry.
 */
export function springGeometryPaths(graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt): SpringGeometryVectorPath[] {
  const vector = graphic.vectorV2;
  if (!vector || vector.kind !== "spring_panel" || vector.schema !== "editkin.motion-vector-continuity/v1") {
    throw new Error("Spring geometry paths require the versioned spring_panel vector");
  }
  if (graphic.compositeLayer === "background") throw new Error("Spring geometry paths currently require foreground composition");
  if (vector.geometry.localId !== graphic.id || layout.graphicId !== graphic.id || frame.graphicId !== graphic.id
    || frame.layoutReceiptId !== layout.receiptId) throw new Error("Spring geometry graphic/layout/frame receipt identity mismatch");
  const envelope = vector.geometry.envelope;
  if (envelope.x !== 0 || envelope.y !== 0 || ![layout.box.width, layout.box.height].every(Number.isFinite)
    || Math.abs(envelope.width - layout.box.width) > .001 || Math.abs(envelope.height - layout.box.height) > .001
    || Math.abs(envelope.height - vector.heightPixels) > .001) {
    throw new Error("Spring geometry envelope does not match the fixed local layout");
  }
  if (!frame.visible) return [];
  const state = frame.vectorState;
  if (!state || state.segmentId !== `${graphic.id}:vector`
    || ![state.opacity, state.scale, state.translateXPixels, state.translateYPixels].every(Number.isFinite)
    || state.opacity < 0 || state.opacity > 1 || state.scale <= 0) throw new Error("Invalid spring geometry vector frame receipt");
  const fps = vector.geometry.left.fps;
  const startFrame = Math.round(graphic.timelineStart * fps), durationFrames = Math.max(1, Math.round(graphic.duration * fps));
  if (!Number.isInteger(frame.localFrame) || frame.localFrame < 0 || frame.localFrame >= durationFrames
    || frame.timelineFrame !== startFrame + frame.localFrame) throw new Error("Spring geometry frame receipt has an invalid local frame");
  const { geometry } = sampleSpringGeometryTrack(vector.geometry, frame.localFrame);
  const outline = graphic.outlineWidth ?? 0;
  // panelGeometry keeps compatibility clamps for older panels. Reject invalid
  // continuity samples before calling it, so those clamps cannot conceal them.
  if (!Number.isFinite(outline) || outline < 0 || outline > Math.min(geometry.width, geometry.height) / 2) {
    throw new Error("Spring geometry outline exceeds the sampled inside-stroke bounds");
  }
  if (state.opacity <= .001) return [];
  const panel = motionPanelPaths(geometry.width, geometry.height, geometry.cornerRadius, outline, { x: geometry.x, y: geometry.y });
  return [
    { color: graphic.backgroundColor, ass: panel.fillAss, svg: panel.fillSvg },
    ...(panel.borderAss ? [{ color: graphic.accentColor, ass: panel.borderAss, svg: panel.borderSvg }] : []),
  ];
}
