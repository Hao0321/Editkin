import type { EditProject } from "./types";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "./types";
import { EditGraphError } from "./editGraphError";
import { MESH3D_SCENE_BUDGET_V1, type Mesh3dScene } from "../motion/mesh3dScene";
import { mesh3dOverlayClipIdsV1 } from "../motion/mesh3dOverlayV1";

/** Validate the raw-pixel route: unsupported clip processing must never disappear silently. */
export function validateMesh3dOverlaysV1(project: EditProject, scene: Mesh3dScene): Set<string> {
  const bindings = scene.overlaysV1, bound = new Set<string>();
  if (!bindings) return bound;
  const fail = (detail: string): never => { throw new EditGraphError(`3D 疊圖綁定不合法：${detail}`); };
  if (new Set(bindings.anchors.map(a => a.id)).size !== bindings.anchors.length
    || new Set(bindings.layers.map(l => l.id)).size !== bindings.layers.length) fail("重複 ID");
  for (const anchor of bindings.anchors) {
    const segment = scene.segments.find(s => s.id === anchor.segmentId);
    if (!segment?.objects.some(o => o.id === anchor.objectId)) fail("附著物件不存在");
    if (!bindings.layers.some(l => l.anchorId === anchor.id)) fail("附著點未使用");
  }
  for (const layer of bindings.layers) {
    const anchor = bindings.anchors.find(a => a.id === layer.anchorId);
    if (!anchor) fail("附著點不存在");
    const segment = scene.segments.find(s => s.id === anchor!.segmentId)!;
    const track = project.tracks.find(t => t.clips.some(c => c.id === layer.clipId));
    const clip = track?.clips.find(c => c.id === layer.clipId);
    if (!clip || track?.kind !== "video" || track.hidden || clip.layer?.enabled === false) fail("來源需可見影片軌道");
    const source = clip!, asset = project.assets.find(a => a.id === source.assetId);
    if (!asset || !["image", "video"].includes(asset.kind)
      || (asset.color?.interpretation && asset.color.interpretation !== "rec709")) fail("來源需 Rec.709 SDR 圖片或影片");
    const start = source.sourceStart + segment.timelineStart - source.timelineStart;
    if (source.timelineStart > segment.timelineStart + 1e-6
      || source.timelineStart + source.duration < segment.timelineStart + segment.duration - 1e-6
      || start < -1e-6 || (asset!.kind === "video" && start + segment.duration > asset!.duration + 1e-6)) fail("來源未完整覆蓋場景");
    if ((source.speed !== undefined && source.speed !== 1) || source.timeRemap || source.transform3d || source.floatingFrame
      || source.layout || source.chromaKey || source.masks?.length || source.keyframes.length || source.gradeV2
      || Object.keys(source.expressions ?? {}).length || source.rec709Input === "camera"
      || Object.entries(source.transform).some(([k, v]) => v !== (k === "flipX" || k === "flipY" ? false : DEFAULT_TRANSFORM[k as keyof typeof DEFAULT_TRANSFORM]))
      || Object.entries(source.color).some(([k, v]) => v !== DEFAULT_COLOR[k as keyof typeof DEFAULT_COLOR])
      || source.creative?.nativeEffectInstances?.length || source.creative?.effectPresetIds?.length
      || source.creative?.lookPresetId || source.creative?.transitionIn || source.creative?.transitionOut
      || source.layer?.parentClipId || source.layer?.trackMatte
      || (source.layer?.role !== undefined && source.layer.role !== "content")
      || (source.layer?.blendMode !== undefined && source.layer.blendMode !== "normal")) fail("請先物化來源的變速、遮罩、調色、動畫或特效");
    bound.add(source.id);
  }
  for (const segment of scene.segments) {
    const ids = new Set([...segment.objects.flatMap(o => o.material.clipId ? [o.material.clipId] : []),
      ...mesh3dOverlayClipIdsV1(bindings, segment.id)]);
    if (ids.size > MESH3D_SCENE_BUDGET_V1.textures) fail(`同幕材質與疊圖合計最多 ${MESH3D_SCENE_BUDGET_V1.textures} 個來源`);
  }
  return bound;
}
