import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { parseAutopilotPlan, getPlanOriginalMotionSources, compactAutopilotContract } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { prepareOriginalMotionSourceEvidence, originalMotionCueEvidenceReference } from "./originalMotionSourceEvidence";
import type { OriginalMotionScene2dInput } from "./originalMotionScene2d";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { designRequestSchema, designEvidenceSchema } from "./autopilotDesignContract";
import { verifyAutopilotDesign, designIdentity, type CurrentDesignBrief } from "../mcp/autopilotDesignTools";
import { testDesignReviewEnvelope } from "./testDesignReviewPolicy";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "./motionTreatment";

// This is wire admission only. Controlled file descriptors do not stand in for
// MCP's actual workspace reader, font preparation, audit or atomic apply.
async function fixture(intent: OriginalMotionScene2dInput["intent"] = "standalone_showcase") {
  const project = createEmptyProject("Authored admission", { width: 640, height: 360, fps: 30 });
  const input: OriginalMotionScene2dInput = { sceneId: "admission-scene", expectedRevision: project.revision, intent,
    reason: "Keep the authored panel stable across three deliberate semantic camera phases", startFrame: 0, durationFrames: 90,
    safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" }, typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "admission-panel", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 220, yPixels: 140, widthPixels: 120, heightPixels: 70, cornerRadiusPixels: 8, colorRole: "accent" }],
    semanticCues: [0, 35, 70].map((frame, index) => ({ id: `phase-${index}`, frame, purpose: "Authored illustration handoff", graphicIds: ["admission-panel"], evidenceRefs: [`brief:phase-${index}`], focus: { centerX: 320 + index, centerY: 180, zoom: 1 } })),
  };
  const prepared = await prepareOriginalMotionSourceEvidence(project, input, { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration", realityProof: false, importedReferenceMedia: false, declaration: "Original unit-control vector illustration, with no outside factual claims" }, 1, { authoringSource: { sourcePath: ".editkin/original-sources/admission.json", sourceSha256: "1".repeat(64), sourcePayloadSha256: "2".repeat(64), bytes: 1200 } });
  const base = createAutopilotV4Fixture();
  const set = { schema: "editkin.original-motion-source/v1" as const, sources: [prepared.evidence] };
  const plan = { ...base, materialEvidence: { ...set, receipts: [] }, commands: [base.commands[0], ...prepared.preparation.commands], editorial: {
    ...base.editorial, graphics: prepared.preparation.editorialGraphics, transitions: [],
    narrative: { ...base.editorial.narrative, beats: base.editorial.narrative.beats.map((beat, index) => ({ ...beat, range: { startFrame: index * 30, endFrame: (index + 1) * 30 }, evidenceRefs: [originalMotionCueEvidenceReference(prepared.evidence.sourceSha256, `phase-${index}`)] })) },
    audio: { ...base.editorial.audio, mode: "silent_original" as const, layers: [], impactFrames: [], breathFrames: [] },
    color: { ...base.editorial.color, sourceMode: "authored_palette" as const, shotMatchRequired: false },
  } };
  return { plan, set, base, project };
}

async function designFixture() {
  const f = await fixture(), plan = parseAutopilotPlan(f.plan);
  if (plan.schema !== "hao.video-autopilot.edit-plan/v4") throw new Error("current required");
  const request = designRequestSchema.parse({ format: plan.route.format, domain: plan.route.domain, topic: "Authored diagram", duration: 3,
    originalSourceScope: { schema: "editkin.original-motion-design-scope/v1", sourceSetSha256: sha256Canonical(f.set), usage: "standalone" },
    beats: plan.editorial.narrative.beats.map(beat => ({ id: beat.id, role: beat.id === "promise" ? "first_frame" : beat.id === "payoff" ? "payoff" : "process", energy: beat.energy, subject: beat.primaryFocus })) });
  const brief: CurrentDesignBrief = { schema: "hao.editkin.current-design-brief/v1", request, sources: [{ path: "unit-own-craft.json", sha256: "a".repeat(64) }], sourceSha256: "b".repeat(64),
    ...testDesignReviewEnvelope(), recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: plan.aesthetic.primaryFamily } } })) };
  plan.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = plan.commands.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
    return { family, action: commandIndexes.length ? "use" : "omit", reason: "Declare only actual authored commands; no imagined pixels or media", beatIds: request.beats.map(beat => beat.id), commandIndexes };
  }) };
  plan.designEvidence = designEvidenceSchema.parse({ schema: "editkin.autopilot-design-evidence/v1", request, ...designIdentity(brief, f.project),
    decisions: brief.recipes.map(recipe => ({ beatId: recipe.beatId, recipeSha256: sha256Canonical(recipe.recipe), application: "Keep the same original vector identity and motivated shared camera handoff", commandIndexes: [1, 2] })) });
  return { ...f, plan, brief };
}

describe("v4 explicit original source admission", () => {
  it("binds every authored design beat to current original scope and actual scene commands", async () => {
    const f = await designFixture();
    await expect(verifyAutopilotDesign(f.plan, f.project, async () => f.brief)).resolves.toMatchObject({ state: "COMMAND_BOUND_REVIEW_REQUIRED", beatCount: 3 });
  });
  it("rejects omitted, stale and wrong-usage authored design scope before compiling recipes", async () => {
    for (const mutation of ["omitted", "stale", "wrong-usage"] as const) {
      const f = await designFixture();
      const request = f.plan.designEvidence!.request;
      if (mutation === "omitted") delete request.originalSourceScope;
      else if (mutation === "stale") request.originalSourceScope!.sourceSetSha256 = "0".repeat(64);
      else request.originalSourceScope!.usage = "authored_overlay";
      await expect(verifyAutopilotDesign(f.plan, f.project, async () => { throw new Error("Should not compile wrong source scope"); })).rejects.toThrow(/original-source scope/);
    }
  });
  it("admits compiled file-bound original vector commands with disclosed silent audio and palette", async () => {
    const { plan, set } = await fixture();
    const parsed = parseAutopilotPlan(plan);
    expect(parsed.schema).toBe("hao.video-autopilot.edit-plan/v4");
    if (parsed.schema !== "hao.video-autopilot.edit-plan/v4") throw new Error("current required");
    expect(getPlanOriginalMotionSources(parsed)).toEqual(set);
    expect(parsed.materialEvidence.receipts).toHaveLength(0);
    expect(compactAutopilotContract().originalSourceExecution.actualFileRequired).toBe(true);
  });
  it("retains mandatory nonempty material receipts and audio layers in ordinary media plans", () => {
    const media = createAutopilotV4Fixture();
    expect(() => parseAutopilotPlan(media)).not.toThrow();
    expect(() => parseAutopilotPlan({ ...media, materialEvidence: { ...media.materialEvidence, receipts: [] } })).toThrow();
    expect(() => parseAutopilotPlan({ ...media, editorial: { ...media.editorial, audio: { ...media.editorial.audio, layers: [] } } })).toThrow(/Media audio/);
    expect(() => parseAutopilotPlan({ ...media, editorial: { ...media.editorial, color: { ...media.editorial.color, sourceMode: "authored_palette", shotMatchRequired: false } } })).toThrow(/Media plans/);
  });
  it("refuses invented dialogue or impacts in a disclosed silent original", async () => {
    const { plan, base } = await fixture();
    expect(() => parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, audio: base.editorial.audio } })).toThrow(/explicit silent/);
    expect(() => parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, audio: { ...plan.editorial.audio, impactFrames: [35] } } })).toThrow(/Silent original/);
  });
  it("refuses missing files, duplicate source branches and unbound visible commands", async () => {
    const { plan, set } = await fixture();
    const missing = structuredClone(plan); delete missing.materialEvidence.sources[0].authoringSource;
    expect(() => parseAutopilotPlan(missing)).toThrow(/file-bound/);
    expect(() => parseAutopilotPlan({ ...plan, originalMotionEvidence: set })).toThrow(/twice/);
    expect(() => parseAutopilotPlan({ ...plan, commands: [...plan.commands, { type: "rename_project", name: "Unbound mutation" }] })).toThrow(/authored sources|fabricate/);
  });
  it("refuses scene camera and semantic cue mutation under the same compiled manifest", async () => {
    const { plan } = await fixture();
    for (const target of ["camera", "cue"] as const) {
      const changed = structuredClone(plan);
      const command = changed.commands.find(row => row.type === "add_motion_scene");
      if (command?.type !== "add_motion_scene") throw new Error("scene absent");
      if (target === "camera") command.scene.camera.zoom.events[0].target += 0.1;
      else command.scene.semanticCues[0].frame += 1;
      expect(() => parseAutopilotPlan(changed)).toThrow(/scene command|hash|differs/);
    }
  });
  it("admits authored overlays only with the existing media branch and its honest audio", async () => {
    const { plan, set, base } = await fixture("authored_overlay");
    const overlay = { ...plan, materialEvidence: base.materialEvidence, originalMotionEvidence: set, editorial: { ...plan.editorial, audio: base.editorial.audio, color: base.editorial.color } };
    expect(() => parseAutopilotPlan(overlay)).not.toThrow();
    expect(() => parseAutopilotPlan(plan)).toThrow(/intent differs/);
    expect(() => parseAutopilotPlan({ ...overlay, editorial: { ...overlay.editorial, audio: plan.editorial.audio } })).toThrow(/Media plans/);
  });
});
