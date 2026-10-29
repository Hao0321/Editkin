import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createClipMask } from "../domain/masks";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { prepareReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import type { ReferenceMotionPlan } from "../application/referenceMotionPlan";
import { rotoKeyerScopedCommands, type AutopilotPlan } from "../application/autopilotPlan";
import { assertRotoKeyerPlanCommandBinding } from "../application/rotoKeyerAutopilot";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { verifyReferenceMotionPlan } from "./referenceMotionPlanVerification";

async function fixture() {
  // Real bundled glyph bytes and actual theme compiler; synthetic media metadata, no footage/art approval.
  const project = createEmptyProject("Template mask evidence boundary", { width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "asset-a", name: "Synthetic boundary control", kind: "video", uri: "synthetic.mp4",
    duration: 30, width: 1080, height: 1920 }];
  project.tracks[0].clips = ["primary", "unrelated"].map((id, index) => ({ id, assetId: "asset-a", trackId: project.tracks[0].id,
    timelineStart: index * 11, sourceStart: 0, duration: 11, volume: .7, keyframes: [],
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }));
  let ordinal = 0;
  const prepared = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateInstance(project, {
    templateId: "strike_reframe", clipId: "primary", startFrame: 0, durationFrames: 330,
    designSystem: "trip_pop_v1", graphicCadence: "kinetic", intent: "shortform",
    title: "WATCH WATER", previousText: "LOOK FOR BATS", kicker: "OWNED", subtitle: "WATER CURTAIN",
    purpose: "Synthetic exact mask recompilation control", evidenceRefs: ["synthetic:mask-scope"], sources: [],
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } },
  }, prefix => `${prefix}-mask-control-${++ordinal}`, deps));
  const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{
    instanceId: prepared.instance.id, mode: "create", commandIndexes: prepared.commands.map((_, index) => index),
  }] };
  if (!prepared.commands.some(command => command.type === "add_clip_mask")) throw new Error("Control requires a real compiled footage-window mask");
  return { project, prepared, declaration };
}

const scope = (commands: EditorCommand[], referenceMotion: ReferenceMotionPlan) =>
  rotoKeyerScopedCommands({ commands, referenceMotion } as unknown as AutopilotPlan);
const unrelatedMask = (): EditorCommand => ({ type: "add_clip_mask", clipId: "unrelated", mask: createClipMask("caller-mask", "polygon") });

describe("physical template mask exemption retains exact compiler authority", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);

  it("accepts an authentic window after recompilation without requiring a Roto decision", async () => {
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, f.prepared.commands)).resolves.toMatchObject({ instanceCount: 1 });
    expect(scope(f.prepared.commands, f.declaration)).toEqual([]);
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, scope(f.prepared.commands, f.declaration), "review_required", 4096)).not.toThrow();
  });

  it("rejects edited window geometry despite an unchanged declaration", async () => {
    const commands = structuredClone(f.prepared.commands);
    const mask = commands.find(command => command.type === "add_clip_mask");
    if (!mask || mask.type !== "add_clip_mask") throw new Error("Control requires compiled window geometry");
    mask.mask.path[0].x += .001;
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });

  it("rejects a caller mask hidden inside syntactically valid template indexes", async () => {
    const commands = structuredClone(f.prepared.commands);
    commands.splice(commands.length - 1, 0, unrelatedMask());
    const declaration = structuredClone(f.declaration);
    declaration.instances[0].commandIndexes = commands.map((_, index) => index);
    expect(scope(commands, declaration)).toEqual([]); // Syntax alone is deliberately not execution authority.
    await expect(verifyReferenceMotionPlan(declaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });

  it("keeps an undeclared mask on a separate clip subject to Roto evidence", async () => {
    const extra = unrelatedMask(), commands = [...f.prepared.commands, extra];
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, commands)).resolves.toMatchObject({ instanceCount: 1 });
    expect(scope(commands, f.declaration)).toEqual([extra]);
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, scope(commands, f.declaration), "review_required", 4096)).toThrow(/roto-keyer-plan/);
  });
});
