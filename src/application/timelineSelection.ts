import type { EditProject } from "../domain/types";
import { createSnapshotTimelineSelectionNormalizerV1 } from "./timelineSelectionNormalizerV1";

/** Editor-only selection. A primary identifies the item shown in the adjustment panel. */
export interface TimelineSelection {
  clipIds: string[];
  /** S4: peers selected with their primary clip; omitted for unlinked legacy selections. */
  linkedClipIds?: string[];
  captionIds: string[];
  primaryClipId?: string;
  primaryCaptionId?: string;
}

export type TimelineSelectionItem = { kind: "clip" | "caption"; id: string };

export const emptyTimelineSelection = (): TimelineSelection => ({ clipIds: [], captionIds: [] });

/** Single click replaces; Shift and Ctrl/Command click toggle without changing the other kind. */
export function selectTimelineItem(selection: TimelineSelection, item: TimelineSelectionItem, toggle = false): TimelineSelection {
  if (!toggle) return item.kind === "clip"
    ? { clipIds: [item.id], captionIds: [], primaryClipId: item.id }
    : { clipIds: [], captionIds: [item.id], primaryCaptionId: item.id };
  const clips = [...new Set(selection.clipIds)], captions = [...new Set(selection.captionIds)];
  const ids = item.kind === "clip" ? clips : captions;
  const index = ids.indexOf(item.id);
  if (index === -1) {
    ids.push(item.id);
    return { clipIds: clips, captionIds: captions,
      ...(item.kind === "clip" ? { primaryClipId: item.id } : { primaryCaptionId: item.id }) };
  }
  ids.splice(index, 1);
  const primaryClipId = selection.primaryClipId && clips.includes(selection.primaryClipId) ? selection.primaryClipId : undefined;
  const primaryCaptionId = selection.primaryCaptionId && captions.includes(selection.primaryCaptionId) ? selection.primaryCaptionId : undefined;
  return withPrimary(clips, captions, primaryClipId, primaryCaptionId);
}

function withPrimary(clipIds: string[], captionIds: string[], primaryClipId?: string, primaryCaptionId?: string): TimelineSelection {
  if (primaryClipId) return { clipIds, captionIds, primaryClipId };
  if (primaryCaptionId) return { clipIds, captionIds, primaryCaptionId };
  return clipIds.length ? { clipIds, captionIds, primaryClipId: clipIds.at(-1) }
    : captionIds.length ? { clipIds, captionIds, primaryCaptionId: captionIds.at(-1) } : emptyTimelineSelection();
}

/** Removes deleted/stale ids after an edit or Undo; never retains two primary items. */
export function normalizeTimelineSelection(project: EditProject, selection: TimelineSelection): TimelineSelection {
  return createTimelineSelectionNormalizerV1(project)(selection);
}

/** Bind only to a published immutable snapshot; the raw normalizer above deliberately remains fresh. */
export function createTimelineSelectionNormalizerV1(project: EditProject): (selection: TimelineSelection) => TimelineSelection {
  return createSnapshotTimelineSelectionNormalizerV1(project, withPrimary);
}

/** Ctrl+A, or Ctrl+Shift+A for items whose start is at/after the playhead, on every track. */
export function selectAllTimelineItems(project: EditProject, from = 0): TimelineSelection {
  const minimumFrame = Math.round(Math.max(0, from) * project.fps);
  return withPrimary(project.tracks.flatMap(track => track.clips)
    .filter(clip => Math.round(clip.timelineStart * project.fps) >= minimumFrame).map(clip => clip.id),
  project.captions.filter(caption => Math.round(caption.start * project.fps) >= minimumFrame).map(caption => caption.id));
}
