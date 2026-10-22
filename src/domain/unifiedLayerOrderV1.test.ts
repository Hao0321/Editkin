import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { projectVisualLayersV1, resolveUnifiedLayerOrderV1, type UnifiedLayerOrderV1 } from "./unifiedLayerOrderV1";

function fixture() {
  const project = createDemoProject();
  project.captions = [{ id: "caption-order", text: "Caption", start: 0, duration: 3 }];
  project.motionGraphics = [createMotionGraphic("graphic-order", "title", "Motion", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
  return project;
}
function order(project: ReturnType<typeof fixture>): UnifiedLayerOrderV1 {
  return { schema: "editkin.unified-layer-order/v1", layers: projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })).reverse() };
}
describe("unified visual layer order v1", () => {
  it("resolves a complete mixed order using actual project objects without changing tracks or audio", () => {
    const project = fixture(), original = JSON.stringify(project);
    const resolved = resolveUnifiedLayerOrderV1(project, order(project));
    expect(resolved.map(ref => ref.kind)).toEqual(["graphic", "caption", "clip"]);
    expect(resolved[0]).toMatchObject({ graphic: project.motionGraphics[0] });
    expect(resolved[0].kind === "graphic" && resolved[0].graphic).toBe(project.motionGraphics[0]);
    expect(resolved[2].kind === "clip" && resolved[2].clip).toBe(project.tracks[0].clips[0]);
    expect(JSON.stringify(project)).toBe(original);
  });
  it("rejects partial, duplicate, missing, injected and malformed identities", () => {
    const project = fixture(), valid = order(project), before = JSON.stringify(project);
    const invalid: unknown[] = [null, { ...valid, extra: true }, { ...valid, layers: valid.layers.slice(1) },
      { ...valid, layers: [valid.layers[0], valid.layers[0], valid.layers[2]] },
      { ...valid, layers: [{ kind: "graphic", id: "missing" }, ...valid.layers.slice(1)] },
      { ...valid, layers: [{ ...valid.layers[0], extra: true }, ...valid.layers.slice(1)] },
      { ...valid, layers: [{ kind: "audio", id: "sound" }, ...valid.layers.slice(1)] }];
    for (const candidate of invalid) expect(() => resolveUnifiedLayerOrderV1(project, candidate as UnifiedLayerOrderV1)).toThrow(/UNIFIED_LAYER_/);
    expect(JSON.stringify(project)).toBe(before);
  });
  it("keeps locked clips and template-owned caption/graphic positions protected", () => {
    const project = fixture();
    project.tracks[0].locked = true;
    expect(() => resolveUnifiedLayerOrderV1(project, order(project))).toThrow("UNIFIED_LAYER_TRACK_LOCKED");
    project.tracks[0].locked = false;
    const owner = { schema: "editkin.template-element-owner/v1" as const, sessionId: "owner-session", templateId: "owner-template", format: "short" as const, role: "title" };
    project.motionGraphics[0].templateOwner = owner;
    expect(() => resolveUnifiedLayerOrderV1(project, order(project))).toThrow("UNIFIED_LAYER_OWNER_GROUP_REQUIRED");
    project.motionGraphics[0].templateOwner = undefined;
    project.captions[0].templateOwner = owner;
    const requested = order(project);
    expect(() => resolveUnifiedLayerOrderV1(project, { ...requested, layers: [requested.layers[1], requested.layers[0], requested.layers[2]] })).toThrow("UNIFIED_LAYER_OWNER_GROUP_REQUIRED");
  });
  it("protects a clip the movie template generated, but not one it only restyled", () => {
    const project = fixture(), clipId = project.tracks[0].clips[0].id;
    const snapshot = { editorialProfile: project.editorialProfile, aestheticSystem: null, captionStyle: structuredClone(project.captionStyle),
      clips: [{ clipId, creativePresent: true, lookPresetId: null, effectPresetIds: [], transitionIn: null, transitionOut: null }] };
    project.templateApplication = { schema: "editkin.template-application/v1", sessionId: "template-session", templateId: "movie-template",
      templateName: "Owned movie", format: "long", createdAt: "2026-10-22T00:00:00Z", before: structuredClone(snapshot), applied: structuredClone(snapshot) };
    expect(resolveUnifiedLayerOrderV1(project, order(project)).map(ref => ref.kind)).toEqual(["graphic", "caption", "clip"]);
    project.templateApplication.generatedClips = [{ clipId, trackId: project.tracks[0].id }];
    expect(() => resolveUnifiedLayerOrderV1(project, order(project))).toThrow("UNIFIED_LAYER_OWNER_GROUP_REQUIRED");
    const requested = order(project);
    // The generated clip keeps its slot; the user's own caption and graphic still reorder around it.
    expect(resolveUnifiedLayerOrderV1(project, { ...requested, layers: [requested.layers[2], requested.layers[0], requested.layers[1]] })
      .map(ref => ref.kind)).toEqual(["clip", "graphic", "caption"]);
  });
});
