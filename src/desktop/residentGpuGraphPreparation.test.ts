import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM_3D } from "../domain/types";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { prepareResidentGpuGraphs, sampleResidentGpuGraph } from "./residentGpuGraphPreparation";

describe("resident graph preparation versus native frame sampling", () => {
  it.each(["video", "image", "particle-image", "scene-video", "caption-video", "unsupported"])("preserves the original builder at every sampled frame: %s", (kind) => {
    const project = createDemoProject(); project.width = 960; project.height = 540;
    project.assets[0].uri = "C:/fixtures/source.mp4";
    if (kind.includes("image")) { project.assets[0].kind = "image"; project.assets[0].uri = "C:/fixtures/source.png"; project.tracks[0].clips[0].volume = 0; }
    if (kind === "particle-image") project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
    if (kind === "scene-video") { project.scene25d = structuredClone(DEFAULT_SCENE_25D); project.tracks[0].clips[0].transform3d = structuredClone(DEFAULT_TRANSFORM_3D); }
    if (kind === "caption-video") project.captions = [{ id: "cue", start: 1, duration: 3, text: "單色字幕" }];
    if (kind === "unsupported") project.assets[0].color = { interpretation: "hlg" };
    const original = JSON.stringify(project), prepared = prepareResidentGpuGraphs(project);
    if (kind !== "unsupported") expect(prepared.image ?? prepared.video).toBeDefined();
    else expect(prepared.video).toBeUndefined();
    for (const time of [-1, 0, 0.033, 0.5, 1, 2, 4, 11.97, 12, 14]) {
      const image = sampleResidentGpuGraph(prepared.image, time);
      const video = sampleResidentGpuGraph(prepared.video, time);
      expect(image).toEqual(buildGpuEnginePreviewGraph(project, time));
      expect(video).toEqual(buildGpuEngineVideoPreviewGraph(project, time));
      if (video) expect(video.graph).toBe(prepared.video!.graph);
      if (image) expect(image.graph).toBe(prepared.image!.graph);
    }
    expect(JSON.stringify(project)).toBe(original);
  });
  it("retains rational frame rounding and leaves the compiled origin untouched", () => {
    const project = createDemoProject(); project.width = 960; project.height = 540;
    project.fps = 30000 / 1001;
    const prepared = prepareResidentGpuGraphs(project).video!;
    expect(prepared).toBeDefined();
    expect(sampleResidentGpuGraph(prepared, 1)!.timelineFrame).toBe(30);
    expect(prepared.timelineFrame).toBe(0);
  });
});
