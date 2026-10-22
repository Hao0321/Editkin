import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import type { EditProject, FloatingVideoFrame, TimelineClip } from "../domain/types";

export const FLOATING_FRAME_SCENE_PRESETS = [
  { id: "portrait_duo", name: "雙素材背景舞台", description: "兩片影片按原片比例置於後景，主影片完整嵌入前景平面並緩慢環繞；2.5D 透視" },
  { id: "portrait_stack", name: "錯層浮窗展廊", description: "三片影片各自保留原片比例，前後錯位、柔邊、陰影與逐格進退場；2.5D 平面" },
] as const;
export type FloatingFrameScenePresetId = typeof FLOATING_FRAME_SCENE_PRESETS[number]["id"];
export interface FloatingFrameSourceBinding { assetId: string; sourceStart: number }
export interface FloatingFrameSceneBindings { rearRight: FloatingFrameSourceBinding; front: FloatingFrameSourceBinding }

/** Compiles one scene into ordinary, editable EditGraph tracks and clips. */
export function floatingFrameSceneCommands(project: EditProject, clipId: string, presetId: FloatingFrameScenePresetId, sources?: FloatingFrameSceneBindings): EditorCommand[] {
  if (!FLOATING_FRAME_SCENE_PRESETS.some(item => item.id === presetId)) throw new Error(`未知浮空框場景：${presetId}`);
  const portraitCanvas = project.height > project.width;
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId);
  const asset = project.assets.find(item => item.id === clip?.assetId);
  if (!clip || track?.kind !== "video" || asset?.kind !== "video") throw new Error("請選擇一段影片片段");
  if (sources) {
    if (new Set([clip.assetId, sources.rearRight.assetId, sources.front.assetId]).size !== 3) throw new Error("三片素材槽需要三個不同影片，不能複製成三份案例");
    for (const binding of [sources.rearRight, sources.front]) {
      const boundAsset = project.assets.find(item => item.id === binding.assetId);
      if (boundAsset?.kind !== "video" || !Number.isFinite(binding.sourceStart) || binding.sourceStart < 0
        || binding.sourceStart + clip.duration > boundAsset.duration + .5 / project.fps) throw new Error(`浮窗素材槽 ${binding.assetId} 缺少足夠有效影片`);
    }
  }
  const sourceAssets = [asset, ...(sources ? [
    project.assets.find(item => item.id === sources.rearRight.assetId),
    project.assets.find(item => item.id === sources.front.assetId),
  ] : [])];
  if (sourceAssets.some(value => !value || (value.displayAspectRatio !== undefined
    ? !Number.isFinite(value.displayAspectRatio) || value.displayAspectRatio <= 0
    : !Number.isFinite(value.width) || value.width! <= 0 || !Number.isFinite(value.height) || value.height! <= 0))) {
    throw new Error("浮窗素材缺少原片顯示比例或正向尺寸；請先重新讀取素材資訊。");
  }
  if (track.locked || clip.floatingFrame || clip.keyframes.length || clip.transform.x || clip.transform.y
    || clip.transform.scale !== 1 || clip.transform.rotation || clip.transform.opacity !== 1) {
    throw new Error("雙直式背景舞台需要未鎖定、沒有其他浮空框或位置關鍵幀的影片片段");
  }
  const existing = new Set([...project.tracks.map(item => item.id), ...project.tracks.flatMap(item => item.clips.map(part => part.id))]);
  const unique = (base: string) => {
    let candidate = base;
    let suffix = 2;
    while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
    existing.add(candidate);
    return candidate;
  };
  const frame = (style: FloatingVideoFrame["style"], size: number, yawDegrees: number, centerX: number, centerY = .5, orbit = false): FloatingVideoFrame => ({
    schema: "editkin.floating-video-frame/v2", style, size, yawDegrees, pitchDegrees: 3,
    aspect: "source", mediaFit: "contain", motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 }, centerX, centerY,
    ...(orbit ? { orbit: { amplitudeDegrees: presetId === "portrait_stack" ? 8 : 20, periodSeconds: presetId === "portrait_stack" ? 6 : 3.6 } } : {}),
  });
  const clone = (id: string, trackId: string, floatingFrame: FloatingVideoFrame, binding?: FloatingFrameSourceBinding): TimelineClip => ({
    ...structuredClone(clip), ...(binding ? { assetId: binding.assetId, sourceStart: binding.sourceStart } : {}), id, trackId, volume: 0, floatingFrame,
    layer: { ...clip.layer, enabled: true, role: "content", blendMode: "normal" },
  });
  const rightTrack = unique(`${clip.id}-rear-right-track`);
  const frontTrack = unique(`${clip.id}-front-track`);
  const stacked = presetId === "portrait_stack";
  const commands: EditorCommand[] = [
    { type: "set_clip_floating_frame", clipId, frame: stacked ? portraitCanvas ? frame("matte", .46, -17, .31, .49) : frame("matte", .62, -17, .57, .49) : frame("graphite", .62, -24, .26) },
    { type: "add_track", track: { id: rightTrack, name: "浮空框 · 後右", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clone(unique(`${clip.id}-rear-right`), rightTrack, stacked ? portraitCanvas ? frame("matte", .41, 19, .71, .65) : frame("matte", .54, 19, .8, .61) : frame("graphite", .62, 24, .74), sources?.rearRight) },
    { type: "add_track", track: { id: frontTrack, name: "浮空框 · 前景", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clone(unique(`${clip.id}-front`), frontTrack, stacked ? portraitCanvas ? frame("matte", .52, 0, .52, .59, true) : frame("matte", .66, 0, .69, .56, true) : frame("prism", .65, 0, .5, .5, true), sources?.front) },
  ];
  // The MCP compiler is read-only, but must never hand Autopilot a scene that
  // the same EditGraph transaction would reject during audit/apply.
  applyCommand(project, { type: "batch", commands });
  return commands;
}
