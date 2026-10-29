import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import { createHistory, dispatchCommand, undo, redo } from "./history";
import { projectSchema, editorCommandSchema } from "./schema";
import { parseProject } from "../application/projectCodec";
import { projectFromComposition } from "./projectComposition";
import { projectVisualLayersV1 } from "./unifiedLayerOrderV1";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import type { EditProject } from "./types";
import type { EditorCommand } from "./commandTypes";

function fixture() {
  const project = createDemoProject();
  project.captions = [{ id: "caption-order20", text: "Caption", start: 0, duration: 3 }];
  project.motionGraphics = [createMotionGraphic("graphic-order20", "title", "Motion", 0, 3, undefined, legacyMotionGraphicSeed("title"))];
  return project;
}
function setOrder(project: EditProject, layers = projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id })).reverse()): Extract<EditorCommand, { type: "set_unified_layer_order" }> {
  return { type: "set_unified_layer_order", expected: { projectId: project.id, revision: project.revision, updatedAt: project.updatedAt },
    order: { schema: "editkin.unified-layer-order/v1", layers } };
}
describe("saved unified layer edits", () => {
  it("uses real history, strict schema and updatedAt to reject stale in-memory edits", () => {
    const project = fixture(), original = JSON.stringify(project), command = setOrder(project);
    const history = dispatchCommand(createHistory(project), editorCommandSchema.parse(command));
    expect(history.present.schemaVersion).toBe(11);
    expect(() => parseProject({ ...history.present, schemaVersion: 10 })).toThrow("UNIFIED_LAYER_ORDER_REQUIRES_SCHEMA11");
    expect(projectSchema.safeParse({ ...history.present, schemaVersion: 10 }).success).toBe(false);
    expect(projectSchema.parse(history.present).unifiedLayerOrderV1).toEqual(command.order);
    expect(undo(history).present).toEqual(project);
    expect(redo(undo(history)).present).toEqual(history.present);
    expect(() => applyCommand(history.present, command)).toThrow("UNIFIED_LAYER_EDIT_STALE");
    expect(history.present.revision).toBe(project.revision);
    expect(JSON.stringify(project)).toBe(original);
  });
  it("keeps split descendants at the original depth and removes deleted caption identities", () => {
    const project = fixture(), ordered = applyCommand(project, setOrder(project));
    const split = applyCommand(ordered, { type: "split_clip", clipId: "clip-demo", at: 6, newClipId: "right20" });
    expect(split.unifiedLayerOrderV1!.layers.map(ref => ref.id)).toEqual(["graphic-order20", "caption-order20", "clip-demo", "right20"]);
    const removed = applyCommand(split, { type: "delete_caption", captionId: "caption-order20" });
    expect(projectSchema.parse(removed).unifiedLayerOrderV1!.layers.map(ref => ref.id)).toEqual(["graphic-order20", "clip-demo", "right20"]);
    expect(ordered.unifiedLayerOrderV1!.layers.map(ref => ref.id)).toEqual(["graphic-order20", "caption-order20", "clip-demo"]);
  });
  it("reconciles the optimized add-track/add-clip batch without modifying input metadata", () => {
    const project = fixture(), ordered = applyCommand(project, setOrder(project)), before = JSON.stringify(ordered);
    const next = applyCommand(ordered, { type: "batch", commands: [
      { type: "add_track", track: { id: "upper-track20", name: "Upper", kind: "video", locked: false, muted: false, clips: [] } },
      { type: "add_clip", clip: { ...structuredClone(ordered.tracks[0].clips[0]), id: "upper20", trackId: "upper-track20" } },
    ] });
    expect(projectSchema.parse(next).unifiedLayerOrderV1!.layers.at(-1)).toEqual({ kind: "clip", id: "upper20" });
    expect(JSON.stringify(ordered)).toBe(before);
  });
  it("allows a reordered layer to be locked, parsed and later reopened", () => {
    const project = fixture(), ordered = applyCommand(project, setOrder(project));
    const locked = applyCommand(ordered, { type: "toggle_track_lock", trackId: "video-main" });
    expect(projectSchema.parse(locked).unifiedLayerOrderV1).toEqual(ordered.unifiedLayerOrderV1);
    expect(() => applyCommand(locked, setOrder(locked, projectVisualLayersV1(locked).map(({ kind, id }) => ({ kind, id }))))).toThrow("UNIFIED_LAYER_TRACK_LOCKED");
  });
  it("stores a contiguous precomposition's internal order and refuses a scattered group atomically", () => {
    const project = fixture(), first = project.tracks[0].clips[0];
    project.tracks.push({ id: "upper-track20", name: "Upper", kind: "video", locked: false, muted: false, clips: [{ ...structuredClone(first), id: "upper20", trackId: "upper-track20" }] });
    const refs = projectVisualLayersV1(project).map(({ kind, id }) => ({ kind, id }));
    const ordered = applyCommand(project, setOrder(project, [refs[3], refs[2], refs[0], refs[1]]));
    const command: EditorCommand = { type: "precompose_clips", compositionId: "compound20", assetId: "compound-asset20", replacementClipId: "compound-clip20", targetTrackId: "video-main", name: "Compound", clipIds: [first.id, "upper20"] };
    const nested = applyCommand(ordered, command);
    expect(nested.unifiedLayerOrderV1!.layers.map(ref => ref.id)).toEqual(["graphic-order20", "caption-order20", "compound-clip20"]);
    expect(projectFromComposition(nested, nested.compositions[0]).unifiedLayerOrderV1!.layers.map(ref => ref.id)).toEqual(["clip-demo", "upper20"]);
    const scattered = applyCommand(project, setOrder(project, [refs[0], refs[2], refs[1], refs[3]])), before = JSON.stringify(scattered);
    expect(() => applyCommand(scattered, command)).toThrow("UNIFIED_LAYER_PRECOMPOSE_GROUP_NOT_CONTIGUOUS");
    expect(JSON.stringify(scattered)).toBe(before);
  });
});
