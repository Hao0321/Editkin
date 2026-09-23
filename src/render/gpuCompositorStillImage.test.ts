import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import {
  buildGpuEnginePreviewGraph,
  buildGpuRenderGraph,
  gpuLayerPropertyBuffer,
} from "./gpuCompositor";

describe("production GPU still-image graph adapter", () => {
  it("maps all professional blend modes to stable native ABI codes", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.tracks[0].clips[0].layer = { enabled: true, blendMode: "color_burn" };
    expect(gpuLayerPropertyBuffer(buildGpuRenderGraph(project, 1)!)[1].blendMode).toBe(11);
  });

  it("routes the safe still-image subset through the common typed engine graph", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/fixtures/still.png";
    const preview = buildGpuEnginePreviewGraph(project, 2)!;
    expect(preview.graph.schema).toBe("editkin.engine-graph/v1");
    expect(preview.graph.audio).toBeUndefined();
    expect(preview.assetBindings).toEqual({ [project.assets[0].id]: "C:/fixtures/still.png" });
    expect(preview.timelineFrame).toBe(60);
  });

  it("routes deterministic monochrome effects through the common GPU graph and rejects unsupported effects", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.assets[0].uri = "C:/fixtures/still.png";
    project.tracks[0].clips[0].creative = { effectPresetIds: ["mono_halftone"] };
    const preview = buildGpuEnginePreviewGraph(project, 1)!;
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      kind: "effect", pluginId: "editkin.builtin.mono_halftone", abiVersion: 1,
    }));
    project.tracks[0].clips[0].creative = { effectPresetIds: ["film_grain_soft"] };
    expect(buildGpuEnginePreviewGraph(project, 1)).toBeUndefined();
  });

  it("does not hide unsupported image semantics behind the common graph executor", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.tracks[0].clips[0].keyframes.push({
      id: "animated", time: 0, easing: "linear",
      transform: structuredClone(project.tracks[0].clips[0].transform),
      color: structuredClone(project.tracks[0].clips[0].color),
    });
    expect(buildGpuEnginePreviewGraph(project, 0)).toBeUndefined();
  });

  it("fails closed when the resident image executor cannot preserve a project node", () => {
    const project = createDemoProject();
    project.assets[0].kind = "image";
    project.tracks[0].clips[0].color.exposure = 1;
    expect(buildGpuRenderGraph(project, 1)).toBeUndefined();
    project.tracks[0].clips[0].color.exposure = 0;
    project.tracks[0].clips[0].masks = [{
      id: "mask", name: "mask", kind: "rectangle", mode: "add", enabled: true, inverted: false, opacity: 1, feather: 0,
      expansion: 0, path: [{ id: "a", x: .1, y: .1 }, { id: "b", x: .9, y: .1 }, { id: "c", x: .9, y: .9 }], keyframes: [],
      refine: { edgeShift: 0, contrast: .5, chatterReduction: .5 },
    }];
    expect(buildGpuRenderGraph(project, 1)).toBeUndefined();
  });
});
