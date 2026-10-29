import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_25D } from "../domain/types";
import { pairFixtureV1 } from "../domain/timelineTransitionV1.fixture";
import { buildGpuEngineVideoPreviewGraph, estimateGpuEngineVideoResources } from "./gpuCompositor";
import { reserveNativePairResourcesV1 } from "./timelineTransitionNativeV1";

function fixture() {
  const { project, transition } = pairFixtureV1();
  project.width = 960; project.height = 540;
  project.assets[0].uri = "C:/fixtures/original-pair-source.mp4";
  project.assets[0].derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-10-13T00:00:00.000Z", proxyUri: "C:/fixtures/nominal-proxy.mp4", proxyWidth: 480, proxyHeight: 270 };
  project.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
  project.timelineTransitions = [transition];
  return project;
}
describe("source version of the existing resident paired preview hook", () => {
  it("keeps the new executor unavailable without the explicit version", () => {
    expect(buildGpuEngineVideoPreviewGraph(fixture(), 2)).toBeUndefined();
  });
  it("emits typed paired scenes with original media and actual RGBA16F resources", () => {
    const project = fixture(), original = structuredClone(project);
    const graph = buildGpuEngineVideoPreviewGraph(project, 2, undefined, undefined, 1)!;
    expect(graph).toBeDefined();
    expect(graph.graph.workingFormat).toBe("rgba16_float");
    expect(graph.graph.nodes.find(node => node.kind === "timeline_transition_v1")?.plans).toHaveLength(1);
    expect(graph.assetBindings[project.assets[0].id]).toBe("C:/fixtures/original-pair-source.mp4");
    expect(graph.decoderDimensions[project.assets[0].id]).toEqual({ width: 960, height: 540, source: "original" });
    expect(project).toEqual(original);
  });
  it("declines colour or depth contracts that the new consumer cannot preserve", () => {
    const project = fixture();
    project.colorManagement!.rec709DisplayPolicy = "phone-bt1886";
    expect(buildGpuEngineVideoPreviewGraph(project, 2, undefined, undefined, 1)).toBeUndefined();
    project.colorManagement = undefined;
    expect(buildGpuEngineVideoPreviewGraph(project, 2, undefined, undefined, 1)).toBeUndefined();
    project.colorManagement = fixture().colorManagement;
    project.scene25d = structuredClone(DEFAULT_SCENE_25D);
    expect(buildGpuEngineVideoPreviewGraph(project, 2, undefined, undefined, 1)).toBeUndefined();
  });
  it("retains the previous no-pair graph JSON and proxy choice", () => {
    const project = fixture(); project.timelineTransitions = undefined;
    expect(JSON.stringify(buildGpuEngineVideoPreviewGraph(project, 2, undefined, undefined, 1))).toBe(JSON.stringify(buildGpuEngineVideoPreviewGraph(project, 2)));
    expect(buildGpuEngineVideoPreviewGraph(project, 2)?.assetBindings[project.assets[0].id]).toBe("C:/fixtures/nominal-proxy.mp4");
  });
  it("reserves all four float textures and refuses a real budget shortfall", () => {
    const baseline = estimateGpuEngineVideoResources(960, 540, 128, 2, 0, 0, 0, 0, 0, 8)!;
    const paired = reserveNativePairResourcesV1(baseline, 2, 2)!;
    expect(paired.requiredBytes - baseline.requiredBytes).toBe(960 * 540 * 32);
    expect(paired.maxVideoLayers).toBe(Math.floor((baseline.budgetBytes - baseline.compositorWorkingBytes - 960 * 540 * 32) / baseline.bytesPerVideoLayer));
    expect(reserveNativePairResourcesV1({ ...baseline, budgetBytes: baseline.requiredBytes + 960 * 540 * 32 - 1 }, 1, 2)).toBeUndefined();
    expect(reserveNativePairResourcesV1(baseline, 0, 2)).toBe(baseline);
  });
});
