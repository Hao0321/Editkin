import type { EditorCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset } from "../domain/types";

export interface LoopingMusicPlan {
  commands: EditorCommand[];
  targetDuration: number;
  crossfade: number;
  lastClipId?: string;
}

export const MUSIC_BED_TRACK_IDS: readonly string[] = ["audio-music-a", "audio-music-b"];

/**
 * How long the music bed must be: the picture (every non-audio track, captions, graphics, scenes, 3D), never the bed
 * itself. projectDuration also counts the previous bed, so a re-run after trimming used to keep the old length (B7).
 * A project with no picture (audio only) falls back to its non-music audio.
 */
export function musicBedDuration(project: EditProject): number {
  const music = (clip: EditProject["tracks"][number]["clips"][number]) => project.assets.find((asset) => asset.id === clip.assetId)?.role === "background-music";
  const picture = projectDuration({ ...project, tracks: project.tracks.filter((track) => track.kind !== "audio") });
  if (picture > 0) return picture;
  return projectDuration({ ...project, tracks: project.tracks.filter((track) => track.kind === "audio" && !MUSIC_BED_TRACK_IDS.includes(track.id))
    .map((track) => ({ ...track, clips: track.clips.filter((clip) => !music(clip)) })) });
}

export function buildLoopingMusicPlan(
  project: EditProject,
  asset: MediaAsset,
  clipIdFactory: (index: number) => string,
): LoopingMusicPlan {
  const frame = 1 / project.fps;
  if (!Number.isFinite(asset.duration) || asset.duration < frame) throw new Error("配樂長度不足一個 frame，無法鋪設時間軸");
  const targetDuration = Math.max(frame, musicBedDuration(project) || Math.min(asset.duration, 60));
  const crossfade = Math.min(1.2, asset.duration / 5, targetDuration / 5);
  const commands: EditorCommand[] = [];
  for (const track of project.tracks.filter((item) => MUSIC_BED_TRACK_IDS.includes(item.id))) {
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
