import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import { shortcutAction } from "../desktop/useEditorShortcuts";
import { selectTimelineItem, type TimelineSelection } from "./timelineSelection";
import type { TimelineClipboard } from "./timelineClipboard";
import type { TimelineMarkRange } from "./timelineNavigation";
import { createTimelineShortcutActions, type TimelineShortcutHost, type TimelineViewAction } from "./timelineShortcutActions";
import { createTimelineNudgeQueue } from "./timelineNudgeQueue";

function projectWithClips() {
  const project = createDemoProject(), base = project.tracks[0].clips[0];
  project.tracks[0].clips = [0, 2, 4].map((time, index) => ({ ...structuredClone(base), id: `clip-${index}`, timelineStart: time, duration: 2 }));
  project.captions = [{ id: "inside", start: 2.5, duration: .5, text: "inside" }, { id: "later", start: 5, duration: .5, text: "later" }];
  return project;
}

function owner(project: EditProject = projectWithClips()) {
  let history = createHistory(project), selection: TimelineSelection = { clipIds: ["clip-0"], captionIds: [], primaryClipId: "clip-0" };
  let clipboard: TimelineClipboard | undefined, playhead = 0, range: TimelineMarkRange = {}, id = 0, blade = false, simple = true;
  const state = { status: "", pauses: 0, motionClears: 0, refuseCommit: false, rangePlay: undefined as { in: number; out: number } | undefined,
    view: [] as TimelineViewAction[] };
  const host: TimelineShortcutHost = {
    getProject: () => history.present,
    runCommand: (command: EditorCommand, message?: string, options?: { coalesce?: string }) => {
      if (state.refuseCommit) return false;
      history = dispatchCommand(history, command, `edit-${history.present.revision}`, undefined, options?.coalesce);
      if (message) state.status = message;
      return true;
    },
    setStatus: value => { state.status = value; },
    getSelection: () => selection, setSelection: value => { selection = value; },
    getClipboard: () => clipboard, setClipboard: value => { clipboard = value; },
    getPlayhead: () => playhead, setPlayhead: value => { playhead = value; }, pause: () => { state.pauses++; },
    getMarkRange: () => range, setMarkRange: value => { range = value; },
    playRange: value => { state.rangePlay = value; playhead = value.in; },
    view: action => { state.view.push(action); }, simpleMode: () => simple,
    escapeTool: () => { if (!blade) return false; blade = false; return true; },
    clearMotionSelection: () => { state.motionClears++; return false; },
    deleteMotionSelection: () => false, nudgeMotionSelection: () => false,
    nudgeSequence: { current: 0 }, nudgeQueue: createTimelineNudgeQueue(), makeId: prefix => `${prefix}-new-${++id}`, defaultMarkerTitle: () => "Marker",
    now: () => "2026-10-11T05:00:00.000Z",
  };
  const actions = createTimelineShortcutActions(host);
  const press = (key: string, modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => {
    const input = { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
    const action = shortcutAction(input);
    return action ? actions[action]?.({ repeat: input.repeat ?? false }) : undefined;
  };
  return { host, state, press, actions, get history() { return history; }, undo: () => { history = undo(history); },
    select: (ids: string[], captions: string[] = []) => { selection = { clipIds: ids, captionIds: captions, primaryClipId: ids.at(-1), primaryCaptionId: ids.length ? undefined : captions.at(-1) }; },
    click: (clipId: string, shift = false) => { selection = selectTimelineItem(selection, { kind: "clip", id: clipId }, shift); },
    setBlade: (value: boolean) => { blade = value; }, setSimple: (value: boolean) => { simple = value; } };
}

describe("B1 keys use one live project transaction", () => {
  it("a click and Shift+click delete both clips with one Undo, including attached captions", () => {
    const editor = owner(), before = structuredClone(editor.history.present);
    editor.click("clip-0"); editor.click("clip-1", true); editor.press("Delete");
    expect(editor.state.pauses).toBe(1);
    expect(editor.history.present.tracks[0].clips.map(clip => [clip.id, clip.timelineStart])).toEqual([["clip-2", 0]]);
    expect(editor.history.present.captions.map(caption => caption.id)).toEqual(["later"]);
    expect(editor.history.past).toHaveLength(1);
    editor.undo();
    expect(editor.history.present.tracks).toEqual(before.tracks);
    expect(editor.history.present.captions).toEqual(before.captions);
  });

  it("Shift+Delete removes the selection while keeping the following gap", () => {
    const editor = owner(); editor.select(["clip-0", "clip-1"], ["inside"]);
    editor.press("Delete", { shiftKey: true });
    expect(editor.history.present.tracks[0].clips[0].timelineStart).toBe(4);
    expect(editor.history.present.captions[0].start).toBe(5);
    expect(editor.history.past).toHaveLength(1);
  });

  it("Ctrl+C snapshots without a project Undo, then Ctrl+V finds a free slot and is one Undo", () => {
    const editor = owner(), before = structuredClone(editor.history.present);
    editor.press("c", { ctrlKey: true });
    expect(editor.history.past).toHaveLength(0);
    expect(editor.history.present).toEqual(before);
    editor.press("v", { ctrlKey: true });
    const pasted = editor.history.present.tracks[0].clips.at(-1)!;
    expect(pasted.timelineStart).toBe(6);
    expect(pasted.id).toBe(editor.host.getSelection().primaryClipId);
    expect(editor.state.status).toContain("第一個空位");
    expect(editor.history.past).toHaveLength(1);
    editor.undo(); expect(editor.history.present.tracks).toEqual(before.tracks);
  });

  it("Ctrl+X copies then ripple-deletes as one Undo; a refused cut keeps the old clipboard", () => {
    const editor = owner(), before = structuredClone(editor.history.present);
    editor.select(["clip-0", "clip-1"]); editor.press("x", { ctrlKey: true });
    expect(editor.host.getClipboard()!.clips.map(clip => clip.id)).toEqual(["clip-0", "clip-1"]);
    expect(editor.history.present.tracks[0].clips.map(clip => clip.id)).toEqual(["clip-2"]);
    expect(editor.history.past).toHaveLength(1);
    editor.undo(); expect(editor.history.present.tracks).toEqual(before.tracks);
    const oldClipboard = editor.host.getClipboard(); editor.select(["clip-2"]); editor.state.refuseCommit = true;
    editor.press("x", { ctrlKey: true });
    expect(editor.host.getClipboard()).toBe(oldClipboard);
    expect(editor.history.present.tracks).toEqual(before.tracks);
  });

  it("Ctrl+D places one copy after the selected arrangement and preserves the ordinary clipboard", () => {
    const editor = owner(); editor.press("c", { ctrlKey: true }); const clipboard = editor.host.getClipboard();
    editor.select(["clip-0", "clip-1"]); editor.press("d", { ctrlKey: true });
    expect(editor.history.present.tracks[0].clips.slice(-2).map(clip => clip.timelineStart)).toEqual([6, 8]);
    expect(editor.host.getClipboard()).toBe(clipboard);
    expect(editor.history.past).toHaveLength(1);
    editor.undo(); expect(editor.history.present.tracks[0].clips).toHaveLength(3);
  });

  it("held Alt nudges share one Undo, and a new press starts a new Undo", () => {
    const editor = owner(), before = structuredClone(editor.history.present);
    editor.press("a", { ctrlKey: true });
    for (let i = 0; i < 3; i++) editor.press("ArrowRight", { altKey: true, repeat: i > 0 });
    expect(editor.history.past).toHaveLength(1);
    expect(editor.history.present.tracks[0].clips[0].timelineStart).toBe(.1);
    editor.press("ArrowRight", { altKey: true });
    expect(editor.history.past).toHaveLength(2);
    editor.undo(); expect(editor.history.present.tracks[0].clips[0].timelineStart).toBe(.1);
    editor.undo(); expect(editor.history.present.tracks).toEqual(before.tracks);
  });

  it("Esc leaves the blade first, then clears the selection, then returns false", () => {
    const editor = owner(); editor.setBlade(true);
    expect(editor.press("Escape")).toBe(true);
    expect(editor.host.getSelection().clipIds).toEqual(["clip-0"]);
    expect(editor.press("Escape")).toBe(true);
    expect(editor.host.getSelection().clipIds).toEqual([]);
    expect(editor.press("Escape")).toBe(false);
  });

  it("Ctrl+A includes clips and captions; Ctrl+Shift+A includes only items starting after the playhead", () => {
    const editor = owner(); editor.press("a", { ctrlKey: true });
    expect(editor.host.getSelection().clipIds).toEqual(["clip-0", "clip-1", "clip-2"]);
    expect(editor.host.getSelection().captionIds).toEqual(["inside", "later"]);
    editor.host.setPlayhead(3); editor.press("a", { ctrlKey: true, shiftKey: true });
    expect(editor.host.getSelection().clipIds).toEqual(["clip-2"]);
    expect(editor.host.getSelection().captionIds).toEqual(["later"]);
    expect(editor.history.past).toHaveLength(0);
  });

  it("M uses the existing director marker command, and next/previous marker keys only seek", () => {
    const editor = owner(); editor.host.setPlayhead(1.003); editor.press("m");
    editor.host.setPlayhead(4); editor.press("m");
    expect(editor.history.present.director.markers.map(marker => [marker.time, marker.title])).toEqual([[1, "Marker"], [4, "Marker"]]);
    editor.host.setPlayhead(0); editor.press("m", { shiftKey: true }); expect(editor.host.getPlayhead()).toBe(1);
    editor.host.setPlayhead(4.5); editor.press("m", { ctrlKey: true, shiftKey: true }); expect(editor.host.getPlayhead()).toBe(4);
    expect(editor.state.pauses).toBe(2);
    expect(editor.history.past).toHaveLength(2);
    editor.undo(); expect(editor.history.present.director.markers).toHaveLength(1);
  });

  it("I/O and range playback use transient editor state, and missing or crossed marks refuse playback", () => {
    const editor = owner(), before = structuredClone(editor.history.present); editor.press("/");
    expect(editor.state.status).toContain("入點和出點"); expect(editor.state.rangePlay).toBeUndefined();
    editor.host.setPlayhead(1); editor.press("i"); editor.host.setPlayhead(3); editor.press("o"); editor.press("/");
    expect(editor.state.rangePlay).toEqual({ in: 1, out: 3 }); expect(editor.host.getPlayhead()).toBe(1);
    editor.press("o", { shiftKey: true }); expect(editor.host.getPlayhead()).toBe(3);
    editor.press("i", { shiftKey: true }); expect(editor.host.getPlayhead()).toBe(1);
    editor.press("x", { altKey: true }); expect(editor.host.getMarkRange()).toEqual({});
    expect(editor.history.present).toEqual(before); expect(editor.history.past).toHaveLength(0);
  });

  it("up/down navigation ignores locked tracks and reads the live project", () => {
    const project = projectWithClips(); project.tracks[0].locked = true;
    project.tracks.push({ id: "other", name: "Other", kind: "video", locked: false, muted: false,
      clips: [{ ...structuredClone(project.tracks[0].clips[0]), id: "other-clip", trackId: "other", timelineStart: 1, duration: .5 }] });
    const editor = owner(project); editor.press("ArrowDown"); expect(editor.host.getPlayhead()).toBe(1);
    editor.host.setPlayhead(2); editor.press("ArrowUp"); expect(editor.host.getPlayhead()).toBe(1.5);
    expect(editor.history.past).toHaveLength(0);
  });

  it("view keys request zoom/fit, and N only requests snap in advanced mode", () => {
    const editor = owner(); editor.press("="); editor.press("-"); editor.press("\\"); editor.press("z", { shiftKey: true });
    editor.press("n"); expect(editor.state.view).toEqual(["zoom-in", "zoom-out", "fit-timeline", "fit-timeline"]);
    editor.setSimple(false); editor.press("n"); expect(editor.state.view.at(-1)).toBe("toggle-snap");
  });

  it.each(["[", "]"])("%s trims only the primary clip with a ripple and one Undo", key => {
    const editor = owner(), before = structuredClone(editor.history.present); editor.host.setPlayhead(1); editor.press(key);
    const clips = editor.history.present.tracks[0].clips;
    expect(clips[0].duration).toBe(1); expect(clips[0].sourceStart).toBe(key === "[" ? 1 : 0);
    expect(clips.slice(1).map(clip => clip.timelineStart)).toEqual([1, 3]);
    expect(editor.host.getSelection().primaryClipId).toBe(clips[0].id);
    expect(editor.history.past).toHaveLength(1);
    editor.undo(); expect(editor.history.present.tracks).toEqual(before.tracks);
  });

  it("trim does not fall back to a different clip when the playhead is outside the primary", () => {
    const editor = owner(), before = structuredClone(editor.history.present); editor.host.setPlayhead(3); editor.press("[");
    expect(editor.state.status).toContain("主選取"); expect(editor.history.present).toEqual(before);
  });

  it("a rejected range start reports the refusal without leaking an exception or changing project history", () => {
    const editor = owner(), before = structuredClone(editor.history.present);
    editor.host.setMarkRange({ in: 1, out: 3 });
    editor.host.playRange = () => { throw new Error("請先設定入點和出點，出點要在入點之後。"); };
    expect(() => editor.press("/")).not.toThrow();
    expect(editor.state.status).toContain("入點和出點"); expect(editor.history.present).toEqual(before);
  });
});
