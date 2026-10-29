import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { createEmptyEditkinSkillSelectionReceipt } from "../plugins/skillPack";
import { canonicalJson } from "../shared/canonicalJson";
import { parseAutopilotPlan } from "./autopilotPlan";
import type { DesignRequest } from "./autopilotDesignContract";
import { sha256Canonical, type AutopilotPlanLiveSource } from "./autopilotInvocationIdentity";
import { AUTOPILOT_CONTEXT_PROTOCOL, inferenceRouterSha256, recommendInferenceRoute, renderInferenceRouterMarkdown } from "./inferencePolicy";
import { REFERENCE_MOTION_EDITORIAL_BINDING_CAPABILITY } from "./referenceMotionPlan";
import { TemplateShortBlockError } from "./templateShortBrief";
import { TEMPLATE_SHORT_FIXTURE_COPY, TEMPLATE_SHORT_FIXTURE_POLICY, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS, compileTemplateShortFixture,
  templateBeatsFromRoleMap, templateShortFixtureProject, type TemplateShortRoleMapBeat } from "./templateShortFixtures";
import { assertTemplateBeatCoverage, composeTemplateShortPlan, deriveEditorial, type TemplateShortBeat, type TemplateShortComposeInputs,
  type TemplateShortPacket } from "./templateShortPlan";

const blocked = (run: () => unknown) => {
  try { run(); } catch (error) { if (error instanceof TemplateShortBlockError) return error; throw error; }
  throw new Error("expected a TemplateShortBlockError");
};
/** The r52 hand map T01 still carried into r53 (engineering/EDITORIAL_ROLE_CORRECTION.json `before`). */
const STALE_T01_MAP: TemplateShortRoleMapBeat[] = [
  { id: "strike-hook", narrativeRole: "promise", designRole: "first_frame", startsAtRole: null, roles: ["design:*", "previous", "strike*"] },
  { id: "curtain-payoff", narrativeRole: "payoff", designRole: "payoff", startsAtRole: "headline:0", roles: ["headline*", "source*", "subtitle*", "tag*"] },
];
const SOURCE: AutopilotPlanLiveSource = { skillId: "video-autopilot", revision: 185, skillSha256: "a".repeat(64), workflowContractRevision: 6,
  workflowContractSha256: "b".repeat(64), knowledgeRevision: 79, knowledgeSha256: "c".repeat(64), stableRulesSha256: "d".repeat(64),
  pluginRegistrySha256: "e".repeat(64), invocationBindingSha256: "f".repeat(64) };
const USE_REASONS = { title: "地點、原句、新主張、副標與貼紙全部用實體字形排版", cards: "手帳頁、色暈、拍立得相框、紙膠帶、貼紙與刪線都是主題向量圖卡",
  motion: "Motion Language：逐字彈跳、刪線劃過、拍立得落下、貼紙拍上", tracking_masks: "實拍放進主題視窗的固定形狀柔邊遮罩，不是追蹤",
  transitions_camera: "同一連續鏡頭在主題視窗裡的版面裁切與落下關鍵影格；不是轉場或數位運鏡" };

/** Synthetic material receipts over a fresh trip_pop_v1 strike_reframe compile with the real bundled glyphs. */
async function syntheticInputs(options: { hasAudio?: boolean; map?: TemplateShortRoleMapBeat[] } = {}): Promise<TemplateShortComposeInputs & { beats: TemplateShortBeat[] }> {
  const project = templateShortFixtureProject();
  const { packet } = await compileTemplateShortFixture("strike_reframe", "trip_pop_v1", project);
  const aesthetic = project.aestheticSystem!, input = packet.instance.input;
  const beats = templateBeatsFromRoleMap(packet, options.map ?? TEMPLATE_SHORT_FIXTURE_ROLE_MAPS.strike_reframe, project.fps);
  const topic = "三民蝙蝠洞：名字叫蝙蝠洞，主角其實是洞頂落下的水簾";
  const request: DesignRequest = { format: "shorts", domain: aesthetic.domain, topic, duration: 11, styleFamily: aesthetic.primaryFamily, beats: [
    { id: "strike-hook", role: "first_frame", energy: 0.8, subject: "刪去「來看蝙蝠」，改看洞頂落下的水簾",
      nativeTemplateDirection: { templateId: input.templateId, graphicCadence: input.graphicCadence ?? "legacy", style: input.style } },
    { id: "curtain-payoff", role: "payoff", energy: 0.5, subject: "拍立得框裡的水簾，讀完名字的反差" }] };
  const markdown = renderInferenceRouterMarkdown("quality_critical", "quality");
  return {
    project, source: SOURCE, route: { ...recommendInferenceRoute("quality_critical", "quality"), taskClass: "quality_critical", priority: "quality" },
    router: { protocol: AUTOPILOT_CONTEXT_PROTOCOL, markdown, markdownRouterSha256: inferenceRouterSha256(markdown) },
    skill: createEmptyEditkinSkillSelectionReceipt(SOURCE.pluginRegistrySha256, { format: "shorts", domain: aesthetic.domain, semanticRoles: ["hook", "reveal"] }),
    brief: { request, context: { learning: { budget: { estimated_tokens: 900, knowledge_rules_trimmed: 0, within_budget: true, knowledge_rules_selected: 1 },
      knowledge_card: [{ id: "K-03fb82e28066" }] } }, recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: aesthetic.primaryFamily, role: beat.role } } })) },
    identity: { projectSha256: sha256Canonical(project), sourceSha256: "1".repeat(64), briefSha256: "2".repeat(64) },
    packet, beats,
    semantics: [{ materialId: "5".repeat(64), sourceSha256: "4".repeat(64), assetId: "batcave-4022", clipId: "clip-batcave", semanticReceiptSha256: "d".repeat(64) }],
    editorial: deriveEditorial({ family: "strike_reframe", copy: TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, topic, shortId: "ts-20261009-batcave-3f9a1c",
      assetId: "batcave-4022", themeName: "旅遊手帳", probe: { hasAudio: options.hasAudio ?? true, colorTransfer: "arib-std-b67" }, speech: "absent",
      beats: [{ id: "strike-hook", summary: "第一格讀到地點與「來看蝙蝠」，接著被刪去", application: "地點與原句在第一格就完整可讀；刪線劃過原句後退場。" },
        { id: "curtain-payoff", summary: "「其實是來看水簾」彈入，水簾畫面落進相框", application: "答案逐字彈入並標出「水簾」；實拍放進主題相框，副標說明名字的反差。" }],
      useReasons: USE_REASONS }),
    policy: TEMPLATE_SHORT_FIXTURE_POLICY, provider: "claude_code",
  };
}

describe("template short plan: fresh compile", () => {
  it("composes a v4 plan that passes parseAutopilotPlan and binds every visible compiled command to one beat", async () => {
    const inputs = await syntheticInputs(), result = composeTemplateShortPlan(inputs);
    const plan = parseAutopilotPlan(result.plan);
    expect(plan.schema).toBe("hao.video-autopilot.edit-plan/v4");
    expect(result.planSha256).toBe(sha256Canonical(result.plan));
    expect(sha256Canonical(plan)).toBe(result.planSha256);
    expect(result.commandCount).toBe(inputs.packet.commands.length + 1);
    expect(result.plan.commands[0].type).toBe("set_aesthetic_system");
    expect(result.plan.referenceMotion.instances[0].commandIndexes).toEqual(inputs.packet.commands.map((_, index) => index + 1));
    const bound = result.plan.designEvidence.decisions.flatMap(row => row.commandIndexes).sort((a, b) => a - b);
    const visible = result.plan.commands.flatMap((command, index) => index > 0 && !["add_track", "upsert_reference_motion_instance"].includes(command.type) ? [index] : []);
    expect(bound).toEqual(visible);
    expect(result.plan.editorial.narrative.beats.map(beat => [beat.range.startFrame, beat.range.endFrame])).toEqual(inputs.beats.map(beat => [beat.startFrame, beat.endFrame]));
    expect(result.plan.editorial.graphics.every(event => event.referenceMotionBinding && !event.presetVariant)).toBe(true);
    expect(result.plan.editorial.audio).toMatchObject({ mode: "source_layers", layers: [{ role: "production_sound", evidenceRefs: ["asset:batcave-4022"] }] });
    expect(result.plan.inference).toMatchObject({ provider: "claude_code", taskClass: "quality_critical", safeguards: { humanReviewRequired: false } });
    expect(result.plan.editorial.graphics.flatMap(event => event.evidenceRefs).some(ref => ref.includes(":viewed-"))).toBe(false);
  }, 60_000);

  it("keeps a silent source silent: audio.mode silent_media, and the plan still parses", async () => {
    const result = composeTemplateShortPlan(await syntheticInputs({ hasAudio: false }));
    expect(result.plan.editorial.audio).toMatchObject({ mode: "silent_media", layers: [], impactFrames: [], breathFrames: [] });
    expect(() => parseAutopilotPlan(result.plan)).not.toThrow();
    expect(result.plan.editorial.motionTreatment.decisions.find(row => row.family === "sound")).toMatchObject({ action: "omit", reason: "原片沒有音軌；不加音效或配樂" });
  }, 60_000);

  it("r53 negative: the stale r52 map leaves today's previous:hook in no beat", async () => {
    const inputs = await syntheticInputs({ map: STALE_T01_MAP });
    expect(blocked(() => composeTemplateShortPlan(inputs))).toMatchObject({ code: "BLOCK_TEMPLATE_BEATS", message: "BLOCK_TEMPLATE_BEATS: role previous:hook is in no beat" });
    const corrected = templateBeatsFromRoleMap(inputs.packet, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS.strike_reframe, 30);
    expect(corrected[0].roleKeys).toEqual(expect.arrayContaining(["previous:hook", "previous"]));
  }, 60_000);

  it("caps: 101 commands and over 256 KiB block the compose", async () => {
    const inputs = await syntheticInputs(), packet = structuredClone(inputs.packet);
    const roleOf = new Map(packet.instance.roles.map(role => [role.id, role.key]));
    const template = packet.commands.find(command => command.type === "add_motion_graphic" && roleOf.get(command.graphic.id)?.startsWith("design:"));
    if (template?.type !== "add_motion_graphic") throw new Error("fixture has no design:* graphic");
    const event = packet.editorialGraphics.find(row => row.id === template.graphic.id)!;
    const extra = 100 - packet.commands.length;
    const clones = Array.from({ length: extra }, (_, index) => `template-short-extra-${index}`);
    packet.commands.splice(packet.commands.length - 1, 0, ...clones.map(id => ({ type: "add_motion_graphic" as const, graphic: { ...template.graphic, id } })));
    packet.instance.roles.push(...clones.map((id, index) => ({ key: `design:extra:${index}`, kind: "graphic" as const, id })));
    packet.editorialGraphics.push(...clones.map(id => ({ ...structuredClone(event), id })));
    const metadata = packet.commands.at(-1)!;
    if (metadata.type !== "upsert_reference_motion_instance") throw new Error("compiler group lost its metadata");
    metadata.instance = packet.instance;
    packet.planDeclaration.instances[0].commandIndexes = packet.commands.map((_, index) => index);
    const beats = templateBeatsFromRoleMap(packet, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS.strike_reframe, 30);
    expect(blocked(() => composeTemplateShortPlan({ ...inputs, packet, beats }))).toMatchObject({ code: "BLOCK_COMPOSE",
      detail: "Plan has 101 commands; the v4 limit is 100" });
    const bloated = blocked(() => composeTemplateShortPlan({ ...inputs, editorial: { ...inputs.editorial, backbone: "很".repeat(90_000) } }));
    expect(bloated.code).toBe("BLOCK_COMPOSE");
    expect(bloated.detail).toMatch(/^Plan is \d+ bytes; the v4 limit is 262144$/);
  }, 60_000);

  it("names what breaks the coverage invariant", async () => {
    const { packet, beats } = await syntheticInputs();
    const failure = (next: TemplateShortBeat[]) => blocked(() => assertTemplateBeatCoverage(packet, next)).detail;
    const [hook, answer] = beats;
    expect(failure([{ ...hook, roleKeys: [...hook.roleKeys, answer.roleKeys[0]] }, answer])).toBe(`role ${answer.roleKeys[0]} is in beats strike-hook and curtain-payoff`);
    expect(failure([{ ...hook, narrativeRole: "build" }, answer])).toBe("the first beat strike-hook must be the promise");
    expect(failure([hook, { ...answer, narrativeRole: "reveal" }])).toBe("the last beat curtain-payoff must be the payoff");
    expect(failure([{ ...hook, startFrame: 1 }, answer])).toBe("beat strike-hook must start at the template start frame 0");
    expect(failure([{ ...hook, endFrame: answer.startFrame - 1 }, answer])).toBe(`beat strike-hook must end at frame ${answer.startFrame}, inside the template window`);
    const hookGraphics = hook.roleKeys.filter(key => packet.commands.some(command => command.type === "add_motion_graphic"
      && packet.instance.roles.find(role => role.id === command.graphic.id)?.key === key));
    expect(failure([{ ...hook, roleKeys: hook.roleKeys.filter(key => !hookGraphics.includes(key)) }, { ...answer, roleKeys: [...answer.roleKeys, ...hookGraphics] }]))
      .toBe("beat strike-hook binds no visible command");
    expect(failure([])).toBe("the template declares no beats");
  }, 60_000);
});

// Parity with the real sealed T01 plan: copied r53b receipts (fixtures/t01-r53b/SOURCES.json). Skipped when absent.
const FIXTURE = resolve(".rd/benchmarks/usable-v1-20261009/fixtures/t01-r53b");
const read = (path: string) => JSON.parse(readFileSync(resolve(FIXTURE, path), "utf8").replace(/^﻿/, ""));
function body(value: any): any {
  if (value && typeof value === "object" && "content" in value) {
    expect(value.isError).not.toBe(true);
    const texts = value.content.filter((item: { type: string }) => item.type === "text");
    expect(texts).toHaveLength(1);
    return body(JSON.parse(texts[0].text));
  }
  return value;
}
function t01(provider: TemplateShortComposeInputs["provider"], map?: TemplateShortRoleMapBeat[]): TemplateShortComposeInputs {
  const project = read("t01-strike-trip-batcave.editkin.json.previous") as EditProject;
  const routed = body(read("live-r53b/007-route.result.raw.json")), routeRequest = read("live-r53b/007-route.request.json").arguments;
  const pages = read("authoring/brief/design-pages.full.json"), pageBodies: any[] = pages.pages.map(body), request: DesignRequest = pages.request;
  const content = (pageId: string) => JSON.parse(pageBodies.filter(page => page.pageId === pageId).sort((a, b) => a.offset - b.offset).map(page => page.text).join(""));
  const context = content("context");
  // The template receipt is a module invocation: its carriers are the prepare_reference_motion_template packet.
  const invocation = body(read("live-r53b/011-template.result.compact.json"));
  expect(invocation.commandsSha256).toBe(sha256Canonical(invocation.commands));
  const packet: TemplateShortPacket = { ...invocation.carriers, commands: invocation.commands, status: invocation.status, readOnly: invocation.readOnly };
  const semantic = body(read("live-r53b/006-semantics-m01-clip-batcave.result.raw.json")).receipt;
  const material = body(read("live-r53b/003-prepare_m01-clip-batcave.result.raw.json")).packet;
  const spec = read("authoring/plan-spec.json");
  const beats = templateBeatsFromRoleMap(packet as TemplateShortPacket & { phases: Array<{ role: string; startFrame: number }> },
    map ?? spec.beats.map((beat: TemplateShortRoleMapBeat, index: number) => ({ ...beat, designRole: request.beats[index].role })), project.fps);
  return {
    project, source: body(read("live-r53b/001-contract.result.raw.json")).requiredPlanSource,
    route: { ...routed.route, taskClass: routeRequest.taskClass, priority: routeRequest.priority }, router: routed.context,
    skill: body(read("live-r53b/010-skill.result.raw.json")).receipt,
    brief: { request, context, recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: content(`beat:${beat.id}`) })) },
    identity: { projectSha256: pageBodies[0].projectSha256, sourceSha256: pageBodies[0].sourceSha256, briefSha256: pageBodies[0].briefSha256 },
    packet, beats,
    semantics: [{ materialId: semantic.materialId, sourceSha256: semantic.sourceSha256, assetId: material.source.assetId, clipId: material.source.clipId,
      semanticReceiptSha256: semantic.semanticReceiptSha256 }],
    editorial: { base: spec.editorial, backbone: spec.backbone, beats: spec.beats.map(({ id, summary, application }: { id: string; summary: string; application: string }) =>
      ({ id, summary, application })), familyReasons: spec.familyReasons },
    policy: context.review.policy, provider,
  };
}

describe.skipIf(!existsSync(FIXTURE))("template short plan: parity with the sealed r53b T01 run-r1 plan", () => {
  const sealed = () => read("run-r1/plan.v4.json");
  it("uses the same compact editorial binding capability the r53b contract advertised", () => {
    expect(REFERENCE_MOTION_EDITORIAL_BINDING_CAPABILITY).toEqual(body(read("live-r53b/001-contract.result.raw.json")).contract.motion.referenceInstances.editorialBinding);
  });

  it("reproduces commands, referenceMotion, design decisions, motion treatment and material evidence", () => {
    const expected = sealed(), { plan } = composeTemplateShortPlan(t01("claude_code"));
    for (const pick of [(value: any) => value.commands, (value: any) => value.referenceMotion, (value: any) => value.designEvidence.decisions,
      (value: any) => value.editorial.motionTreatment, (value: any) => value.materialEvidence]) {
      expect(canonicalJson(pick(plan))).toBe(canonicalJson(pick(expected)));
    }
    expect(plan.editorial.narrative.beats.map(beat => [beat.id, beat.range.startFrame, beat.range.endFrame])).toEqual([["strike-hook", 0, 75], ["curtain-payoff", 75, 330]]);
    expect(() => parseAutopilotPlan(plan)).not.toThrow();
  });

  it("with provider codex and the legacy viewed-ref compaction, the whole plan SHA equals the sealed 45629906abbea092…", () => {
    const expected = sealed(), result = composeTemplateShortPlan(t01("codex"), { legacyViewedRefs: true });
    expect(sha256Canonical(expected)).toBe("45629906abbea092d1bc965b1ede9a86b09f66de2424cdb19000f2033f827e1f");
    expect(result.planSha256).toBe("45629906abbea092d1bc965b1ede9a86b09f66de2424cdb19000f2033f827e1f");
    expect(canonicalJson(result.plan)).toBe(canonicalJson(expected));
  });

  it("r53 negative on the real r53b compile: the stale map → role previous:hook is in no beat", () => {
    expect(blocked(() => composeTemplateShortPlan(t01("codex", STALE_T01_MAP)))).toMatchObject({
      code: "BLOCK_TEMPLATE_BEATS", message: "BLOCK_TEMPLATE_BEATS: role previous:hook is in no beat" });
  });
});
