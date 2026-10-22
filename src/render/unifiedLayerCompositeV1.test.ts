import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { projectVisualLayersV1 } from "../domain/unifiedLayerOrderV1";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { buildRenderPlan } from "./planner";
import { assertUnifiedLayerCompositeProfileV1, buildUnifiedLayerCompositeOperationsV1 } from "./unifiedLayerCompositeV1";
import { buildEngineRenderGraph } from "./engineGraph";

function fixture() {
  const project = createDemoProject();
  project.captions = [{ id: "cue-composite21", text: "Caption", start: 0, duration: 3 }];
  project.motionGraphics = [createMotionGraphic("graphic-composite21", "title", "Motion", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
  return project;
}
function ordered() {
  const project = fixture();
  return applyCommand(project, { type: "set_unified_layer_order", expected: { projectId: project.id, revision: project.revision, updatedAt: project.updatedAt },
    order: { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })).reverse() } });
}
describe("saved order formal composite sequence", () => {
  it("interleaves actual Motion/caption/media operations without rewriting leaf drawing data", () => {
    const project = ordered(), before = JSON.stringify(project), plan = buildRenderPlan(project, uri => uri);
    const operations = buildUnifiedLayerCompositeOperationsV1(project, plan)!;
    expect(operations.map(op => op.kind === "clip" ? op.segment.clip.id : op.refs.map(ref => ref.id).join(","))).toEqual(["graphic-composite21", "cue-composite21", "clip-demo"]);
    expect(operations[0].kind === "ass" && operations[0].project.motionGraphics[0]).toBe(project.motionGraphics[0]);
    expect(JSON.stringify(project)).toBe(before);
  });
  it("retains the exact no-order route and refuses missing render-plan identities or stale ASS content", () => {
    const legacy = fixture();
    expect(buildUnifiedLayerCompositeOperationsV1(legacy, buildRenderPlan(legacy, uri => uri))).toBeUndefined();
    const project = ordered(), plan = buildRenderPlan(project, uri => uri);
    expect(() => buildUnifiedLayerCompositeOperationsV1(project, { ...plan, videoLayers: [] })).toThrow("UNIFIED_LAYER_RENDER_PLAN_IDENTITIES_INVALID");
    const changed = structuredClone(project); changed.captions[0].text = "Stale";
    expect(() => buildUnifiedLayerCompositeOperationsV1(project, plan, changed)).toThrow("UNIFIED_LAYER_ASS_SCOPE_MISMATCH");
    expect(() => assertUnifiedLayerCompositeProfileV1(project, true)).toThrow();
  });
  it("requires the explicit original global ASS clock for a rebased chunk", () => {
    const global = ordered(), local = structuredClone(global);
    for (const caption of global.captions) caption.start += 12;
    for (const graphic of global.motionGraphics) graphic.timelineStart += 12;
    const plan = buildRenderPlan(local, uri => uri);
    expect(() => buildUnifiedLayerCompositeOperationsV1(local, plan, global)).toThrow("UNIFIED_LAYER_ASS_SCOPE_MISMATCH");
    expect(buildUnifiedLayerCompositeOperationsV1(local, plan, global, 360)).toBeDefined();
  });
  it("applies a bottom layer's track matte against the transparent native working canvas", () => {
    const project = fixture(), clip = project.tracks[0].clips[0];
    project.tracks.push({ id: "matte-track21", name: "Matte", kind: "video", locked: false, muted: false,
      clips: [{ ...structuredClone(clip), id: "matte-source21", trackId: "matte-track21" }] });
    clip.layer = { enabled: true, blendMode: "normal", ...clip.layer, trackMatte: { sourceClipId: "matte-source21", mode: "alpha" } };
    const graph = buildEngineRenderGraph(project, { unifiedLayerOrderV1: { schema: "editkin.unified-layer-order/v1",
      layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })) } });
    const matte = graph.nodes.find(node => node.kind === "composite" && node.matteInput);
    expect(matte?.inputs[0]).toBe("source:transparent");
    expect(matte?.matteMode).toBe("alpha");
  });
});
