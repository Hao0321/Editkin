import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { planAudioDetach } from "./audioDetach";

const ids = { clipId: "detached-sound", trackId: "detached-track" };
describe("aligned audio detach as one atomic edit", () => {
  it("keeps source, gain and timing, mutes the video, and restores both with one Undo", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0]; clip.timelineStart = 2; clip.sourceStart = 1; clip.duration = 3; clip.volume = .65;
    clip.layout = { crop: { x: .1, y: .1, width: .8, height: .8 }, viewport: { x: 0, y: 0, width: 1, height: 1 } };
    const before = JSON.stringify(project), plan = planAudioDetach(project, clip.id, ids);
    expect(JSON.stringify(project)).toBe(before);
    const state = dispatchCommand(createHistory(project), plan.command), video = state.present.tracks[0].clips[0];
    const sound = state.present.tracks.flatMap(track => track.clips).find(item => item.id === ids.clipId)!;
    expect(state.past).toHaveLength(1); expect(video.volume).toBe(0);
    expect(sound).toMatchObject({ assetId: clip.assetId, sourceStart: 1, timelineStart: 2, duration: 3, volume: .65, trackId: "audio-main" });
    expect(sound.layout).toBeUndefined(); expect(sound.keyframes).toEqual([]);
    expect(() => planAudioDetach(state.present, sound.id, { clipId: "second-sound", trackId: "second-track" })).toThrow("一般影片");
    expect(state.present.assets).toEqual(project.assets); expect(video.layout).toEqual(clip.layout);
    expect(undo(state).present.tracks).toEqual(project.tracks);
  });
  it("creates a fresh track if every existing audio track would overlap; it never overwrites audio", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0], audio = project.tracks.find(track => track.kind === "audio")!;
    audio.clips = [{ ...structuredClone(clip), id: "existing-sound", trackId: audio.id }];
    const next = applyCommand(project, planAudioDetach(project, clip.id, ids).command);
    expect(next.tracks.find(track => track.id === audio.id)!.clips).toEqual(audio.clips);
    expect(next.tracks.find(track => track.id === ids.trackId)!.clips[0].id).toBe(ids.clipId);
  });
  it("does not add audio to a locked destination track", () => {
    const project = createDemoProject(), audio = project.tracks.find(track => track.kind === "audio")!; audio.locked = true;
    const next = applyCommand(project, planAudioDetach(project, project.tracks[0].clips[0].id, ids).command);
    expect(next.tracks.find(track => track.id === audio.id)).toEqual(audio);
    expect(next.tracks.find(track => track.id === ids.trackId)!.clips).toHaveLength(1);
  });
  it("refuses locked sources and unsupported assets before muting anything", () => {
    const project = createDemoProject(), clipId = project.tracks[0].clips[0].id; project.tracks[0].locked = true;
    expect(() => planAudioDetach(project, clipId, ids)).toThrow("鎖定"); expect(project.tracks[0].clips[0].volume).toBe(1);
    project.tracks[0].locked = false; project.assets[0].kind = "image";
    expect(() => planAudioDetach(project, clipId, ids)).toThrow("一般影片"); expect(project.tracks[0].clips[0].volume).toBe(1);
  });
  it("rejects reused IDs atomically and preserves the original project", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0], before = JSON.stringify(project);
    expect(() => planAudioDetach(project, clip.id, { ...ids, clipId: clip.id })).toThrow();
    expect(JSON.stringify(project)).toBe(before);
  });
});
