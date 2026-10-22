import { testDesignReviewEnvelope } from "./testDesignReviewPolicy";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import type { MotionVectorV2 } from "../domain/types";
import { parseProject } from "./projectFiles";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { assertAutopilotProjectTimelineBinding, parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { designEvidenceSchema, designRequestSchema } from "./autopilotDesignContract";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "./motionTreatment";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { designIdentity, verifyAutopilotDesign, type CurrentDesignBrief } from "../mcp/autopilotDesignTools";
import { prepareNativeGeometryMotion, type NativeGeometryMotionInput } from "./nativeGeometryMotion";
import { assertScopedMotionRevisionEffects } from "./scopedMotionRevision";

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  return value;
}

async function fixture(fillColor = "#175CD3") {
  const original = parseProject(createEmptyProject());
  const input: NativeGeometryMotionInput = { expectedRevision: original.revision,
    range: { startFrame: 0, endFrame: 120 }, position: { x: .1, y: .2 }, fixedEnvelope: { width: 400, height: 250 },
    initial: { left: 60, top: 70, right: 180, bottom: 170, cornerRadius: 16 },
    dynamics: { stiffness: 120, damping: 24, mass: 1 }, targets: [
      { property: "right", frame: 12, target: 320 }, { property: "bottom", frame: 18, target: 210 },
      { property: "left", frame: 24, target: 40 }, { property: "top", frame: 24, target: 50 },
      { property: "cornerRadius", frame: 36, target: 24 },
    ], purpose: "沿既有節點的右緣擴展內容容器，保留同一圖形與局部輪廓", evidenceRefs: ["director:original-node-expansion"], fillColor };
  // Create the actual existing target before authoring the v4 revision plan.
  const created = await prepareNativeGeometryMotion(original, input, () => "existing-node");
  const project = parseProject(applyCommand(original, created.commands[0]));
  const revision = await prepareNativeGeometryMotion(project, { ...input, expectedRevision: project.revision, graphicId: "existing-node",
    targets: input.targets.map(event => event.property === "right" ? { ...event, target: 300 } : event) });
  const plan = parseAutopilotPlan(createAutopilotV4Fixture()) as CurrentAutopilotPlan;
  const commandIndex = plan.commands.length;
  plan.commands.push(...revision.commands);
  const request = designRequestSchema.parse({ format: plan.route.format, domain: plan.route.domain, topic: "既有連續輪廓的局部導演修訂", duration: 3,
    beats: plan.editorial.narrative.beats.map(beat => ({ id: beat.id, role: "proof", energy: beat.energy, subject: beat.primaryFocus })) });
  const brief: CurrentDesignBrief = { schema: "hao.editkin.current-design-brief/v1", request, sources: [{ path: "original-geometry-method", sha256: "a".repeat(64) }],
    sourceSha256: "b".repeat(64), ...testDesignReviewEnvelope(), recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: plan.aesthetic.primaryFamily } } })) };
  plan.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => ({
    family, action: family === "motion" ? "use" : "omit", reason: "只修改既有面板的輪廓目標；保留內容、範圍、位置與音訊",
    beatIds: family === "motion" ? request.beats.map(beat => beat.id) : [], commandIndexes: family === "motion" ? [commandIndex] : [],
  })) };
  plan.designEvidence = designEvidenceSchema.parse({ schema: "editkin.autopilot-design-evidence/v1", request, ...designIdentity(brief, project),
    decisions: brief.recipes.map(row => ({ beatId: row.beatId, recipeSha256: sha256Canonical(row.recipe),
      application: "縮小既有面板右緣的擴展幅度，保留同一節點與固定範圍", commandIndexes: [commandIndex] })) });
  return { project, input, revision, plan, brief, commandIndex, compile: async () => brief };
}

function updateVector(graphicId: string, vectorV2: MotionVectorV2): EditorCommand {
  return { type: "update_motion_graphic", graphicId, patch: { vectorV2 } };
}

describe("original geometry director revisions through current v4 design binding", () => {
  it("binds actual creation metadata, preset variant and both visible families from an empty project", async () => {
    const project = parseProject(createEmptyProject()), before = structuredClone(project);
    expect(project.motionGraphics).toEqual([]);
    const prepared = await prepareNativeGeometryMotion(project, { expectedRevision: project.revision,
      range: { startFrame: 0, endFrame: 90 }, position: { x: .1, y: .2 }, fixedEnvelope: { width: 400, height: 250 },
      initial: { left: 60, top: 70, right: 180, bottom: 190, cornerRadius: 60 },
      dynamics: { stiffness: 120, damping: 24, mass: 1 }, targets: [
        { property: "right", frame: 12, target: 320 }, { property: "bottom", frame: 18, target: 210 },
        { property: "left", frame: 24, target: 40 }, { property: "top", frame: 24, target: 50 },
        { property: "cornerRadius", frame: 36, target: 24 },
      ], purpose: "以同一個圓形節點擴展成內容容器，保留連續輪廓與固定畫布", evidenceRefs: ["director:original-circle-to-card"] }, () => "created-node");
    expect(prepared.operation).toBe("create");
    expect(prepared.v4Binding.visibleFamilies).toEqual(["cards", "motion"]);
    expect(prepared.editorialGraphics).toHaveLength(1);
    expect(prepared.editorialGraphics[0].presetVariant).toEqual(prepared.presetVariant);
    expect(prepared.presetVariant?.basePresetSha256).toMatch(/^[a-f0-9]{64}$/);
    const authored = parseAutopilotPlan(createAutopilotV4Fixture()) as CurrentAutopilotPlan;
    const commandIndex = authored.commands.length;
    authored.commands.push(...prepared.commands);
    authored.editorial.graphics.push(...prepared.editorialGraphics);
    const request = designRequestSchema.parse({ format: authored.route.format, domain: authored.route.domain,
      topic: "原創圓形節點擴展成內容容器", duration: 3,
      beats: authored.editorial.narrative.beats.map(beat => ({ id: beat.id, role: "proof", energy: beat.energy, subject: beat.primaryFocus })) });
    const brief: CurrentDesignBrief = { schema: "hao.editkin.current-design-brief/v1", request,
      sources: [{ path: "original-geometry-creation-method", sha256: "a".repeat(64) }], sourceSha256: "b".repeat(64), ...testDesignReviewEnvelope(),
      recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: authored.aesthetic.primaryFamily } } })) };
    authored.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => {
      const used = family === "cards" || family === "motion";
      return { family, action: used ? "use" as const : "omit" as const, reason: "以原創連續輪廓建立內容容器，並保持素材與音訊不變",
        beatIds: used ? request.beats.map(beat => beat.id) : [], commandIndexes: used ? [commandIndex] : [] };
    }) };
    authored.designEvidence = designEvidenceSchema.parse({ schema: "editkin.autopilot-design-evidence/v1", request, ...designIdentity(brief, project),
      decisions: brief.recipes.map(row => ({ beatId: row.beatId, recipeSha256: sha256Canonical(row.recipe),
        application: "建立一個真實可編輯的原創圓形節點，以邊緣彈簧擴展為內容容器", commandIndexes: [commandIndex] })) });
    const plan = parseAutopilotPlan(authored) as CurrentAutopilotPlan;
    expect(plan.editorial.graphics[0]).toMatchObject({ id: prepared.graphicId, kind: "native_shape", range: prepared.range });
    expect(plan.editorial.graphics[0].presetVariant).toEqual(prepared.presetVariant);
    expect(motionCommandFamilies(plan.commands[commandIndex])).toEqual(["cards", "motion"]);
    expect(() => assertAutopilotProjectTimelineBinding(plan, project.fps)).not.toThrow();
    await expect(verifyAutopilotDesign(plan, project, async () => brief)).resolves.toMatchObject({ state: "COMMAND_BOUND_REVIEW_REQUIRED", beatCount: 3 });
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands: plan.commands }))));
    expect(project).toEqual(before);
    expect(reopened.motionGraphics).toHaveLength(1);
    expect(reopened.motionGraphics[0]).toMatchObject({ id: prepared.graphicId, presetId: "reel_native_panel", compositeLayer: "foreground", vectorV2: prepared.after });
    expect(reopened.tracks).toEqual(before.tracks);
    expect(reopened.assets).toEqual(before.assets);
  });

  it("binds the prepared existing-target revision without fake additions or input mutation", async () => {
    const f = await fixture(), before = structuredClone(f.project);
    const plan = parseAutopilotPlan(f.plan) as CurrentAutopilotPlan;
    expect(plan.editorial.graphics).toEqual([]);
    expect(plan.commands.filter(command => command.type === "add_motion_graphic")).toEqual([]);
    expect(motionCommandFamilies(plan.commands[f.commandIndex])).toEqual(["motion"]);
    await expect(verifyAutopilotDesign(plan, f.project, f.compile)).resolves.toMatchObject({ state: "COMMAND_BOUND_REVIEW_REQUIRED", beatCount: 3 });
    const after = parseProject(JSON.parse(JSON.stringify(applyCommand(f.project, { type: "batch", commands: plan.commands }))));
    expect(f.project).toEqual(before);
    expect(after.tracks).toEqual(before.tracks);
    expect(after.assets).toEqual(before.assets);
    expect(after.motionGraphics).toHaveLength(1);
    expect(after.motionGraphics[0].vectorV2).toEqual(f.revision.after);
    const { vectorV2: _old, ...oldGraphic } = before.motionGraphics[0];
    const { vectorV2: _new, ...newGraphic } = after.motionGraphics[0];
    expect(newGraphic).toEqual(oldGraphic);
  });

  it.each(["canonical", "zero-delta-event"])("rejects a %s no-op against the actual current target", async kind => {
    const f = await fixture(), before = structuredClone(f.project), vector = structuredClone(f.project.motionGraphics[0].vectorV2!);
    if (vector.kind !== "spring_panel") throw new Error("fixture lost continuity target");
    if (kind === "zero-delta-event") vector.geometry.cornerRadius.events = [{ frame: 0, target: vector.geometry.cornerRadius.initialTarget }, ...vector.geometry.cornerRadius.events];
    f.plan.commands[f.commandIndex] = updateVector(f.revision.graphicId, kind === "canonical" ? reverseKeys(vector) as MotionVectorV2 : vector);
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/unchanged|visible contour/);
    expect(f.project).toEqual(before);
  });

  it("rejects a contour edit on a fully transparent, unstroked target", async () => {
    const f = await fixture("#175CD300");
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/visible contour/);
  });

  it("checks repeated revisions in order, including a nested command batch", async () => {
    const f = await fixture();
    expect(() => assertScopedMotionRevisionEffects(f.project, [f.revision.commands[0], f.revision.commands[0]])).toThrow(/unchanged/);
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "batch", commands: [f.revision.commands[0], f.revision.commands[0]] }])).toThrow(/unchanged/);
  });

  it("rejects a revision restored to its original contour by the final command", async () => {
    const f = await fixture();
    const restoreIndex = f.plan.commands.length;
    f.plan.commands.push(updateVector(f.revision.graphicId, structuredClone(f.project.motionGraphics[0].vectorV2!)));
    f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "motion")!.commandIndexes.push(restoreIndex);
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/final contour is unchanged/);
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "batch", commands: f.plan.commands }])).toThrow(/final contour is unchanged/);
  });

  it.each(["removed", "replaced"])("rejects a %s final target after the real scoped revision", async kind => {
    const f = await fixture();
    f.plan.commands.push({ type: "delete_motion_graphic", graphicId: f.revision.graphicId });
    if (kind === "replaced") {
      const replacementIndex = f.plan.commands.length;
      f.plan.commands.push({ type: "add_motion_graphic", graphic: structuredClone(f.project.motionGraphics[0]) });
      // Bind the destructive control's actual replacement so family coverage
      // cannot mask the final-target check exercised by verifyAutopilotDesign.
      const motion = f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "motion")!;
      motion.commandIndexes.push(replacementIndex);
      const cards = f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "cards")!;
      cards.action = "use"; cards.beatIds = [...motion.beatIds]; cards.commandIndexes = [replacementIndex];
    }
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/final surviving|final contour is unchanged/);
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "batch", commands: f.plan.commands }])).toThrow(/final surviving|final contour is unchanged/);
  });

  it.each(["duration", "position", "envelope"])("rejects a late ordinary %s patch that invalidates the fixed target binding", async kind => {
    const f = await fixture();
    const patch = kind === "duration" ? { duration: 3.9 } : kind === "position" ? { x: .11 } : { width: 399 / f.project.width };
    f.plan.commands.push({ type: "update_motion_graphic", graphicId: f.revision.graphicId, patch });
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/preserve identity, range, position and fixed envelope|fixed envelope/);
    expect(() => assertScopedMotionRevisionEffects(f.project, [{ type: "batch", commands: f.plan.commands }])).toThrow(/preserve identity, range, position and fixed envelope|fixed envelope/);
  });

  it.each(["hidden", "wrong-family"])("rejects %s geometry family binding through both plan and design verification", async kind => {
    const f = await fixture(), motion = f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "motion")!;
    if (kind === "hidden") { motion.action = "omit"; motion.commandIndexes = []; }
    else { const cards = f.plan.editorial.motionTreatment!.decisions.find(row => row.family === "cards")!;
      cards.action = "use"; cards.beatIds = [...motion.beatIds]; cards.commandIndexes = [f.commandIndex]; }
    expect(() => parseAutopilotPlan(f.plan)).toThrow(/未交代用途|命令綁定/);
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/未交代用途|命令綁定/);
  });

  it.each(["project", "source", "recipe", "family"])("rejects current %s design drift for a physically valid contour revision", async kind => {
    const f = await fixture();
    if (kind === "project") f.plan.designEvidence!.projectSha256 = "0".repeat(64);
    if (kind === "source") f.brief.sourceSha256 = "c".repeat(64);
    if (kind === "recipe") {
      f.brief.recipes[0].recipe = { ...f.brief.recipes[0].recipe, contourPurpose: "changed-source-recipe" };
      f.plan.designEvidence!.briefSha256 = sha256Canonical(f.brief);
    }
    if (kind === "family") {
      f.brief.recipes[0].recipe.route.primary_family = "different-design-family";
      f.plan.designEvidence!.briefSha256 = sha256Canonical(f.brief);
      f.plan.designEvidence!.decisions[0].recipeSha256 = sha256Canonical(f.brief.recipes[0].recipe);
    }
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/changed|recipe mismatch|family mismatch/);
  });
});
