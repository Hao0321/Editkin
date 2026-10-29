import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { DEFAULT_PARTICLE_SIMULATION } from "../domain/types";
import { projectVisualLayersV1, type UnifiedLayerOrderV1 } from "../domain/unifiedLayerOrderV1";
import { buildEngineRenderGraph, type EngineRenderGraph } from "./engineGraph";
import { assertUnifiedEngineNodeIdentitiesV1 } from "./unifiedLayerGraphV1";

function fixture() {
  const project = createDemoProject();
  project.captions = [{ id: "caption-order", text: "Caption", start: 0, duration: 3 }];
  project.motionGraphics = [createMotionGraphic("graphic-order", "title", "Motion", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
  return project;
}
function drawOrder(graph: EngineRenderGraph): string[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const trace = (id: string): string[] => {
    const node = nodes.get(id)!;
    if (node.kind === "composite") return [...trace(node.inputs[0]), ...trace(node.inputs[1])];
    if (node.kind === "caption" || node.kind === "motion_graphic") return [node.id];
    if (node.kind === "source") return node.mediaKind === "generator" ? [] : [node.id];
    return node.inputs.length ? trace(node.inputs[0]) : [];
  };
  return trace(graph.outputNode);
}
describe("native mixed layer composition order", () => {
  it("changes actual graph composition order, retaining original source, transform, grade and audio nodes", () => {
    const project = fixture(), before = JSON.stringify(project), original = buildEngineRenderGraph(project);
    const order: UnifiedLayerOrderV1 = { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })).reverse() };
    const mixed = buildEngineRenderGraph(project, { unifiedLayerOrderV1: order });
    expect(drawOrder(original)).toEqual(["source:clip-demo", "caption:caption-order", "motion-graphic:graphic-order"]);
    expect(drawOrder(mixed)).toEqual(["motion-graphic:graphic-order", "caption:caption-order", "source:clip-demo"]);
    for (const node of original.nodes.filter(node => ["source", "transform2d", "color", "caption", "motion_graphic"].includes(node.kind))) {
      expect(mixed.nodes.find(candidate => candidate.id === node.id)).toEqual(node);
    }
    expect(mixed.audio).toEqual(original.audio);
    const forward = buildEngineRenderGraph(project, { unifiedLayerOrderV1: { ...order, layers: [...order.layers].reverse() } });
    expect(mixed.graphId).not.toBe(forward.graphId);
    expect(buildEngineRenderGraph(project, { unifiedLayerOrderV1: order }).graphId).toBe(mixed.graphId);
    expect(JSON.stringify(project)).toBe(before);
  });
  it("keeps simulation groups explicit rather than silently flattening their boundary", () => {
    const project = fixture();
    project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
    const order: UnifiedLayerOrderV1 = { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })) };
    expect(() => buildEngineRenderGraph(project, { unifiedLayerOrderV1: order })).toThrow("UNIFIED_LAYER_PARTICLE_GROUP_REQUIRED");
    expect(() => buildEngineRenderGraph(project)).not.toThrow();
  });
  it("rejects native node aliases even when their project identities are distinct", () => {
    const project = fixture(), first = project.tracks[0].clips[0];
    first.id = "alias one";
    project.tracks[0].clips.push({ ...structuredClone(first), id: "alias_one", timelineStart: 12 });
    const order: UnifiedLayerOrderV1 = { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })) };
    expect(() => buildEngineRenderGraph(project, { unifiedLayerOrderV1: order })).toThrow("UNIFIED_LAYER_ENGINE_NODE_ID_COLLISION");
  });
  it("reserves one output node within the native node capacity", () => {
    const nodes = Array.from({ length: 16_383 }, (_, index) => ({ id: `node-${index}`, inputs: [], enabled: true, kind: "source" }));
    expect(() => assertUnifiedEngineNodeIdentitiesV1(nodes)).not.toThrow();
    expect(() => assertUnifiedEngineNodeIdentitiesV1([...nodes, { ...nodes[0], id: "one-over-cap" }])).toThrow("UNIFIED_LAYER_ENGINE_NODE_CAPACITY");
  });
});
