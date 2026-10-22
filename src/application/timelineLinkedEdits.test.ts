import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { migrateProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { LINK_TIMING_REFUSAL } from "../domain/linkedClipCommands";
import { linkedClipIds } from "../domain/clipLinks";
import type { EditProject, TimelineClip } from "../domain/types";
import { parseProject } from "./projectCodec";
import { planAudioDetach } from "./audioDetach";
import { planTimelineClipLink } from "./timelineLinkedEdits";
import { buildClipTrimCommand } from "./timelineTrim";
import { normalizeTimelineSelection } from "./timelineSelection";
import { selectLinkedTimelineItem } from "./timelineLinkedSelection";
import { planTimelineSelectionDelete, planTimelineSelectionNudge } from "./timelineSelectionEdits";
import { copyTimelineSelection, planTimelinePaste } from "./timelineClipboard";

const find = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!;
function fixture() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  project.captions = []; project.director.markers = []; clip.timelineStart = 2; clip.sourceStart = 1; clip.duration = 4;
  const linked = applyCommand(project, planAudioDetach(project, clip.id, { clipId: "sound", trackId: "detached-track" }).command);
  return { original: project, project: linked, video: clip.id, audio: "sound" };
}
const timing = (clip: TimelineClip) => [clip.timelineStart, clip.sourceStart, clip.duration];

describe("linked ordinary picture and sound transactions", () => {
  it("auto-links detached audio, round-trips schema9/10, and restores exactly in one Undo", () => {
    const { original, project, video, audio } = fixture();
    expect(linkedClipIds(project, video)).toEqual([video, audio]);
    expect(find(project, audio).linkGroupId).toBe(find(project, video).linkGroupId);
    for (const schemaVersion of [9, 10] as const) expect(parseProject({ ...JSON.parse(JSON.stringify(project)), schemaVersion }).tracks).toEqual(project.tracks);
    const state = dispatchCommand(createHistory(original), planAudioDetach(original, video, { clipId: audio, trackId: "detached-track" }).command);
    expect(state.past).toHaveLength(1); expect(undo(state).present).toEqual(original);
    for (const schemaVersion of [1, 8, 9]) expect(migrateProject({ ...structuredClone(original), schemaVersion }).tracks[0].clips[0]).not.toHaveProperty("linkGroupId");
    expect(editorCommandSchema.safeParse({ type: "set_clip_links", clipIds: [video, audio], groupId: " " }).success).toBe(false);
  });
  it("moves offsets once when both peers are explicit S4 selections; a vertical move keeps each media kind", () => {
    const { project, video, audio } = fixture(); find(project, audio).timelineStart += .5;
    const selection = normalizeTimelineSelection(project, { clipIds: [video], captionIds: [], primaryClipId: video });
    expect(selection.linkedClipIds).toEqual([video, audio]);
    const plan = planTimelineSelectionNudge(project, selection, 30)!;
    const state = dispatchCommand(createHistory(project), plan.command);
    expect(timing(find(state.present, video))).toEqual([3, 1, 4]); expect(timing(find(state.present, audio))).toEqual([3.5, 1, 4]);
    expect(undo(state).present).toEqual(project);
    const withTrack = applyCommand(project, { type: "add_track", track: { id: "sound-other", kind: "audio", name: "Other sound", muted: false, locked: false, clips: [] } });
    const moved = applyCommand(withTrack, { type: "move_clip_to_track", clipId: audio, trackId: "sound-other", timelineStart: 3.5 });
    expect(find(moved, audio).trackId).toBe("sound-other"); expect(find(moved, video).trackId).toBe("video-main"); expect(find(moved, video).timelineStart).toBe(3);
  });
  it("trims both sources and clocks once, including a normal head-trim batch and an explicit all-track tail trim", () => {
    const { project, video, audio } = fixture();
    const head = applyCommand(project, buildClipTrimCommand(find(project, video), "start", .5));
    for (const id of [video, audio]) expect(timing(find(head, id))).toEqual([2.5, 1.5, 3.5]);
    const state = dispatchCommand(createHistory(head), { type: "batch", commands: [video, audio].map(clipId => ({ type: "trim_clip_end", clipId, seconds: .5 })) });
    for (const id of [video, audio]) expect(timing(find(state.present, id))).toEqual([2.5, 1.5, 3]);
    expect(undo(state).present).toEqual(head);
  });
  it("splits at the same absolute frame, honours explicit new ids, and makes independently movable left/right pairs", () => {
    const { project, video, audio } = fixture(); find(project, audio).timelineStart += .5;
    const state = dispatchCommand(createHistory(project), { type: "batch", commands: [
      { type: "split_clip", clipId: video, at: 4, newClipId: "right-picture" },
      { type: "split_clip", clipId: audio, at: 4, newClipId: "right-sound" },
    ] });
    expect(timing(find(state.present, video))).toEqual([2, 1, 2]); expect(timing(find(state.present, audio))).toEqual([2.5, 1, 1.5]);
    expect(timing(find(state.present, "right-picture"))).toEqual([4, 3, 2]); expect(timing(find(state.present, "right-sound"))).toEqual([4, 2.5, 2.5]);
    expect(linkedClipIds(state.present, video)).toEqual([video, audio]);
    expect(linkedClipIds(state.present, "right-picture")).toEqual(["right-picture", "right-sound"]);
    const shifted = applyCommand(state.present, { type: "move_clip", clipId: "right-sound", timelineStart: 7 });
    expect(find(shifted, "right-picture").timelineStart).toBe(7); expect(find(shifted, video).timelineStart).toBe(2);
    expect(undo(state).present).toEqual(project);
  });
  it("lifts the whole selection and ripples the primary gap only once, including captions, later pairs and markers", () => {
    const { project, video, audio } = fixture();
    for (const id of [video, audio]) {
      const later = structuredClone(find(project, id)); later.id = `${id}-later`; later.timelineStart = 6; later.sourceStart = 0; later.duration = 2; later.linkGroupId = "later-pair";
      project.tracks.find(track => track.id === later.trackId)!.clips.push(later);
    }
    project.director.markers = [{ id: "later-marker", title: "Later", note: "Owned marker", time: 8, kind: "note", status: "open", createdAt: project.updatedAt }];
    const selection = { clipIds: [video], captionIds: [] };
    const lift = planTimelineSelectionDelete(project, selection, true), lifted = dispatchCommand(createHistory(project), lift.command);
    expect(lifted.present.tracks.flatMap(track => track.clips).map(clip => clip.id).sort()).toEqual([`${audio}-later`, `${video}-later`].sort());
    expect(find(lifted.present, `${video}-later`).timelineStart).toBe(6); expect(undo(lifted).present).toEqual(project);
    const ripple = planTimelineSelectionDelete(project, selection), state = dispatchCommand(createHistory(project), ripple.command);
    for (const id of [video, audio]) expect(find(state.present, `${id}-later`).timelineStart).toBe(2);
    expect(state.present.director.markers[0].time).toBe(4); expect(undo(state).present).toEqual(project);
    const explicit = applyCommand(project, { type: "batch", commands: [audio, video].map(clipId => ({ type: "ripple_delete_clip", clipId })) });
    expect(explicit.tracks).toEqual(state.present.tracks);
  });
  it("refuses a locked peer, a non-intersecting split, and downstream ripple desynchronization without touching the input", () => {
    const { project, video, audio } = fixture(); project.tracks.find(track => track.id === find(project, audio).trackId)!.locked = true;
    const before = JSON.stringify(project);
    for (const command of [{ type: "move_clip", clipId: video, timelineStart: 3 }, { type: "trim_clip_end", clipId: video, seconds: .5 },
      { type: "split_clip", clipId: video, at: 4, newClipId: "right" }, { type: "delete_clip", clipId: video }] as const) {
      expect(() => applyCommand(project, command)).toThrow(TRACK_LOCKED_MESSAGE); expect(JSON.stringify(project)).toBe(before);
    }
    project.tracks.find(track => track.id === find(project, audio).trackId)!.locked = false; find(project, audio).timelineStart = 5;
    expect(() => applyCommand(project, { type: "split_clip", clipId: video, at: 4, newClipId: "right" })).toThrow("每段連結片段");
    const global = fixture(); global.project.tracks[0].clips.unshift({ ...structuredClone(find(global.project, global.video)), id: "unlinked-before", timelineStart: 0, sourceStart: 0, duration: 2, linkGroupId: undefined });
    global.project.tracks.find(track => track.id === find(global.project, global.audio).trackId)!.locked = true;
    const originalBytes = JSON.stringify(global.project);
    expect(() => applyCommand(global.project, { type: "ripple_delete_clip", clipId: "unlinked-before" })).toThrow(LINK_TIMING_REFUSAL);
    expect(JSON.stringify(global.project)).toBe(originalBytes);
  });
  it("extends available head/tail source handles together, and refuses a push that cannot remain synchronous", () => {
    const { project, video, audio } = fixture();
    const tail = applyCommand(project, { type: "extend_clip", clipId: audio, edge: "end", seconds: 1 });
    for (const id of [video, audio]) expect(timing(find(tail, id))).toEqual([2, 1, 5]);
    const head = applyCommand(tail, { type: "extend_clip", clipId: video, edge: "start", seconds: .5 });
    for (const id of [video, audio]) expect(timing(find(head, id))).toEqual([1.5, .5, 5.5]);
    project.tracks[0].clips.push({ ...structuredClone(find(project, video)), id: "next", timelineStart: 6, sourceStart: 0, duration: 2, linkGroupId: undefined });
    expect(() => applyCommand(project, { type: "extend_clip", clipId: video, edge: "end", seconds: 1 })).toThrow(LINK_TIMING_REFUSAL);
  });
  it("unlinks the whole group with one Undo, and toggles linked S4 selection as a unit", () => {
    const { project, video, audio } = fixture(), selected = selectLinkedTimelineItem(project, { clipIds: [], captionIds: [] }, { kind: "clip", id: audio });
    expect(new Set(selected.clipIds)).toEqual(new Set([video, audio])); expect(selected.primaryClipId).toBe(audio);
    expect(selectLinkedTimelineItem(project, selected, { kind: "clip", id: video }, true).clipIds).toEqual([]);
    const state = dispatchCommand(createHistory(project), planTimelineClipLink(project, [audio], true).command);
    for (const id of [video, audio]) expect(find(state.present, id)).not.toHaveProperty("linkGroupId");
    expect(undo(state).present).toEqual(project);
    const linkedAgain = applyCommand(state.present, planTimelineClipLink(state.present, [video, audio]).command);
    expect(linkedClipIds(linkedAgain, audio)).toEqual([video, audio]);
    expect(() => planTimelineClipLink(state.present, [video])).toThrow("至少兩個");
  });
  it("copies an entire linked pair and gives pasted clips a fresh independent group", () => {
    const { project, video, audio } = fixture();
    const clipboard = copyTimelineSelection(project, { clipIds: [audio], captionIds: [], primaryClipId: audio });
    expect(clipboard.clips.map(clip => clip.id)).toEqual([video, audio]);
    let count = 0; const plan = planTimelinePaste(project, clipboard, 8, prefix => `${prefix}-${++count}`), pasted = applyCommand(project, plan.command);
    const copies = pasted.tracks.flatMap(track => track.clips).filter(clip => plan.selection.clipIds.includes(clip.id));
    expect(copies[0].linkGroupId).toBe(copies[1].linkGroupId); expect(copies[0].linkGroupId).not.toBe(find(project, video).linkGroupId);
    const moved = applyCommand(pasted, { type: "move_clip", clipId: copies[1].id, timelineStart: 10 });
    expect(find(moved, copies[0].id).timelineStart).toBe(10); expect(timing(find(moved, video))).toEqual([2, 1, 4]);
  });
});
