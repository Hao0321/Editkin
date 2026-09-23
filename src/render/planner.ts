import { findAsset, projectDuration, validateProject } from "../domain/editGraph";
import type { CaptionCue, EditProject, TimelineClip } from "../domain/types";

export type RenderSegment =
  | { kind: "gap"; start: number; duration: number }
  | { kind: "clip"; start: number; duration: number; clip: TimelineClip; assetPath: string };

export interface RenderAudioClip {
  clip: TimelineClip;
  assetPath: string;
}

export interface RenderVideoLayer {
  trackId: string;
  trackIndex: number;
  segments: RenderSegment[];
}

export interface RenderPlan {
  fps: number;
  width: number;
  height: number;
  duration: number;
  videoLayers: RenderVideoLayer[];
  audioClips: RenderAudioClip[];
  captions: CaptionCue[];
}

export type AssetPathResolver = (uri: string) => string;

export function buildRenderPlan(project: EditProject, resolveAssetPath: AssetPathResolver): RenderPlan {
  validateProject(project);
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error("專案沒有可輸出的內容");

  const videoLayers = project.tracks.flatMap((track, trackIndex) => {
    if (track.kind !== "video" || track.muted) return [];
    const clips = track.clips.filter((clip) => clip.layer?.enabled !== false).sort((a, b) => a.timelineStart - b.timelineStart);
    const segments: RenderSegment[] = [];
    let cursor = 0;
    for (const clip of clips) {
      if (clip.timelineStart > cursor + 1e-6) segments.push({ kind: "gap", start: cursor, duration: clip.timelineStart - cursor });
      segments.push({ kind: "clip", start: clip.timelineStart, duration: clip.duration, clip, assetPath: resolveAssetPath(findAsset(project, clip.assetId).uri) });
      cursor = clip.timelineStart + clip.duration;
    }
    if (cursor < duration - 1e-6) segments.push({ kind: "gap", start: cursor, duration: duration - cursor });
    if (segments.length === 0) segments.push({ kind: "gap", start: 0, duration });
    return [{ trackId: track.id, trackIndex, segments }];
  });

  const audioClips = project.tracks
    .filter((track) => (track.kind === "audio" || track.kind === "video") && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.volume > 0 && clip.layer?.enabled !== false && (clip.layer?.role ?? "content") === "content" && findAsset(project, clip.assetId).kind !== "image")
    .map((clip) => ({ clip, assetPath: resolveAssetPath(findAsset(project, clip.assetId).uri) }));

  return {
    fps: project.fps,
    width: project.width,
    height: project.height,
    duration,
    videoLayers,
    audioClips,
    captions: [...project.captions].sort((a, b) => a.start - b.start),
  };
}
