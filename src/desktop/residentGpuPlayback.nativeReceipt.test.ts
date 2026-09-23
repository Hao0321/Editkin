import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateResidentEngineVideoFrame } from "./residentGpuEngineVideoPresenter";
import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type { GpuEngineVideoPresentedFrame } from "./gpuFrameTypes";

// The owned native harness supplies a current real GPU frame. Do not pretend
// an invented static fixture or a normal source-only Vitest run measured this.
describe.skipIf(!process.env.EDITKIN_NATIVE_PLAYBACK_RECEIPT)("actual native producer frame consumed by the production UI validator", () => {
  const fixture = () => {
    const native = JSON.parse(readFileSync(process.env.EDITKIN_NATIVE_PLAYBACK_RECEIPT!, "utf8"));
    const receipt: GpuEngineVideoPresentedFrame["receipt"] = native.snapshot.frameReceipt;
    const preview = { graph: native.graph, timelineFrame: receipt.timelineFrame, structureKey: "native-fixture",
      assetBindings: {}, decoderDimensions: {} } as GpuEngineVideoPreviewGraph;
    return { preview, presented: { receipt, endOfStream: receipt.endOfStream === true } };
  };
  it("accepts the real full native receipt through the unchanged color/effect/compositing checks", () => {
    const { preview, presented } = fixture();
    expect(presented.receipt.active).toBe(true);
    expect(() => validateResidentEngineVideoFrame(preview, presented)).not.toThrow();
  });
  it("rejects changed frame identity, color surface, node coverage, readback and resource budget", () => {
    const mutations: Array<(receipt: GpuEngineVideoPresentedFrame["receipt"]) => void> = [
      receipt => { receipt.timelineFrame++; },
      receipt => { receipt.surface.surfaceColorSpace = "Bt2100Pq"; },
      receipt => { receipt.engineGraph.ignoredNodeIds.push("source"); },
      receipt => { receipt.frame!.nativeSurfaceCpuPixelReadbacks = 1 as 0; },
      receipt => { (receipt as unknown as { resourcePlan: unknown }).resourcePlan = {}; },
    ];
    for (const mutate of mutations) {
      const { preview, presented } = fixture(); mutate(presented.receipt);
      expect(() => validateResidentEngineVideoFrame(preview, presented)).toThrow();
    }
  });
});
