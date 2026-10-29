import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, findClip, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_PIP_LAYOUT } from "./appDefaults";
import { planPictureInPictureV1 } from "./pictureInPicturePlanV1";

// BUG-12 (P8): 畫中畫 sent set_clip_layer { blendMode: "normal" }, silently undoing a blend the creator had chosen.
// The plan is App's makeSelectedPictureInPicture; real domain commands.
function clip(id: string, trackId: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "cam", trackId, timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
function project(): EditProject {
  const value = createEmptyProject("PiP", { id: "pip", fps: 30 });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 20, width: 1920, height: 1080 }];
  value.tracks[0].clips = [clip("BG", "video-main", 0, 6)];
  value.tracks.push({ id: "overlay", name: "畫面 2", kind: "video", locked: false, muted: false, clips: [clip("TOP", "overlay", 1, 3)] });
  return validateProject(value);
}

describe("making a picture-in-picture keeps the clip's blend mode", () => {
  it.each(["multiply", "screen", "normal"] as const)("keeps %s and the rest of the layer, and still switches the clip on", blendMode => {
    let value = applyCommand(project(), { type: "set_clip_layer", clipId: "TOP", patch: { blendMode, enabled: false } });
    let next = 0;
    const plan = planPictureInPictureV1(value, findClip(value, "TOP"), DEFAULT_PIP_LAYOUT, () => `pip-track-${++next}`);
    expect(plan.hasBackground).toBe(true);
    expect(JSON.stringify(plan.commands)).not.toContain("blendMode");
    value = applyCommand(value, { type: "batch", commands: plan.commands });
    const moved = findClip(value, "TOP");
    expect(moved.layer).toMatchObject({ blendMode, enabled: true });
    expect(moved.layout).toEqual(DEFAULT_PIP_LAYOUT);
    expect(value.tracks.find(track => track.clips.some(item => item.id === "TOP"))).toMatchObject({ id: "pip-track-1", name: "畫中畫 1", kind: "video" });
    expect(moved.timelineStart).toBe(1);
  });

  it("reuses an existing 畫中畫 track and says when nothing plays underneath", () => {
    const value = project();
    value.tracks.push({ id: "pip-a", name: "畫中畫 1", kind: "video", locked: false, muted: false, clips: [] });
    value.tracks[0].clips = [];
    const plan = planPictureInPictureV1(validateProject(value), findClip(value, "TOP"), DEFAULT_PIP_LAYOUT, () => { throw new Error("no new track"); });
    expect(plan.hasBackground).toBe(false);
    expect(plan.commands.map(command => command.type)).toEqual(["move_clip_to_track", "set_clip_layout", "set_clip_layer"]);
    expect(plan.commands[0]).toMatchObject({ trackId: "pip-a", timelineStart: 1 });
  });
});
