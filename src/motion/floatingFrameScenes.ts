import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import type { EditProject, FloatingVideoFrame, TimelineClip } from "../domain/types";

export const FLOATING_FRAME_SCENE_PRESETS = [
  { id: "portrait_duo", name: "雙直式背景舞台", description: "兩片大型直式影片在後，主影片在前環繞旋轉" },
] as const;
export type FloatingFrameScenePresetId = typeof FLOATING_FRAME_SCENE_PRESETS[number]["id"];

/** Compiles one scene into ordinary, editable EditGraph tracks and clips. */
export function floatingFrameSceneCommands(project: EditProject, clipId: string, presetId: FloatingFrameScenePresetId): EditorCommand[] {
  if (presetId !== "portrait_duo") throw new Error(`未知浮空框場景：${presetId}`);
  if (project.height <= project.width) throw new Error("雙直式背景舞台需要直式畫布");
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId);
  const asset = project.assets.find(item => item.id === clip?.assetId);
  if (!clip || track?.kind !== "video" || asset?.kind !== "video") throw new Error("請選擇一段直式影片片段");
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
  const frame = (style: FloatingVideoFrame["style"], size: number, yawDegrees: number, centerX: number, orbit = false): FloatingVideoFrame => ({
    schema: "editkin.floating-video-frame/v1", style, size, yawDegrees, pitchDegrees: 3,
    aspect: "portrait", centerX, centerY: .5,
    ...(orbit ? { orbit: { amplitudeDegrees: 20, periodSeconds: 3.6 } } : {}),
  });
  const clone = (id: string, trackId: string, floatingFrame: FloatingVideoFrame): TimelineClip => ({
    ...structuredClone(clip), id, trackId, volume: 0, floatingFrame,
    layer: { ...clip.layer, enabled: true, role: "content", blendMode: "normal" },
  });
  const rightTrack = unique(`${clip.id}-rear-right-track`);
  const frontTrack = unique(`${clip.id}-front-track`);
  const commands: EditorCommand[] = [
    { type: "set_clip_floating_frame", clipId, frame: frame("graphite", .62, -24, .26) },
    { type: "add_track", track: { id: rightTrack, name: "浮空框 · 後右", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clone(unique(`${clip.id}-rear-right`), rightTrack, frame("graphite", .62, 24, .74)) },
    { type: "add_track", track: { id: frontTrack, name: "浮空框 · 前景", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clone(unique(`${clip.id}-front`), frontTrack, frame("prism", .65, 0, .5, true)) },
  ];
  // The MCP compiler is read-only, but must never hand Autopilot a scene that
  // the same EditGraph transaction would reject during audit/apply.
  applyCommand(project, { type: "batch", commands });
  return commands;
}
