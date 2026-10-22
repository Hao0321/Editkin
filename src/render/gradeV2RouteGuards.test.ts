import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_SCENE_25D, DEFAULT_TRANSFORM_3D, type ColorGradeV2 } from "../domain/types";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, buildGpuRenderGraph } from "./gpuCompositor";
import { buildOpenExrSequenceRenderRequest } from "./openExrSequence";

/** Native GPU executors do not run Color Grade v2 yet: they must decline instead of silently dropping it. */
const GRADE: ColorGradeV2 = { schema: "editkin.color-grade/v2", look: { id: "hfl2_teaching_clear_neutral" } };

describe("Color Grade v2 route guards", () => {
  it("declines the image GPU render graph that otherwise admits the project", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    expect(buildGpuRenderGraph(project, 2)).toBeDefined();
    project.tracks[0].clips[0].gradeV2 = GRADE;
    expect(buildGpuRenderGraph(project, 2)).toBeUndefined();
  });

  it("declines the resident engine preview graphs that otherwise admit the project", () => {
    const image = createDemoProject();
    image.assets[0].kind = "image"; image.assets[0].uri = "C:/fixtures/back.png";
    image.scene25d = structuredClone(DEFAULT_SCENE_25D);
    image.tracks[0].clips[0].transform3d = structuredClone(DEFAULT_TRANSFORM_3D);
    expect(buildGpuEnginePreviewGraph(image, 1)).toBeDefined();
    image.tracks[0].clips[0].gradeV2 = GRADE;
    expect(buildGpuEnginePreviewGraph(image, 1)).toBeUndefined();

    const video = createDemoProject();
    video.width = 960; video.height = 540;
    video.assets[0].uri = "C:/fixtures/back.mp4"; video.assets[0].width = 960; video.assets[0].height = 540;
    const admitted = buildGpuEngineVideoPreviewGraph(video, 1);
    video.tracks[0].clips[0].gradeV2 = GRADE;
    expect(buildGpuEngineVideoPreviewGraph(video, 1)).toBeUndefined();
    if (!admitted) expect(admitted).toBeUndefined();
  });

  it("refuses OpenEXR / scene-linear requests that would lose the grade", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].gradeV2 = GRADE;
    expect(() => buildOpenExrSequenceRenderRequest(project)).toThrow(/Color Grade v2/);
  });
});
