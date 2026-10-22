import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { EngineRenderGraph } from "../render/engineGraph";
import type { GpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import type { GpuEngineVideoPresentedFrame } from "./gpuFrameTypes";
import { estimateGpuEngineVideoResources } from "../render/gpuCompositorAdmission";
import { prepareUnifiedLayerNativeProgramV1, reserveUnifiedLayerNativeResourcesV1 } from "../render/unifiedLayerNativeProgramV1";
import { unifiedNativeVideoStateReceiptMatchesV1 } from "./unifiedLayerNativeReceiptV1";
import { validateResidentEngineVideoFrame } from "./residentGpuEngineVideoPresenter";

// Synthetic source-level IPC controls. No fixture here represents native/GPU/font/pixel evidence.
function graph(): EngineRenderGraph {
  return JSON.parse(readFileSync(new URL("../../spikes/gpu-compositor/test-fixtures/unified-mixed-graph-v1.json", import.meta.url), "utf8"));
}
function delay(graph: EngineRenderGraph, kinds: string[]) {
  for (const node of graph.nodes) if (kinds.includes(node.kind) && node.timeline) Object.assign(node.timeline as object, { timelineStartFrame: 60 });
}
function steps(graph: EngineRenderGraph, picture: "typography" | "adjustment" | "empty") {
  const program = prepareUnifiedLayerNativeProgramV1(graph)!.program;
  return program.steps.filter(step => picture === "empty" ? false : step.kind === "adjustment" || picture === "typography" && step.kind !== "video")
    .map(step => step.kind === "adjustment" ? { kind: "adjustment", adjustment: step.index, nodeId: step.nodeId }
      : { kind: "draw", layer: step.kind === "caption" ? 0 : 1, nodeId: step.tailId, sourceNodeId: step.sourceNodeId });
}
function receipt(graph: EngineRenderGraph, execution: unknown[], frame = 30): Record<string, unknown> {
  return { videoAbsent: true, active: execution.length > 0, nativeSurfaceCleared: execution.length === 0, timelineFrame: frame,
    sourceFrame: null, sourceTimeSeconds: null, layers: [], layerFrames: [], visualLayers: [], temporalSampling: null,
    productPathCpuPixelCopies: 0, decodedVideoCpuPixelCopies: 0,
    surface: { unifiedCompositeExecutionV1: { schema: "editkin.unified-native-execution/v1", graphId: graph.graphId,
      outputNode: graph.outputNode, timelineFrame: frame, steps: execution, workingSeed: "transparent", deliveryBackground: "opaque_black",
      workingPingPongTextures: 2, seedTextures: 1, retainedFrameHistory: 0 } } };
}
export function syntheticEmptyPresentation() {
  const source = graph(); delay(source, ["source", "caption", "motion_graphic", "adjustment"]);
  const plan = reserveUnifiedLayerNativeResourcesV1(estimateGpuEngineVideoResources(64, 64, source.cacheBudgetMb, 2, 2, 2), 2)!;
  const raw = receipt(source, []), surface = raw.surface as Record<string, unknown>;
  Object.assign(surface, { bound: true, backend: "Dx12", nativeSwapChain: true, cpuPixelReadbacks: 0, surfaceColorSpace: "Auto", requestedColorSpace: "srgb",
    surfaceFormat: "Bgra8Unorm", pixelContract: "rec709-encoded-sdr-video/v2", hdrTransportConfigured: false, legacyVideoPresentationAllowed: true,
    dxgiColorSpaceConfiguration: "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1", physicalDisplayHdrVisibility: "advisory-unverified", displayHdrInfo: { advisoryOnly: true },
    compositeExecutionMode: "unified-draw-adjust-ping-pong/v1", compositeLayerCount: 0, compositeFullFramePassCount: 2,
    compositeMaximumLayersPerPass: 1, compositeDirtyRectLayerCount: 0, compositeTextureCopyCount: 0,
    adjustmentExecutionMode: "none", adjustmentPassCount: 0, matteExecutionMode: "none", mattePassCount: 0 });
  Object.assign(raw, { sessionId: "SOURCE_TEST_ONLY_NOT_NATIVE", generation: 1, endOfStream: false,
    engineGraph: { directExecution: true, blockedNodeIds: [], ignoredNodeIds: [], executedNodeIds: source.nodes.map(node => node.id) },
    resourcePlan: { ...plan, width: 64, height: 64, videoLayerCount: 2, overlayCount: 2, remainingBytes: plan.budgetBytes - plan.requiredBytes },
    decodeSchedule: { schema: "editkin.resident-video-decode-schedule/v1", fullRateLayerCount: 2, adaptiveLayerCount: 0, maximumDecodeCadenceDivisor: 1, maximumReuseAgeFrames: 0 },
    captionTextureUploads: 1, motionGraphicTextureUploads: 1, activeCaptions: [], activeMotionGraphics: [], activeAdjustments: [], adjustmentPassCount: 0,
    activeParticleEmitters: [], activeParticles: null, activeFloatingVideoFrames: [], activeNativeMotionPaints: [], controllers: [],
    visualGraphApplied: true, visualLayersApplied: true });
  const preview = { graph: source, timelineFrame: 30, structureKey: "SOURCE_TEST_ONLY", assetBindings: {}, decoderDimensions: {} } as GpuEngineVideoPreviewGraph;
  const presented = { receipt: raw, endOfStream: false } as unknown as GpuEngineVideoPresentedFrame;
  return { source, raw, preview, presented };
}

describe("explicit mixed no-video state (synthetic source controls only)", () => {
  it("admits active typography plus scoped adjustments without creating a decoded-video receipt", () => {
    const source = graph(); delay(source, ["source"]);
    const raw = receipt(source, steps(source, "typography"));
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 30, raw));
    assert.equal(raw.frame, undefined); assert.equal(raw.visualGraph, undefined);
    assert.equal(raw.active, true); assert.equal(raw.nativeSurfaceCleared, false);
  });
  it("admits adjustment-only and truly empty pictures with distinct active/cleared state", () => {
    const source = graph(); delay(source, ["source", "caption", "motion_graphic"]);
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 30, receipt(source, steps(source, "adjustment"))));
    delay(source, ["adjustment"]);
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 30, receipt(source, [])));
    const wrong = receipt(source, []); wrong.active = true;
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, wrong), false);
  });
  it("rejects omitted markers, fabricated primaries, staged arrays, source clocks and copy claims", () => {
    const source = graph(); delay(source, ["source"]);
    const good = receipt(source, steps(source, "typography"));
    for (const [key, value] of [["videoAbsent", undefined], ["frame", {}], ["visualGraph", {}], ["layers", [{}]], ["layerFrames", [{}]],
      ["visualLayers", [{}]], ["sourceFrame", 0], ["sourceTimeSeconds", 0], ["productPathCpuPixelCopies", 1], ["decodedVideoCpuPixelCopies", 1],
      ["temporalSampling", {}], ["nativeSurfaceCleared", true]] as const) {
      assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, { ...structuredClone(good), [key]: value }), false, key);
    }
  });
  it("refuses clearing or absence claims while any canonical video is active, including partial source windows", () => {
    const source = graph(), normal = { active: true, nativeSurfaceCleared: false };
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 30, normal));
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, receipt(source, steps(source, "typography"))), false);
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, { active: false, nativeSurfaceCleared: true }), false);
    Object.assign(source.nodes.find(node => node.id === "source:upper22")!.timeline as object, { timelineStartFrame: 60 });
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 30, normal));
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, { ...normal, videoAbsent: true }), false);
  });
  it("requires the actual active draw/adjustment proof and preserves half-open timeline boundaries", () => {
    const source = graph(); delay(source, ["source"]);
    const execution = steps(source, "typography"), good = receipt(source, execution);
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, receipt(source, [])), false);
    const missing = structuredClone(good); delete missing.surface;
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, missing), false);
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 0, receipt(source, execution, 0)));
    delay(source, ["caption", "motion_graphic", "adjustment"]);
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 59, receipt(source, [], 59)));
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 60, receipt(source, [], 60)), false);
  });
  it("runs the real full presented-frame validator for an empty source fixture without any font/atlas authority", () => {
    const { preview, presented } = syntheticEmptyPresentation();
    assert.doesNotThrow(() => validateResidentEngineVideoFrame(preview, presented));
    assert.equal(presented.receipt.frame, undefined);
  });
  it("keeps full validator surface, coverage, missing-video-state and budget failures active for empty frames", () => {
    const changes: Array<(row: Record<string, unknown>) => void> = [
      row => { delete row.videoAbsent; }, row => { row.frame = {}; }, row => { row.active = true; },
      row => { (row.surface as Record<string, unknown>).compositeFullFramePassCount = 0; },
      row => { (row.surface as Record<string, unknown>).surfaceColorSpace = "Bt2100Pq"; },
      row => { (row.engineGraph as Record<string, unknown>).ignoredNodeIds = ["source:clip-demo"]; },
      row => { (row.resourcePlan as Record<string, unknown>).unifiedSeedBytes = 0; },
    ];
    for (const change of changes) {
      const { raw, preview, presented } = syntheticEmptyPresentation(); change(raw);
      assert.throws(() => validateResidentEngineVideoFrame(preview, presented));
    }
  });
  it("retains legacy marker absence and rejects attempts to route a legacy clear as mixed absence", () => {
    const source = graph(); source.graphId = "legacy:r7";
    assert(unifiedNativeVideoStateReceiptMatchesV1(source, 30, {}));
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(source, 30, { videoAbsent: true }), false);
  });
});
