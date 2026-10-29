import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createClipMask, resolveMaskPath } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { compileFixedTemplateWindowMaskV3, FIXED_TEMPLATE_WINDOW_V3_CONTRACT } from "./fixedTemplateWindowV3";

function fixture() {
  const project = parseProject(createEmptyProject("Fixed window geometry", { id: "window-v3", width: 160, height: 240, fps: 30 }));
  project.assets.push({ id: "source", name: "Synthetic metadata", kind: "video", uri: "D:/owned/window-source.mp4", duration: 4, width: 160, height: 240 });
  const clip: TimelineClip = { id: "main", assetId: "source", trackId: project.tracks[0].id, timelineStart: 3, sourceStart: 1, duration: 2, volume: .35,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layout: { crop: { x: .125, y: .125, width: .75, height: .75 }, viewport: { x: .2, y: .05, width: .6, height: .6 } } };
  clip.keyframes = [0, 1, 59/30].map((time, i) => ({ id: `pose-${i}`, time, transform: { ...DEFAULT_TRANSFORM, scale: i === 1 ? 2 : 1 }, color: { ...DEFAULT_COLOR }, easing: "linear" as const }));
  const mask = createClipMask("owned-window", "polygon");
  mask.feather = 0; mask.expansion = 0; mask.refine.chatterReduction = 0;
  mask.path = [{ id: "tl", x: .125, y: .125 }, { id: "tr", x: .875, y: .125 }, { id: "br", x: .875, y: .875 }, { id: "bl", x: .125, y: .875 }];
  clip.masks = [mask]; project.tracks[0].clips.push(clip);
  return { project, clip, mask };
}

describe("explicit fixed template window v3 frame compilation", () => {
  it("leaves the author graph untouched and emits every integer frame through both existing mask consumers and project reopen", () => {
    const { project, clip, mask } = fixture(), before = encodeProjectBytes(project);
    const fixed = compileFixedTemplateWindowMaskV3(project, clip, mask);
    expect(encodeProjectBytes(project)).toEqual(before);
    expect(fixed.keyframes).toHaveLength(60);
    clip.masks = [fixed];
    const reopened = decodeProjectBytes(encodeProjectBytes(project)), reopenedClip = reopened.tracks[0].clips[0], reopenedMask = reopenedClip.masks![0];
    const plan = compileClipAlphaPlan(reopened, reopenedClip), operation = plan.operations[0];
    expect(operation.source).toBe("vector");
    if (operation.source !== "vector") throw new Error("Expected compiled vector window");
    for (let frame = 0; frame < 60; frame++) {
      expect(fixed.keyframes[frame].frame).toBe(frame);
      expect(operation.samples[frame].time).toBe(frame/30);
      expect(operation.samples[frame].points).toEqual(fixed.keyframes[frame].points);
      expect(resolveMaskPath(reopened, reopenedClip, reopenedMask, frame/30).points).toEqual(fixed.keyframes[frame].points);
    }
  });

  it("keeps identity paths byte exact even when the viewport centre differs from the project centre", () => {
    const { project, clip, mask } = fixture(); clip.keyframes = [];
    const result = compileFixedTemplateWindowMaskV3(project, clip, mask);
    for (const frame of result.keyframes) expect(JSON.stringify(frame.points)).toBe(JSON.stringify(mask.path));
    expect(FIXED_TEMPLATE_WINDOW_V3_CONTRACT.defaultSelection).toBe(false);
    expect(FIXED_TEMPLATE_WINDOW_V3_CONTRACT.certification).toBe("ART_PENDING_CLAUDE");
  });

  it("compensates a real animated two-times push and returns to the exact initial boundary at the loop frame", () => {
    const { project, clip, mask } = fixture(), result = compileFixedTemplateWindowMaskV3(project, clip, mask);
    expect(result.keyframes[30].points).toEqual([{ id: "tl", x: .3125, y: .3125 }, { id: "tr", x: .6875, y: .3125 },
      { id: "br", x: .6875, y: .6875 }, { id: "bl", x: .3125, y: .6875 }]);
    expect(result.keyframes[59].points).toEqual(result.keyframes[0].points);
    expect({ sourceStart: clip.sourceStart, timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume }).toEqual({ sourceStart: 1, timelineStart: 3, duration: 2, volume: .35 });
  });

  it("uses viewport pixel translation and authored mirrors rather than a normalized full-canvas translation", () => {
    const { project, clip, mask } = fixture();
    Object.assign(clip.keyframes[1].transform, { x: 6, y: 3 }); clip.transform.flipX = true;
    const point = compileFixedTemplateWindowMaskV3(project, clip, mask).keyframes[30].points[0];
    expect(point).toEqual({ id: "tl", x: .7109375, y: .3046875 });
  });

  it("refuses source coverage loss instead of clamping the mask into a different silhouette", () => {
    const { project, clip, mask } = fixture(); clip.keyframes[1].transform.x = 300;
    const before = encodeProjectBytes(project);
    expect(() => compileFixedTemplateWindowMaskV3(project, clip, mask)).toThrow("固定影像窗超出素材可用範圍");
    expect(encodeProjectBytes(project)).toEqual(before);
  });

  it("refuses an already animated/tracked mask, parent transform, fractional window or singular transform", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.mask.trackId = "unresolved"; },
      (f: ReturnType<typeof fixture>) => { f.mask.keyframes = [{ frame: 0, time: 0, points: f.mask.path, confidence: 1, status: "manual" }]; },
      (f: ReturnType<typeof fixture>) => { f.clip.layer = { enabled: true, blendMode: "normal", role: "content", parentClipId: "unresolved" }; },
      (f: ReturnType<typeof fixture>) => { f.clip.duration = 2.001; },
      (f: ReturnType<typeof fixture>) => { f.clip.keyframes[0].transform.scale = 0; },
    ]) { const f = fixture(); mutate(f); expect(() => compileFixedTemplateWindowMaskV3(f.project, f.clip, f.mask)).toThrow(); }
  });
});
