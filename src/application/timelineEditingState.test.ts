import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommandSafely, undo } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { copyTimelineSelection, planTimelinePaste } from "./timelineClipboard";
import { createTimelineEditingState } from "./timelineEditingState";
import { emptyTimelineSelection, selectTimelineItem } from "./timelineSelection";

function fixture() {
  const project = createDemoProject();
  project.captions.push({ id: "caption-a", start: 1, duration: 1, text: "A" });
  const session = createProjectSession(project);
  const state = createTimelineEditingState(session, selectTimelineItem(emptyTimelineSelection(), { kind: "clip", id: "clip-demo" }));
  return { session, state };
}

describe("live editor-only timeline state", () => {
  it("keeps a stable snapshot, one primary and synchronous functional selection setters", () => {
    const { state } = fixture();
    expect(state.getSnapshot()).toBe(state.getSnapshot());
    state.setSelection(selectTimelineItem(state.getSelection(), { kind: "caption", id: "caption-a" }, true));
    expect(state.getSelection()).toMatchObject({ clipIds: ["clip-demo"], captionIds: ["caption-a"], primaryCaptionId: "caption-a" });
    state.setSelectedClipId(current => current ?? "clip-demo");
    state.setSelectedCaptionId(undefined);
    expect(state.getSelection()).toEqual({ clipIds: ["clip-demo"], captionIds: [], primaryClipId: "clip-demo" });
    state.setSelectedClipId(undefined);
    expect(state.getSelection()).toEqual(emptyTimelineSelection());
  });

  it("selects newly pasted ids immediately, using the live committed project", () => {
    const { session, state } = fixture();
    const clipboard = copyTimelineSelection(session.getSnapshot().history.present, state.getSelection());
    let id = 0;
    const paste = planTimelinePaste(session.getSnapshot().history.present, clipboard, 12, prefix => `${prefix}-${++id}`);
    const result = dispatchCommandSafely(session.getSnapshot().history, paste.command, "paste");
    expect(result.error).toBeUndefined();
    session.setHistory(result.state);
    state.setSelection(paste.selection);
    expect(state.getSelection().primaryClipId).toBe(paste.selection.primaryClipId);
    expect(state.getSelection().clipIds).toEqual(paste.selection.clipIds);
    session.setHistory(undo(session.getSnapshot().history));
    expect(state.getSelection()).toEqual(emptyTimelineSelection());
  });

  it("keeps marks and clipboard outside project history and clears them on project replacement", () => {
    const { session, state } = fixture();
    const before = session.getSnapshot();
    state.setMarkRange({ in: 1 });
    state.setMarkRange({ ...state.getMarkRange(), out: 3 });
    state.setClipboard(copyTimelineSelection(before.history.present, state.getSelection()));
    expect(state.getMarkRange()).toEqual({ in: 1, out: 3 });
    expect(session.getSnapshot()).toBe(before);
    session.replaceProject(createDemoProject());
    expect(state.getSnapshot()).toEqual({ selection: emptyTimelineSelection(), markRange: {} });
    state.setSelectedClipId("clip-demo");
    state.setSelectedCaptionId(undefined);
    expect(state.getSelection().primaryClipId).toBe("clip-demo");
  });

  it("publishes project-driven pruning while attached and reconciles after detaching", () => {
    const { session, state } = fixture();
    const changed = vi.fn();
    const detach = state.subscribe(changed);
    const result = dispatchCommandSafely(session.getSnapshot().history, { type: "delete_clip", clipId: "clip-demo" }, "remove");
    expect(result.error).toBeUndefined();
    session.setHistory(result.state);
    expect(changed).toHaveBeenCalledOnce();
    expect(state.getSelection()).toEqual(emptyTimelineSelection());
    detach();
    session.setHistory(undo(session.getSnapshot().history));
    expect(changed).toHaveBeenCalledOnce();
    state.setSelectedClipId("clip-demo");
    expect(state.getSelection().primaryClipId).toBe("clip-demo");
  });
});
