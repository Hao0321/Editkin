import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createEmptyProject } from "../domain/editGraph";

/** The shared source bake is neutral. Decorations and the timeline placement remain on the
 * original/render graph; keep the entire authored clock even when a consumer requests one window.
 * Volume1 is source-level audio; this function never silently mutes following audio. */
export function createTimeRemapSourceStageV1(project: Pick<EditProject, "fps">, clip: TimelineClip, asset: MediaAsset, sourcePath: string): EditProject {
  const stage = createEmptyProject("Source clock cache", { id: "source-clock-cache", width: asset.width!, height: asset.height!, fps: project.fps });
  const source = structuredClone(asset); source.uri = sourcePath; delete source.derivatives;
  stage.assets = [source]; stage.tracks[0].clips = [{ id: "source-clock", assetId: source.id, trackId: stage.tracks[0].id, timelineStart: 0,
    sourceStart: clip.sourceStart, duration: clip.duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    ...(clip.speed === undefined ? {} : { speed: clip.speed }), ...(clip.timeRemap === undefined ? {} : { timeRemap: structuredClone(clip.timeRemap) }) }];
  return stage;
}
