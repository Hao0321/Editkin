import type { EditProject } from "../domain/types";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { planInsertClip, planOverwriteClip, type AssetEditPlan } from "./timelineAdjacentEdits";
import { planTimelineAssetInsert, type TimelinePlacementIdFactory } from "./timelinePlacement";

export type TimelineAssetEditMode = "insert" | "overwrite";

/** Main picture uses the specified insert/overwrite semantics; other lanes retain collision layers. */
export function planTimelineAssetDrop(project: EditProject, assetId: string, trackId: string, time: number,
  clipId: string, makeId: TimelinePlacementIdFactory, mode: TimelineAssetEditMode = "insert"): AssetEditPlan {
  if (project.tracks.find(track => track.id === trackId)?.locked) throw new Error(TRACK_LOCKED_MESSAGE);
  if (trackId === "video-main") return (mode === "overwrite" ? planOverwriteClip : planInsertClip)(project, assetId, trackId, time, clipId, makeId);
  const plan = planTimelineAssetInsert(project, assetId, trackId, time, clipId, makeId);
  return { ...plan, timelineStart: Math.round(time * project.fps) / project.fps,
    message: plan.newLayer ? "已放到指定影格並新增圖層；原片段保留，一次復原即可還原。" : "已將素材放到指定影格，可復原。" };
}
