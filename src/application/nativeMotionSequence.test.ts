import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { prepareNativeMotionSequence, type NativeMotionSection } from "./nativeMotionSequence";
import { prepareNativeReelScene } from "./nativeReelScenes";
import { applyCommand } from "../domain/commands";
import { parseProject } from "./projectFiles";

function fixture() {
  const project = createDemoProject(); project.width = 1920; project.height = 1080;
  project.assets[0].duration = 120; project.tracks[0].clips[0].duration = 120;
  return parseProject(project);
}
function section(project = fixture()): NativeMotionSection {
  return { id: "brief-cue", role: "chapter", treatment: "context_label", startFrame: 0, durationFrames: 75,
    title: "先看操作", clipId: project.tracks[0].clips[0].id, labelBox: { x: .6, y: .25, width: .2 },
    evidenceRefs: ["source:observed-empty-region"] };
}
describe("native long-form emphasis over continuous footage", () => {
  it("keeps every source clip, cut, transform and audio parameter unchanged and returns to clean footage", () => {
    const project = fixture(), original = structuredClone(project); let i = 0;
    const plan = prepareNativeMotionSequence(project, [section(project), { ...section(project), id: "later-cue", startFrame: 1800 }], p => `${p}-${i++}`);
    expect(project).toEqual(original);
    expect(plan.schema).toBe("editkin.native-motion-sequence/v2");
    expect(plan.holds).toEqual([{ startFrame: 75, endFrame: 1800, treatment: "clean_hold" }, { startFrame: 1875, endFrame: 3600, treatment: "clean_hold" }]);
    const applied = applyCommand(project, { type: "batch", commands: plan.commands });
    expect(applied.tracks).toEqual(project.tracks);
    expect(plan.commands.every(command => command.type === "add_motion_graphic")).toBe(true);
    expect(applied.motionGraphics).toHaveLength(4);
    expect(applied.motionGraphics.every(g => !g.vectorV2 || g.vectorV2.kind === "rule")).toBe(true);
    expect(applied.motionGraphics.every(g => g.backgroundColor === "#00000000")).toBe(true);
    expect(plan.editorialGraphics.every(g => g.presetVariant?.basePresetSha256.length === 64)).toBe(true);
    expect(() => prepareNativeMotionSequence(project, [section(project), { ...section(project), id: "collision", startFrame: 120 }], p => p)).toThrow(/安靜/);
    expect(() => prepareNativeMotionSequence({ ...project, tracks: [{ ...project.tracks[0], clips: [{ ...project.tracks[0].clips[0], duration: 8 }] }] }, [section(project)], p => p)).toThrow(/四分之一/);
  });
  it("requires an observed focus region and rejects text occlusion, missing sources and whole slide recipes", () => {
    const project = fixture(); let i = 0;
    const focus: NativeMotionSection = { ...section(project), treatment: "focus_hint", focusRegion: { x: .35, y: .25, width: .18, height: .5 } };
    const plan = prepareNativeMotionSequence(project, [focus], p => `${p}-${i++}`);
    expect(plan.scenes[0].layouts[1].box).toMatchObject({ x: 672, y: 810, width: 345.6, height: 2 });
    expect(() => prepareNativeMotionSequence(project, [{ ...focus, focusRegion: undefined }], p => p)).toThrow(/明確觀察/);
    expect(() => prepareNativeMotionSequence(project, [{ ...focus, labelBox: { x: .35, y: .3, width: .18 } }], p => p)).toThrow(/遮擋焦點/);
    expect(() => prepareNativeMotionSequence(project, [{ ...focus, clipId: "missing" }], p => p)).toThrow(/明確來源/);
    expect(() => prepareNativeMotionSequence(project, [{ ...focus, templateId: "editorial_steps" } as NativeMotionSection], p => p)).toThrow(/Unrecognized/);
    expect(() => prepareNativeReelScene(project, { templateId: "editorial_steps", startFrame: 0, durationFrames: 75,
      title: "禁止長片底板", progress: { steps: 3, activeStep: 1 }, evidenceRefs: ["source:longform"] }, p => p)).toThrow(/長片/);
  });
});
