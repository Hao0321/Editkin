// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { trackAudioAudible } from "../domain/trackState";
import { buildRenderPlan } from "../render/planner";
import { buildEngineRenderGraph } from "../render/engineGraph";
import { materializeMesh3dProject } from "../render/mesh3dRender";
import { compileNativeAudioProjectPlan } from "./nativeAudioProjectPlan";
import { activeMediaLayers } from "./previewMedia";
import { trackSoloFixture } from "./trackSolo.fixture";

describe("one solo policy across picture, browser audio, native audio and exports", () => {
  it.each(["none", "audio", "video", "both", "muted-solo"] as const)("keeps every executor in agreement for %s", async mode => {
    const project = trackSoloFixture(), video = project.tracks[0], audio = project.tracks.find(track => track.kind === "audio")!;
    if (mode === "audio" || mode === "both" || mode === "muted-solo") audio.solo = true;
    if (mode === "video" || mode === "both") video.solo = true;
    if (mode === "muted-solo") audio.muted = true;
    const expected = mode === "audio" ? ["solo-sound"] : mode === "video" ? [video.clips[0].id] : mode === "muted-solo" ? [] : [video.clips[0].id, "solo-sound"];
    const pictures = activeMediaLayers(project, 1.5, {}, "video"), sounds = activeMediaLayers(project, 1.5, {}, "audio");
    expect(pictures.map(layer => layer.clip.id)).toEqual([video.clips[0].id]);
    expect([...pictures.filter(layer => !layer.silent), ...sounds.filter(layer => !layer.silent)].map(layer => layer.clip.id)).toEqual(expected);
    expect(buildRenderPlan(project, uri => uri).audioClips.map(item => item.clip.id)).toEqual(expected);
    const graph = buildEngineRenderGraph(project);
    const graphAssets = graph.audio?.nodes.flatMap(node => node.operation.kind === "source" ? [node.operation.asset_id] : []) ?? [];
    expect(graphAssets).toEqual(expected.map(id => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!.assetId));
    const native = await compileNativeAudioProjectPlan(project, { generation: 1, timelineStartSeconds: 0, silentMediaRoot: resolve("cache"),
      resolveSource: async asset => ({ path: resolve(asset.uri), sha256: "a".repeat(64), bytes: 1024, hasAudio: true }) });
    expect(native.bindings.map(binding => binding.clipId)).toEqual(expected);
    const mesh = materializeMesh3dProject(project, resolve("own-scene.mp4"), 3);
    expect(buildRenderPlan(mesh, uri => uri).audioClips.map(item => item.clip.assetId).sort()).toEqual(expected.map(id => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!.assetId).sort());
  });
  it("a hidden solo picture track keeps its sound; a caption flag never silences media", () => {
    const project = trackSoloFixture(); project.tracks[0].hidden = true; project.tracks[0].solo = true;
    expect(activeMediaLayers(project, 1.5, {}, "video")).toEqual([]);
    expect(activeMediaLayers(project, 1.5, {}, "audio").map(layer => layer.clip.id)).toEqual([project.tracks[0].clips[0].id]);
    delete project.tracks[0].solo; project.tracks.find(track => track.kind === "caption")!.solo = true;
    expect(project.tracks.filter(track => trackAudioAudible(project, track))).toHaveLength(2);
  });
});
