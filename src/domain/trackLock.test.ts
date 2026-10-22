import { describe, expect, it } from "vitest";
import { applyCommand, type EditorCommand } from "./commands";
import { createEmptyProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommandSafely } from "./history";
import { lockedTrackRefusal, TRACK_LOCKED_MESSAGE } from "./trackLock";
import { createClipMask } from "./masks";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "./types";

// Track lock is enforced in the domain (applyCommand), so the editor's gestures, the Inspector, B/切開 and an agent's
// apply_edit_commands all meet the same refusal; nothing changes and the history keeps no step.
function clip(id: string, trackId: string, timelineStart: number, duration: number, sourceStart = 0): TimelineClip {
  return { id, assetId: "cam", trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [{ id: `${id}-key`, time: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, easing: "linear" }],
    layer: { ...DEFAULT_CLIP_LAYER } };
}
function project(locked = true): EditProject {
  const value = createEmptyProject("Lock", { id: "lock", width: 1920, height: 1080, fps: 30 });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 60, width: 1920, height: 1080 }];
  value.tracks[0].clips = [clip("A", "video-main", 0, 4), clip("B", "video-main", 4, 4, 10)];
  value.tracks.push({ id: "open", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [clip("O", "open", 0, 4, 20)] });
  value.tracks[0].locked = locked;
  return validateProject(value);
}
function refused(base: EditProject, command: EditorCommand) {
  const result = dispatchCommandSafely(createHistory(base), command);
  return { error: result.error, unchanged: result.state.present === base && result.state.past.length === 0 };
}

describe("a locked track refuses every change to its items, in plain words", () => {
  const edits: Array<[string, EditorCommand]> = [
    ["split (B and 切開)", { type: "split_clip", clipId: "A", at: 2, newClipId: "A-tail" }],
    ["保留後面 / trim start", { type: "trim_clip_start", clipId: "A", seconds: 1 }],
    ["保留前面 / trim end", { type: "trim_clip_end", clipId: "A", seconds: 1 }],
    ["delete (lift)", { type: "delete_clip", clipId: "A" }],
    ["ripple delete", { type: "ripple_delete_clip", clipId: "A" }],
    ["move", { type: "move_clip", clipId: "B", timelineStart: 9 }],
    ["move to another track", { type: "move_clip_to_track", clipId: "A", trackId: "open", timelineStart: 9 }],
    ["move onto the locked track", { type: "move_clip_to_track", clipId: "O", trackId: "video-main", timelineStart: 9 }],
    ["add a clip to it", { type: "add_clip", clip: clip("new", "video-main", 9, 1, 30) }],
    ["compact it", { type: "compact_track", trackId: "video-main" }],
    ["transform", { type: "update_clip_transform", clipId: "A", patch: { scale: 1.2 } }],
    ["colour", { type: "set_clip_color", clipId: "A", patch: { brightness: 0.1 } }],
    ["look / transitions", { type: "set_clip_creative", clipId: "A", patch: { effectPresetIds: [] } }],
    ["layout / crop", { type: "set_clip_layout", clipId: "A", layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } } }],
    ["add a keyframe", { type: "add_keyframe", clipId: "A", keyframe: { id: "k2", time: 2, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, easing: "linear" } }],
    ["change a keyframe", { type: "update_keyframe", clipId: "A", keyframeId: "A-key", patch: { time: 2 } }],
    ["delete a keyframe", { type: "delete_keyframe", clipId: "A", keyframeId: "A-key" }],
    ["mask", { type: "add_clip_mask", clipId: "A", mask: createClipMask("mask-1", "rectangle") }],
    ["layer", { type: "set_clip_layer", clipId: "A", patch: { blendMode: "screen" } }],
    ["expression", { type: "set_clip_expression", clipId: "A", property: "opacity", expression: null }],
    ["volume", { type: "set_clip_volume", clipId: "A", volume: 0.5 }],
    ["3D transform", { type: "update_clip_transform_3d", clipId: "A", patch: {} }],
    ["floating frame", { type: "set_clip_floating_frame", clipId: "A" }],
    ["chroma key", { type: "set_clip_chroma_key", clipId: "A" }],
  ];
  it.each(edits)("%s", (_name, command) => {
    expect(refused(project(), command)).toEqual({ error: TRACK_LOCKED_MESSAGE, unchanged: true });
  });

  it("inside a batch, each command meets the lock as the commands before it left the track", () => {
    const base = project();
    expect(refused(base, { type: "batch", commands: [{ type: "set_clip_volume", clipId: "O", volume: 0.5 }, { type: "split_clip", clipId: "A", at: 2, newClipId: "A-tail" }] }).error)
      .toBe(TRACK_LOCKED_MESSAGE);
    const unlocked = applyCommand(base, { type: "batch", commands: [{ type: "toggle_track_lock", trackId: "video-main" }, { type: "split_clip", clipId: "A", at: 2, newClipId: "A-tail" }] });
    expect(unlocked.tracks[0].clips.map(item => item.id)).toEqual(["A", "A-tail", "B"]);
  });

  it("locking, unlocking, muting, hiding and renaming the track stay allowed, and unlocked tracks are untouched by the rule", () => {
    let value = project();
    for (const command of [{ type: "toggle_track_mute", trackId: "video-main" }, { type: "toggle_track_hidden", trackId: "video-main" },
      { type: "rename_track", trackId: "video-main", name: "主畫面（鎖）" }, { type: "toggle_track_lock", trackId: "video-main" }] as EditorCommand[]) {
      value = applyCommand(value, command);
    }
    expect(value.tracks[0]).toMatchObject({ locked: false, muted: true, hidden: true, name: "主畫面（鎖）" });
    expect(applyCommand(project(), { type: "split_clip", clipId: "O", at: 2, newClipId: "O-tail" }).tracks.find(track => track.id === "open")!.clips).toHaveLength(2);
  });

  it("captions on a locked 字幕 track stay as they are", () => {
    const base = applyCommand(project(false), { type: "add_caption", caption: { id: "c1", text: "你好", start: 1, duration: 1 } });
    const locked = applyCommand(base, { type: "toggle_track_lock", trackId: "caption-main" });
    for (const command of [{ type: "update_caption", captionId: "c1", patch: { start: 2 } }, { type: "delete_caption", captionId: "c1" },
      { type: "add_caption", caption: { id: "c2", text: "再見", start: 3, duration: 1 } }] as EditorCommand[]) {
      expect(refused(locked, command).error).toBe(TRACK_LOCKED_MESSAGE);
    }
  });

  it("extend and slip keep their own, more specific lock words", () => {
    expect(refused(project(), { type: "extend_clip", clipId: "B", edge: "end", seconds: 1 }).error).toMatch(/軌道已鎖定.*延長片段/);
    expect(refused(project(), { type: "slip_clip", clipId: "B", sourceStart: 12 }).error).toMatch(/軌道已鎖定.*換入點/);
  });

  it("names nothing for commands that do not touch a locked track's items", () => {
    const base = project();
    expect(lockedTrackRefusal(base, { type: "set_clip_volume", clipId: "O", volume: 0.2 })).toBeUndefined();
    expect(lockedTrackRefusal(base, { type: "toggle_track_lock", trackId: "video-main" })).toBeUndefined();
    expect(lockedTrackRefusal(base, { type: "set_clip_volume", clipId: "missing", volume: 0.2 })).toBeUndefined();
  });
});
