import type { EditProject, MotionGraphic } from "../domain/types";
import type { MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { projectMotionScenePoint } from "../motion/sceneCamera2d";
import { trackedPhysicalTextFrameV1, trackedTextNumberV1 } from "../application/trackedTextGeometryV1";
import { assOverrideColor } from "./assText";

/** World-space contours: no font reshaping, second layout origin or v1 fallback. */
export function trackedTextAssFrameV1(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt,
  timelineFrame: number, camera: Parameters<typeof projectMotionScenePoint>[1]) {
  return trackedPhysicalTextFrameV1(project, graphic, layout, timelineFrame, camera).paths.map(path => ({
    slot: path.slot, layer: path.layer,
    body: `{\\an7\\q2\\p1\\pos(0,0)\\fscx100\\fscy100\\bord0\\shad0${path.blurPixels ? `\\blur${trackedTextNumberV1(path.blurPixels)}` : ""}${assOverrideColor(path.color, 1, path.opacity)}}${path.ass}{\\p0}`,
  }));
}
