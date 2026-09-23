import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { animatedClipState, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { projectSchema } from "./schema";
import type { ClipKeyframe, KeyframeEasing, TimelineClip } from "./types";
import { sampleDepthOfFieldNode } from "../render/depthOfFieldAnimation";
import { sampleScene25dCameraNode } from "../render/scene25dCameraAnimation";
import type { EngineNode } from "../render/engineGraph";

const rates = [24, 30, 60, 24000 / 1001, 30000 / 1001, 60000 / 1001];
const point = (clip: TimelineClip, time: number, x: number, easing: KeyframeEasing = "hold"): ClipKeyframe => ({
  id: `point-${time}`, time, transform: { ...clip.transform, x }, color: { ...clip.color, brightness: x / 200 }, easing,
});

describe("authored clip keyframe boundaries", () => {
  it.each(rates)("preserves time zero and switches Hold on the authored frame at %s fps", fps => {
    const clip = createDemoProject().tracks[0].clips[0]; clip.duration = 6 / fps;
    clip.keyframes = [point(clip, 0, -24), point(clip, 2 / fps, 24), point(clip, 4 / fps, 0)];
    const before = JSON.stringify(clip);
    for (const frame of [-1, 0, 1, 2, 3, 4, 5, 6, 7]) {
      const x = frame < 2 ? -24 : frame < 4 ? 24 : 0;
      const state = animatedClipState(clip, frame / fps, fps);
      expect(state.transform.x, `frame ${frame}`).toBe(x);
      expect(state.color.brightness, `frame ${frame}`).toBe(x / 200);
    }
    expect(JSON.stringify(clip)).toBe(before);
  });

  it.each(["linear", "hold", "ease_in", "ease_out", "ease_in_out", "spring_soft"] as const)("lands exactly on authored values after %s", easing => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.keyframes = [point(clip, .1, 20, easing), point(clip, .2, 80)];
    expect(animatedClipState(clip, 0).transform.x).toBe(0);
    expect(animatedClipState(clip, .05).transform.x).toBeCloseTo(10, 8);
    expect(animatedClipState(clip, .1).transform).toEqual(clip.keyframes[0].transform);
    expect(animatedClipState(clip, .2).transform).toEqual(clip.keyframes[1].transform);
    expect(animatedClipState(clip, .2).color).toEqual(clip.keyframes[1].color);
  });

  it("distinguishes a real pre-boundary sample from floating subtraction noise", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.keyframes = [point(clip, .1, 20), point(clip, .3, 80)];
    expect(animatedClipState(clip, .3 - 1e-6).transform.x).toBe(20);
    expect(animatedClipState(clip, .7 - .4).transform.x).toBe(80);
  });

  it("applies expressions to the authored boundary value", () => {
    const clip = createDemoProject().tracks[0].clips[0];
    clip.keyframes = [point(clip, 0, 10), point(clip, .1, 40)];
    clip.expressions = { x: "hao.expression/v1: value + frame" };
    expect(animatedClipState(clip, 0, 30).transform.x).toBe(10);
    expect(animatedClipState(clip, .1, 30).transform.x).toBe(43);
  });

  it("keeps a zero keyframe editable through update, undo/redo and JSON reopen", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    let history = createHistory(project);
    history = dispatchCommand(history, { type: "add_keyframe", clipId: clip.id, keyframe: point(clip, 0, 24) });
    const added = history;
    history = dispatchCommand(history, { type: "update_keyframe", clipId: clip.id, keyframeId: "point-0", patch: { transform: { ...clip.transform, x: 48 } } });
    expect(animatedClipState(history.present.tracks[0].clips[0], 0).transform.x).toBe(48);
    history = undo(history);
    expect(animatedClipState(history.present.tracks[0].clips[0], 0).transform.x).toBe(24);
    history = redo(history);
    const reopened = validateProject(projectSchema.parse(JSON.parse(JSON.stringify(history.present))));
    expect(animatedClipState(reopened.tracks[0].clips[0], 0).transform.x).toBe(48);
    expect(added.present.tracks[0].clips[0].keyframes[0].transform.x).toBe(24);
    history = dispatchCommand(history, { type: "delete_keyframe", clipId: clip.id, keyframeId: "point-0" });
    expect(animatedClipState(history.present.tracks[0].clips[0], 0).transform.x).toBe(0);
  });

  it.each([NaN, Infinity, -.1])("rejects nonfinite/out-of-range keyframe time %s", time => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    clip.keyframes = [point(clip, time, 20)];
    expect(() => validateProject(project)).toThrow(/關鍵幀時間/);
  });

  it("rejects ambiguous duplicate times without mutating history", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    const first = dispatchCommand(createHistory(project), { type: "add_keyframe", clipId: clip.id, keyframe: point(clip, 0, 20) });
    const before = JSON.stringify(first);
    expect(() => dispatchCommand(first, { type: "add_keyframe", clipId: clip.id, keyframe: { ...point(clip, 0, 40), id: "other" } })).toThrow(/關鍵幀時間/);
    expect(JSON.stringify(first)).toBe(before);
  });

  it("samples a time-zero camera and focus point without dividing by zero", () => {
    const camera: EngineNode = { id: "camera", kind: "camera", enabled: true, inputs: [], position: [0, 0, 4], target: [0, 0, 0], verticalFovRadians: 1,
      keyframes: [{ frame: 0, position: [1, 2, 6], target: [0, 1, 0], verticalFovRadians: 1.2, easing: "hold" }] };
    expect(sampleScene25dCameraNode(camera, 0)).toMatchObject({ position: [1, 2, 6], target: [0, 1, 0], verticalFovRadians: 1.2 });
    const focus: EngineNode = { id: "focus", kind: "depth_of_field", enabled: true, inputs: [], focusDistance: 3, aperture: 2, maxBlurRadius: 8,
      keyframes: [{ frame: 0, focusDistance: 6, aperture: 4, maxBlurRadius: 12, easing: "hold" }] };
    expect(sampleDepthOfFieldNode(focus, 0)).toMatchObject({ focusDistance: 6, aperture: 4, maxBlurRadius: 12 });
  });
});
