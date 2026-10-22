import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { prepareNativeMotionRevision } from "./nativeMotionRevision";
import { applyCommand } from "../domain/commands";
import { parseProject } from "./projectFiles";

function fixture() {
  const project = createDemoProject();
  project.motionGraphics = [createMotionGraphic("title", "title", "動作有明確用途", 0, 4, undefined, findMotionGraphicPreset("reel_spatial_headline").seed)];
  const input = { expectedRevision: project.revision, graphicId: "title", range: { startFrame: 0, endFrame: 120 }, phase: "entrance" as const,
    change: { kind: "animation_speed_multiplier" as const, value: .7 }, evidenceRefs: ["director:slower-title-entrance"] };
  return { project: parseProject(project), input };
}
describe("scoped native director revisions", () => {
  it("distinguishes 0.7x motion speed from a duration and changes only the named entrance", () => {
    const { project, input } = fixture(); const before = structuredClone(project);
    const revision = prepareNativeMotionRevision(project, input);
    expect(project).toEqual(before);
    expect(revision.after.entrance.durationFrames).toBe(Math.round(revision.before.entrance.durationFrames / .7));
    expect(revision.after.exit).toEqual(revision.before.exit);
    expect(revision.after.entrance.scale).toBe(revision.before.entrance.scale);
    const applied = applyCommand(project, { type: "batch", commands: revision.commands });
    expect(applied.tracks).toEqual(project.tracks);
    const { motionV2: _before, ...original } = project.motionGraphics[0], { motionV2: _after, ...next } = applied.motionGraphics[0];
    expect(next).toEqual(original);
    const duration = prepareNativeMotionRevision(project, { ...input, change: { kind: "animation_duration_frames", value: 21 } });
    expect(duration.after.entrance.durationFrames).toBe(21);
  });
  it("blocks stale identity, mismatched targets and revisions that eliminate the reading hold", () => {
    const { project, input } = fixture();
    expect(() => prepareNativeMotionRevision(project, { ...input, expectedRevision: project.revision + 1 })).toThrow(/過期/);
    expect(() => prepareNativeMotionRevision(project, { ...input, graphicId: "other" })).toThrow(/指定對象/);
    expect(() => prepareNativeMotionRevision(project, { ...input, range: { startFrame: 1, endFrame: 120 } })).toThrow(/精確對應/);
    expect(() => prepareNativeMotionRevision(project, { ...input, change: { kind: "animation_duration_frames", value: 110 } })).toThrow(/閱讀停留/);
  });
});
