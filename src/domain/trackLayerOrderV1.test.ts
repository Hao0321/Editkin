import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import { createHistory, dispatchCommand, undo, redo, dispatchCommandSafely } from "./history";
import { editorCommandSchema, projectSchema } from "./schema";
import { activeMediaLayers } from "../application/previewMedia";
import { buildRenderPlan } from "../render/planner";
import { adjacentTrackLayerCommandV1, reorderedTrackLayersV1 } from "./trackLayerOrderV1";

function fixture() {
  const initial = createDemoProject(), bottom = initial.tracks.find(track => track.kind === "video")!;
  const top = { ...structuredClone(bottom), id: "layer-order-top", name: "Top", clips: [
    { ...structuredClone(bottom.clips[0]), id: "layer-order-top-clip", trackId: "layer-order-top" },
  ] };
  return applyCommand(initial, { type: "add_track", track: top });
}
const order = (project: ReturnType<typeof fixture>) => project.tracks.filter(track => track.kind === "video").map(track => track.id);
describe("canonical track layer order", () => {
  it("uses the same changed order in history, preview, render plan and reopened JSON", () => {
    const project = fixture(), before = JSON.stringify(project), ids = order(project);
    const command = editorCommandSchema.parse(adjacentTrackLayerCommandV1(project, ids[0], "up"));
    const history = dispatchCommand(createHistory(project), command);
    expect(order(history.present)).toEqual(ids.toReversed());
    expect(activeMediaLayers(history.present, 0.1, {}, "video").map(layer => layer.clip.trackId)).toEqual(ids.toReversed());
    expect(buildRenderPlan(history.present, uri => uri).videoLayers.map(layer => layer.trackId)).toEqual(ids.toReversed());
    expect(order(projectSchema.parse(JSON.parse(JSON.stringify(history.present))))).toEqual(ids.toReversed());
    expect(order(undo(history).present)).toEqual(ids); expect(order(redo(undo(history)).present)).toEqual(ids.toReversed());
    expect(history.past).toHaveLength(1); expect(JSON.stringify(project)).toBe(before);
  });
  it("keeps unselected track slots and all clip data unchanged", () => {
    const project = fixture(), ids = order(project), reversed = reorderedTrackLayersV1(project, ids.toReversed());
    for (const track of project.tracks) expect(reversed.find(item => item.id === track.id)).toBe(track);
    for (const [index, track] of project.tracks.entries()) if (!ids.includes(track.id)) expect(reversed[index]).toBe(track);
  });
  it("refuses missing, duplicate, empty and mixed-kind identities before mutation", () => {
    const project = fixture(), ids = order(project), before = JSON.stringify(project);
    const audio = project.tracks.find(track => track.kind === "audio")!;
    for (const invalid of [[], [ids[0], ids[0]], [ids[0], "missing"], [ids[0], audio.id]]) expect(() => reorderedTrackLayersV1(project, invalid)).toThrow();
    expect(JSON.stringify(project)).toBe(before);
  });
  it("refuses locked layers and disables moving past a boundary", () => {
    const project = fixture(), ids = order(project);
    expect(adjacentTrackLayerCommandV1(project, ids[0], "down")).toBeUndefined();
    expect(adjacentTrackLayerCommandV1(project, ids[1], "up")).toBeUndefined();
    project.tracks.find(track => track.id === ids[1])!.locked = true;
    expect(adjacentTrackLayerCommandV1(project, ids[0], "up")).toBeUndefined();
    expect(() => reorderedTrackLayersV1(project, ids.toReversed())).toThrow("圖層已鎖定");
  });
  it("a failed reorder inside a batch leaves history and the original project intact", () => {
    const project = fixture(), history = createHistory(project), ids = order(project), before = JSON.stringify(history);
    const result = dispatchCommandSafely(history, { type: "batch", commands: [
      { type: "reorder_tracks", trackIds: ids.toReversed() }, { type: "reorder_tracks", trackIds: [ids[0], "missing"] },
    ] });
    expect(result.state).toBe(history); expect(result.error).toBeTruthy(); expect(JSON.stringify(history)).toBe(before);
  });
  it("strictly rejects an injected reorder field", () => {
    const project = fixture(), ids = order(project);
    expect(editorCommandSchema.safeParse({ type: "reorder_tracks", trackIds: ids, injected: true }).success).toBe(false);
  });
});
