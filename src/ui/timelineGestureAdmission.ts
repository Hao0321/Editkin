import type { EditProject, TimelineClip } from "../domain/types";

export const TIMELINE_GESTURE_CHANGED = "專案剛剛有變更，這次調整沒有套用；請再試一次。";
interface Dependencies {
  members: (project: EditProject, clipId: string) => TimelineClip[];
  captionsLocked: (project: EditProject) => boolean;
}
interface Origin { project: EditProject; kind: "clip" | "caption"; id: string }

/** One transient gesture reference; the canonical graph/history remain owned by the editor. */
export function createTimelineGestureAdmission(dependencies: Dependencies) {
  let origin: Origin | undefined;
  const clipUnchanged = (before: EditProject, after: EditProject, left: TimelineClip, right: TimelineClip): boolean => {
    if (left.id !== right.id || left.assetId !== right.assetId || left.trackId !== right.trackId
      || left.timelineStart !== right.timelineStart || left.sourceStart !== right.sourceStart
      || left.duration !== right.duration || left.linkGroupId !== right.linkGroupId
      || left.speed !== right.speed || JSON.stringify(left.timeRemap) !== JSON.stringify(right.timeRemap)) return false;
    const oldTrack = before.tracks.find(track => track.id === left.trackId);
    const newTrack = after.tracks.find(track => track.id === right.trackId);
    const oldAsset = before.assets.find(asset => asset.id === left.assetId);
    const newAsset = after.assets.find(asset => asset.id === right.assetId);
    return Boolean(oldTrack && newTrack && oldAsset && newAsset
      && oldTrack.kind === newTrack.kind && oldTrack.locked === newTrack.locked
      && oldAsset.kind === newAsset.kind && oldAsset.uri === newAsset.uri);
  };
  return {
    refusalMessage: TIMELINE_GESTURE_CHANGED,
    begin(project: EditProject, kind: Origin["kind"], id: string): void { origin = { project, kind, id }; },
    isCurrent(project: EditProject): boolean {
      const source = origin;
      if (!source) return false;
      if (source.project === project) return true;
      if (source.project.id !== project.id || source.project.fps !== project.fps) return false;
      if (source.kind === "caption") {
        const before = source.project.captions.find(cue => cue.id === source.id), after = project.captions.find(cue => cue.id === source.id);
        return Boolean(before && after && before.start === after.start && before.duration === after.duration
          && dependencies.captionsLocked(source.project) === dependencies.captionsLocked(project));
      }
      const before = dependencies.members(source.project, source.id), after = dependencies.members(project, source.id);
      if (!before.length || before.length !== after.length) return false;
      const current = new Map(after.map(clip => [clip.id, clip]));
      return before.every(clip => {
        const next = current.get(clip.id);
        return Boolean(next && clipUnchanged(source.project, project, clip, next));
      });
    },
    clear(): void { origin = undefined; },
  };
}

