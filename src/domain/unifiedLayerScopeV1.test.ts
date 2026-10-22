import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import { projectVisualLayersV1 } from "./unifiedLayerOrderV1";
import { createUnifiedLayerScopeProjectorV1 } from "./unifiedLayerScopeV1";
import { createLongSubProjectIndexV1 } from "../render/longSubProjectV1";
import { projectSchema } from "./schema";

describe("long window saved layer order", () => {
  it("projects complete saved depth into actual local/global ASS windows and preserves input", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    project.tracks[0].clips.push({ ...structuredClone(clip), id: "later-scope21", timelineStart: 12 });
    project.captions = [{ id: "early-cue21", text: "Early", start: 1, duration: 2 }, { id: "later-cue21", text: "Later", start: 13, duration: 2 }];
    const ordered = applyCommand(project, { type: "set_unified_layer_order", expected: { projectId: project.id, revision: project.revision, updatedAt: project.updatedAt },
      order: { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })).reverse() } });
    const before = JSON.stringify(ordered), index = createLongSubProjectIndexV1(ordered);
    const result = index({ startFrame: 360, frameCount: 360, preRollFrames: 0, ramEstimateBytes: 0 });
    expect(result.project.unifiedLayerOrderV1!.layers.map(ref => ref.id)).toEqual(["later-cue21", "later-scope21"]);
    expect(result.assProject.unifiedLayerOrderV1).toEqual(result.project.unifiedLayerOrderV1);
    expect(result.project.captions[0].start).toBe(1); expect(result.assProject.captions[0].start).toBe(13);
    expect(projectSchema.safeParse(result.project).success).toBe(true);
    expect(JSON.stringify(ordered)).toBe(before);
    const bad = structuredClone(result.project); bad.captions[0].id = "injected";
    expect(() => createUnifiedLayerScopeProjectorV1(ordered)(bad)).toThrow("UNIFIED_LAYER_SCOPE_IDENTITIES_INVALID");
  });
});
