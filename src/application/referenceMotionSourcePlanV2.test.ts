import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { referenceMotionPlanSchema, referenceMotionRequestedIndexes, referenceMotionVisibleProjection } from "./referenceMotionPlan";
import { referenceMotionCompatiblePlanSchema, referenceMotionRequestedIndexesCompatible, referenceMotionVisibleProjectionCompatible,
  type ReferenceMotionCompatiblePlan } from "./referenceMotionSourcePlanV2";
import { hasReferenceMotionSourceReplacement, referenceMotionReplacementWindows, assertReferenceMotionReplacementCoverage } from "./referenceMotionReplacementWindows";
import type { EditorCommand } from "../domain/commandTypes";

function fixture() {
  const project = createDemoProject(), primary = project.tracks[0].clips[0]; primary.sourceStart = 1; primary.duration = 8;
  const instance = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "owner", instanceRevision: 1, authoringGeneration: 2,
    input: { templateId: "level_bridge", clipId: primary.id, startFrame: 0, durationFrames: 240, title: "FOCUS", sources: [],
      purpose: "Pure coverage control", evidenceRefs: ["synthetic:coverage"], intent: "shortform", style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: project.width, height: project.height, fps: project.fps }, primaryBefore: { layout: null }, roles: [{ key: "heading", kind: "graphic", id: "graphic" }],
    dependencies: { recipeVersion: "synthetic", presetHashes: [], fonts: [] }, appliedScopeSha256: "a".repeat(64) });
  project.referenceMotionInstances = [instance];
  const declaration: ReferenceMotionCompatiblePlan = { schema: "editkin.reference-motion-plan/v2", instances: [{ mode: "replace_source", instanceId: instance.id,
    expectedInstanceRevision: 1, commandIndexes: [0, 1], replacement: { primary: { assetId: "new", sourceStart: 2 }, audio: { primary: "mute" } } }] };
  const commands: EditorCommand[] = [{ type: "rebind_reference_motion_clip_source", clipId: primary.id, assetId: "new", sourceStart: 2, duration: 8,
    expected: { assetId: primary.assetId, sourceStart: 1, duration: 8 } },
    { type: "upsert_reference_motion_instance", instance: { ...structuredClone(instance), instanceRevision: 2 }, expectedInstanceRevision: 1 }];
  return { project, primary, instance, declaration, commands };
}
describe("optional reference source plan syntax and post-verification coverage", () => {
  it("keeps every old v1 parser and visible projection output unchanged", () => {
    const f = fixture(), declaration = { schema: "editkin.reference-motion-plan/v1" as const, instances: [{ mode: "revise" as const, instanceId: "owner", expectedInstanceRevision: 1, commandIndexes: [0], patch: { title: "FOCUS" } }] };
    const commands = [f.commands[1]];
    expect(referenceMotionCompatiblePlanSchema.parse(declaration)).toEqual(referenceMotionPlanSchema.parse(declaration));
    expect(referenceMotionRequestedIndexesCompatible(declaration, commands)).toEqual(referenceMotionRequestedIndexes(declaration, commands));
    expect(referenceMotionVisibleProjectionCompatible(declaration, commands)).toEqual(referenceMotionVisibleProjection(declaration, commands));
    expect(hasReferenceMotionSourceReplacement(declaration)).toBe(false);
  });
  it("requires a flat contiguous source declaration and rejects forged fields, owners and naked rebinds", () => {
    const f = fixture(); expect([...referenceMotionRequestedIndexesCompatible(f.declaration, f.commands)]).toEqual([0, 1]);
    expect(() => referenceMotionPlanSchema.parse(f.declaration)).toThrow();
    expect(() => referenceMotionRequestedIndexesCompatible(undefined, f.commands)).toThrow(/declaration/);
    expect(() => referenceMotionCompatiblePlanSchema.parse({ ...f.declaration, proof: {} })).toThrow();
    const wrong = structuredClone(f.commands); if (wrong[0].type === "rebind_reference_motion_clip_source") wrong[0].clipId = "foreign";
    expect(() => referenceMotionRequestedIndexesCompatible(f.declaration, wrong)).toThrow(/clip owner/);
  });
  it("derives new asset/window coverage from original source slots rather than caller metadata", () => {
    const f = fixture(); expect(referenceMotionReplacementWindows(f.project, f.declaration)).toEqual([{ assetId: "new", sourceStart: 2, duration: 8 }]);
    f.commands[1].type === "upsert_reference_motion_instance" && (f.commands[1].instance.input.durationFrames = 900);
    expect(referenceMotionReplacementWindows(f.project, f.declaration)[0].duration).toBe(8);
    const step = f.declaration.instances[0]; if (step.mode !== "replace_source") throw new Error("Source control required");
    step.replacement.primary = { assetId: f.primary.assetId, sourceStart: 1 };
    expect(referenceMotionReplacementWindows(f.project, f.declaration)).toEqual([]);
    step.replacement.durationFrames = 180; expect(referenceMotionReplacementWindows(f.project, f.declaration)[0].duration).toBe(6);
    f.instance.instanceRevision = 2; expect(() => referenceMotionReplacementWindows(f.project, f.declaration)).toThrow(/current saved/);
  });
  it("requires one same-asset verified window containing the whole replacement; partial unions and old assets earn no coverage", () => {
    const required = [{ assetId: "new", sourceStart: 2, duration: 8 }];
    expect(() => assertReferenceMotionReplacementCoverage(required, [{ assetId: "new", sourceStart: 1, duration: 10 }])).not.toThrow();
    for (const receipts of [[], [{ assetId: "old", sourceStart: 0, duration: 30 }], [{ assetId: "new", sourceStart: 2, duration: 7 }],
      [{ assetId: "new", sourceStart: 2, duration: 4 }, { assetId: "new", sourceStart: 6, duration: 4 }]]) {
      expect(() => assertReferenceMotionReplacementCoverage(required, receipts)).toThrow(/fresh verified material coverage/);
    }
  });
});
