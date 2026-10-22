import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyCommand } from "../domain/commands";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace } from "../typography/preparedGlyphRun";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { parseProject } from "./projectFiles";
import { ADJACENT_TEMPLATE_REFUSAL, nearestTimelineCut, planInsertClip, planOverwriteClip, planRollEdit, planSlideEdit, ROLL_LIMIT, SLIDE_LIMIT } from "./timelineAdjacentEdits";
import { planTimelineAssetDrop } from "./timelineAssetEditDrop";

function fixture(fps = 30) {
  const project = parseProject(createEmptyProject("Adjacent edits", { id: "owned-adjacent", width: 640, height: 360, fps }));
  project.assets = [{ id: "source", name: "Original", kind: "video", uri: "owned-original.mp4", duration: 30 },
    { id: "insert", name: "Inserted", kind: "video", uri: "owned-insert.mp4", duration: 1 },
    { id: "sound", name: "Sound", kind: "audio", uri: "owned-sound.wav", duration: 20 }];
  const clip = (id: string, start: number, sourceStart = 2): TimelineClip => ({ id, assetId: "source", trackId: "video-main", timelineStart: start,
    sourceStart, duration: 4, volume: .75, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  project.tracks[0].clips = [clip("left", 0), clip("middle", 4, 4), clip("right", 8, 3)];
  project.tracks[1].clips = [{ ...clip("audio", 4), assetId: "sound", trackId: "audio-main", duration: 2 }];
  return project;
}
function ids() { let next = 0; return (prefix: string) => `${prefix}-${++next}`; }
const clocks = (project: EditProject) => project.tracks[0].clips.map(clip => [clip.id, clip.timelineStart, clip.sourceStart, clip.duration]);
function commit(project: EditProject, command: Parameters<typeof dispatchCommand>[1]) {
  const before = structuredClone(project), history = dispatchCommand(createHistory(project), command);
  expect(history.past).toHaveLength(1); expect(undo(history).present).toEqual(before); expect(project).toEqual(before);
  return history.present;
}

describe("main-track insert and overwrite", () => {
  it("chooses the nearest whole-track cut with an earlier tie and ripples later media/captions once", () => {
    const project = fixture(); project.captions = [{ id: "c", text: "later", start: 5, duration: 1 }];
    expect(nearestTimelineCut(project.tracks[0], 6, 30)).toBe(4);
    const plan = planInsertClip(project, "insert", "video-main", 5.7, "new", ids()), after = commit(project, plan.command);
    expect(plan.timelineStart).toBe(4); expect(plan.newLayer).toBe(false);
    expect(clocks(after)).toEqual([["left", 0, 2, 4], ["new", 4, 0, 1], ["middle", 5, 4, 4], ["right", 9, 3, 4]]);
    expect(after.tracks[1].clips[0].timelineStart).toBe(5); expect(after.captions[0].start).toBe(6);
  });
  it("inserts into an empty main track at zero and leaves locked secondary content still", () => {
    const project = fixture(); project.tracks[0].clips = []; project.tracks[1].locked = true;
    const after = commit(project, planInsertClip(project, "insert", "video-main", 15, "new", ids()).command);
    expect(after.tracks[0].clips[0].timelineStart).toBe(0); expect(after.tracks[1]).toEqual(project.tracks[1]);
  });
  it("overwrites inside a clip, retaining both exact source windows and all following clocks", () => {
    const project = fixture(), after = commit(project, planOverwriteClip(project, "insert", "video-main", 1, "new", ids()).command);
    expect(clocks(after)).toEqual([["left", 0, 2, 1], ["new", 1, 0, 1], ["overwrite-tail-2", 2, 4, 2], ["middle", 4, 4, 4], ["right", 8, 3, 4]]);
    expect(after.tracks[1]).toEqual(project.tracks[1]);
  });
  it("cuts both sides of an overwrite spanning a shared boundary, without ripple", () => {
    const project = fixture(); project.assets[1].duration = 2;
    const after = commit(project, planOverwriteClip(project, "insert", "video-main", 3, "new", ids()).command);
    expect(clocks(after)).toEqual([["left", 0, 2, 3], ["new", 3, 0, 2], ["middle", 5, 5, 3], ["right", 8, 3, 4]]);
  });
  it("fully removes covered clips, may extend the tail, and floors fractional-rate source duration", () => {
    const project = fixture(30000 / 1001); project.tracks[0].clips = [];
    const plan = planOverwriteClip(project, "insert", "video-main", 2, "new", ids()), after = commit(project, plan.command);
    expect(after.tracks[0].clips[0].duration).toBe(29 / project.fps);
    expect(after.tracks[0].clips[0].timelineStart).toBe(Math.round(2 * project.fps) / project.fps);
    const all = fixture(); all.assets[1].duration = 14;
    expect(commit(all, planOverwriteClip(all, "insert", "video-main", 0, "new", ids()).command).tracks[0].clips.map(clip => clip.id)).toEqual(["new"]);
  });
  it("keeps other-lane collision layers and refuses a locked main track before edits", () => {
    const project = fixture(), plan = planTimelineAssetDrop(project, "sound", "audio-main", 4, "new", ids(), "overwrite");
    expect(plan.newLayer).toBe(true); const after = commit(project, plan.command); expect(after.tracks[0]).toEqual(project.tracks[0]);
    project.tracks[0].locked = true;
    for (const planner of [planInsertClip, planOverwriteClip]) expect(() => planner(project, "insert", "video-main", 4, "new", ids())).toThrow(TRACK_LOCKED_MESSAGE);
  });
  it("rejects invalid clocks, duplicate IDs, and incompatible assets atomically", () => {
    const project = fixture(), before = structuredClone(project);
    for (const planner of [planInsertClip, planOverwriteClip]) {
      for (const time of [NaN, Infinity, -1]) expect(() => planner(project, "insert", "video-main", time, "new", ids())).toThrow();
      expect(() => planner(project, "insert", "video-main", 4, "left", ids())).toThrow();
      expect(() => planner(project, "sound", "video-main", 4, "new", ids())).toThrow();
    }
    expect(project).toEqual(before);
  });
});

describe("roll and slide source handles", () => {
  it.each([30, -30])("rolls a cut by %i frames with fixed outer anchors, one Undo and literal reopen", frames => {
    const project = fixture(), after = commit(project, planRollEdit(project, "left", "middle", frames)!.command), delta = frames / project.fps;
    expect(clocks(after)).toEqual([["left", 0, 2, 4 + delta], ["middle", 4 + delta, 4 + delta, 4 - delta], ["right", 8, 3, 4]]);
    expect(after.tracks[1]).toEqual(project.tracks[1]); expect(parseProject(after).tracks).toEqual(after.tracks);
  });
  it("clamps roll to the real source tail and preserves one frame on either side", () => {
    const project = fixture(); project.assets.push({ ...project.assets[0], id: "short-left", duration: 6.5 }); project.tracks[0].clips[0].assetId = "short-left";
    const plan = planRollEdit(project, "left", "middle", 300)!; expect(plan.deltaFrames).toBe(15); expect(plan.limited).toBe(true); expect(plan.message).toContain(ROLL_LIMIT);
    expect(commit(project, plan.command).tracks[0].clips[0].duration).toBe(4.5);
    project.tracks[0].clips[1].sourceStart = 0; expect(() => planRollEdit(project, "left", "middle", -1)).toThrow(ROLL_LIMIT);
    const long = fixture(), last = planRollEdit(long, "left", "middle", 1000)!;
    expect(last.deltaFrames).toBe(119); expect(commit(long, last.command).tracks[0].clips[1].duration).toBeCloseTo(1 / 30);
  });
  it.each([30, -30])("slides the middle by %i frames while preserving its content and leaving no gaps", frames => {
    const project = fixture(); project.captions = [{ id: "inside", text: "middle", start: 5, duration: 1 }];
    const after = commit(project, planSlideEdit(project, "middle", frames)!.command), delta = frames / project.fps;
    expect(clocks(after)).toEqual([["left", 0, 2, 4 + delta], ["middle", 4 + delta, 4, 4], ["right", 8 + delta, 3 + delta, 4 - delta]]);
    expect(after.tracks[0].clips[1].transform).toEqual(project.tracks[0].clips[1].transform); expect(after.captions[0].start).toBe(5 + delta);
    expect(after.tracks[0].clips.at(-1)!.timelineStart + after.tracks[0].clips.at(-1)!.duration).toBe(12);
  });
  it("refuses an out-of-handles slide instead of clamping or changing anything", () => {
    const project = fixture(); project.tracks[0].clips[2].sourceStart = 0; const before = structuredClone(project);
    expect(() => planSlideEdit(project, "middle", -1)).toThrow(SLIDE_LIMIT);
    expect(() => planSlideEdit(project, "middle", 120)).toThrow(SLIDE_LIMIT); expect(project).toEqual(before);
  });
  it("requires touching neighbours, refuses locked/managed tracks, and returns no command for zero", () => {
    const project = fixture(); expect(planRollEdit(project, "left", "middle", 0)).toBeUndefined(); expect(planSlideEdit(project, "middle", 0)).toBeUndefined();
    project.tracks[0].clips[1].timelineStart += 1; expect(() => planRollEdit(project, "left", "middle", 1)).toThrow(/相鄰/);
    expect(() => planSlideEdit(project, "middle", 1)).toThrow(/相鄰/);
    const locked = fixture(); locked.tracks[0].locked = true;
    expect(() => planRollEdit(locked, "left", "middle", 1)).toThrow(TRACK_LOCKED_MESSAGE); expect(() => planSlideEdit(locked, "middle", 1)).toThrow(TRACK_LOCKED_MESSAGE);
    });
  it("refuses edits to a real compiled CURRENT title template without changing its saved state", async () => {
    const project = fixture(); project.width=1080; project.height=1920;
    project.tracks[0].clips.forEach((clip,index)=>{clip.timelineStart=index*6;clip.duration=6;});
    const packet = await prepareReferenceMotionTemplateInstance(project, {
      templateId: "level_bridge", clipId: "middle", startFrame: 180, durationFrames: 180, title: "FOCUS", kicker: "LOOK",
      purpose: "Owned adjacent edit guard", evidenceRefs: ["owned:adjacent"], graphicCadence: "kinetic",
      style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } },
    }, ids(), { prepareText: async (faceId,text)=>{
      const bytes=await readFile(join(resolve("public/fonts"),bundledFontFaceSpec(faceId).fontFile));
      return (await preparePhysicalFace(faceId,new Uint8Array(bytes)))(text);
    } });
    const managed = applyCommand(project,{type:"batch",commands:packet.commands}), before=structuredClone(managed);
    expect((await inspectReferenceMotionTemplateInstance(managed,packet.instance.id)).status).toBe("CURRENT");
    expect(() => planRollEdit(managed, "left", "middle", 1)).toThrow(ADJACENT_TEMPLATE_REFUSAL);
    expect(() => planSlideEdit(managed, "middle", 1)).toThrow(ADJACENT_TEMPLATE_REFUSAL);
    expect(() => planInsertClip(managed,"insert","video-main",6,"new",ids())).toThrow(ADJACENT_TEMPLATE_REFUSAL);
    expect(() => planOverwriteClip(managed,"insert","video-main",7,"new",ids())).toThrow(ADJACENT_TEMPLATE_REFUSAL);
    expect(managed).toEqual(before);
    expect((await inspectReferenceMotionTemplateInstance(managed,packet.instance.id)).status).toBe("CURRENT");
  });
});
