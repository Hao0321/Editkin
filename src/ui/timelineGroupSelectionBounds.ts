import type { EditProject } from "../domain/types";
import type { TimelineSelection } from "../application/timelineSelection";

/** One captured gesture owns one read-only snapshot, never a process-wide project cache. */
export function createTimelineGroupSelectionBounds() {
  let project: EditProject | undefined;
  let selection: TimelineSelection | undefined;
  let minimum: number | undefined;
  return {
    minimumStart(current: EditProject, selected: TimelineSelection): number | undefined {
      if (current === project && selected === selection) return minimum;
      const clipIds = new Set(selected.clipIds), captionIds = new Set(selected.captionIds);
      let found = false, next = Number.POSITIVE_INFINITY;
      for (const track of current.tracks) for (const clip of track.clips) {
        if (clipIds.has(clip.id)) { found = true; next = Math.min(next, clip.timelineStart); }
      }
      for (const caption of current.captions) {
        if (captionIds.has(caption.id)) { found = true; next = Math.min(next, caption.start); }
      }
      project = current;
      selection = selected;
      minimum = found ? next : undefined;
      return minimum;
    },
    clear(): void {
      project = undefined;
      selection = undefined;
      minimum = undefined;
    },
  };
}
