import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { compositeChunkOutputPlanV1 } from "./compositeChunkOutputV1";

const raw = { kind: "raw-video-v1", sink: { async onFrame() {} } } as const;
describe("B2 display-plane output policy", () => {
  it.each([
    ["rec709_sdr", "yuv420p", "bt709", "bt709", 96 * 54 * 1.5],
    ["rec2100_hlg_1000", "yuv420p10le", "bt2020nc", "arib-std-b67", 96 * 54 * 3],
    ["rec2100_pq_1000", "yuv420p10le", "bt2020nc", "smpte2084", 96 * 54 * 3],
  ] as const)("binds %s to its final planes with no codec-specific bitstream filter", (transform, pixelFormat, matrix, transfer, frameBytes) => {
    const project = createEmptyProject("planes", { width: 96, height: 54, fps: 30 });
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: transform };
    const plan = compositeChunkOutputPlanV1(project, 2, "ffv1", false, raw);
    expect(plan).toMatchObject({ pixelFormat, frameBytes, frameCount: 60, frameRate: { numerator: 30, denominator: 1 } });
    expect(plan.metadataArgs).toEqual(["-color_primaries", matrix === "bt709" ? "bt709" : "bt2020", "-colorspace", matrix, "-color_trc", transfer, "-color_range", "tv"]);
    expect(plan.metadataArgs).not.toContain("-bsf:v"); expect(plan.metadataArgs).not.toContain("rgb");
    expect(plan.frameTagFilter).toBe(`setparams=range=tv:color_primaries=${matrix === "bt709" ? "bt709" : "bt2020"}:color_trc=${transfer}:colorspace=${matrix}`);
  });

  it("keeps NTSC frame clocks rational", () => {
    const project = createEmptyProject("ntsc", { width: 96, height: 54, fps: 30000 / 1001 });
    expect(compositeChunkOutputPlanV1(project, 60 * 1001 / 30000, "ffv1", false, raw)).toMatchObject({ frameCount: 60, frameRate: { numerator: 30000, denominator: 1001 } });
  });

  it("does not permit alpha working pixels or a different output codec through this display seam", () => {
    const project = createEmptyProject("invalid", { width: 96, height: 54, fps: 30 });
    expect(() => compositeChunkOutputPlanV1(project, 2, "ffv1", true, raw)).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
    expect(() => compositeChunkOutputPlanV1(project, 2, "libx264", false, raw)).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
  });

  it("refuses unmeasured P3 metadata rather than labelling it Rec.709", () => {
    const project = createEmptyProject("p3", { width: 96, height: 54, fps: 30 });
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "p3d65_sdr" };
    expect(() => compositeChunkOutputPlanV1(project, 2, "ffv1", false, raw)).toThrow("LONG_RENDER_ROUTE_NOT_AVAILABLE");
  });

  it("rejects an unaligned raw duration, odd dimensions and an oversized frame", () => {
    const project = createEmptyProject("invalid", { width: 96, height: 54, fps: 30 });
    expect(() => compositeChunkOutputPlanV1(project, 1.01, "ffv1", false, raw)).toThrow("LONG_RENDER_OUTPUT_QA");
    project.width = 95;
    expect(() => compositeChunkOutputPlanV1(project, 2, "ffv1", false, raw)).toThrow("LONG_RENDER_OUTPUT_QA");
    project.width = 32768; project.height = 32768;
    expect(() => compositeChunkOutputPlanV1(project, 2, "ffv1", false, raw)).toThrow("LONG_RENDER_OUTPUT_QA");
  });
});
