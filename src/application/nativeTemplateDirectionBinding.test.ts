import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { designRequestSchema, designEvidenceSchema, assertNativeTemplateDirectionBinding } from "./autopilotDesignContract";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { withReferenceMotionPhysicalFonts } from "../mcp/referenceMotionPhysicalFonts";
import { type ReferenceMotionPlan } from "./referenceMotionPlan";
import { parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { motionCommandFamilies, MOTION_TREATMENT_FAMILIES } from "./motionTreatment";
import { testDesignReviewEnvelope } from "./testDesignReviewPolicy";
import { verifyAutopilotDesign, designIdentity, type CurrentDesignBrief } from "../mcp/autopilotDesignTools";
import { sha256Canonical } from "./autopilotInvocationIdentity";

async function fixture() {
  const project = createEmptyProject("Synthetic brisk native design control", { id: "cadence-design", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source", name: "Synthetic source metadata", kind: "video", uri: "D:/synthetic/brisk-native-source.mp4",
    duration: 20, width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "source", timelineStart: 0, sourceStart: 2,
    duration: 12, volume: .62, keyframes: [], transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }];
  const direction = { templateId: "level_bridge" as const, graphicCadence: "brisk" as const, style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) };
  let serial = 0;
  const prepared = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateInstance(project, {
    ...direction, clipId: "primary", startFrame: 0, durationFrames: 360, title: "找到夥伴", kicker: "共作", subtitle: "開始合作",
    purpose: "Synthetic actual native design binding; no film or art acceptance", evidenceRefs: ["synthetic:direction"] },
    prefix => prefix + "-direction-" + serial++, deps));
  const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: prepared.instance.id,
    mode: "create", commandIndexes: prepared.commands.map((_, index) => index) }] };
  const visible = prepared.commands.flatMap((command, index) => command.type === "add_motion_graphic" ? [index] : []);
  const request = designRequestSchema.parse({ format: "shorts", domain: "technology", topic: "自研動態", duration: 12,
    beats: [{ id: "native", role: "first_frame", energy: .6, subject: "真實合作", nativeTemplateDirection: direction }] });
  const evidence = designEvidenceSchema.parse({ schema: "editkin.autopilot-design-evidence/v1", request, projectSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64), briefSha256: "c".repeat(64), decisions: [{ beatId: "native", recipeSha256: "d".repeat(64),
    application: "原生真字形模板依指定配色與俐落節奏落定", commandIndexes: visible }] });
  return { project, direction, prepared, declaration, visible, request, evidence };
}

function integrated(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = parseAutopilotPlan(createAutopilotV4Fixture()) as CurrentAutopilotPlan;
  plan.route.format = "shorts";
  const beat = { ...plan.editorial.narrative.beats[0], id: "native", energy: .6, primaryFocus: "真實合作",
    range: { startFrame: 0, endFrame: 360 } };
  plan.editorial.narrative.beats = [beat]; plan.commands = f.prepared.commands; plan.referenceMotion = f.declaration;
  plan.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = plan.commands.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
    return { family, action: commandIndexes.length ? "use" as const : "omit" as const,
      reason: "Synthetic exact actual command family coverage, no aesthetic credit", beatIds: ["native"], commandIndexes };
  }) };
  const brief: CurrentDesignBrief = { schema: "hao.editkin.current-design-brief/v1", request: f.request,
    sources: [{ path: "synthetic-compiler", sha256: "b".repeat(64) }], sourceSha256: "b".repeat(64),
    ...testDesignReviewEnvelope(), recipes: [{ beatId: "native", recipe: { route: { primary_family: plan.aesthetic.primaryFamily },
      nativeTemplateDirection: f.direction } }] };
  plan.designEvidence = { ...f.evidence, ...designIdentity(brief, f.project),
    decisions: f.evidence.decisions.map(row => ({ ...row, recipeSha256: sha256Canonical(brief.recipes[0].recipe) })) };
  return { plan, brief, compile: async () => brief };
}

describe("actual native template cadence design binding", () => {
  it("accepts explicit complete native direction and keeps omitted historical design request unchanged", async () => {
    const f = await fixture();
    expect(() => assertNativeTemplateDirectionBinding(f.evidence, f.prepared.commands, f.declaration)).not.toThrow();
    const raw = { ...f.request, beats: f.request.beats.map(({ nativeTemplateDirection: _discard, ...beat }) => beat) };
    expect(designRequestSchema.parse(raw)).toEqual(raw);
    expect(() => assertNativeTemplateDirectionBinding({ ...f.evidence, request: raw }, [], undefined)).not.toThrow();
  });
  it("rejects whole-board native direction in longform rather than replacing true UI", async () => {
    const f = await fixture();
    for (const format of ["longform", "podcast", "interview"]) expect(() => designRequestSchema.parse({ ...f.request, format })).toThrow(/Longform/);
  });
  it("rejects native unknown template cadence incomplete style and injected fields", async () => {
    const f = await fixture();
    for (const nativeTemplateDirection of [
      { ...f.direction, templateId: "third_party_ui" }, { ...f.direction, graphicCadence: "instant" },
      { ...f.direction, style: { ...f.direction.style, palette: { text: "#172033" } } }, { ...f.direction, automaticApproval: true },
    ]) expect(() => designRequestSchema.parse({ ...f.request, beats: [{ ...f.request.beats[0], nativeTemplateDirection }] })).toThrow();
  });
  it("rejects caller direction with different actual cadence palette typography or template", async () => {
    const f = await fixture();
    for (const change of [
      { graphicCadence: "legacy" as const }, { templateId: "strike_reframe" as const },
      { style: { ...f.direction.style, palette: { ...f.direction.style.palette, accent: "#0B3B95" } } },
      { style: { ...f.direction.style, typography: { ...f.direction.style.typography, bodyFamily: "Noto Serif TC" } } },
    ]) {
      const evidence = { ...f.evidence, request: { ...f.request, beats: [{ ...f.request.beats[0], nativeTemplateDirection: { ...f.direction, ...change } }] } };
      expect(() => assertNativeTemplateDirectionBinding(evidence, f.prepared.commands, f.declaration)).toThrow(/differs from actual authoring/);
    }
  });
  it("rejects unrelated captions metadata-only and missing compiler declarations for native credit", async () => {
    const f = await fixture();
    const commands = [...f.prepared.commands, { type: "add_caption" as const, caption: { id: "outside", text: "unrelated", start: 0, duration: 1 } }];
    expect(() => assertNativeTemplateDirectionBinding({ ...f.evidence, decisions: [{ ...f.evidence.decisions[0],
      commandIndexes: [commands.length - 1] }] }, commands, f.declaration)).toThrow(/authenticated template group/);
    expect(() => assertNativeTemplateDirectionBinding({ ...f.evidence, decisions: [{ ...f.evidence.decisions[0],
      commandIndexes: [f.prepared.commands.length - 1] }] }, f.prepared.commands, f.declaration)).toThrow(/visible physical graphic/);
    expect(() => assertNativeTemplateDirectionBinding(f.evidence, f.prepared.commands, undefined)).toThrow(/declaration/);
  });
  it("rejects duplicated beat credit from a single compiled native instance", async () => {
    const f = await fixture(), second = { ...f.request.beats[0], id: "second" };
    const evidence = { ...f.evidence, request: { ...f.request, beats: [...f.request.beats, second] },
      decisions: [...f.evidence.decisions, { ...f.evidence.decisions[0], beatId: "second" }] };
    expect(() => assertNativeTemplateDirectionBinding(evidence, f.prepared.commands, f.declaration)).toThrow(/duplicate beat/);
  });
  it("actual v4 design verifier independently reopens native commands before accepting bound brisk direction", async () => {
    const f = await fixture(), a = integrated(f), before = JSON.stringify(f.project);
    await expect(verifyAutopilotDesign(a.plan, f.project, a.compile)).resolves.toMatchObject({ state: "COMMAND_BOUND_REVIEW_REQUIRED", beatCount: 1 });
    expect(JSON.stringify(f.project)).toBe(before);
    expect(f.prepared.instance.input).toMatchObject({ graphicCadence: "brisk", clipId: "primary", durationFrames: 360 });
  });
  it("actual v4 design verifier blocks drift even when a new matching brief hash is provided", async () => {
    const f = await fixture(), a = integrated(f);
    const request = { ...f.request, beats: [{ ...f.request.beats[0], nativeTemplateDirection: { ...f.direction, graphicCadence: "legacy" as const } }] };
    const brief: CurrentDesignBrief = { ...a.brief, request, recipes: [{ ...a.brief.recipes[0],
      recipe: { ...a.brief.recipes[0].recipe, nativeTemplateDirection: request.beats[0].nativeTemplateDirection } }] };
    a.plan.designEvidence = { ...a.plan.designEvidence!, request, ...designIdentity(brief, f.project),
      decisions: a.plan.designEvidence!.decisions.map(row => ({ ...row, recipeSha256: sha256Canonical(brief.recipes[0].recipe) })) };
    await expect(verifyAutopilotDesign(a.plan, f.project, async () => brief)).rejects.toThrow(/differs from actual authoring/);
  });
  it("actual v4 design verifier rejects forged timing rather than trusting directional metadata", async () => {
    const f = await fixture(), a = integrated(f);
    const graphic = a.plan.commands.find(command => command.type === "add_motion_graphic" && command.graphic.text);
    if (!graphic || graphic.type !== "add_motion_graphic" || !graphic.graphic.motionV2) throw new Error("actual graphic control required");
    graphic.graphic.motionV2.entrance.durationFrames++;
    await expect(verifyAutopilotDesign(a.plan, f.project, a.compile)).rejects.toThrow(/independently recompiled/);
  });
});
