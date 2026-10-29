import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import type { EditProject, TimelineTrack } from "../domain/types";
import { LAYER_TRACK_KIND_MISMATCH, LAYER_TRACK_LOCKED, planLayerTrackMoveV1 } from "./layerTrackReorderV1";

// P7 (2026-10-23): dragging a track in the 圖層 panel onto another track of its kind. Real domain commands and history.
function project(): EditProject {
  const value = createDemoProject();
  const base = value.tracks.find(track => track.kind === "video")!;
  const extra = (id: string): TimelineTrack => ({ id, name: id, kind: "video", locked: false, muted: false, clips: [] });
  value.tracks.splice(value.tracks.indexOf(base) + 1, 0, extra("v1"), extra("v2"), extra("v3"));
  return value;
}
const videoOrder = (value: EditProject) => value.tracks.filter(track => track.kind === "video").map(track => track.id);

describe("layer track drag reorder", () => {
  it("lets the dragged track take the target's place and shifts the tracks in between, as one Undo", () => {
    const value = project(), main = videoOrder(value)[0];
    expect(videoOrder(value)).toEqual([main, "v1", "v2", "v3"]);
    // The panel lists the top first (v3, v2, v1, main); dropping v3 onto v1 puts v3 where v1 was.
    const command = planLayerTrackMoveV1(value, "v3", "v1")!;
    expect(command).toEqual({ type: "reorder_tracks", trackIds: ["v3", "v1", "v2"] });
    const before = createHistory(value), after = dispatchCommand(before, command);
    expect(videoOrder(after.present)).toEqual([main, "v3", "v1", "v2"]);
    expect(after.past.length).toBe(before.past.length + 1);
    expect(undo(after).present).toEqual(value);
    // Other kinds keep their slots.
    expect(after.present.tracks.filter(track => track.kind !== "video").map(track => track.id)).toEqual(value.tracks.filter(track => track.kind !== "video").map(track => track.id));
  });
  it("moves a lower track up past several tracks the same way", () => {
    const value = project(), main = videoOrder(value)[0];
    const after = dispatchCommand(createHistory(value), planLayerTrackMoveV1(value, "v1", "v3")!);
    expect(videoOrder(after.present)).toEqual([main, "v2", "v3", "v1"]);
  });
  it("does nothing on itself, refuses another kind and any locked track it would move", () => {
    const value = project();
    expect(planLayerTrackMoveV1(value, "v2", "v2")).toBeUndefined();
    const audio = value.tracks.find(track => track.kind === "audio")!;
    expect(() => planLayerTrackMoveV1(value, "v2", audio.id)).toThrow(LAYER_TRACK_KIND_MISMATCH);
    value.tracks.find(track => track.id === "v2")!.locked = true;
    expect(() => planLayerTrackMoveV1(value, "v3", "v1")).toThrow(LAYER_TRACK_LOCKED);
    expect(planLayerTrackMoveV1(value, "v1", videoOrder(value)[0])).toEqual({ type: "reorder_tracks", trackIds: ["v1", videoOrder(value)[0]] });
    expect(() => planLayerTrackMoveV1(value, "missing", "v1")).toThrow(/已不存在/);
  });
});
