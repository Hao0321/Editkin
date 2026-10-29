import type { TimelineTrack } from "../domain/types";
import { nearestTimelineCut } from "../application/timelineAdjacentEdits";
import type { TimelineAssetEditMode } from "../application/timelineAssetEditDrop";
import { alignTimelineTime } from "./timelineInteraction";
import type { TimelineAssetDropResult } from "./timelineAssetDrop";

/** A lightweight pointer preview, with the same cut choice as the committing planner. */
export function resolveMainTrackDrop(track: TimelineTrack, rawTime: number, duration: number, fps: number, ctrlKey: boolean):
  { mode: TimelineAssetEditMode; result: TimelineAssetDropResult } {
  const mode = ctrlKey ? "overwrite" : "insert";
  const start = ctrlKey ? alignTimelineTime(rawTime, fps) : nearestTimelineCut(track, rawTime, fps);
  return { mode, result: { start, duration, allowed: !track.locked && duration > 0, newLayer: false,
    ...(ctrlKey ? {} : { snappedTo: start }) } };
}
