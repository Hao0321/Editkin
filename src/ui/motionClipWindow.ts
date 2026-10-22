import type { EditProject, MotionGraphic } from "../domain/types";
import { projectMotionScenePoint, type MotionSceneCamera2DProjection } from "../motion/sceneCamera2d";

/**
 * Preview counterpart of the ASS \clip window: the authored frame-space clipRegion (projected by the scene camera,
 * never by the graphic's own motion) as a CSS clip-path relative to the element's projected box. Points may fall
 * outside the box; polygon() keeps them exact where inset() would not.
 */
export function motionClipWindowStyle(project: EditProject, graphic: MotionGraphic, origin: { x: number; y: number },
  boxWidth: number, boxHeight: number, camera: MotionSceneCamera2DProjection): { clipPath?: string } {
  const region = graphic.clipRegion;
  if (!region || boxWidth <= 0 || boxHeight <= 0) return {};
  const a = projectMotionScenePoint({ x: region.x * project.width, y: region.y * project.height }, camera);
  const b = projectMotionScenePoint({ x: (region.x + region.width) * project.width, y: (region.y + region.height) * project.height }, camera);
  const px = (x: number) => `${(x - origin.x) / boxWidth * 100}%`, py = (y: number) => `${(y - origin.y) / boxHeight * 100}%`;
  return { clipPath: `polygon(${px(a.x)} ${py(a.y)}, ${px(b.x)} ${py(a.y)}, ${px(b.x)} ${py(b.y)}, ${px(a.x)} ${py(b.y)})` };
}
