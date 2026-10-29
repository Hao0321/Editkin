import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { copyTimelineSelection, planTimelinePaste } from "./timelineClipboard";

const ids = () => { let value = 0; return (prefix: string) => `${prefix}-copy-${++value}`; };

describe("timeline clipboard", () => {
  it("copies a value snapshot without changing the project or history", () => {
    const project = createDemoProject(), history = createHistory(project);
    const copy = copyTimelineSelection(project, { clipIds: ["clip-demo"], captionIds: [], primaryClipId: "clip-demo" });
    project.tracks[0].clips[0].volume = 0;
    expect(copy.clips[0].volume).toBe(1);
    expect(history.past).toHaveLength(0);
    expect(copy.origin).toBe(0);
    expect(copy.end).toBe(12);
  });

  it("skips occupied space, pastes on the original track and restores everything in one Undo", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].duration = 2;
    project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[0]), id: "after-gap", timelineStart: 8 });
    const copy = copyTimelineSelection(project, { clipIds: ["clip-demo"], captionIds: [] });
    const plan = planTimelinePaste(project, copy, 1, ids());
    expect(plan.start).toBe(2);
    expect(plan.moved).toBe(true);
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.past).toHaveLength(1);
    expect(history.present.tracks[0].clips.map(clip => [clip.id, clip.timelineStart])).toEqual([
      ["clip-demo", 0], [plan.selection.clipIds[0], 2], ["after-gap", 8],
    ]);
    expect(undo(history).present.tracks).toEqual(project.tracks);
  });

  it("keeps a multitrack arrangement and captions together at the earliest common free slot", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].duration = 2;
    project.assets.push({ ...structuredClone(project.assets[0]), id: "audio-asset", kind: "audio" });
    project.tracks.push({ id: "audio-other", name: "Audio", kind: "audio", locked: false, muted: false,
      clips: [{ ...structuredClone(project.tracks[0].clips[0]), id: "sound", assetId: "audio-asset", trackId: "audio-other", timelineStart: 1 }] });
    project.captions = [{ id: "text", start: 1, duration: 1, text: "我的文字" }];
    const copy = copyTimelineSelection(project, { clipIds: ["clip-demo", "sound"], captionIds: ["text"] });
    const plan = planTimelinePaste(project, copy, 0, ids());
    expect(plan.start).toBe(2);
    const pasted = applyCommand(project, plan.command);
    expect(pasted.tracks.find(track => track.id === "audio-other")!.clips.at(-1)!.timelineStart).toBe(3);
    expect(pasted.captions.at(-1)).toMatchObject({ start: 3, text: "我的文字" });
    expect(project.captions).toHaveLength(1);
  });

  it("refuses locks, missing original tracks/assets and empty copies before an edit", () => {
    const project = createDemoProject();
    const copy = copyTimelineSelection(project, { clipIds: ["clip-demo"], captionIds: [] });
    project.tracks[0].locked = true;
    expect(() => planTimelinePaste(project, copy, 12, ids())).toThrow(/鎖定/);
    project.tracks[0].locked = false;
    project.assets = [];
    expect(() => planTimelinePaste(project, copy, 12, ids())).toThrow(/重新複製/);
    expect(() => copyTimelineSelection(project, { clipIds: [], captionIds: [] })).toThrow(/先選取/);
  });

  it("makes every mask identity new while preserving point correspondence, geometry, and one Undo", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    const path = [{ id: "p0", x: .1, y: .1 }, { id: "p1", x: .8, y: .1 }, { id: "p2", x: .8, y: .8 }];
    clip.masks = [{ id: "mask-original", name: "輪廓", kind: "polygon", mode: "add", enabled: true, inverted: false,
      opacity: 1, feather: 0, expansion: 0, path: structuredClone(path),
      keyframes: [{ frame: 0, time: 0, points: structuredClone(path), confidence: 1, status: "manual" },
        { frame: 30, time: 1, points: path.map(point => ({ ...point, x: point.x + .05 })), confidence: 1, status: "manual" }],
      refine: { edgeShift: 0, contrast: 0, chatterReduction: 0 },
      rotoCorrections: [{ id: "stroke-original", frame: 0, mode: "foreground", radius: .01, points: [{ x: .2, y: .2 }] }] }];
    const before = structuredClone(project), minted: string[] = [], allocate = ids();
    const copy = copyTimelineSelection(project, { clipIds: [clip.id], captionIds: [] });
    const plan = planTimelinePaste(project, copy, 12, prefix => { const id = allocate(prefix); minted.push(id); return id; });
    const history = dispatchCommand(createHistory(project), plan.command);
    const pasted = history.present.tracks[0].clips.find(item => item.id === plan.selection.clipIds[0])!.masks![0];
    expect(minted).toEqual(expect.arrayContaining([pasted.id, ...pasted.path.map(point => point.id), pasted.rotoCorrections![0].id]));
    expect(pasted.path.map(point => point.id)).not.toEqual(path.map(point => point.id));
    for (const keyframe of pasted.keyframes) expect(keyframe.points.map(point => point.id)).toEqual(pasted.path.map(point => point.id));
    expect(pasted.path.map(({ x, y }) => ({ x, y }))).toEqual(path.map(({ x, y }) => ({ x, y })));
    expect(pasted.keyframes[1].points[0].x).toBeCloseTo(.15);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present.tracks).toEqual(before.tracks);
    expect(project).toEqual(before);
    pasted.path[0].x = .4;
    expect(copy.clips[0].masks![0].path[0].x).toBe(.1);
  });

  it("retains the primary caption when clips and captions are pasted together", () => {
    const project = createDemoProject();
    project.captions = [{ id: "text", start: 0, duration: 1, text: "文字" }];
    const copy = copyTimelineSelection(project, { clipIds: ["clip-demo"], captionIds: ["text"], primaryCaptionId: "text" });
    const plan = planTimelinePaste(project, copy, 12, ids());
    expect(plan.selection.primaryCaptionId).toBe(plan.selection.captionIds[0]);
    expect(plan.selection.primaryClipId).toBeUndefined();
  });
});
