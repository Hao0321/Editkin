import { testDesignReviewEnvelope } from "./testDesignReviewPolicy";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { parseProject } from "./projectFiles";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { designEvidenceSchema, designRequestSchema } from "./autopilotDesignContract";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "./motionTreatment";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { designIdentity, verifyAutopilotDesign, type CurrentDesignBrief } from "../mcp/autopilotDesignTools";
import { prepareNativeMotionRevision } from "./nativeMotionRevision";
import { assertScopedMotionRevisionEffects } from "./scopedMotionRevision";

function fixture() {
  const original = createEmptyProject();
  const graphic = createMotionGraphic("existing-title", "title", "動作有明確用途", 0, 4, undefined, findMotionGraphicPreset("reel_spatial_headline").seed);
  graphic.motionV2!.entrance.easing = { type: "ease_out" };
  original.motionGraphics = [graphic];
  const project = parseProject(original);
  const input = { expectedRevision: project.revision, graphicId: graphic.id, range: { startFrame: 0, endFrame: 120 }, phase: "entrance" as const,
    change: { kind: "animation_spring" as const, stiffness: 196, damping: 22, mass: 1, initialVelocity: 0 }, evidenceRefs: ["director:restrained-motion"] };
  const revision = prepareNativeMotionRevision(project, input);
  const plan = parseAutopilotPlan(createAutopilotV4Fixture()) as CurrentAutopilotPlan;
  plan.commands.push(...revision.commands);
  const request = designRequestSchema.parse({ format: plan.route.format, domain: plan.route.domain, topic: "既有動作的局部修正", duration: 3,
    beats: plan.editorial.narrative.beats.map(beat => ({ id: beat.id, role: "proof", energy: beat.energy, subject: beat.primaryFocus })) });
  const brief: CurrentDesignBrief = { schema: "hao.editkin.current-design-brief/v1", request, sources: [{ path: "original-method-card", sha256: "a".repeat(64) }],
    sourceSha256: "b".repeat(64), ...testDesignReviewEnvelope(), recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: plan.aesthetic.primaryFamily } } })) };
  plan.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => ({
    family, action: family === "motion" ? "use" : "omit", reason: "只修正既有主標入場動作；保持原內容、版面與音訊",
    beatIds: family === "motion" ? request.beats.map(beat => beat.id) : [], commandIndexes: family === "motion" ? [2] : [],
  })) };
  plan.designEvidence = designEvidenceSchema.parse({ schema: "editkin.autopilot-design-evidence/v1", request, ...designIdentity(brief, project),
    decisions: brief.recipes.map(row => ({ beatId: row.beatId, recipeSha256: sha256Canonical(row.recipe), application: "局部修訂既有 Motion 的入場彈簧，持續保留閱讀停留", commandIndexes: [2] })) });
  return { project, input, revision, plan, brief, compile: async () => brief };
}

describe("original Motion director revisions through current v4 design binding", () => {
  it("binds an actual spring revision without adding fake graphics or changing the input project", async () => {
    const f = fixture(), before = structuredClone(f.project);
    const plan = parseAutopilotPlan(f.plan) as CurrentAutopilotPlan;
    expect(plan.editorial.graphics).toEqual([]);
    expect(motionCommandFamilies(plan.commands[2])).toEqual(["motion"]);
    await expect(verifyAutopilotDesign(plan, f.project, f.compile)).resolves.toMatchObject({ state: "COMMAND_BOUND_REVIEW_REQUIRED", beatCount: 3 });
    const after = applyCommand(f.project, { type: "batch", commands: plan.commands });
    expect(f.project).toEqual(before);
    expect(after.tracks).toEqual(before.tracks);
    expect(after.motionGraphics[0].motionV2!.entrance.easing).toEqual({ type: "spring", stiffness: 196, damping: 22, mass: 1, initialVelocity: 0 });
    expect(after.motionGraphics[0].motionV2!.exit).toEqual(before.motionGraphics[0].motionV2!.exit);
    const { motionV2: _old, ...oldGraphic } = before.motionGraphics[0];
    const { motionV2: _new, ...newGraphic } = after.motionGraphics[0];
    expect(newGraphic).toEqual(oldGraphic);
  });
  it.each(["empty", "name", "mixed"])("does not grant a visual design binding to %s metadata patches", kind => {
    const f = fixture();
    const patch = kind === "empty" ? {} : kind === "name" ? { name: "renamed" } : { ...f.revision.commands[0].patch, name: "mixed" };
    f.plan.commands[2] = { type: "update_motion_graphic", graphicId: f.project.motionGraphics[0].id, patch };
    expect(motionCommandFamilies(f.plan.commands[2])).toEqual([]);
    expect(() => parseAutopilotPlan(f.plan)).toThrow();
  });
  it.each(["hidden", "wrong-family"])("rejects %s Motion revisions in the plan parser", kind => {
    const f = fixture(), motion = f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "motion")!;
    if (kind === "hidden") { motion.action = "omit"; motion.commandIndexes = []; }
    else { const title = f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "title")!; title.action = "use"; title.beatIds = ["promise"]; title.commandIndexes = [2]; }
    expect(() => parseAutopilotPlan(f.plan)).toThrow(/未交代用途|命令綁定/);
  });
  it.each(["noop", "missing", "v1", "project-drift", "source-drift"])("rejects %s against the actual current project/source", async kind => {
    const f = fixture(), before = structuredClone(f.project);
    if (kind === "noop") f.plan.commands[2] = { type: "update_motion_graphic", graphicId: f.project.motionGraphics[0].id, patch: { motionV2: structuredClone(f.project.motionGraphics[0].motionV2!) } };
    if (kind === "missing") (f.plan.commands[2] as Extract<EditorCommand, { type: "update_motion_graphic" }>).graphicId = "absent";
    if (kind === "v1") { f.project.motionGraphics[0].schema = "hao.motion-composition/v1"; delete f.project.motionGraphics[0].motionV2; }
    if (kind === "project-drift") f.plan.designEvidence!.projectSha256 = "0".repeat(64);
    if (kind === "source-drift") f.brief.sourceSha256 = "c".repeat(64);
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/unchanged|existing v2|changed/);
    if (kind !== "v1") expect(f.project).toEqual(before);
  });
  it("checks repeated revisions in execution order, not against a stale initial target", () => {
    const f = fixture();
    expect(() => assertScopedMotionRevisionEffects(f.project, [f.revision.commands[0], f.revision.commands[0]])).toThrow(/unchanged/);
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "batch", commands: [f.revision.commands[0], f.revision.commands[0]] }])).toThrow(/unchanged/);
  });
  it("rejects a raw v4 patch that bypasses the director's reading-hold protection", async () => {
    const f = fixture(), motion = structuredClone(f.revision.after);
    motion.entrance.durationFrames = 108; motion.exit.durationFrames = 12;
    f.plan.commands[2] = { type: "update_motion_graphic", graphicId: f.project.motionGraphics[0].id, patch: { motionV2: motion } };
    const plan = parseAutopilotPlan(f.plan) as CurrentAutopilotPlan;
    await expect(verifyAutopilotDesign(plan, f.project, f.compile)).rejects.toThrow(/閱讀停留/);
  });
  it("rejects a no-op with permuted property order rather than granting visual credit", () => {
    const f = fixture(), before = f.project.motionGraphics[0].motionV2!;
    const reordered = { exit: before.exit, entrance: before.entrance, sequence: before.sequence };
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "update_motion_graphic", graphicId: f.project.motionGraphics[0].id, patch: { motionV2: reordered } }])).toThrow(/unchanged/);
  });
  it("checks final reading hold after an ordinary duration patch later in the batch", async () => {
    const f = fixture(), motion = f.revision.after;
    const shortenedDuration = (motion.entrance.durationFrames + motion.exit.durationFrames + 1) / f.project.fps;
    f.plan.commands.push({ type: "update_motion_graphic", graphicId: f.project.motionGraphics[0].id, patch: { duration: shortenedDuration } });
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/閱讀停留/);
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "batch", commands: f.plan.commands }])).toThrow(/閱讀停留/);
  });
  it("does not credit a scoped revision whose target is deleted before the final state", () => {
    const f = fixture();
    expect(() => assertScopedMotionRevisionEffects(f.project, [f.revision.commands[0], { type: "delete_motion_graphic", graphicId: f.project.motionGraphics[0].id }])).toThrow(/final surviving/);
  });
  it.each(["stiffness", "damping", "mass", "initialVelocity"])("rejects out-of-range %s before authoring", key => {
    const f = fixture();
    expect(() => prepareNativeMotionRevision(f.project, { ...f.input, change: { ...f.input.change, [key]: Infinity } })).toThrow();
  });
  it("includes staggered words when protecting the actual reading hold", () => {
    const f = fixture();
    const graphic = f.project.motionGraphics[0];
    graphic.text = "一 二 三 四 五";
    graphic.motionV2!.sequence = { unit: "word", order: "forward", exitOrder: "reverse", staggerFrames: 9 };
    graphic.motionV2!.entrance.durationFrames = 18; graphic.motionV2!.exit.durationFrames = 12;
    graphic.duration = 3; // 30+72 =102 frames already consume more than90.
    expect(() => prepareNativeMotionRevision(f.project, { ...f.input, range: { startFrame: 0, endFrame: 90 } })).toThrow(/閱讀停留/);
  });
});
