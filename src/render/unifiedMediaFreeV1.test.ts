import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { buildEngineRenderGraph, type EngineRenderGraph } from "./engineGraph";
import { estimateGpuEngineMediaFreeResourcesV1, estimateGpuEngineVideoResources } from "./gpuCompositorAdmission";
import { prepareUnifiedLayerNativeProgramV1, reserveUnifiedLayerNativeResourcesV1 } from "./unifiedLayerNativeProgramV1";
import { expectedEngineVideoLayers, expectedEngineVideoControllers, expectedEngineVideoCaptions, expectedEngineVideoMotionGraphics } from "../desktop/residentGpuPreviewExpectations";
import { engineVideoResourcePlanMatches, engineVideoDecodeScheduleMatches } from "../desktop/residentGpuPreviewResources";
import { unifiedNativeLoadReceiptMatchesV1, unifiedNativeFrameReceiptMatchesV1, unifiedNativeVideoStateReceiptMatchesV1 } from "../desktop/unifiedLayerNativeReceiptV1";
import { presentResidentEngineVideo, type EngineVideoPreviewContext } from "../desktop/residentGpuEngineVideoPresenter";
import type { GpuEngineVideoResourcePlan } from "../desktop/gpuTypes";

/** Source metadata fixture only. It creates no media file,decoder,font raster,GPU session or visual preset. */
export function mediaFreeGraphV1(draws: Array<"captionA" | "captionB" | "graphic"> = ["graphic", "captionA"]): EngineRenderGraph {
  const p = createDemoProject(); p.width = 64; p.height = 64; p.assets = [];
  for (const track of p.tracks) track.clips = [];
  p.captionStyle = { ...p.captionStyle, fontSize: 20, marginV: 4, outlineWidth: 1, shadow: 1 };
  p.captions = draws.filter(id => id !== "graphic").map(id => ({ id, text: id, start: 0, duration: 3 }));
  p.motionGraphics = draws.includes("graphic") ? [createMotionGraphic("graphic", "title", "Source fixture", 0, 3, undefined,
    { ...legacyMotionGraphicSeed("title"), x: .1, y: .1, width: .7, fontSize: 18 })] : [];
  const saved = applyCommand(p, { type: "set_unified_layer_order", expected: { projectId: p.id, revision: p.revision, updatedAt: p.updatedAt },
    order: { schema: "editkin.unified-layer-order/v1", layers: draws.map(id => ({ kind: id === "graphic" ? "graphic" : "caption", id })) } });
  return buildEngineRenderGraph(saved, { rec709PrimaryVersion: 2 });
}
export function mediaFreeResourceReceiptV1(graph: EngineRenderGraph): GpuEngineVideoResourcePlan {
  const steps = prepareUnifiedLayerNativeProgramV1(graph)!.program.steps;
  const overlays = steps.filter(step => step.kind !== "adjustment").length, adjustments = steps.length - overlays;
  const plan = reserveUnifiedLayerNativeResourcesV1(estimateGpuEngineMediaFreeResourcesV1(graph.width, graph.height, graph.cacheBudgetMb, overlays, adjustments), 0)!;
  return { ...plan, width: graph.width, height: graph.height, videoLayerCount: 0, overlayCount: overlays, particleCount: 0,
    remainingBytes: plan.budgetBytes - plan.requiredBytes } as GpuEngineVideoResourcePlan;
}
export function syntheticMediaFreeClearContextV1(mutateLoad?: (value: Record<string, unknown>) => void) {
  const graph = mediaFreeGraphV1([]), program = prepareUnifiedLayerNativeProgramV1(graph)!.program, resourcePlan = mediaFreeResourceReceiptV1(graph);
  const coverage = { directExecution: true, blockedNodeIds: [], ignoredNodeIds: [], executedNodeIds: graph.nodes.map(node => node.id) };
  const decodeSchedule = { schema: "editkin.resident-video-decode-schedule/v1", fullRateLayerCount: 0, adaptiveLayerCount: 0, maximumDecodeCadenceDivisor: 1, maximumReuseAgeFrames: 0 };
  const loaded: Record<string, unknown> = { sessionId: "SOURCE_29", generation: 1, resident: true, executor: "media-foundation-d3d11-d3d12-wgpu/v1", displayTransform: "scene_linear_preview",
    compositeMode: "unified-layer-order/v1", videoAbsent: true, decoder: null, visualGraph: null, initialFrame: null, layerCount: 0, layers: [], visualLayers: [], unifiedCompositeV1: structuredClone(program),
    engineGraph: coverage, resourcePlan, decodeSchedule, matteCount: 0, precompositionCount: 0, parentCount: 0, controllerCount: 0, controllers: [],
    captionCount: 0, captionTextureUploads: 0, captions: [], activeCaptions: [], motionGraphicCount: 0, motionGraphicTextureUploads: 0, motionGraphics: [], activeMotionGraphics: [],
    adjustmentCount: 0, adjustments: [], particleCount: 0, particleTexturesResident: 0, nativeMotionPaintCount: 0,
    gpuEffects: { runtime: "editkin.gpu-effect-graph/v1", resolved: true, count: 0, programs: [] } };
  const surface = { bound: true, backend: "Dx12", nativeSwapChain: true, cpuPixelReadbacks: 0, surfaceColorSpace: "Auto", requestedColorSpace: "srgb",
    surfaceFormat: "Bgra8UnormSrgb", pixelContract: "legacy-sdr-video/v1", hdrTransportConfigured: false, legacyVideoPresentationAllowed: true,
    dxgiColorSpaceConfiguration: "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1", physicalDisplayHdrVisibility: "advisory-unverified", displayHdrInfo: { advisoryOnly: true },
    compositeExecutionMode: "unified-draw-adjust-ping-pong/v1", compositeLayerCount: 0, compositeFullFramePassCount: 2, compositeMaximumLayersPerPass: 1,
    compositeDirtyRectLayerCount: 0, compositeTextureCopyCount: 0, adjustmentExecutionMode: "none", adjustmentPassCount: 0, matteExecutionMode: "none", mattePassCount: 0,
    unifiedCompositeExecutionV1: { schema: "editkin.unified-native-execution/v1", graphId: graph.graphId, outputNode: graph.outputNode, timelineFrame: 30, steps: [],
      workingSeed: "transparent", deliveryBackground: "opaque_black", workingPingPongTextures: 2, seedTextures: 1, retainedFrameHistory: 0 } };
  const frame = { sessionId: "SOURCE_29", generation: 1, videoAbsent: true, active: false, nativeSurfaceCleared: true, timelineFrame: 30, endOfStream: false,
    sourceFrame: null, sourceTimeSeconds: null, layers: [], layerFrames: [], visualLayers: [], temporalSampling: null,
    productPathCpuPixelCopies: 0, decodedVideoCpuPixelCopies: 0, engineGraph: coverage, resourcePlan, decodeSchedule, surface,
    captionTextureUploads: 0, motionGraphicTextureUploads: 0, activeCaptions: [], activeMotionGraphics: [], activeAdjustments: [], adjustmentPassCount: 0,
    activeParticleEmitters: [], activeParticles: null, activeFloatingVideoFrames: [], activeNativeMotionPaints: [], controllers: [], visualGraphApplied: true, visualLayersApplied: true };
  const calls = { load: 0, bind: 0, present: 0 }, ref = <T>(current: T) => ({ current });
  const preview = { graph, timelineFrame: 30, structureKey: "SOURCE_MEDIA_FREE_29", assetBindings: {}, decoderDimensions: {} };
  const context: EngineVideoPreviewContext = {
    next: { kind: "engine-video", preview, token: 1, fps: 30, nativeBounds: { x: 0, y: 0, width: 64, height: 64, revision: 1 } },
    desktop: { loadGpuEngineVideoPreviewSession: async () => { calls.load++; mutateLoad?.(loaded); return loaded; }, bindGpuPreviewSurface: async () => { calls.bind++; return surface; },
      presentGpuEngineVideoPreviewFrame: async () => { calls.present++; return { receipt: frame, endOfStream: false }; } } as unknown as EngineVideoPreviewContext["desktop"],
    imageSessionRef: ref("image-source29"), videoSessionRef: ref("video-source29"), engineVideoSessionRef: ref("SOURCE_29"),
    loadedImageStructureRef: ref(undefined), loadedVideoStructureRef: ref(undefined), loadedEngineVideoStructureRef: ref(undefined), surfaceBoundsKeyRef: ref(undefined),
    surfaceColorSpaceRef: ref(undefined), surfaceBoundRef: ref(false), tokenRef: ref(1), releaseSurface: async () => {}, setFrameUrl: () => {}, setNativeSurfaceActive: () => {}, setFallbackReason: () => {},
  };
  return { graph, loaded, frame, context, calls };
}
function clearAdjustmentGraph(): EngineRenderGraph {
  const graph = mediaFreeGraphV1([]), original = JSON.parse(readFileSync(new URL("../../spikes/gpu-compositor/test-fixtures/unified-mixed-graph-v1.json", import.meta.url), "utf8")) as EngineRenderGraph;
  const adjustment = structuredClone(original.nodes.find(node => node.kind === "adjustment")!);
  const color = structuredClone(original.nodes.find(node => node.kind === "color" && node.inputs[0] === adjustment.id)!);
  const output = graph.nodes.find(node => node.id === graph.outputNode)!;
  adjustment.inputs = [...output.inputs]; adjustment.affectedInputs = [...adjustment.inputs]; output.inputs = [color.id]; graph.nodes.splice(graph.nodes.length - 1, 0, adjustment, color);
  return graph;
}

describe("explicit native media-free graphs (source-only controls)", () => {
  it("prepares canonical caption-only,Motion-only and mixed graphs without media paths,video nodes or decoders", () => {
    for (const draws of [["captionA"], ["graphic"], ["graphic", "captionA"]] as const) {
      const graph = mediaFreeGraphV1([...draws]), before = JSON.stringify(graph), prepared = prepareUnifiedLayerNativeProgramV1(graph)!;
      assert.deepEqual(prepared.program.steps.map(step => step.kind), draws.map(id => id === "graphic" ? "motion_graphic" : "caption"));
      assert(!graph.nodes.some(node => node.kind === "source" && node.mediaKind === "video")); assert.equal(graph.audio, undefined);
      assert.deepEqual(expectedEngineVideoLayers(graph), []); assert.deepEqual(expectedEngineVideoControllers(graph), []);
      assert.equal(expectedEngineVideoCaptions(graph).length, draws.filter(id => id !== "graphic").length);
      assert.equal(expectedEngineVideoMotionGraphics(graph).length, draws.filter(id => id === "graphic").length);
      assert.equal(prepareUnifiedLayerNativeProgramV1(prepared.leafGraph), undefined); assert.equal(JSON.stringify(graph), before);
    }
  });
  it("keeps every saved order of two captions and one Motion in all six canonical graphs", () => {
    const ids = ["captionA", "captionB", "graphic"] as const, sequences = new Set<string>();
    for (const first of ids) for (const second of ids.filter(id => id !== first)) {
      const order = [first, second, ids.find(id => id !== first && id !== second)!], graph = mediaFreeGraphV1(order), program = prepareUnifiedLayerNativeProgramV1(graph)!.program;
      assert.deepEqual(program.steps.map(step => step.kind !== "adjustment" ? step.sourceNodeId : "unexpected"), order.map(id => `${id === "graphic" ? "motion-graphic" : "caption"}:${id}`));
      sequences.add(JSON.stringify(program.steps));
    }
    assert.equal(sequences.size, 6);
  });
  it("clear-only and adjustment-only use the original genuine transparent seed in their leaf graph", () => {
    for (const graph of [mediaFreeGraphV1([]), clearAdjustmentGraph()]) {
      const prepared = prepareUnifiedLayerNativeProgramV1(graph)!;
      assert(!prepared.program.steps.some(step => step.kind === "video"));
      assert.equal(prepared.leafGraph.nodes.filter(node => node.kind === "source").length, 1);
      assert.equal(prepared.leafGraph.nodes.find(node => node.kind === "source")!.assetId, "editkin.generator.transparent");
      assert(prepared.leafGraph.nodes.every(node => node.inputs.every(id => prepared.leafGraph.nodes.some(input => input.id === id))));
    }
  });
  it("counts no residentvideo memory and reserves the seed once;originalvideo estimator still refuses zero", () => {
    const base = estimateGpuEngineMediaFreeResourcesV1(64, 64, 64, 2, 1)!, plan = reserveUnifiedLayerNativeResourcesV1(base, 0)!;
    assert.equal(estimateGpuEngineVideoResources(64, 64, 64, 0, 2, 1), undefined);
    assert.equal(base.requiredBytes, 64 * 64 * (12 + 8 + 8)); assert.equal(plan.requiredBytes, base.requiredBytes + 64 * 64 * 4);
    assert.equal(base.temporalResidentBytes, 0); assert.equal(base.matteCount, 0); assert.equal(base.nativePaintCount, 0); assert.equal(base.particleCount, 0);
    assert(reserveUnifiedLayerNativeResourcesV1({ ...base, budgetBytes: plan.requiredBytes }, 0));
    assert.equal(reserveUnifiedLayerNativeResourcesV1({ ...base, budgetBytes: plan.requiredBytes - 1 }, 0), undefined);
    assert.equal(reserveUnifiedLayerNativeResourcesV1(base, -1), undefined); assert.equal(estimateGpuEngineMediaFreeResourcesV1(0, 64, 64, 1), undefined);
  });
  it("strict actual0-source resource/schedule validators reject phantomvideo and incorrect budgets or seed accounting", () => {
    const graph = mediaFreeGraphV1(), resource = mediaFreeResourceReceiptV1(graph);
    assert(engineVideoResourcePlanMatches(resource, graph, 0, 2, 0, 0, 0));
    for (const patch of [{ videoLayerCount: 1 }, { requiredBytes: resource.requiredBytes + resource.bytesPerVideoLayer }, { unifiedSeedBytes: undefined }, { overlayCount: 1 }, { temporalResidentBytes: 1 }]) {
      assert.equal(engineVideoResourcePlanMatches({ ...resource, ...patch }, graph, 0, 2, 0, 0, 0), false);
    }
    const schedule = { schema: "editkin.resident-video-decode-schedule/v1" as const, fullRateLayerCount: 0, adaptiveLayerCount: 0, maximumDecodeCadenceDivisor: 1, maximumReuseAgeFrames: 0 };
    assert(engineVideoDecodeScheduleMatches(schedule, [])); assert.equal(engineVideoDecodeScheduleMatches({ ...schedule, fullRateLayerCount: 1 }, []), false);
    const legacy = { ...graph, graphId: "legacy" }; assert.equal(engineVideoResourcePlanMatches(resource, legacy, 0, 2, 0, 0, 0), false);
  });
  it("load proof requires original program,explicitabsence,null primary fields,emptyvideo arrays and honest zero resources", () => {
    const { graph, loaded } = syntheticMediaFreeClearContextV1(); assert(unifiedNativeLoadReceiptMatchesV1(graph, loaded));
    for (const [key, value] of [["videoAbsent", undefined], ["decoder", {}], ["visualGraph", {}], ["initialFrame", { active: false }], ["layers", [{}]], ["visualLayers", [{}]], ["controllers", [{}]],
      ["layerCount", 1], ["particleCount", 1], ["nativeMotionPaintCount", 1], ["compositeMode", undefined], ["compositeMode", "single/v1"], ["frame", null], ["sourceFrame", 0], ["uniform", {}]] as const) {
      assert.equal(unifiedNativeLoadReceiptMatchesV1(graph, { ...structuredClone(loaded), [key]: value }), false, key);
    }
    const legacy = { ...graph, graphId: "legacy" }; assert.equal(unifiedNativeLoadReceiptMatchesV1(legacy, loaded), false);
  });
  it("still rejects orphannodes,badtransparentseeds,unownedgroups and malformed or overcapacity zero-source programs", () => {
    const mutations: Array<(graph: EngineRenderGraph) => void> = [
      graph => graph.nodes.push({ id: "orphan", kind: "source", inputs: [], enabled: true, mediaKind: "video", assetId: "not-bound" }),
      graph => graph.nodes.push({ id: "camera", kind: "camera", inputs: [], enabled: true }),
      graph => { graph.nodes.find(node => node.kind === "source")!.alphaMode = "premultiplied"; },
      graph => { graph.nodes.push(structuredClone(graph.nodes[0])); },
      graph => { graph.nodes.find(node => node.id === graph.outputNode)!.inputs = ["missing"]; },
    ];
    for (const mutate of mutations) { const graph = mediaFreeGraphV1([]); mutate(graph); assert.throws(() => prepareUnifiedLayerNativeProgramV1(graph)); }
  });
  it("zero-video frame proof retains real overlay execution and forbids phantom video frame fields", () => {
    const graph = mediaFreeGraphV1(["captionA", "graphic", "captionB"]), steps = [
      { kind: "draw", layer: 0, nodeId: "caption:captionA", sourceNodeId: "caption:captionA" },
      { kind: "draw", layer: 2, nodeId: "motion-graphic:graphic", sourceNodeId: "motion-graphic:graphic" },
      { kind: "draw", layer: 1, nodeId: "caption:captionB", sourceNodeId: "caption:captionB" },
    ];
    const receipt = { videoAbsent: true, active: true, nativeSurfaceCleared: false, sourceFrame: null, sourceTimeSeconds: null, layers: [], layerFrames: [], visualLayers: [],
      temporalSampling: null, productPathCpuPixelCopies: 0, decodedVideoCpuPixelCopies: 0, unifiedCompositeExecutionV1: { schema: "editkin.unified-native-execution/v1", graphId: graph.graphId,
        outputNode: graph.outputNode, timelineFrame: 30, steps, workingSeed: "transparent", deliveryBackground: "opaque_black", workingPingPongTextures: 2, seedTextures: 1, retainedFrameHistory: 0 } };
    assert(unifiedNativeFrameReceiptMatchesV1(graph, 30, receipt)); assert(unifiedNativeVideoStateReceiptMatchesV1(graph, 30, receipt));
    assert.equal(unifiedNativeVideoStateReceiptMatchesV1(graph, 30, { ...receipt, frame: {} }), false);
  });
  it("actual original presenter load->resource validation->bind->present path accepts a truthful0-source clear under declared IPC ports", async () => {
    const f = syntheticMediaFreeClearContextV1(), result = await presentResidentEngineVideo(f.context);
    assert.deepEqual(result, { motionGraphicIds: [], captionIds: [] }); assert.deepEqual(f.calls, { load: 1, bind: 1, present: 1 });
    assert.equal(f.loaded.decoder, null); assert.equal(f.loaded.initialFrame, null); assert.equal(f.context.loadedEngineVideoStructureRef.current, "engine-video:SOURCE_MEDIA_FREE_29");
    for (const pixelContract of ["rec709-encoded-sdr-video/v2", "rec2020-pq-encoded-rgb/v1"]) {
      const bad = syntheticMediaFreeClearContextV1(); bad.frame.surface.pixelContract = pixelContract;
      await assert.rejects(() => presentResidentEngineVideo(bad.context), /色彩傳輸契約|呈現：surface/);
    }
  });
  it("actual presenter refuses missingabsence or fakeprimary atload,retainsrelease ownership and never binds/presents", async () => {
    for (const mutate of [(value: Record<string, unknown>) => { delete value.videoAbsent; }, (value: Record<string, unknown>) => { value.decoder = { invented: true }; }]) {
      const f = syntheticMediaFreeClearContextV1(mutate); await assert.rejects(() => presentResidentEngineVideo(f.context), /unifiedComposite/);
      assert.deepEqual(f.calls, { load: 1, bind: 0, present: 0 }); assert.equal(f.context.loadedEngineVideoStructureRef.current, "engine-video:SOURCE_MEDIA_FREE_29");
    }
  });
});
