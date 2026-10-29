// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { buildRenderPlan } from "../render/planner";
import { activeMediaLayers } from "./previewMedia";
import { trackSoloFixture } from "./trackSolo.fixture";
import { planAudioDetach } from "./audioDetach";

describe("audio detach preserves monitoring instead of adopting destination mute or solo", () => {
  it.each(["muted-destination", "solo-source", "muted-source", "other-track-solo"] as const)("preserves the audible sources and one Undo for %s", mode => {
    const project = trackSoloFixture(), picture = project.tracks[0], audio = project.tracks.find(track => track.kind === "audio")!;
    audio.clips = [];
    if (mode === "muted-destination") audio.muted = true;
    if (mode === "solo-source") picture.solo = true;
    if (mode === "muted-source") picture.muted = true;
    if (mode === "other-track-solo") audio.solo = true;
    const clip = picture.clips[0], before = JSON.stringify(project);
    const expected = mode === "muted-destination" || mode === "solo-source" ? [clip.assetId] : [];
    const plan = planAudioDetach(project, clip.id, { clipId: "detached", trackId: "detached-track" });
    expect(JSON.stringify(project)).toBe(before);
    const state = dispatchCommand(createHistory(project), plan.command), next = state.present;
    expect(state.past).toHaveLength(1);
    expect(next.tracks.find(track => track.id === audio.id)).toEqual(audio);
    const detached = next.tracks.find(track => track.id === "detached-track")!;
    expect(detached.muted).toBe(picture.muted);
    expect(Boolean(detached.solo)).toBe(Boolean(picture.solo));
    expect(detached.clips[0]).toMatchObject({ assetId: clip.assetId, sourceStart: clip.sourceStart, timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume });
    const heard = [...activeMediaLayers(next, 1.5, {}, "video"), ...activeMediaLayers(next, 1.5, {}, "audio")].filter(layer => !layer.silent && layer.clip.volume > 0).map(layer => layer.asset.id);
    expect(heard).toEqual(expected);
    expect(buildRenderPlan(next, uri => uri).audioClips.filter(item => item.clip.volume > 0).map(item => item.clip.assetId)).toEqual(expected);
    expect(undo(state).present).toEqual(project);
  });
  it("reuses an empty compatible audio track without changing its state", () => {
    const project = trackSoloFixture(), picture = project.tracks[0], audio = project.tracks.find(track => track.kind === "audio")!;
    picture.solo = true; audio.solo = true; audio.clips = [];
    const plan = planAudioDetach(project, picture.clips[0].id, { clipId: "detached", trackId: "unused-track" });
    const next = applyCommand(project, plan.command);
    expect(plan.audioTrackId).toBe(audio.id);
    expect(next.tracks).toHaveLength(project.tracks.length);
    expect(next.tracks.find(track => track.id === audio.id)).toMatchObject({ solo: true, muted: false });
    expect(buildRenderPlan(next, uri => uri).audioClips.filter(item => item.clip.volume > 0).map(item => item.clip.id)).toEqual(["detached"]);
  });
});
