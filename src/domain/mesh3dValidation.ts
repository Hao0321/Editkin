import type { EditProject } from "./types";
import { mesh3dSceneSchema } from "../motion/mesh3dScene";
import { EditGraphError } from "./editGraphError";
import { DEFAULT_COLOR } from "./types";

export function validateMesh3dProject(project: EditProject): void {
  if (project.compositions.some(c=>c.scene3d?.enabled)) throw new EditGraphError("網格 3D 預合成尚未驗證；請先在根專案輸出，避免落入平面合成路徑");
  if (!project.scene3d) return;
  const result = mesh3dSceneSchema.safeParse(project.scene3d);
  if (!result.success) throw new EditGraphError(`3D 場景格式不合法：${result.error.message}`);
  const scene = result.data;
  if (!scene.enabled) return;
  if (project.scene25d?.enabled || project.particleSimulation?.enabled || project.compositions.length || project.motionTracks.length
    || project.motionGraphics.some(g => g.trackId)) throw new EditGraphError("網格 3D 場景不可混用平面場景、螢幕粒子、預合成或追蹤字卡；一般字幕與獨立 Motion 字卡可疊加");
  if (project.colorManagement?.mode === "aces2") throw new EditGraphError("網格 3D 目前只驗證 Rec.709 SDR，拒絕 ACES/HDR");
  if (Math.hypot(...scene.light.direction) < .001) throw new EditGraphError("3D 光線方向不可為零");
  let end = 0;
  const ids = new Set<string>(), boundClips = new Set<string>();
  for (const segment of scene.segments) {
    if (ids.has(segment.id) || Math.abs(segment.timelineStart - end) > 1e-6) throw new EditGraphError("3D 場景需唯一 ID 並連續覆蓋時間軸");
    ids.add(segment.id); end += segment.duration;
    for (const time of [segment.timelineStart, segment.duration]) if (Math.abs(time * project.fps - Math.round(time * project.fps)) > 1e-6) throw new EditGraphError("3D 場景時間需對齊影格");
    for (const cam of [segment.camera, ...segment.cameraKeyframes.map(k => k.camera)]) if (cam.near >= cam.far || Math.hypot(...cam.position.map((v, i) => v - cam.target[i])) < .001 || Math.hypot(cam.position[0] - cam.target[0], cam.position[2] - cam.target[2]) < .001) throw new EditGraphError("3D 相機近遠裁切或視線不合法");
    const ordered = (keys: { time: number }[]) => keys.every((k, i) => k.time > (i ? keys[i - 1].time : 0) && k.time <= segment.duration);
    if (!ordered(segment.cameraKeyframes)) throw new EditGraphError("3D 相機 keyframe 需遞增且位於場景內");
    const objectIds = new Set<string>(), textureIds = new Set<string>();
    for (const object of segment.objects) {
      if (objectIds.has(object.id) || !ordered(object.keyframes)) throw new EditGraphError("3D 物件 ID 或 keyframe 不合法");
      objectIds.add(object.id);
      if (object.geometry.kind === "curved_video" && object.geometry.width / object.geometry.radius > Math.PI * 1.8) throw new EditGraphError("曲面影片張角過大");
      if (object.material.clipId) {
        const binding = project.tracks.flatMap(t => t.clips.map(c => ({ t, c }))).find(v => v.c.id === object.material.clipId);
        if (!binding || binding.t.muted || binding.t.kind !== "video" || binding.c.layer?.enabled === false
          || binding.c.timelineStart > segment.timelineStart + 1e-6 || binding.c.timelineStart + binding.c.duration < end - 1e-6) throw new EditGraphError(`3D 影片材質 ${object.id} 需可見、完整覆蓋場景的影片片段`);
        const asset = project.assets.find(a => a.id === binding.c.assetId)!;
        if (!asset || !["video", "image"].includes(asset.kind) || (asset.color?.interpretation && asset.color.interpretation !== "rec709")) throw new EditGraphError("3D 材質需已轉為 Rec.709 SDR 的影片或圖片");
        if (binding.c.masks?.length || binding.c.creative?.nativeEffectInstances?.length || binding.c.creative?.effectPresetIds?.length || binding.c.creative?.lookPresetId || binding.c.creative?.transitionIn || binding.c.creative?.transitionOut || binding.c.floatingFrame || binding.c.keyframes.length || Object.keys(binding.c.expressions ?? {}).length
          || Object.entries(binding.c.color).some(([key,value]) => typeof value === "number" && value !== (DEFAULT_COLOR[key as keyof typeof DEFAULT_COLOR] ?? 0))) throw new EditGraphError("3D 材質尚不接受 2D 遮罩、調色、濾鏡、特效與原片動畫；請先物化來源，避免忽略效果");
        textureIds.add(binding.c.id);
        boundClips.add(binding.c.id);
      }
    }
    if (textureIds.size > 6) throw new EditGraphError("3D 同幕最多 6 個影片材質");
  }
  if (project.tracks.filter(t=>t.kind==="video"&&!t.muted).flatMap(t=>t.clips).some(c=>c.layer?.enabled!==false&&!boundClips.has(c.id))) throw new EditGraphError("3D 場景有未綁定的可見影片；拒絕悄悄丟棄時間軸畫面");
  const duration = Math.max(end, ...project.tracks.flatMap(t => t.clips.map(c => c.timelineStart + c.duration)), ...project.captions.map(c => c.start + c.duration), ...project.motionGraphics.map(g => g.timelineStart + g.duration));
  if (Math.abs(end - duration) > 1e-6) throw new EditGraphError("3D 場景總長必須覆蓋專案完整時間軸");
}
