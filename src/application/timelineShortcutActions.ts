import type { EditorShortcutHandlers, EditorShortcutPress } from "../desktop/useEditorShortcuts";
import type { EditorCommand } from "../domain/commandTypes";
import { EditGraphError } from "../domain/editGraphError";
import { copyTimelineSelection, planTimelinePaste, CLIPBOARD_TEMPLATE_NOTE, type TimelineClipboard } from "./timelineClipboard";
import { setTimelineMark, timelineEditPoint, timelineMarkerPoint, validTimelineMarkRange, type TimelineMarkRange } from "./timelineNavigation";
import { emptyTimelineSelection, normalizeTimelineSelection, selectAllTimelineItems, type TimelineSelection } from "./timelineSelection";
import { planTimelineSelectionDelete, planTimelineSelectionNudge, SELECTION_GENERATED, type TimelineSelectionEditPlan } from "./timelineSelectionEdits";
import { editTouchesTemplates, planEditCommandsWithTemplates, templateEditMessage } from "./timelineMotionEdits";
import { planDeleteToPlayhead } from "./timelineRippleEdits";
import { runTemplateFollowGesture, type TemplateFollowEditHost } from "./templateFollowEditActions";
import type { TimelineNudgeQueue } from "./timelineNudgeQueue";

export const SHORTCUT_COPY_DONE = "已複製選取的片段與字幕。";
export const SHORTCUT_CUT_DONE = "已剪下選取的片段與字幕；一次復原即可還原。";
export const SHORTCUT_PASTE_DONE = "已貼上選取的片段與字幕；一次復原即可還原。";
export const SHORTCUT_DUPLICATE_DONE = "已複製一份，接在選取內容後面；一次復原即可還原。";
export const SHORTCUT_PASTE_MOVED = "這裡已經有內容，已貼在 {time} 秒的第一個空位；一次復原即可還原。";
export const SHORTCUT_MARKER_DONE = "已在播放頭加入標記；一次復原即可還原。";
export const SHORTCUT_RANGE_REQUIRED = "請先設定入點和出點，出點要在入點之後。";
export const SHORTCUT_TRIM_REQUIRED = "請把播放頭放在主選取片段的中間，再修剪開頭或結尾。";
export const SHORTCUT_FAILED = "這次編輯沒有套用，請確認選取的內容和軌道。";
export const SHORTCUT_CHANGED = "專案剛剛有變更，這次編輯沒有套用；請再試一次。";

export type TimelineViewAction = "zoom-in" | "zoom-out" | "fit-timeline" | "toggle-snap";
export interface TimelineShortcutHost extends TemplateFollowEditHost {
  runCommand: (command: EditorCommand, message?: string, options?: { coalesce?: string }) => boolean | void;
  getSelection: () => TimelineSelection;
  setSelection: (selection: TimelineSelection) => void;
  getClipboard: () => TimelineClipboard | undefined;
  setClipboard: (clipboard: TimelineClipboard) => void;
  getPlayhead: () => number;
  setPlayhead: (time: number) => void;
  pause: () => void;
  getMarkRange: () => TimelineMarkRange;
  setMarkRange: (range: TimelineMarkRange) => void;
  playRange: (range: { in: number; out: number }) => void;
  view: (action: TimelineViewAction) => void;
  simpleMode: () => boolean;
  escapeTool: () => boolean;
  clearMotionSelection: () => boolean;
  deleteMotionSelection: () => boolean;
  nudgeMotionSelection: (frames: number, coalesce: string) => boolean;
  /** Persisted outside this per-render action map, so held nudges share one history transaction. */
  nudgeSequence: { current: number };
  nudgeQueue: TimelineNudgeQueue;
  makeId: (prefix: string) => string;
  defaultMarkerTitle: () => string;
  now?: () => string;
}

/** The existing template follower owns the final transaction; no raw command can leave a saved title stale. */
function commit(host: TimelineShortcutHost, plan: TimelineSelectionEditPlan, coalesce?: string): boolean | Promise<boolean> {
  host.pause();
  const options = coalesce ? { coalesce } : undefined;
  const plain = () => host.runCommand(plan.command, plan.message, options) !== false;
  if (!editTouchesTemplates(host.getProject(), [plan.command])) return plain();
  return runTemplateFollowGesture({ ...host, runCommand: (command, message) => host.runCommand(command, message, options) },
    async (project, glyphs) => {
      const followed = await planEditCommandsWithTemplates(project, [plan.command], glyphs);
      return followed && { command: followed.command, message: templateEditMessage(plan.message, followed) };
    }, { failed: SHORTCUT_FAILED, changed: SHORTCUT_CHANGED }, plain);
}

function afterCommit(ran: boolean | Promise<boolean>, done: () => void): void {
  if (typeof ran === "boolean") { if (ran) done(); }
  else void ran.then(ok => { if (ok) done(); });
}

/** All getters read the live session when a key is pressed; the App supplies stable forwarders to this action map. */
export function createTimelineShortcutActions(host: TimelineShortcutHost): EditorShortcutHandlers {
  const guarded = (action: () => void) => () => {
    try { action(); }
    catch (error) { host.setStatus(error instanceof Error ? error.message : SHORTCUT_FAILED); }
  };
  const cleanSelection = () => host.setSelection(normalizeTimelineSelection(host.getProject(), host.getSelection()));
  const note = (message: string, clipboard: TimelineClipboard) => clipboard.templatesSkipped ? `${message} ${CLIPBOARD_TEMPLATE_NOTE}` : message;
  const seek = (time: number | undefined) => { if (time !== undefined) { host.pause(); host.setPlayhead(time); } };
  const deleteSelection = (lift: boolean) => {
    if (host.deleteMotionSelection()) return;
    const plan = planTimelineSelectionDelete(host.getProject(), host.getSelection(), lift);
    afterCommit(commit(host, plan), cleanSelection);
  };
  const paste = (clipboard: TimelineClipboard, at: number, duplicate = false) => {
    const plan = planTimelinePaste(host.getProject(), clipboard, at, host.makeId);
    const message = plan.moved ? SHORTCUT_PASTE_MOVED.replace("{time}", plan.start.toFixed(2))
      : duplicate ? SHORTCUT_DUPLICATE_DONE : SHORTCUT_PASTE_DONE;
    afterCommit(commit(host, { command: plan.command, message: note(message, clipboard) }), () => host.setSelection(plan.selection));
  };
  const nudge = (frames: number) => (press: EditorShortcutPress) => {
    if (!press.repeat) host.nudgeSequence.current += 1;
    const coalesce = `nudge:${host.nudgeSequence.current}`;
    if (host.nudgeMotionSelection(frames, coalesce)) return;
    const selection = structuredClone(host.getSelection());
    host.nudgeQueue.enqueue(() => {
      const plan = planTimelineSelectionNudge(host.getProject(), selection, frames);
      if (!plan) return true;
      const ran = commit(host, plan, coalesce);
      if (typeof ran === "boolean") { if (ran) cleanSelection(); return ran; }
      return ran.then(ok => { if (ok) cleanSelection(); return ok; });
    }, error => host.setStatus(error instanceof Error ? error.message : SHORTCUT_FAILED));
  };
  const trim = (side: "left" | "right") => {
    const project = host.getProject(), selection = host.getSelection(), at = host.getPlayhead();
    const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === selection.primaryClipId);
    const frame = (time: number) => Math.round(time * project.fps);
    if (!clip || frame(at) <= frame(clip.timelineStart) || frame(at) >= frame(clip.timelineStart + clip.duration)) throw new EditGraphError(SHORTCUT_TRIM_REQUIRED);
    if (project.referenceMotionInstances?.some(instance => instance.input.clipId !== clip.id
      && instance.roles.some(role => role.kind === "clip" && role.id === clip.id))) throw new EditGraphError(SELECTION_GENERATED);
    const plan = planDeleteToPlayhead(project, frame(at) / project.fps, clip.id, side, host.makeId("clip"));
    afterCommit(commit(host, plan), () => {
      const current = host.getSelection();
      host.setSelection(normalizeTimelineSelection(host.getProject(), { ...current,
        clipIds: current.clipIds.map(id => id === plan.clipId ? plan.keptClipId : id),
        primaryClipId: current.primaryClipId === plan.clipId ? plan.keptClipId : current.primaryClipId }));
      if (side === "left") seek(plan.start);
    });
  };
  return {
    delete: guarded(() => deleteSelection(false)),
    lift: guarded(() => deleteSelection(true)),
    "escape-tool": () => {
      if (host.escapeTool()) return true;
      const selection = host.getSelection(), motion = host.clearMotionSelection();
      if (!selection.clipIds.length && !selection.captionIds.length) return motion;
      host.setSelection(emptyTimelineSelection());
      return true;
    },
    "select-all": () => { host.clearMotionSelection(); host.setSelection(selectAllTimelineItems(host.getProject())); },
    "select-forward": () => { host.clearMotionSelection(); host.setSelection(selectAllTimelineItems(host.getProject(), host.getPlayhead())); },
    copy: guarded(() => {
      const clipboard = copyTimelineSelection(host.getProject(), host.getSelection());
      host.setClipboard(clipboard);
      host.setStatus(note(SHORTCUT_COPY_DONE, clipboard));
    }),
    cut: guarded(() => {
      const project = host.getProject(), selection = host.getSelection();
      const clipboard = copyTimelineSelection(project, selection), plan = planTimelineSelectionDelete(project, selection);
      afterCommit(commit(host, { command: plan.command, message: note(SHORTCUT_CUT_DONE, clipboard) }), () => {
        host.setClipboard(clipboard); cleanSelection();
      });
    }),
    paste: guarded(() => {
      const clipboard = host.getClipboard();
      if (!clipboard) throw new EditGraphError("剪貼簿還沒有片段或字幕，請先複製。");
      paste(clipboard, host.getPlayhead());
    }),
    duplicate: guarded(() => {
      const clipboard = copyTimelineSelection(host.getProject(), host.getSelection());
      paste(clipboard, clipboard.end, true);
    }),
    "nudge-back": nudge(-1), "nudge-forward": nudge(1), "nudge-back-ten": nudge(-10), "nudge-forward-ten": nudge(10),
    "add-marker": guarded(() => {
      const project = host.getProject(), time = Math.round(host.getPlayhead() * project.fps) / project.fps;
      host.runCommand({ type: "add_director_marker", marker: { id: host.makeId("marker"), time,
        title: host.defaultMarkerTitle(), note: "", kind: "note", status: "open", createdAt: (host.now ?? (() => new Date().toISOString()))() } }, SHORTCUT_MARKER_DONE);
    }),
    "next-marker": () => seek(timelineMarkerPoint(host.getProject().director.markers, host.getPlayhead(), 1, host.getProject().fps)),
    "previous-marker": () => seek(timelineMarkerPoint(host.getProject().director.markers, host.getPlayhead(), -1, host.getProject().fps)),
    "previous-edit": () => seek(timelineEditPoint(host.getProject(), host.getPlayhead(), -1)),
    "next-edit": () => seek(timelineEditPoint(host.getProject(), host.getPlayhead(), 1)),
    "mark-in": () => host.setMarkRange(setTimelineMark(host.getMarkRange(), "in", host.getPlayhead(), host.getProject().fps)),
    "mark-out": () => host.setMarkRange(setTimelineMark(host.getMarkRange(), "out", host.getPlayhead(), host.getProject().fps)),
    "clear-marks": () => host.setMarkRange({}),
    "go-in": () => seek(host.getMarkRange().in), "go-out": () => seek(host.getMarkRange().out),
    "play-range": guarded(() => {
      const range = host.getMarkRange();
      if (!validTimelineMarkRange(range)) { host.setStatus(SHORTCUT_RANGE_REQUIRED); return; }
      host.playRange({ ...range });
    }),
    "zoom-in": () => host.view("zoom-in"), "zoom-out": () => host.view("zoom-out"), "fit-timeline": () => host.view("fit-timeline"),
    "toggle-snap": () => { if (!host.simpleMode()) host.view("toggle-snap"); },
    "trim-start": guarded(() => trim("left")), "trim-end": guarded(() => trim("right")),
  };
}
