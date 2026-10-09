import { projectDuration } from "../domain/editGraph";
import type { EditProject } from "../domain/types";

export interface PotentialAudioGap { start: number; end: number }

/** Conservative timeline check: video is counted as a possible source until its audio stream is probed. */
export function projectPotentialAudioGaps(project: EditProject, minimumSeconds = 2): PotentialAudioGap[] {
  const duration = projectDuration(project);
  if (!(duration > 0)) return [];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const coverage = project.tracks.flatMap((track) => {
    if ((track.kind !== "audio" && track.kind !== "video") || track.muted) return [];
    return track.clips.flatMap((clip) => {
      const asset = assets.get(clip.assetId);
      if (!asset || asset.kind === "image" || clip.volume <= 0 || clip.layer?.enabled === false
        || (clip.layer?.role ?? "content") !== "content") return [];
      const start = Math.max(0, clip.timelineStart);
      const end = Math.min(duration, clip.timelineStart + clip.duration);
      return end > start ? [{ start, end }] : [];
    });
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps: PotentialAudioGap[] = [];
  let cursor = 0;
  for (const interval of coverage) {
    if (interval.start - cursor >= minimumSeconds) gaps.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (duration - cursor >= minimumSeconds) gaps.push({ start: cursor, end: duration });
  return gaps;
}
