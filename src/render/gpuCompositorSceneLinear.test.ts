import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { DEFAULT_PARTICLE_SIMULATION } from "../domain/types";
import { buildGpuEngineVideoPreviewGraph, estimateGpuEngineVideoResources } from "./gpuCompositor";

describe("resident scene-linear GPU graph admission", () => {
  it("routes bounded Rec.709 video through one scene-linear ACES2 display transform", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/rec709-source.mp4";
    project.assets[0].color = { interpretation: "rec709" };
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    project.tracks[0].clips[0].color = { ...project.tracks[0].clips[0].color, exposure: .25, contrast: 1.05 };
    const adjustment = structuredClone(project.tracks[0].clips[0]);
    adjustment.id = "scene-linear-adjustment"; adjustment.trackId = "adjustment-track";
    adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    adjustment.color = { ...adjustment.color, exposure: .1, saturation: .9 };
    project.tracks.push({ id: "adjustment-track", name: "Adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });

    const preview = buildGpuEngineVideoPreviewGraph(project, 1)!;
    const colors = preview.graph.nodes.filter((node) => node.kind === "color");
    expect(colors).toContainEqual(expect.objectContaining({
      id: "color:clip-demo", processor: "editkin-srgb-to-linear-rec709-primary/v1",
      inputSpace: "rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709",
    }));
    expect(colors.filter((node) => node.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1")).toHaveLength(1);
    expect(colors).toContainEqual(expect.objectContaining({
      id: "color:scene-linear-adjustment", processor: "editkin-linear-primary/v1",
      inputSpace: "linear_rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709",
    }));
    expect(preview.graph.nodes.find((node) => node.id === preview.graph.outputNode)?.inputs).toEqual(["display:aces2"]);
    expect(estimateGpuEngineVideoResources(960, 540, 64, 1, 0, 1, 0, 0, 0, 8)).toMatchObject({
      workingBytesPerPixel: 8, compositorWorkingBytes: 12_441_600,
      adjustmentWorkingBytes: 8_294_400, requiredBytes: 39_398_400,
    });
  });

  it("admits bounded effects, decoded temporal sampling, and particles while keeping unsupported color semantics fail-closed", () => {
    const project = createDemoProject();
    project.width = 960; project.height = 540;
    project.assets[0].width = 960; project.assets[0].height = 540;
    project.assets[0].uri = "C:/fixtures/rec709-source.mp4";
    project.assets[0].color = { interpretation: "rec709" };
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeDefined();
    project.colorManagement.outputTransform = "rec2100_pq_1000";
    expect(buildGpuEngineVideoPreviewGraph(project, 1)?.graph.nodes).toContainEqual(expect.objectContaining({
      id: "display:aces2",
      processor: "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
      outputSpace: "rec2100_pq_1000",
    }));
    project.colorManagement.outputTransform = "rec2100_hlg_1000";
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.colorManagement.outputTransform = "p3d65_sdr";
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.colorManagement.outputTransform = "rec709_sdr";
    project.assets[0].color.interpretation = "hlg";
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
    project.assets[0].color.interpretation = "rec709";
    project.tracks[0].clips[0].creative = { effectPresetIds: ["mono_halftone"] };
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeDefined();
    project.tracks[0].clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [createTransformMotionBlurInstance()] };
    project.particleSimulation = { ...structuredClone(DEFAULT_PARTICLE_SIMULATION), timeline: { start: 0, duration: 12 } };
    const temporalParticle = buildGpuEngineVideoPreviewGraph(project, 1);
    expect(temporalParticle).toBeDefined();
    expect(temporalParticle?.graph.nodes.filter((node) => node.kind === "motion_blur")).toEqual([
      expect.objectContaining({ samples: 8, sourceSampling: "decoded_temporal" }),
    ]);
    expect(temporalParticle?.graph.nodes.filter((node) => node.kind === "particle_emitter")).toHaveLength(1);
    expect(temporalParticle?.vfxSimulationExpectation).toMatchObject({ emitterCount: 1, executor: "wgpu-resident-video-particle-overlay/v1" });
    project.particleSimulation.maxParticles = 193;
    expect(buildGpuEngineVideoPreviewGraph(project, 1)).toBeUndefined();
  });
});
