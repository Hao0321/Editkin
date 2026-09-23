import type { EditorCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset } from "../domain/types";

export interface LoopingMusicPlan {
  commands: EditorCommand[];
  targetDuration: number;
  crossfade: number;
  lastClipId?: string;
}

export function buildLoopingMusicPlan(
  project: EditProject,
  asset: MediaAsset,
  clipIdFactory: (index: number) => string,
): LoopingMusicPlan {
  const frame = 1 / project.fps;
  if (!Number.isFinite(asset.duration) || asset.duration < frame) throw new Error("配樂長度不足一個 frame，無法鋪設時間軸");
  const targetDuration = Math.max(frame, projectDuration(project) || Math.min(asset.duration, 60));
  const crossfade = Math.min(1.2, asset.duration / 5, targetDuration / 5);
  const commands: EditorCommand[] = [];
  for (const track of project.tracks.filter((item) => item.id === "audio-music-a" || item.id === "audio-music-b")) {
    commands.push(...track.clips.map((clip): EditorCommand => ({ type: "delete_clip", clipId: clip.id })), { type: "delete_track", trackId: track.id });
  }
  commands.push(
    { type: "import_asset", asset: { ...asset, role: "background-music" } },
    { type: "add_track", track: { id: "audio-music-a", name: "配樂 A", kind: "audio", locked: false, muted: false, clips: [] } },
    { type: "add_track", track: { id: "audio-music-b", name: "配樂 B", kind: "audio", locked: false, muted: false, clips: [] } },
  );
  let cursor = 0;
  let index = 0;
  let lastClipId: string | undefined;
  while (cursor < targetDuration - 0.5 * frame) {
    const clipDuration = Math.min(asset.duration, targetDuration - cursor);
    lastClipId = clipIdFactory(index);
    commands.push({ type: "add_clip", clip: {
      id: lastClipId, assetId: asset.id, trackId: index % 2 === 0 ? "audio-music-a" : "audio-music-b",
      timelineStart: cursor, sourceStart: 0, duration: clipDuration, volume: 0.24,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    } });
    if (clipDuration >= targetDuration - cursor) break;
    cursor += Math.max(frame, clipDuration - crossfade);
    index += 1;
  }
  return { commands, targetDuration, crossfade, lastClipId };
}
