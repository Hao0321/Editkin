import type { ProjectSession } from "./projectSession";
import type { EditProject } from "../domain/types";
import type { TimelineClipboard } from "./timelineClipboard";
import type { TimelineMarkRange } from "./timelineNavigation";
import { createTimelineSelectionNormalizerV1, emptyTimelineSelection, selectTimelineItem, type TimelineSelection } from "./timelineSelection";

export interface TimelineEditingSnapshot {
  selection: TimelineSelection;
  clipboard?: TimelineClipboard;
  markRange: TimelineMarkRange;
}
type SelectionValue = string | undefined | ((current: string | undefined) => string | undefined);
const sameIds = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((id, index) => id === b[index]);
const sameSelection = (a: TimelineSelection, b: TimelineSelection) => a.primaryClipId === b.primaryClipId
  && a.primaryCaptionId === b.primaryCaptionId && sameIds(a.clipIds, b.clipIds)
  && sameIds(a.captionIds, b.captionIds) && sameIds(a.linkedClipIds, b.linkedClipIds);

/** Window-local selection, clipboard and In/Out marks; setters read the live session before React renders again. */
export function createTimelineEditingState(session: ProjectSession, initial = emptyTimelineSelection()) {
  const started = session.getSnapshot();
  let sessionId = started.sessionId;
  type Projection = { project: EditProject; contentOwner: object; normalize: ReturnType<typeof createTimelineSelectionNormalizerV1> };
  let projection: Projection | undefined = { project: started.history.present, contentOwner: started.contentOwner,
    normalize: createTimelineSelectionNormalizerV1(started.history.present) };
  let snapshot: TimelineEditingSnapshot = {
    selection: projection.normalize(initial), markRange: {},
  };
  let version = 0, notifiedVersion = 0;
  const replaceSnapshot = (next: TimelineEditingSnapshot) => { snapshot = next; version++; };
  const listeners = new Set<() => void>();
  let detach: (() => void) | undefined;
  const notify = () => { notifiedVersion = version; for (const listener of [...listeners]) listener(); };
  const reconcile = () => {
    const live = session.getSnapshot();
    if (projection && live.sessionId === sessionId && live.history.present === projection.project && live.contentOwner === projection.contentOwner) return false;
    const replaced = live.sessionId !== sessionId;
    sessionId = live.sessionId;
    projection = { project: live.history.present, contentOwner: live.contentOwner, normalize: createTimelineSelectionNormalizerV1(live.history.present) };
    if (replaced) {
      replaceSnapshot({ selection: emptyTimelineSelection(), markRange: {} });
      return true;
    }
    const selection = projection.normalize(snapshot.selection);
    if (sameSelection(selection, snapshot.selection)) return false;
    replaceSnapshot({ ...snapshot, selection });
    return true;
  };
  const getSnapshot = () => { reconcile(); return snapshot; };
  const setSelection = (value: TimelineSelection) => {
    const changed = reconcile();
    const selection = projection!.normalize(value);
    if (!sameSelection(selection, snapshot.selection)) { replaceSnapshot({ ...snapshot, selection }); notify(); }
    else if (changed || version !== notifiedVersion) notify();
  };
  const setPrimary = (kind: "clip" | "caption", value: SelectionValue) => {
    const current = getSnapshot().selection;
    const primary = kind === "clip" ? current.primaryClipId : current.primaryCaptionId;
    const next = typeof value === "function" ? value(primary) : value;
    setSelection(next !== undefined ? selectTimelineItem(current, { kind, id: next }) : kind === "clip"
      ? { ...current, clipIds: [], primaryClipId: undefined }
      : { ...current, captionIds: [], primaryCaptionId: undefined });
  };
  return {
    getSnapshot,
    subscribe: (listener: () => void) => {
      let subscribed = true;
      const entry = () => { if (subscribed) listener(); };
      listeners.add(entry);
      if (!detach) detach = session.subscribe(() => { reconcile(); if (version !== notifiedVersion) notify(); });
      reconcile();
      if (version !== notifiedVersion) notify();
      return () => {
        if (!subscribed) return;
        subscribed = false; listeners.delete(entry);
        if (!listeners.size) { detach?.(); detach = undefined; projection = undefined; }
      };
    },
    getSelection: () => getSnapshot().selection,
    setSelection,
    setSelectedClipId: (value: SelectionValue) => setPrimary("clip", value),
    setSelectedCaptionId: (value: SelectionValue) => setPrimary("caption", value),
    getClipboard: () => getSnapshot().clipboard,
    setClipboard: (clipboard: TimelineClipboard) => { reconcile(); replaceSnapshot({ ...snapshot, clipboard }); notify(); },
    getMarkRange: () => getSnapshot().markRange,
    setMarkRange: (markRange: TimelineMarkRange) => { reconcile(); replaceSnapshot({ ...snapshot, markRange: { ...markRange } }); notify(); },
  };
}
