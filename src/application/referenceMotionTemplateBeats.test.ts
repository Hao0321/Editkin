import { beforeAll, describe, expect, it } from "vitest";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { buildReferenceMotionTemplateCommands, type ReferenceMotionTemplateBeat } from "./referenceMotionTemplateCommands";
import { REFERENCE_MOTION_BEAT_TABLES, templateBeatTexts } from "./referenceMotionBeatTables";
import { TEMPLATE_SHORT_FIXTURE_COPY, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS, compileTemplateShortFixture, physicalText, templateBeatsFromRoleMap,
  templateShortFixtureProject, warmTemplateShortFonts } from "./templateShortFixtures";
import { toTemplateInput } from "./templateShortCatalog";
import { assertTemplateBeatCoverage } from "./templateShortPlan";

// M1 one-tool Short wave 2 step 2.1: the template declares its beats where it draws its roles (DesignContext.beat/withBeat).
const emitted = (packet: unknown) => (packet as { beats: ReferenceMotionTemplateBeat[] }).beats;
const shape = (beats: ReadonlyArray<{ startFrame: number; endFrame: number; roleKeys: readonly string[] }>) =>
  beats.map(beat => ({ range: [beat.startFrame, beat.endFrame], roles: [...beat.roleKeys].sort() }));
beforeAll(() => warmTemplateShortFonts(["trip_pop_v1", "tech_spec_v1"]), 60_000);

describe("template-emitted beats: the two v1 families on trip_pop_v1", () => {
  it("T01 strike_reframe: hook [0,75) and answer [75,330), exactly the hand-corrected r53b map (EDITORIAL_ROLE_CORRECTION.json after)", async () => {
    const { project, packet } = await compileTemplateShortFixture("strike_reframe", "trip_pop_v1");
    const beats = emitted(packet);
    expect(beats.map(beat => ({ id: beat.id, narrativeRole: beat.narrativeRole, designRole: beat.designRole, range: [beat.startFrame, beat.endFrame] }))).toEqual([
      { id: "hook", narrativeRole: "promise", designRole: "first_frame", range: [0, 75] },
      { id: "answer", narrativeRole: "payoff", designRole: "payoff", range: [75, 330] }]);
    const [hook, answer] = beats;
    expect(hook.roleKeys).toEqual(expect.arrayContaining(["previous:hook", "previous", "strike:0"]));
    expect(hook.roleKeys.every(key => /^(design:|previous|strike)/.test(key))).toBe(true);
    expect(answer.roleKeys.every(key => /^(headline|source|subtitle|tag)/.test(key))).toBe(true);
    // The r53b author's corrected patterns (design:* previous* strike* | headline* source* subtitle* tag*, payoff at headline:0) give the same partition.
    expect(shape(beats)).toEqual(shape(templateBeatsFromRoleMap(packet, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS.strike_reframe, project.fps)));
    expect(() => assertTemplateBeatCoverage(packet, beats)).not.toThrow();
  }, 60_000);

  it("context_stack: page, title and footage promise; the steps pay off from the first step's settled hold (the t04 author's anchor)", async () => {
    const { project, packet } = await compileTemplateShortFixture("context_stack", "trip_pop_v1");
    const beats = emitted(packet), firstHold = packet.phases.find(phase => phase.role === "hold")!;
    expect(beats.map(beat => [beat.id, beat.narrativeRole, beat.designRole, beat.startFrame, beat.endFrame]))
      .toEqual([["promise", "promise", "first_frame", 0, firstHold.startFrame], ["steps", "payoff", "process", firstHold.startFrame, 330]]);
    // withBeat keeps the footage (drawn after the steps) in the promise beat.
    expect(beats[0].roleKeys).toEqual(expect.arrayContaining(["headline:0", "source:0:clip", "source:0:mask"]));
    expect(beats[1].roleKeys.every(key => key.startsWith("item:"))).toBe(true);
    expect(shape(beats)).toEqual(shape(templateBeatsFromRoleMap(packet, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS.context_stack, project.fps)));
    expect(() => assertTemplateBeatCoverage(packet, beats)).not.toThrow();
  }, 60_000);

  it("T04 context_stack copy: promise until the first compiled hold, then the steps (the anchor the r53b author used: startsAtPhase hold)", async () => {
    // T04's actual creator copy and window (live-r53b/011-template input). Its sealed r53b plan narrated [0,15) and [15,360) on that day's compile;
    // the anchor, not the number, is the contract: the beat follows whatever hold today's template compiles.
    const copy = { payoff: "越走越懸空", accent: "懸空", place: "桃園復興｜小烏來", points: [{ label: "先走樹林步道" },
      { label: "站上和平橋往下看", detail: "溪底全是大石頭" }, { label: "終點在瀑布正上方", detail: "瀑布就砸在腳底下" }] };
    const { project, packet } = await compileTemplateShortFixture("context_stack", "trip_pop_v1", templateShortFixtureProject({ durationFrames: 360 }), copy,
      { focus: { x: 0, y: 0, w: 1, h: 0.78 } });
    const hold = packet.phases.find(phase => phase.role === "hold")!.startFrame;
    expect(emitted(packet).map(beat => [beat.id, beat.startFrame, beat.endFrame])).toEqual([["promise", 0, hold], ["steps", hold, 360]]);
    expect(shape(emitted(packet))).toEqual(shape(templateBeatsFromRoleMap(packet, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS.context_stack, project.fps)));
  }, 60_000);

  it("atHold: when the cadence settles the first step's hold after its 14-frame roll, the steps beat moves with it", async () => {
    // tech_spec_v1 (animation speed 1, so the step lands at frame 0 + 14): its first hold is settled later than the landing.
    const { packet } = await compileTemplateShortFixture("context_stack", "tech_spec_v1");
    const hold = packet.phases.find(phase => phase.role === "hold")!.startFrame;
    expect(hold).toBeGreaterThan(14);
    expect(emitted(packet)[1].startFrame).toBe(hold);
  }, 60_000);

  it("offsets every beat by the template's start frame, like phase()", async () => {
    const project = templateShortFixtureProject({ durationFrames: 330 });
    project.tracks[0].clips[0].timelineStart = 2;
    const input = { ...toTemplateInput("strike_reframe", TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, { clipId: "clip-batcave", durationFrames: 330,
      designSystem: "trip_pop_v1", shortId: "ts-20261009-batcave-3f9a1c", semanticRef: `material:${"5".repeat(64)}:semantic:${"d".repeat(64)}` }),
    startFrame: 60, strikePresentation: "semantic_replace_v1" as const };
    let ordinal = 0;
    const later = await prepareReferenceMotionTemplateInstance(project, input, prefix => `${prefix}-${ordinal++}`, { prepareText: physicalText });
    const beats = emitted(later);
    expect(beats[0].startFrame).toBe(60);
    expect(beats.at(-1)!.endFrame).toBe(390);
    expect(() => assertTemplateBeatCoverage(later, beats)).not.toThrow();
  }, 60_000);
});

describe("template-emitted beats: scope", () => {
  it("a family that declares no beats yet reports an empty list, which the coverage check names", async () => {
    const project = templateShortFixtureProject({ durationFrames: 180 });
    const input = { templateId: "level_bridge" as const, clipId: "clip-batcave", startFrame: 0, durationFrames: 180, designSystem: "trip_pop_v1" as const,
      graphicCadence: "kinetic" as const, intent: "shortform" as const, title: "烏嘎彥竹林", accentText: "竹林", purpose: "Synthetic beat scope control",
      evidenceRefs: ["synthetic:beat-scope"] };
    let ordinal = 0;
    const packet = await prepareReferenceMotionTemplateInstance(project, input, prefix => `${prefix}-${ordinal++}`, { prepareText: physicalText });
    expect(emitted(packet)).toEqual([]);
    expect(() => assertTemplateBeatCoverage(packet, emitted(packet))).toThrow("BLOCK_TEMPLATE_BEATS: the template declares no beats");
  }, 60_000);

  it("a scene without a design system carries no beats at all", () => {
    const project = templateShortFixtureProject({ durationFrames: 300 });
    let ordinal = 0;
    const packet = buildReferenceMotionTemplateCommands(project, { templateId: "kinetic_network", clipId: "clip-batcave", startFrame: 0, durationFrames: 300,
      title: "一句話剪成一支片", items: [{ label: "看懂素材" }, { label: "自動剪輯" }, { label: "動態模板" }], purpose: "Synthetic beat scope control",
      evidenceRefs: ["synthetic:beat-scope"] }, prefix => `${prefix}-${ordinal++}`);
    expect("beats" in packet).toBe(false);
  });

  it("every emitted beat id of the v1 families has its beat-table words", async () => {
    for (const family of ["strike_reframe", "context_stack"] as const) {
      const { packet } = await compileTemplateShortFixture(family, "trip_pop_v1");
      const texts = templateBeatTexts(family, TEMPLATE_SHORT_FIXTURE_COPY[family], emitted(packet));
      expect(texts.map(row => row.id)).toEqual(Object.keys(REFERENCE_MOTION_BEAT_TABLES[family].beats));
      expect(texts.map(row => row.energy)).toEqual([0.8, 0.5]);
    }
  }, 60_000);
});
