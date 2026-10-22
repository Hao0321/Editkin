import type { EditProject } from "../domain/types";
import { linkedClipIds } from "../domain/clipLinks";
import { normalizeTimelineSelection, selectTimelineItem, type TimelineSelection, type TimelineSelectionItem } from "./timelineSelection";

/** Toggle a linked group as one selection; its peers cannot silently select a just-toggled primary again. */
export function selectLinkedTimelineItem(project: EditProject, selection: TimelineSelection, item: TimelineSelectionItem, toggle = false): TimelineSelection {
  if (item.kind === "clip" && toggle && selection.clipIds.includes(item.id)) {
    const group = new Set(linkedClipIds(project, item.id));
    const next = { ...selection, clipIds: selection.clipIds.filter(id => !group.has(id)) };
    return normalizeTimelineSelection(project, next);
  }
  return normalizeTimelineSelection(project, selectTimelineItem(selection, item, toggle));
}
