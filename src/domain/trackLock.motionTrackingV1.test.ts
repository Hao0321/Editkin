import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { EditorCommand } from "./commands";
import type { MotionTrack } from "./types";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { dispatchCommandSafely, createHistory, undo, redo } from "./history";
import { projectSchema } from "./schema";
import { createClipMask } from "./masks";
import { TRACK_LOCKED_MESSAGE, lockedTrackRefusal } from "./trackLock";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";

function fixture() {
  const rect = { x: .2, y: .2, width: .2, height: .2 };
  const track: MotionTrack = { id: "subject", clipId: "clip-demo", name: "Subject", engine: "source-fixture", analysisFps: 5,
    initialRect: rect, points: [{ frame: 0, time: 0, rect, confidence: 1, status: "manual" }], lostRatio: 0, createdAt: "2026-10-20T00:00:00.000Z" };
  let project = applyCommand(createDemoProject(), { type: "add_motion_track", track });
  project = applyCommand(project, { type: "add_clip_mask", clipId: "clip-demo", mask: createClipMask("tracked-mask", "ellipse") });
  project = applyCommand(project, { type: "set_clip_mask_track", clipId: "clip-demo", maskId: "tracked-mask", trackId: track.id });
  project = applyCommand(project, { type: "add_motion_graphic", graphic: createMotionGraphic("tracked-tag", "tag", "Subject", 0, 2, track.id, legacyMotionGraphicSeed("tag")) });
  return { project, track };
}
function mutations(track: MotionTrack): EditorCommand[] {
  return [{ type: "add_motion_track", track: { ...structuredClone(track), id: "second" } },
    { type: "set_motion_track_point", trackId: track.id, point: { ...structuredClone(track.points[0]), rect: { x: .3, y: .3, width: .2, height: .2 } } },
    { type: "delete_motion_track", trackId: track.id }];
}
describe("canonical track locking applies to all tracking entrypoints", () => {
  it("refuses add/correct/delete on a locked track without mutating graph, bindings or history", () => {
    const f = fixture(), locked = applyCommand(f.project, { type: "toggle_track_lock", trackId: "video-main" }), history = createHistory(locked), before = JSON.stringify(locked);
    for (const command of mutations(f.track)) {
      assert.equal(lockedTrackRefusal(locked, command), TRACK_LOCKED_MESSAGE);
      const result = dispatchCommandSafely(history, command); assert.equal(result.error, TRACK_LOCKED_MESSAGE); assert.equal(result.state, history);
      assert.equal(JSON.stringify(locked), before);
    }
  });
  it("enforces locks inside batches and rolls back earlier batch work", () => {
    const f = fixture(), locked = applyCommand(f.project, { type: "toggle_track_lock", trackId: "video-main" }), history = createHistory(locked);
    for (const command of mutations(f.track)) {
      const result = dispatchCommandSafely(history, { type: "batch", commands: [{ type: "set_editorial_profile", profile: "podcast_on_camera" }, command] });
      assert.equal(result.error, TRACK_LOCKED_MESSAGE); assert.equal(result.state, history); assert.deepEqual(history.present, locked);
    }
  });
  it("preserves successful unlocked commands with one Undo/Redo and JSON roundtrip", () => {
    const f = fixture();
    for (const command of mutations(f.track)) {
      const result = dispatchCommandSafely(createHistory(f.project), command); assert.equal(result.error, undefined);
      assert.equal(result.state.past.length, 1); assert.deepEqual(undo(result.state).present, f.project);
      assert.deepEqual(redo(undo(result.state)).present, result.state.present);
      // Existing commands can explicitly clear optional fields to undefined; the wire codec omits them.
      const wire = JSON.parse(JSON.stringify(result.state.present));
      assert.deepEqual(JSON.parse(JSON.stringify(projectSchema.parse(wire))), wire);
    }
  });
  it("unlocked deletion keeps tracked tags and masks as editable static items", () => {
    const f = fixture(), next = applyCommand(f.project, { type: "delete_motion_track", trackId: f.track.id });
    assert.equal(next.motionTracks.length, 0); assert.equal(next.motionGraphics.length, 1); assert.equal(next.motionGraphics[0].trackId, undefined);
    const mask = next.tracks[0].clips[0].masks![0]; assert.equal(mask.trackId, undefined); assert.equal(mask.frozenRange, undefined);
    assert.deepEqual(mask.path, f.project.tracks[0].clips[0].masks![0].path);
  });
  it("defensively refuses deletion that would change a locked mask reference even in an invalid in-memory graph", () => {
    const f = fixture(), mask = structuredClone(f.project.tracks[0].clips[0].masks![0]);
    const project = { ...f.project, tracks: [...f.project.tracks, { id: "locked-consumer", name: "Locked", kind: "video" as const, locked: true, muted: false,
      clips: [{ ...structuredClone(f.project.tracks[0].clips[0]), id: "invalid-cross-clip-mask", trackId: "locked-consumer", masks: [mask] }] }] };
    // This is a detector negative, not a claim that cross-clip mask binding is supported by the schema.
    assert.equal(lockedTrackRefusal(project, { type: "delete_motion_track", trackId: f.track.id }), TRACK_LOCKED_MESSAGE);
  });
  it("keeps legacy non-tracking lock decisions and missing-track canonical errors", () => {
    const f = fixture(), locked = applyCommand(f.project, { type: "toggle_track_lock", trackId: "video-main" });
    assert.equal(lockedTrackRefusal(locked, { type: "set_clip_volume", clipId: "clip-demo", volume: .5 }), TRACK_LOCKED_MESSAGE);
    assert.equal(lockedTrackRefusal(locked, { type: "rename_track", trackId: "video-main", name: "Renamed" }), undefined);
    const result = dispatchCommandSafely(createHistory(locked), { type: "delete_motion_track", trackId: "missing" });
    assert(result.error?.includes("找不到追蹤資料"));
  });
});
