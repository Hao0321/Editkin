import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, dispatchCommandSafely, undo } from "./history";
import { liftAttachments, previewRippleDelete } from "./rippleDelete";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "./types";
import { createMotionGraphic } from "../motion/composition";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { planRippleDelete, rippleDeleteReports, RIPPLE_NOTES } from "../application/timelineRippleEdits";

// The real EditGraph command (ripple_delete_clip), history and validation; the planner (application/timelineRippleEdits)
// on top. No rendering or mounted UI here.
const FPS = 30;
function clip(id: string, assetId: string, trackId: string, timelineStart: number, duration: number, sourceStart = 0): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** The audit's example: 主畫面 A[0,4) B[4,8) C[8,12); 聲音 VO1[0,5) VO2[5,9) VO3[9,15). */
function auditExample(): EditProject {
  const value = createEmptyProject("Ripple", { id: "ripple", width: 1920, height: 1080, fps: FPS });
  value.assets = [
    { id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 60, width: 1920, height: 1080 },
    { id: "vo", name: "vo.wav", kind: "audio", uri: "D:/owned/vo.wav", duration: 60 },
    { id: "broll", name: "broll.mp4", kind: "video", uri: "D:/owned/broll.mp4", duration: 60, width: 1920, height: 1080 },
  ];
  value.tracks[0].clips = [clip("A", "cam", "video-main", 0, 4), clip("B", "cam", "video-main", 4, 4, 10), clip("C", "cam", "video-main", 8, 4, 20)];
  value.tracks[1].clips = [clip("VO1", "vo", "audio-main", 0, 5), clip("VO2", "vo", "audio-main", 5, 4, 5), clip("VO3", "vo", "audio-main", 9, 6, 9)];
  return validateProject(value);
}
const startOf = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(item => item.id === id)?.timelineStart;
const frame = (seconds: number | undefined) => seconds === undefined ? undefined : Math.round(seconds * FPS);
function withCaptions(project: EditProject, captions: Array<[string, number, number]>): EditProject {
  return applyCommand(project, { type: "batch", commands: captions.map(([id, start, duration]) => ({ type: "add_caption", caption: { id, text: id, start, duration } })) });
}

describe("ripple delete on 主畫面 never fails for overlap and never deletes other tracks' media", () => {
  it("the audit's example: B goes, 主畫面 closes the gap, the voice-over stays where it is, the status says why; one Undo", () => {
    const project = auditExample();
    // Before 2026-10-11 this command was refused with 「軌道 聲音 的片段重疊…」 and nothing was deleted.
    const history = dispatchCommand(createHistory(project), { type: "ripple_delete_clip", clipId: "B" });
    const after = history.present;
    expect(after.tracks[0].clips.map(item => [item.id, frame(item.timelineStart)])).toEqual([["A", 0], ["C", 120]]);
    expect(after.tracks[1].clips.map(item => [item.id, frame(item.timelineStart)])).toEqual([["VO1", 0], ["VO2", 150], ["VO3", 270]]);
    const plan = planRippleDelete(project, ["B"]);
    expect(plan.command).toEqual({ type: "ripple_delete_clip", clipId: "B" });
    expect(plan.outcomes[0].heldTracks).toEqual([{ trackId: "audio-main", name: "聲音", kind: "audio", reason: "overlap" }]);
    expect(plan.message).toBe("已刪除片段並自動補上空隙；其他軌道的聲音沒有跟著移動，避免重疊；復原一次即可完整還原。");
    expect(undo(history).present).toEqual(project);
  });

  it("another track that can move up without overlap moves with 主畫面; one that cannot stays (picture and sound named)", () => {
    const project = auditExample();
    // A clean B-roll layer: its clip after the cut can move up by the gap.
    project.tracks.push({ id: "broll-track", name: "B-roll", kind: "video", locked: false, muted: false, clips: [clip("R1", "broll", "broll-track", 9, 2)] });
    // A crowded overlay: R2 sits inside B and R3 after it; moving R3 up would land on R2.
    project.tracks.push({ id: "overlay-track", name: "疊圖", kind: "video", locked: false, muted: false,
      clips: [clip("R2", "broll", "overlay-track", 5, 2, 10), clip("R3", "broll", "overlay-track", 8, 2, 20)] });
    const valid = validateProject(project);
    const after = applyCommand(valid, { type: "ripple_delete_clip", clipId: "B" });
    expect(frame(startOf(after, "R1"))).toBe(150);
    expect([frame(startOf(after, "R2")), frame(startOf(after, "R3"))]).toEqual([150, 240]);
    const plan = planRippleDelete(valid, ["B"]);
    expect(plan.outcomes[0].shiftedTrackIds).toEqual(["broll-track"]);
    expect(plan.outcomes[0].heldTracks.map(track => [track.trackId, track.kind, track.reason])).toEqual([["audio-main", "audio", "overlap"], ["overlay-track", "video", "overlap"]]);
    expect(plan.note).toBe(RIPPLE_NOTES.heldBoth);
    expect(plan.message).toBe("已刪除片段並自動補上空隙；其他軌道的畫面和聲音沒有跟著移動，避免重疊；復原一次即可完整還原。");
  });

  it("a locked track stays where it is and the status says so; deleting on a locked track is refused in plain words", () => {
    const project = auditExample();
    project.tracks[1].clips = [clip("VO3", "vo", "audio-main", 9, 6, 9)];
    project.tracks[1].locked = true;
    const valid = validateProject(project);
    const after = applyCommand(valid, { type: "ripple_delete_clip", clipId: "B" });
    expect(frame(startOf(after, "C"))).toBe(120);
    expect(frame(startOf(after, "VO3"))).toBe(270);
    const plan = planRippleDelete(valid, ["B"]);
    expect(plan.outcomes[0].heldTracks).toEqual([{ trackId: "audio-main", name: "聲音", kind: "audio", reason: "locked" }]);
    expect(plan.message).toBe("已刪除片段並自動補上空隙；鎖定的軌道沒有跟著移動；復原一次即可完整還原。");
    const locked = structuredClone(valid);
    locked.tracks[0].locked = true;
    const refused = dispatchCommandSafely(createHistory(locked), { type: "ripple_delete_clip", clipId: "B" });
    expect(refused.error).toBe(TRACK_LOCKED_MESSAGE);
    expect(refused.state.present).toBe(locked);
    expect(() => planRippleDelete(locked, ["B"])).toThrow(TRACK_LOCKED_MESSAGE);
  });
});

describe("captions, free titles and markers follow the cut", () => {
  it("captions inside the deleted clip go with it, half-covered ones are trimmed to what remains, later ones move up", () => {
    // B is [4,8): a caption ending inside it, one inside it, one starting inside it, one after it, and one across all of it.
    const project = withCaptions(auditExample(), [["before", 1, 2], ["tail-in-B", 3, 2], ["inside", 5, 1], ["head-in-B", 7, 2], ["after", 9, 1], ["spans-B", 3.5, 5]]);
    const after = applyCommand(project, { type: "ripple_delete_clip", clipId: "B" });
    const cue = (id: string) => after.captions.find(item => item.id === id);
    expect(cue("before")).toMatchObject({ start: 1, duration: 2 });
    expect(cue("inside")).toBeUndefined();
    expect(cue("tail-in-B")).toMatchObject({ start: 3, duration: 1 });
    expect(cue("head-in-B")).toMatchObject({ start: 4, duration: 1 });
    expect(cue("after")).toMatchObject({ start: 5, duration: 1 });
    expect(cue("spans-B")).toMatchObject({ start: 3.5 });
    expect(cue("spans-B")!.duration).toBeCloseTo(1, 9);
    const outcome = previewRippleDelete(project, "B");
    expect(outcome.removedCaptionIds).toEqual(["inside"]);
    expect(outcome.trimmedCaptionIds.sort()).toEqual(["head-in-B", "spans-B", "tail-in-B"]);
    expect(planRippleDelete(project, ["B"]).message).toBe("已刪除片段並自動補上空隙；其他軌道的聲音沒有跟著移動，避免重疊；復原一次即可完整還原。");
  });

  it("a locked 字幕 track keeps every caption as it is, and the status says so", () => {
    const project = withCaptions(auditExample(), [["inside", 5, 1], ["after", 9, 1]]);
    project.tracks[1].clips = [];
    project.tracks[2].locked = true;
    const after = applyCommand(project, { type: "ripple_delete_clip", clipId: "B" });
    expect(after.captions.map(item => [item.id, item.start])).toEqual([["inside", 5], ["after", 9]]);
    const plan = planRippleDelete(project, ["B"]);
    expect(plan.outcomes[0].captionsLocked).toBe(true);
    expect(plan.message).toBe("已刪除片段並自動補上空隙；字幕軌已鎖定，字幕保留不動；復原一次即可完整還原。");
  });

  it("free titles inside go with the clip, a half-covered one is trimmed (or goes when too short to animate), later ones move up", () => {
    let project = auditExample();
    project.tracks[1].clips = [];
    for (const graphic of [
      createMotionGraphic("inside", "title", "裡面", 4.5, 2), createMotionGraphic("long-tail", "title", "跨到 C", 6, 5),
      createMotionGraphic("tiny-head", "title", "只剩兩格", 3.94, 2), createMotionGraphic("later", "title", "之後", 9, 2),
      createMotionGraphic("earlier", "title", "之前", 0.5, 2),
    ]) project = applyCommand(project, { type: "add_motion_graphic", graphic });
    const after = applyCommand(project, { type: "ripple_delete_clip", clipId: "B" });
    const title = (id: string) => after.motionGraphics.find(item => item.id === id);
    expect(title("inside")).toBeUndefined();
    expect(title("tiny-head")).toBeUndefined();
    expect(frame(title("long-tail")!.timelineStart)).toBe(120);
    expect(frame(title("long-tail")!.duration)).toBe(90);
    expect(frame(title("later")!.timelineStart)).toBe(150);
    expect(title("earlier")).toMatchObject({ timelineStart: 0.5, duration: 2 });
    const plan = planRippleDelete(project, ["B"]);
    expect(plan.outcomes[0].removedGraphicIds.sort()).toEqual(["inside", "tiny-head"]);
    expect(plan.outcomes[0].trimmedGraphicIds).toEqual(["long-tail"]);
    expect(plan.message).toBe("已刪除片段並自動補上空隙；片段上的字幕和標題也一起刪除或修短；復原一次即可完整還原。");
  });

  it("markers inside go with the clip, markers after it move up, one at the cut moves to the new cut", () => {
    const project = auditExample();
    project.tracks[1].clips = [];
    const marker = (id: string, time: number) => ({ id, time, title: id, note: "", kind: "beat" as const, status: "open" as const, createdAt: "2026-10-11T00:00:00.000Z" });
    project.director.markers = [marker("m-before", 2), marker("m-start", 4), marker("m-inside", 6), marker("m-end", 8), marker("m-after", 10)];
    const after = applyCommand(validateProject(project), { type: "ripple_delete_clip", clipId: "B" });
    expect(after.director.markers.map(item => [item.id, item.time])).toEqual([["m-before", 2], ["m-end", 4], ["m-after", 6]]);
  });
});

describe("a saved title template follows its clip", () => {
  /** Fixture metadata (not CURRENT): B carries a template with a title, and a generated copy on its own track. */
  function templated(): EditProject {
    let value = auditExample();
    value.tracks[1].clips = [];
    value.tracks.push({ id: "template-track", name: "模板畫面", kind: "video", locked: false, muted: false, clips: [clip("B-copy", "cam", "template-track", 4, 4, 10)] });
    value = applyCommand(validateProject(value), { type: "add_motion_graphic", graphic: createMotionGraphic("B-title", "title", "其實是水簾", 4, 4) });
    return applyCommand(value, { type: "upsert_reference_motion_instance", instance: {
      schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2, instanceRevision: 1,
      input: { templateId: "level_bridge", clipId: "B", startFrame: 120, durationFrames: 120, title: "其實是水簾", sources: [],
        intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
      frameFormat: { width: value.width, height: value.height, fps: value.fps },
      roles: [{ key: "source:0:clip", kind: "clip", id: "B", parentId: "video-main" }, { key: "heading", kind: "graphic", id: "B-title" },
        { key: "copy:track", kind: "track", id: "template-track" }, { key: "copy:clip", kind: "clip", id: "B-copy", parentId: "template-track" }],
      primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
    } });
  }
  it("deleting the clip a template sits on removes the template, its titles, its own clips and its own empty track; one Undo restores all", () => {
    const project = templated();
    const history = dispatchCommand(createHistory(project), { type: "ripple_delete_clip", clipId: "B" });
    const after = history.present;
    expect(after.referenceMotionInstances).toEqual([]);
    expect(after.motionGraphics.map(item => item.id)).not.toContain("B-title");
    expect(after.tracks.map(track => track.id)).not.toContain("template-track");
    expect(frame(startOf(after, "C"))).toBe(120);
    const plan = planRippleDelete(project, ["B"]);
    expect(plan.outcomes[0].removedTemplateIds).toEqual(["owner"]);
    expect(plan.message).toBe("已刪除片段和上面的標題模板「其實是水簾」，並自動補上空隙；復原一次即可完整還原。");
    expect(undo(history).present).toEqual(project);
  });
  it("a template further on moves with its main clip (titles and own clips), so the editor can re-record it", () => {
    const project = templated();
    const after = applyCommand(project, { type: "ripple_delete_clip", clipId: "A" });
    expect(frame(startOf(after, "B"))).toBe(0);
    expect(frame(startOf(after, "B-copy"))).toBe(0);
    expect(frame(after.motionGraphics.find(item => item.id === "B-title")!.timelineStart)).toBe(0);
    expect(after.referenceMotionInstances).toHaveLength(1);
  });
  it("a template layer on a locked track refuses the delete in plain words", () => {
    const project = templated();
    project.tracks.find(track => track.id === "template-track")!.locked = true;
    expect(dispatchCommandSafely(createHistory(project), { type: "ripple_delete_clip", clipId: "B" }).error)
      .toBe("這段片段的標題模板有圖層在鎖定的軌道上，先解鎖才能刪除。");
  });
});

describe("ripple delete on another track, several clips, lift, and the agent's report", () => {
  it("on another track only that track closes the gap; the clip's own captions go with it, nothing else moves", () => {
    const value = auditExample();
    value.tracks[0].clips = [clip("A", "cam", "video-main", 0, 4)];
    const project = withCaptions(validateProject(value), [["vo2-line", 6, 1], ["over-A", 1, 1], ["vo3-line", 10, 1]]);
    const after = applyCommand(project, { type: "ripple_delete_clip", clipId: "VO2" });
    expect(after.tracks[1].clips.map(item => [item.id, frame(item.timelineStart)])).toEqual([["VO1", 0], ["VO3", 150]]);
    expect(after.captions.map(item => [item.id, item.start])).toEqual([["over-A", 1], ["vo3-line", 10]]);
    expect(frame(startOf(after, "A"))).toBe(0);
  });
  it("several clips go right to left in one command and one Undo", () => {
    const project = auditExample();
    project.tracks[1].clips = [];
    const plan = planRippleDelete(project, ["A", "C"]);
    expect(plan.command).toEqual({ type: "batch", commands: [{ type: "ripple_delete_clip", clipId: "C" }, { type: "ripple_delete_clip", clipId: "A" }] });
    expect(plan.message).toBe("已刪除 2 段片段並自動補上空隙；復原一次即可完整還原。");
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.tracks[0].clips.map(item => [item.id, frame(item.timelineStart)])).toEqual([["B", 0]]);
    expect(undo(history).present).toEqual(project);
  });
  it("lift deletes the clip and what belongs to it but leaves the gap and every other place as it is", () => {
    const project = withCaptions(auditExample(), [["inside", 5, 1], ["after", 9, 1]]);
    project.tracks[1].clips = [];
    expect(liftAttachments(project, "B").captionIds).toEqual(["inside"]);
    const plan = planRippleDelete(project, ["B"], { lift: true });
    expect(plan.message).toBe("已刪除片段，空隙保留在原處；片段上的字幕和標題也一起刪除；復原一次即可完整還原。");
    const after = applyCommand(project, plan.command);
    expect(after.tracks[0].clips.map(item => [item.id, frame(item.timelineStart)])).toEqual([["A", 0], ["C", 240]]);
    expect(after.captions.map(item => [item.id, item.start])).toEqual([["after", 9]]);
  });
  it("an agent's apply_edit_commands gets the same words for each ripple_delete_clip", () => {
    const project = auditExample();
    const reports = rippleDeleteReports(project, [{ type: "ripple_delete_clip", clipId: "B" }, { type: "ripple_delete_clip", clipId: "C" }]);
    expect(reports.map(report => report.message)).toEqual([
      "已刪除片段並自動補上空隙；其他軌道的聲音沒有跟著移動，避免重疊；復原一次即可完整還原。",
      "已刪除片段並自動補上空隙；其他軌道的聲音沒有跟著移動，避免重疊；復原一次即可完整還原。",
    ]);
    expect(reports[0].heldTracks).toEqual([{ trackId: "audio-main", name: "聲音", kind: "audio", reason: "overlap" }]);
  });
});
