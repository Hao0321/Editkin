import { describe, expect, it } from "vitest";
import { estimateGpuEngineVideoResources } from "./gpuCompositor";

describe("resident GPU scene depth resource accounting", () => {
  it("matches native shadow-mask reservation and prevents the same 125 MiB budget from admitting a paint graph", () => {
    const enough = estimateGpuEngineVideoResources(960, 540, 128, 1, 1, 0, 0, 0, 0, 8, 0, 0, 1)!;
    const short = estimateGpuEngineVideoResources(960, 540, 125, 1, 1, 0, 0, 0, 0, 8, 0, 0, 1)!;
    expect(enough.nativePaintCpuBytes).toBe(518_400 * 16 + 67_108_864);
    expect(enough.requiredBytes).toBe(131_578_880);
    expect(enough.requiredBytes).toBeLessThanOrEqual(enough.budgetBytes);
    expect(short.requiredBytes).toBeGreaterThan(short.budgetBytes);
    expect(estimateGpuEngineVideoResources(960, 540, 128, 1, 1, 0, 0, 0, 0, 4, 0, 0, 1)).toBeUndefined();
  });
  it("charges one Depth32Float attachment and reuses an existing RGBA16F lens intermediate", () => {
    expect(estimateGpuEngineVideoResources(960, 540, 64, 2, 0, 0, 0, 0, 0, 8, 1, 1)).toMatchObject({
      sceneDepthAttachmentCount: 1, sceneDepthBytes: 2_073_600, depthOfFieldPassCount: 1,
      depthOfFieldAdditionalWorkingBytes: 0, maximumFullFramePassesPerPresent: 3,
      requiredBytes: 51_840_000, maxVideoLayers: 2,
    });
  });

  it("rejects a lens pass without a depth attachment and charges depth against the budget", () => {
    expect(estimateGpuEngineVideoResources(960, 540, 64, 2, 0, 0, 0, 0, 0, 8, 0, 1)).toBeUndefined();
    const withoutDepth = estimateGpuEngineVideoResources(960, 540, 64, 2, 0, 0, 0, 0, 0, 8, 0, 0)!;
    const withDepth = estimateGpuEngineVideoResources(960, 540, 64, 2, 0, 0, 0, 0, 0, 8, 1, 0)!;
    expect(withDepth.requiredBytes - withoutDepth.requiredBytes).toBe(2_073_600);
    expect(withDepth.maximumFullFramePassesPerPresent).toBe(2);
  });
});
