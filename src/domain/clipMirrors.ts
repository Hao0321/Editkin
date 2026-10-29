import type { EditProject, TimelineClip, Transform2D } from "./types";
import { EditGraphError } from "./editGraphError";
import { isTemplateManagedClip } from "./clipSourceEdits";
import { isTransformMotionBlurInstance } from "./transformMotionBlur";

type Mirrors = Pick<Transform2D, "flipX" | "flipY">;
export function hasClipMirrorPatch(patch: Partial<Transform2D>): boolean { return "flipX" in patch || "flipY" in patch; }
export function numericClipTransformPatch(patch: Partial<Transform2D>): Record<string, number> {
  return Object.fromEntries(Object.entries(patch).filter((entry): entry is [string,number] => typeof entry[1] === "number"));
}
export const MIRROR_TEMPLATE_REFUSAL = "這段是標題模板管理的片段，尚未能安全翻轉；原專案保持不變。";
export const MIRROR_COMPLEX_REFUSAL = "這段使用立體、浮動框或快門效果，尚未能安全翻轉；原專案保持不變。";
export function hasClipMirrors(transform: Mirrors): boolean { return transform.flipX === true || transform.flipY === true; }
export function clipMirrorFlags(transform: Mirrors): Mirrors {
  return { ...(transform.flipX === undefined ? {} : { flipX: transform.flipX }), ...(transform.flipY === undefined ? {} : { flipY: transform.flipY }) };
}
/** Mirrors belong to the clip, and stay fixed while its numeric keyframes animate. */
export function withAuthoredClipMirrors(clip: TimelineClip, transform: Transform2D): Transform2D {
  if (clip.transform.flipX === undefined && clip.transform.flipY === undefined && transform.flipX === undefined && transform.flipY === undefined) return transform;
  const { flipX: _x, flipY: _y, ...numeric } = transform;
  return { ...numeric, ...clipMirrorFlags(clip.transform) };
}
export function clipMirrorCss(transform: Mirrors): string {
  return `${transform.flipX ? " scaleX(-1)" : ""}${transform.flipY ? " scaleY(-1)" : ""}`;
}
export function clipMirrorFilters(transform: Mirrors): string[] {
  return [...(transform.flipX ? ["hflip"] : []), ...(transform.flipY ? ["vflip"] : [])];
}
export function composeClipTransforms(parent: Transform2D, child: Transform2D): Transform2D {
  const radians = parent.rotation * Math.PI / 180;
  if (!hasClipMirrors(parent) && !hasClipMirrors(child)) return {
    x: parent.x + (child.x * Math.cos(radians) - child.y * Math.sin(radians)) * parent.scale,
    y: parent.y + (child.x * Math.sin(radians) + child.y * Math.cos(radians)) * parent.scale,
    scale: parent.scale * child.scale, rotation: parent.rotation + child.rotation, opacity: parent.opacity * child.opacity,
  };
  const sx = parent.flipX ? -1 : 1, sy = parent.flipY ? -1 : 1;
  return {
    x: parent.x + (child.x * sx * Math.cos(radians) - child.y * sy * Math.sin(radians)) * parent.scale,
    y: parent.y + (child.x * sx * Math.sin(radians) + child.y * sy * Math.cos(radians)) * parent.scale,
    scale: parent.scale * child.scale, rotation: parent.rotation + sx * sy * child.rotation, opacity: parent.opacity * child.opacity,
    flipX: Boolean(parent.flipX) !== Boolean(child.flipX), flipY: Boolean(parent.flipY) !== Boolean(child.flipY),
  };
}
export function assertClipMirrorPatch(project: EditProject, clip: TimelineClip, patch: Partial<Transform2D>): void {
  if (!("flipX" in patch) && !("flipY" in patch)) return;
  if (isTemplateManagedClip(project, clip.id)) throw new EditGraphError(MIRROR_TEMPLATE_REFUSAL);
  const asset = project.assets.find(candidate => candidate.id === clip.assetId);
  if (!asset || asset.kind === "audio") throw new EditGraphError("請選取一般影片或圖片片段來翻轉。");
  if (asset.compositionId || clip.floatingFrame || project.scene25d?.enabled || project.scene3d?.enabled
    || clip.creative?.nativeEffectInstances?.some(instance => instance.enabled && isTransformMotionBlurInstance(instance))) throw new EditGraphError(MIRROR_COMPLEX_REFUSAL);
}
