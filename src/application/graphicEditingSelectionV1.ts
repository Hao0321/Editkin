import type { ProjectSession, ProjectSessionSnapshot } from "./projectSession";
import type { TimelineSelection } from "./timelineSelection";
import type { EditorCommand } from "../domain/commandTypes";

export interface GraphicEditingSelectionV1 { id: string; sessionId: number }
export interface GraphicEditingSelectionSnapshotV1 {
  readonly selection?: GraphicEditingSelectionV1;
  readonly timelineSelection: TimelineSelection;
  readonly active: boolean;
}
interface TimelinePort { getSelection: () => TimelineSelection; subscribe: (listener: () => void) => () => void }

export function commandReplacesGraphicV1(command: EditorCommand, id: string): boolean {
  return command.type === "batch" ? command.commands.some(item => commandReplacesGraphicV1(item, id))
    : command.type === "delete_motion_graphic" ? command.graphicId === id
      : command.type === "add_motion_graphic" && command.graphic.id === id;
}
function forwardEdit(previous: ProjectSessionSnapshot, current: ProjectSessionSnapshot): boolean {
  const before = previous.history, after = current.history, n = before.journal.length;
  if (after.journal.length <= n || n > 0 && after.journal[n - 1] !== before.journal.at(-1)) return false;
  return after.past.includes(before.present) || Boolean(before.coalesce && after.coalesce
    && before.coalesce.key === after.coalesce.key && before.coalesce.present === before.present
    && after.coalesce.present === after.present && before.past === after.past);
}

/** Only the shell's transient graphic selection; project/history and timeline keep their existing owners. */
export function createGraphicEditingSelectionV1(session: ProjectSession, timeline: TimelinePort) {
  let previous = session.getSnapshot();
  let snapshot: GraphicEditingSelectionSnapshotV1 = Object.freeze({ timelineSelection: timeline.getSelection(), active: false });
  const listeners = new Set<() => void>();
  let detach: (() => void) | undefined;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const reconcile = () => {
    const current = session.getSnapshot(), selected = timeline.getSelection();
    if (current === previous && selected === snapshot.timelineSelection) return false;
    let selection = snapshot.selection;
    const replaced = Boolean(selection && current.history.journal.slice(previous.history.journal.length)
      .some(record => commandReplacesGraphicV1(record.command, selection!.id)));
    const sessionChanged = current.sessionId !== previous.sessionId;
    const occurrenceChanged = sessionChanged
      || current.contentOwner !== previous.contentOwner && !forwardEdit(previous, current);
    if (selection && (sessionChanged || replaced || selection.sessionId !== current.sessionId
      || selected.primaryClipId !== undefined || selected.primaryCaptionId !== undefined
      || !current.history.present.motionGraphics.some(graphic => graphic.id === selection!.id))) selection = undefined;
    previous = current;
    if (!occurrenceChanged && selection === snapshot.selection && selected === snapshot.timelineSelection) return false;
    snapshot = Object.freeze({ selection, timelineSelection: selected, active: snapshot.active });
    return true;
  };
  const getSnapshot = () => { reconcile(); return snapshot; };
  return {
    getSnapshot,
    select: (value: GraphicEditingSelectionV1 | undefined): boolean => {
      const changed = reconcile(), current = session.getSnapshot(), selected = snapshot.timelineSelection;
      if (value && (value.sessionId !== current.sessionId || selected.primaryClipId !== undefined || selected.primaryCaptionId !== undefined
        || !current.history.present.motionGraphics.some(graphic => graphic.id === value.id))) { if (changed) notify(); return false; }
      if (value || snapshot.selection) {
        snapshot = Object.freeze({ ...snapshot, selection: value ? Object.freeze({ ...value }) : undefined }); notify();
      } else if (changed) notify();
      return true;
    },
    subscribe: (listener: () => void) => {
      const subscription = () => listener();
      listeners.add(subscription);
      if (!detach) {
        const onChange = () => { if (reconcile()) notify(); };
        const a = session.subscribe(onChange), b = timeline.subscribe(onChange);
        detach = () => { a(); b(); };
        reconcile(); snapshot = Object.freeze({ ...snapshot, active: true }); notify();
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return; subscribed = false; listeners.delete(subscription);
        if (!listeners.size) {
          detach?.(); detach = undefined;
          snapshot = Object.freeze({ timelineSelection: timeline.getSelection(), active: false });
        }
      };
    },
  };
}
