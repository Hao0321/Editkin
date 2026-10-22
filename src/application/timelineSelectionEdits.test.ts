import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { planTimelineSelectionDelete, planTimelineSelectionNudge } from "./timelineSelectionEdits";

function projectWithClips() {
  const project = createDemoProject(), base = structuredClone(project.tracks[0].clips[0]);
  project.tracks[0].clips = [0, 2, 4].map((start, index) => ({ ...structuredClone(base), id: `clip-${index}`, timelineStart: start, duration: 2 }));
  project.captions = [{ id: "inside", start: 2, duration: 1, text: "inside" }, { id: "later", start: 5, duration: 1, text: "later" }];
  return project;
}
const selection = (clipIds: string[], captionIds: string[] = []) => ({ clipIds, captionIds });

describe("one transaction for a timeline selection", () => {
  it("ripple deletes several clips plus an explicitly selected attached caption once, with one Undo", () => {
    const project = projectWithClips(), before = structuredClone(project);
    const plan = planTimelineSelectionDelete(project, selection(["clip-0", "clip-1"], ["inside"]));
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.tracks[0].clips.map(clip => [clip.id, clip.timelineStart])).toEqual([["clip-2", 0]]);
    expect(history.present.captions).toEqual([{ id: "later", start: 1, duration: 1, text: "later" }]);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present.tracks).toEqual(before.tracks);
    expect(undo(history).present.captions).toEqual(before.captions);
    expect(project).toEqual(before);
  });
  it("Shift+Delete leaves the time gap while deleting the same selected items in one Undo", () => {
    const project = projectWithClips();
    const plan = planTimelineSelectionDelete(project, selection(["clip-0", "clip-1"], ["inside"]), true);
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.tracks[0].clips.map(clip => [clip.id, clip.timelineStart])).toEqual([["clip-2", 4]]);
    expect(history.present.captions[0].start).toBe(5);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present.tracks).toEqual(project.tracks);
  });
  it("selected captions on their own are one edit and a locked caption track refuses the entire edit", () => {
    const project = projectWithClips();
    const plan = planTimelineSelectionDelete(project, selection([], ["inside", "later"]));
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.captions).toHaveLength(0);
    expect(history.present.tracks).toEqual(project.tracks);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present.captions).toEqual(project.captions);
    expect(plan.message).not.toContain("補上空隙");
    project.tracks.find(track => track.kind === "caption")!.locked = true;
    const before = structuredClone(project);
    expect(() => planTimelineSelectionDelete(project, selection(["clip-0"], ["inside"]))).toThrow(/鎖定/);
    expect(project).toEqual(before);
  });
  it("a locked clip refuses before either a caption or another selected clip is changed", () => {
    const project = projectWithClips(); project.tracks[0].locked = true;
    const before = structuredClone(project);
    expect(() => planTimelineSelectionDelete(project, selection(["clip-0"], ["later"]))).toThrow(/鎖定/);
    expect(() => planTimelineSelectionNudge(project, selection(["clip-0"], ["later"]), 1)).toThrow(/鎖定/);
    expect(project).toEqual(before);
  });
  it("nudges adjoining selected clips together and moves their captions once, preserving every source in-point", () => {
    const project = projectWithClips();
    const chosen = selection(["clip-0", "clip-1", "clip-2"], ["inside"]);
    const plan = planTimelineSelectionNudge(project, chosen, 1)!;
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.tracks[0].clips.map(clip => Math.round(clip.timelineStart * project.fps))).toEqual([1, 61, 121]);
    expect(history.present.tracks[0].clips.map(clip => clip.sourceStart)).toEqual([0, 0, 0]);
    expect(history.present.captions.map(caption => Math.round(caption.start * project.fps))).toEqual([61, 151]);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present.tracks).toEqual(project.tracks);
    expect(undo(history).present.captions).toEqual(project.captions);
  });
  it("clamps the whole group at zero without collapsing relative spacing or adding a no-op Undo", () => {
    const project = projectWithClips();
    expect(planTimelineSelectionNudge(project, selection(["clip-0", "clip-1", "clip-2"]), -10)).toBeUndefined();
    project.tracks[0].clips.forEach(clip => { clip.timelineStart += 1 / project.fps; });
    project.captions.forEach(caption => { caption.start += 1 / project.fps; });
    const plan = planTimelineSelectionNudge(project, selection(["clip-0", "clip-1", "clip-2"]), -10)!;
    expect(applyCommand(project, plan.command).tracks[0].clips.map(clip => clip.timelineStart)).toEqual([0, 2, 4]);
  });
  it("rejects a collision with an unselected clip without moving any selected item", () => {
    const project = projectWithClips(), before = structuredClone(project);
    expect(() => planTimelineSelectionNudge(project, selection(["clip-0"], ["inside"]), 1)).toThrow(/重疊/);
    expect(project).toEqual(before);
  });
  it("held group nudges share the ordinary history coalescing key and one Undo", () => {
    const project = projectWithClips(), chosen = selection(["clip-0", "clip-1", "clip-2"]);
    let history = createHistory(project);
    for (let i = 0; i < 3; i++) history = dispatchCommand(history, planTimelineSelectionNudge(history.present, chosen, 1)!.command, `step-${i}`, undefined, "held-nudge");
    expect(history.past).toHaveLength(1);
    expect(history.present.tracks[0].clips[0].timelineStart).toBe(.1);
    expect(undo(history).present.tracks).toEqual(project.tracks);
    expect(undo(history).present.captions).toEqual(project.captions);
  });
});
