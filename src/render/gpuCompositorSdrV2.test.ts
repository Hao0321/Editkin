import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildGpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { buildEngineRenderGraph } from "./engineGraph";
function project() {
  const p = createDemoProject(); p.width = 960; p.height = 540;
  p.assets[0]!.width = 960; p.assets[0]!.height = 540;
  p.assets[0]!.color = { interpretation: "rec709" }; p.captions = []; p.motionGraphics = [];
  return p;
}
describe("current SDR video v2 opt-in", () => {
  it("emits exact zero channels with v2 while leaving authored project unchanged", () => {
    const p = project(), before = JSON.stringify(p);
    const grade = buildGpuEngineVideoPreviewGraph(p, 0)!.graph.nodes.find(n => n.kind === "color")!;
    expect(grade.processor).toBe("editkin-rec709-primary/v2");
    expect(grade.grade).toMatchObject({ whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 });
    expect(JSON.stringify(p)).toBe(before);
  });
  it("keeps default low-level graph legacy and does not promote ACES", () => {
    const p = project();
    expect(buildEngineRenderGraph(p).nodes.find(n => n.kind === "color")!.processor).toBe("editkin-rec709-primary/v1");
    expect(buildEngineRenderGraph(p, {rec709PrimaryVersion: 1}).nodes.find(n => n.kind === "color")!.processor).toBe("editkin-rec709-primary/v1");
    p.colorManagement = {...p.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr"};
    expect(buildGpuEngineVideoPreviewGraph(p, 0)!.graph.nodes.find(n => n.kind === "color")!.processor).toBe("editkin-srgb-to-linear-rec709-primary/v1");
  });
  it("does not admit still/EXR or HDR video through this promotion", () => {
    for (const kind of ["image", "video"] as const) {
      const p = project(); p.assets[0]!.kind = kind;
      p.assets[0]!.color = {interpretation: kind === "image" ? "linear_rec709" : "hlg"};
      expect(buildGpuEngineVideoPreviewGraph(p, 0)).toBeUndefined();
    }
  });
});
