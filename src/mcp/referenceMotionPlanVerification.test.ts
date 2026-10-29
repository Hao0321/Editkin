import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { canonicalJson } from "../shared/canonicalJson";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "../application/referenceMotionTemplateInstances";
import { referenceMotionRequestedIndexes, referenceMotionVisibleProjection, type ReferenceMotionPlan } from "../application/referenceMotionPlan";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { verifyReferenceMotionPlan } from "./referenceMotionPlanVerification";

function fixture() {
  const project = createEmptyProject("Synthetic source ownership control", { id: "reference-plan-source", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source-asset", name: "Synthetic source, no publication rights", kind: "video", uri: "D:/synthetic/reference-source.mp4", duration: 20, width: 1080, height: 1920 }];
  project.tracks[0].clips = [{ id: "source-clip", trackId: project.tracks[0].id, assetId: "source-asset", sourceStart: 2,
    timelineStart: 0, duration: 12, volume: .7, keyframes: [], transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }];
  const input = { templateId: "level_bridge" as const, clipId: "source-clip", startFrame: 0, durationFrames: 360,
    title: "FOCUS", kicker: "OWNED", subtitle: "STAY CLEAR", sources: [], purpose: "Synthetic exact compilation control",
    evidenceRefs: ["synthetic:source-window-control"], style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE),
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  let count = 0;
  const idFactory = (prefix: string) => `${prefix}-control-${++count}`;
  return { project, input, idFactory };
}
async function created() {
  const f = fixture();
  const prepared = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateInstance(f.project, f.input, f.idFactory, deps));
  const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: prepared.instance.id,
    mode: "create", commandIndexes: prepared.commands.map((_, index) => index) }] };
  return { ...f, prepared, declaration };
}

describe("current v4 exact reference instance compilation authority", () => {
  it("independently recompiles true physical creation without mutating source or granting metadata visual credit", async () => {
    const f = await created(), before = canonicalJson(f.project);
    const verified = await verifyReferenceMotionPlan(f.declaration, f.project, f.prepared.commands);
    expect(verified.instanceCount).toBe(1);
    expect([...verified.indexes]).toEqual(f.declaration.instances[0].commandIndexes);
    expect(canonicalJson(f.project)).toBe(before);
    const projected = referenceMotionVisibleProjection(f.declaration, f.prepared.commands);
    expect(projected.at(-1)?.type).toBe("upsert_reference_motion_instance");
  });
  it("rejects forged prepare commands even when the caller retains metadata and all declared indexes", async () => {
    const f = await created(), commands = structuredClone(f.prepared.commands);
    const graphic = commands.find(command => command.type === "add_motion_graphic" && command.graphic.text);
    if (!graphic || graphic.type !== "add_motion_graphic") throw new Error("Control requires actual compiled text");
    graphic.graphic.text = "FORGED";
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });
  it("rejects metadata without declaration and declaration index aliasing before physical work", async () => {
    const f = await created();
    expect(() => referenceMotionRequestedIndexes(undefined, f.prepared.commands)).toThrow(/declaration/);
    const row = f.declaration.instances[0];
    expect(() => referenceMotionRequestedIndexes({ ...f.declaration, instances: [{ ...row, commandIndexes: [0, 0] }] }, f.prepared.commands)).toThrow(/disjoint|contiguous/);
    expect(() => referenceMotionRequestedIndexes({ ...f.declaration, instances: [{ ...row, commandIndexes: [1, 0] }] }, f.prepared.commands)).toThrow(/disjoint|contiguous/);
    expect(() => referenceMotionRequestedIndexes({ ...f.declaration, instances: [row, row] }, f.prepared.commands)).toThrow(/once/);
  });
  it("rejects later outside updates that alter the exact compiled result", async () => {
    const f = await created();
    const graphic = f.prepared.commands.find(command => command.type === "add_motion_graphic" && command.graphic.text);
    if (!graphic || graphic.type !== "add_motion_graphic") throw new Error("Control requires actual compiled text");
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, [...f.prepared.commands,
      { type: "update_motion_graphic", graphicId: graphic.graphic.id, patch: { text: "LATE FORGED" } }])).rejects.toThrow(/Later plan/);
  });
  it("recompiles a replacement physically and preserves existing graphic IDs and true source audio", async () => {
    const f = await created(), project = applyCommand(f.project, { type: "batch", commands: f.prepared.commands });
    const patch = { title: "KEEP THE FOCUS", kicker: null };
    const revised = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateRevision(project, f.prepared.instance.id, patch,
      { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory }));
    if (revised.status === "UNCHANGED") throw new Error("Control requires actual changed text");
    const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: f.prepared.instance.id,
      mode: "revise", expectedInstanceRevision: 1, patch, commandIndexes: revised.commands.map((_, index) => index) }] };
    await expect(verifyReferenceMotionPlan(declaration, project, revised.commands)).resolves.toMatchObject({ instanceCount: 1 });
    const final = applyCommand(project, { type: "batch", commands: revised.commands });
    const originalHeadline = project.motionGraphics.find(graphic => graphic.text === "FOCUS")!;
    expect(final.motionGraphics.find(graphic => graphic.text === "KEEP THE FOCUS")?.id).toBe(originalHeadline.id);
    expect(final.tracks[0].clips[0]).toEqual(project.tracks[0].clips[0]);
    expect(final.tracks[0].clips[0].volume).toBe(.7);
  });
  it("refuses caller revision claims when trusted source was manually edited", async () => {
    const f = await created(), project = applyCommand(f.project, { type: "batch", commands: f.prepared.commands });
    const patch = { title: "REVISED" };
    const revised = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateRevision(project, f.prepared.instance.id, patch,
      { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory }));
    if (revised.status === "UNCHANGED") throw new Error("Control requires changed text");
    const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: f.prepared.instance.id,
      mode: "revise", expectedInstanceRevision: 1, patch, commandIndexes: revised.commands.map((_, index) => index) }] };
    const changed = applyCommand(project, { type: "update_motion_graphic", graphicId: project.motionGraphics.find(graphic => graphic.text)!.id,
      patch: { x: .2 } });
    await expect(verifyReferenceMotionPlan(declaration, changed, revised.commands)).rejects.toThrow(/EDITED|drift|手動|漂移/);
  });
  it("does not turn partial arbitrary patches, detach or nested metadata into a visual lane", async () => {
    const f = await created();
    expect(() => referenceMotionRequestedIndexes(undefined, [{ type: "remove_reference_motion_instance", id: f.prepared.instance.id, expectedInstanceRevision: 1 }])).toThrow(/manual/);
    expect(() => referenceMotionRequestedIndexes(undefined, [{ type: "batch", commands: f.prepared.commands }])).toThrow(/flat/);
    const commands = structuredClone(f.prepared.commands), index = commands.findIndex(command => command.type === "add_motion_graphic");
    const target = commands[index];
    if (target.type !== "add_motion_graphic") throw new Error("Control requires a compiled graphic");
    commands[index] = { type: "update_motion_graphic", graphicId: target.graphic.id, patch: { motionV2: target.graphic.motionV2 } };
    expect(() => referenceMotionVisibleProjection(f.declaration, commands)).toThrow();
  });
});
