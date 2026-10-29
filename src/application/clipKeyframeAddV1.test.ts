import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { animatedClipState, createEmptyProject, findClip, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { planAddClipKeyframeV1 } from "./clipKeyframeAddV1";

// BUG-13 (P8): ＋ 在目前時間加入 stored animatedClipState's output, which already includes the clip's expressions, and the
// expressions ran again on playback and export: an opacity expression `value * 0.5` played at 0.25 after a keyframe.
// Real domain commands and the real evaluator.
function project(): EditProject {
  const value = createEmptyProject("Keys", { id: "keys", fps: 30 });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 20, width: 1920, height: 1080 }];
  value.tracks[0].clips = [{ id: "C", assetId: "cam", trackId: "video-main", timelineStart: 2, sourceStart: 0, duration: 6, volume: 1,
    transform: { ...DEFAULT_TRANSFORM, scale: 1.2 }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} }];
  return validateProject(value);
}
const expressed = () => applyCommand(applyCommand(project(), { type: "set_clip_expression", clipId: "C", property: "opacity", expression: "hao.expression/v1:value * 0.5" }),
  { type: "set_clip_expression", clipId: "C", property: "x", expression: "hao.expression/v1:value + 100" });

describe("＋ keyframe stores the clip's own values, not the expression result", () => {
  it("an opacity expression value * 0.5 still plays at 0.5 after a keyframe (it played 0.25)", () => {
    const before = expressed();
    expect(animatedClipState(findClip(before, "C"), 1, before.fps).transform).toMatchObject({ opacity: 0.5, x: 100 });
    const plan = planAddClipKeyframeV1(findClip(before, "C"), 3, before.fps, "k1");
    expect(plan.command).toMatchObject({ type: "add_keyframe", clipId: "C", keyframe: { id: "k1", time: 1, easing: "linear" } });
    expect(plan.message).toBe("已在片段 1.00 秒加入關鍵幀。");
    // Stored: the authored values (opacity 1, x 0, scale 1.2), not the expression output.
    if (plan.command.type !== "add_keyframe") throw new Error("not a keyframe");
    expect(plan.command.keyframe.transform).toMatchObject({ opacity: 1, x: 0, scale: 1.2 });
    const after = applyCommand(before, plan.command);
    for (const time of [0, 1, 3, 6]) {
      expect(animatedClipState(findClip(after, "C"), time, after.fps).transform, `t=${time}`)
        .toMatchObject({ opacity: 0.5, x: 100, scale: 1.2 });
    }
  });

  it("inside an existing animation it stores the interpolated authored values", () => {
    let value = project();
    value = applyCommand(value, { type: "add_keyframe", clipId: "C", keyframe: { id: "k4", time: 4, transform: { ...DEFAULT_TRANSFORM, opacity: 0.2 }, color: { ...DEFAULT_COLOR }, easing: "linear" } });
    value = applyCommand(value, { type: "set_clip_expression", clipId: "C", property: "opacity", expression: "hao.expression/v1:value * 0.5" });
    const plan = planAddClipKeyframeV1(findClip(value, "C"), 4, value.fps, "k2");
    if (plan.command.type !== "add_keyframe") throw new Error("not a keyframe");
    // Halfway from 1 to 0.2 is 0.6 (the expression would have stored 0.3).
    expect(plan.command.keyframe.transform.opacity).toBeCloseTo(0.6, 6);
    const after = applyCommand(value, plan.command);
    expect(animatedClipState(findClip(after, "C"), 2, after.fps).transform.opacity).toBeCloseTo(0.3, 6);
  });

  it("keeps the playhead clamp and the plain clip without expressions unchanged", () => {
    const value = project(), clip = findClip(value, "C");
    const early = planAddClipKeyframeV1(clip, 0, value.fps, "a"), late = planAddClipKeyframeV1(clip, 30, value.fps, "b");
    if (early.command.type !== "add_keyframe" || late.command.type !== "add_keyframe") throw new Error("not a keyframe");
    expect([early.command.keyframe.time, late.command.keyframe.time]).toEqual([0, 6]);
    expect(early.command.keyframe.transform).toEqual(animatedClipState(clip, 0, value.fps).transform);
    expect(early.command.keyframe.color).toEqual(animatedClipState(clip, 0, value.fps).color);
  });
});
