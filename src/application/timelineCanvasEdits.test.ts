import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { planCloseGap, planRippleTrim } from "./timelineCanvasEdits";
import { planTimelineGroupMove } from "./timelineGroupMove";

function fixture(starts = [0, 4, 8]) {
  const project = createDemoProject(), clip = structuredClone(project.tracks[0].clips[0]);
  project.tracks[0].clips = starts.map((timelineStart, index) => ({ ...structuredClone(clip), id: `c${index}`, timelineStart, sourceStart: 0, duration: 4 }));
  project.captions = [{ id: "owned", start: 1, duration: 2, text: "owned" }, { id: "later", start: starts[1] + 1, duration: 1, text: "later" }];
  project.motionGraphics = []; project.motionTracks = [];
  project.director.markers = [{ id: "m", time: starts[2], title: "marker", note: "", kind: "note", status: "open", createdAt: "2026-10-11T00:00:00.000Z" }];
  return project;
}
const times = (project: ReturnType<typeof fixture>) => project.tracks[0].clips.map(clip => [clip.timelineStart, clip.sourceStart, clip.duration]);
describe("ripple trim and a single pointed gap", () => {
  it.each(["start", "end"] as const)("shrinks the %s edge with captions/markers and one complete Undo", edge => {
    const project = fixture(), before = structuredClone(project), plan = planRippleTrim(project, "c0", edge, 1)!;
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(times(history.present)).toEqual([[0, edge === "start" ? 1 : 0, 3], [3, 0, 4], [7, 0, 4]]);
    expect(history.present.captions.map(c => [c.start, c.duration])).toEqual([[edge === "start" ? 0 : 1, 2], [4, 1]]);
    expect(history.present.director.markers[0].time).toBe(7);
    expect(history.past).toHaveLength(1); expect(undo(history).present.tracks).toEqual(before.tracks);
    expect(undo(history).present.captions).toEqual(before.captions); expect(undo(history).present.director).toEqual(before.director); expect(project).toEqual(before);
  });
  it("keeps one frame and makes a sub-frame/no-op trim create no command", () => {
    const project = fixture(); expect(planRippleTrim(project, "c0", "end", .001)).toBeUndefined();
    expect(() => planRippleTrim(project, "c0", "end", 4)).toThrow(/一幀/);
    expect(() => planRippleTrim(project, "c0", "end", Number.NaN)).toThrow(/有效/);
  });
  it("closes only the selected middle gap and carries later captions/markers in one Undo", () => {
    const project = fixture([1, 7, 13]), before = structuredClone(project), plan = planCloseGap(project, "video-main", 6);
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(times(history.present).map(c => c[0])).toEqual([1, 5, 11]);
    expect(history.present.captions[1].start).toBe(6); expect(history.present.director.markers[0].time).toBe(11);
    expect(history.past).toHaveLength(1); expect(undo(history).present.tracks).toEqual(before.tracks);
    expect(() => planCloseGap(project, "video-main", 3)).toThrow(/空隙/); expect(() => planCloseGap(project, "video-main", 30)).toThrow(/空隙/);
  });
  it("holds locked tracks and refuses a new collision with a spanning item without editing anything", () => {
    const project = fixture(); const sound = project.tracks.find(t => t.kind === "audio")!;
    sound.clips = [{ ...structuredClone(project.tracks[0].clips[0]), id: "s0", trackId: sound.id, timelineStart: 2, duration: 2 },
      { ...structuredClone(project.tracks[0].clips[0]), id: "s1", trackId: sound.id, timelineStart: 4, duration: 2 }];
    const before = structuredClone(project); expect(() => planRippleTrim(project, "c0", "end", 1)).toThrow(); expect(project).toEqual(before);
    sound.locked = true; const history = dispatchCommand(createHistory(project), planRippleTrim(project, "c0", "end", 1)!.command);
    expect(history.present.tracks.find(t => t.id === sound.id)?.clips).toEqual(sound.clips);
  });
  it("refuses a locked edited track before creating an Undo", () => {
    const project = fixture(); project.tracks[0].locked = true;
    expect(() => planRippleTrim(project, "c0", "end", 1)).toThrow(/鎖定/); expect(() => planCloseGap(project, "video-main", 16)).toThrow(/鎖定/);
  });
});
describe("group drag uses one transaction", () => {
  it("moves every selected clip and its owned captions by the same frame delta, then restores once", () => {
    const project = fixture(), selection = { clipIds: ["c1", "c2"], captionIds: [] }, before = structuredClone(project);
    const history = dispatchCommand(createHistory(project), planTimelineGroupMove(project, selection, 30, "video-main", "video-main")!.command);
    expect(times(history.present).map(c => c[0])).toEqual([0, 5, 9]); expect(history.present.captions[1].start).toBe(6);
    expect(history.past).toHaveLength(1); expect(undo(history).present.tracks).toEqual(before.tracks); expect(undo(history).present.captions).toEqual(before.captions);
  });
  it("can move a group to a compatible unlocked track and refuses an occupied target atomically", () => {
    const project = fixture(); project.tracks.push({ ...structuredClone(project.tracks[0]), id: "v2", name: "v2", clips: [] });
    const selection = { clipIds: ["c0", "c1"], captionIds: [] }, plan = planTimelineGroupMove(project, selection, 0, "video-main", "v2")!;
    const history = dispatchCommand(createHistory(project), plan.command); expect(history.present.tracks.find(t => t.id === "v2")?.clips.map(c => c.id)).toEqual(["c0", "c1"]);
    expect(undo(history).present.tracks).toEqual(project.tracks);
    project.tracks.find(t => t.id === "v2")!.clips = [{ ...structuredClone(project.tracks[0].clips[0]), id: "occupied", trackId: "v2" }];
    const before = structuredClone(project); expect(() => planTimelineGroupMove(project, selection, 0, "video-main", "v2")).toThrow(); expect(project).toEqual(before);
  });
});
