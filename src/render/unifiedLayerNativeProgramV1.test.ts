import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR } from "../domain/types";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { buildEngineRenderGraph, type EngineNode, type EngineRenderGraph } from "./engineGraph";
import { estimateGpuEngineVideoResources } from "./gpuCompositorAdmission";
import { expectedEngineVideoLayers, expectedEngineVideoAdjustments } from "../desktop/residentGpuPreviewExpectations";
import { engineVideoResourcePlanMatches } from "../desktop/residentGpuPreviewResources";
import { unifiedNativeLoadReceiptMatchesV1, unifiedNativeFrameReceiptMatchesV1 } from "../desktop/unifiedLayerNativeReceiptV1";
import { isUnifiedLayerNativeGraphV1, prepareUnifiedLayerNativeProgramV1, reserveUnifiedLayerNativeResourcesV1 } from "./unifiedLayerNativeProgramV1";

const draws = [{ kind: "caption" as const, id: "caption22" }, { kind: "clip" as const, id: "clip-demo" },
  { kind: "graphic" as const, id: "graphic22" }, { kind: "clip" as const, id: "upper22" }];
function fixture(order = draws): EngineRenderGraph {
  const p = createDemoProject(); p.width = 64; p.height = 64;
  p.assets[0].width = 64; p.assets[0].height = 64; p.assets[0].color = { interpretation: "rec709" };
  const first = p.tracks[0].clips[0]; first.volume = 0;
  p.captions = [{ id: "caption22", text: "Caption22", start: 0, duration: 3 }];
  p.motionGraphics = [createMotionGraphic("graphic22", "title", "Motion22", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
  for (const [id, role] of [["upper22", "content"], ["adjustA22", "adjustment"], ["adjustB22", "adjustment"]] as const) {
    p.tracks.push({ id: `${id}-track`, name: id, kind: "video", locked: false, muted: false,
      clips: [{ ...structuredClone(first), id, trackId: `${id}-track`, layer: { enabled: true, role, blendMode: "normal" },
        color: { ...DEFAULT_COLOR, brightness: role === "adjustment" ? .1 : 0 } }] });
  }
  const layers = [...order.slice(0, 2), { kind: "clip" as const, id: "adjustA22" }, ...order.slice(2), { kind: "clip" as const, id: "adjustB22" }];
  const saved = applyCommand(p, { type: "set_unified_layer_order", expected: { projectId: p.id, revision: p.revision, updatedAt: p.updatedAt },
    order: { schema: "editkin.unified-layer-order/v1", layers } });
  return { ...buildEngineRenderGraph(saved, { rec709PrimaryVersion: 2 }), audio: undefined };
}
function permutations<T>(items: T[]): T[][] {
  return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest])) : [[]];
}
function proof(graph: EngineRenderGraph, steps: unknown[], timelineFrame = 30) {
  return { schema: "editkin.unified-native-execution/v1", graphId: graph.graphId, outputNode: graph.outputNode, timelineFrame,
    steps, workingSeed: "transparent", deliveryBackground: "opaque_black", workingPingPongTextures: 2, seedTextures: 1, retainedFrameHistory: 0 };
}
function defaultSteps(graph: EngineRenderGraph) {
  const steps = prepareUnifiedLayerNativeProgramV1(graph)!.program.steps;
  // Independent expected resource slots: video0, video1, caption0, Motion0.
  const slots = [2, 0, undefined, 3, 1, undefined];
  return steps.map((step, index) => step.kind === "adjustment"
    ? { kind: "adjustment", adjustment: step.index, nodeId: step.nodeId }
    : { kind: "draw", layer: slots[index]!, nodeId: step.tailId, sourceNodeId: step.sourceNodeId });
}

describe("native mixed program and original-DAG receipt boundaries", () => {
  it("preserves every requested mixed order and each adjustment site in 24 canonical DAGs", () => {
    for (const order of permutations(draws)) {
      const graph = fixture(order), before = JSON.stringify(graph), prepared = prepareUnifiedLayerNativeProgramV1(graph)!;
      assert.deepEqual(prepared.program.steps.map(step => step.kind), [...order.slice(0, 2).map(ref => ref.kind === "clip" ? "video" : ref.kind === "graphic" ? "motion_graphic" : "caption"),
        "adjustment", ...order.slice(2).map(ref => ref.kind === "clip" ? "video" : ref.kind === "graphic" ? "motion_graphic" : "caption"), "adjustment"]);
      const ids = prepared.program.steps.map(step => step.kind === "adjustment" ? step.nodeId : step.sourceNodeId);
      const identity = (ref: typeof draws[number]) => `${ref.kind === "clip" ? "source" : ref.kind === "graphic" ? "motion-graphic" : "caption"}:${ref.id}`;
      assert.deepEqual(ids, [...order.slice(0, 2).map(identity), "adjustment:adjustA22", ...order.slice(2).map(identity), "adjustment:adjustB22"]);
      assert.equal(expectedEngineVideoLayers(graph).length, 2); assert.equal(expectedEngineVideoAdjustments(graph).length, 2);
      assert.equal(prepareUnifiedLayerNativeProgramV1(prepared.leafGraph), undefined);
      assert.equal(JSON.stringify(graph), before);
    }
  });
  it("requires the complete load program and rejects old-runtime, forged order, extra fields and float drift", () => {
    const graph = fixture(), program = prepareUnifiedLayerNativeProgramV1(graph)!.program;
    assert(unifiedNativeLoadReceiptMatchesV1(graph, { unifiedCompositeV1: structuredClone(program) }));
    const reversed = structuredClone(program); reversed.steps.reverse();
    const opacity = structuredClone(program); const draw = opacity.steps.find(step => step.kind !== "adjustment")!;
    draw.opacity = .5;
    const extra = { ...program, ignoredNodeIds: [] };
    for (const actual of [undefined, reversed, opacity, extra, { ...program, graphId: "other" }, { ...program, steps: program.steps.slice(1) }]) {
      assert.equal(unifiedNativeLoadReceiptMatchesV1(graph, { unifiedCompositeV1: actual }), false);
    }
  });
  it("matches grouped texture slots in actual visible order and rejects draw/adjustment substitutions", () => {
    const graph = fixture(), steps = defaultSteps(graph), good = proof(graph, steps);
    assert(unifiedNativeFrameReceiptMatchesV1(graph, 30, { surface: { unifiedCompositeExecutionV1: good } }));
    assert(unifiedNativeFrameReceiptMatchesV1(graph, 30, { unifiedCompositeExecutionV1: good }));
    const altered = structuredClone(steps); altered.reverse();
    const wrongSlot = structuredClone(steps); Object.assign(wrongSlot[0], { layer: 0 });
    for (const bad of [proof(graph, altered), proof(graph, wrongSlot), proof(graph, steps.slice(1)), { ...good, retainedFrameHistory: 1 },
      { ...good, workingSeed: "opaque_black" }, { ...good, timelineFrame: 29 }, { ...good, graphId: "other" }, { ...good, ignored: [] }]) {
      assert.equal(unifiedNativeFrameReceiptMatchesV1(graph, 30, { surface: { unifiedCompositeExecutionV1: bad } }), false);
      assert.equal(unifiedNativeFrameReceiptMatchesV1(graph, 30, { unifiedCompositeExecutionV1: good, surface: { unifiedCompositeExecutionV1: bad } }), false);
    }
    assert.equal(unifiedNativeFrameReceiptMatchesV1(graph, 30, {}), false);
    assert.equal(unifiedNativeFrameReceiptMatchesV1(graph, .5, { unifiedCompositeExecutionV1: good }), false);
  });
  it("reindexes partial frames and refuses an empty receipt that silently drops active typography or adjustments", () => {
    const graph = fixture(), program = prepareUnifiedLayerNativeProgramV1(graph)!.program;
    for (const node of graph.nodes) if (node.kind === "source" && node.mediaKind === "video") (node.timeline as Record<string, number>).timelineStartFrame = 60;
    const steps = program.steps.filter(step => step.kind !== "video").map(step => step.kind === "adjustment"
      ? { kind: "adjustment", adjustment: step.index, nodeId: step.nodeId }
      : { kind: "draw", layer: step.kind === "caption" ? 0 : 1, nodeId: step.tailId, sourceNodeId: step.sourceNodeId });
    assert(unifiedNativeFrameReceiptMatchesV1(graph, 30, { unifiedCompositeExecutionV1: proof(graph, steps) }));
    assert.equal(unifiedNativeFrameReceiptMatchesV1(graph, 30, { unifiedCompositeExecutionV1: proof(graph, []) }), false);
    for (const node of graph.nodes) if (node.timeline) Object.assign(node.timeline as object, { timelineStartFrame: 60 });
    assert(unifiedNativeFrameReceiptMatchesV1(graph, 30, { unifiedCompositeExecutionV1: proof(graph, []) }));
    assert(unifiedNativeFrameReceiptMatchesV1(graph, 1_000, { unifiedCompositeExecutionV1: proof(graph, [], 1_000) }));
  });
  it("reserves the full transparent seed, exact budget edge and maximum capacity without changing the legacy estimate", () => {
    const graph = fixture(); graph.cacheBudgetMb = 128;
    const base = estimateGpuEngineVideoResources(64, 64, 128, 2, 2, 2)!, before = JSON.stringify(base);
    const plan = reserveUnifiedLayerNativeResourcesV1(base, 2)!;
    assert.equal(plan.unifiedSeedBytes, 64 * 64 * 4); assert.equal(plan.requiredBytes, base.requiredBytes + plan.unifiedSeedBytes);
    assert.equal(JSON.stringify(base), before);
    const receipt = { ...plan, width: 64, height: 64, videoLayerCount: 2, overlayCount: 2,
      sceneDepthAttachmentCount: 0 as const, depthOfFieldPassCount: 0 as const, depthOfFieldAdditionalWorkingBytes: 0 as const,
      remainingBytes: plan.budgetBytes - plan.requiredBytes };
    assert(engineVideoResourcePlanMatches(receipt, graph, 2, 2, 2, 0, 0));
    assert.equal(engineVideoResourcePlanMatches({ ...receipt, unifiedSeedBytes: undefined }, graph, 2, 2, 2, 0, 0), false);
    assert.equal(engineVideoResourcePlanMatches({ ...receipt, requiredBytes: base.requiredBytes }, graph, 2, 2, 2, 0, 0), false);
    assert(reserveUnifiedLayerNativeResourcesV1({ ...base, budgetBytes: base.requiredBytes + 64 * 64 * 4 }, 2));
    assert.equal(reserveUnifiedLayerNativeResourcesV1({ ...base, budgetBytes: base.requiredBytes + 64 * 64 * 4 - 1 }, 2), undefined);
    assert.equal(reserveUnifiedLayerNativeResourcesV1({ ...base, pixelCount: Number.MAX_SAFE_INTEGER }, 2), undefined);
  });
  it("rejects incomplete, shared, cyclic, unsupported, malformed and over-capacity input instead of dropping requests", () => {
    const cases: Array<(graph: EngineRenderGraph) => void> = [
      graph => graph.nodes.push(structuredClone(graph.nodes[0])),
      graph => { graph.nodes.find(node => node.id === graph.outputNode)!.inputs = ["missing"]; },
      graph => { graph.nodes.find(node => node.kind === "composite")!.opacity = Number.NaN; },
      graph => { const node = graph.nodes.find(node => node.kind === "adjustment")!; node.inputs = [node.id]; node.affectedInputs = [node.id]; },
      graph => { graph.nodes.push({ id: "blocked-camera", kind: "camera", inputs: [], enabled: true }); },
      graph => { graph.nodes.push({ id: "temporal", kind: "motion_blur", inputs: [], enabled: true, sourceSampling: "decoded_temporal" }); },
      graph => { const node = graph.nodes.find(node => node.kind === "composite")!; node.matteInput = node.inputs[1]; node.matteMode = "alpha"; },
      graph => { graph.nodes.find(node => node.kind === "adjustment")!.affectedInputs = ["other"]; },
      graph => { graph.nodes = Array.from({ length: 16_385 }, (_, i): EngineNode => ({ id: `n${i}`, kind: "source", inputs: [], enabled: true })); },
    ];
    for (const change of cases) {
      const graph = fixture(); change(graph);
      assert.throws(() => prepareUnifiedLayerNativeProgramV1(graph));
      assert.equal(unifiedNativeLoadReceiptMatchesV1(graph, {}), false);
    }
  });
  it("keeps the legacy route explicit and does not reinterpret a user ID containing an old marker", () => {
    const graph = fixture(); graph.graphId = "project:layer-order-v1:word:r7";
    assert.equal(isUnifiedLayerNativeGraphV1(graph), false); assert.equal(prepareUnifiedLayerNativeProgramV1(graph), undefined);
    assert(unifiedNativeLoadReceiptMatchesV1(graph, {})); assert(unifiedNativeFrameReceiptMatchesV1(graph, 30, {}));
    assert.equal(unifiedNativeLoadReceiptMatchesV1(graph, { unifiedCompositeV1: {} }), false);
    assert.equal(unifiedNativeFrameReceiptMatchesV1(graph, 30, { unifiedCompositeExecutionV1: {} }), false);
  });
});
